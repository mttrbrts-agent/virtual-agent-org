// Validates the network configuration and writes gateway/src/generated/network.json.
// Run in CI on every PR: a config change that breaks an invariant fails the build.
//
//   npx tsx scripts/compile.ts          # validate and write
//   npx tsx scripts/compile.ts --check  # validate only

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOLS, EFFORTS, FILE_TOOLS, ROOT, loadAll, readText, type ReviewYaml } from "./lib";
import { REPOS_MARKER, REPO_RE } from "./repos";

export const PERSON_ROLES = ["owner", "tsc_member", "maintainer"];

/** `role` may be one role or a list, e.g. `role: [tsc_member, maintainer]`. */
export function rolesOf(role: string | string[] | undefined): string[] {
  if (role === undefined || role === null) return [];
  return (Array.isArray(role) ? role : [role]).map((r) => String(r).trim()).filter(Boolean);
}

/** "concerto" → "accordproject/concerto"; full names pass through. */
export function fullRepo(repo: string, org: string): string {
  return repo.includes("/") ? repo : `${org}/${repo}`;
}

/** Kinds the gateway runs without the owner, after its own checks (decisions 20 and 36). */
export const AUTO_KINDS = ["github.approve_ci", "github.review"];
/** What GitHub events may wake Mira for (decision 62). */
export const GITHUB_WAKES = ["review", "merge", "first_response"] as const;
const TONES = ["welcoming", "neutral", "terse"];

export function validateReview(r: ReviewYaml | undefined): string[] {
  if (!r) return ["config/review.yaml is missing"];
  const errs: string[] = [];
  const areas = Object.keys(r.areas ?? {});
  if (!areas.length) errs.push("review.yaml: areas must list at least one area");
  for (const a of areas) if (!/^[a-z_]+$/.test(a)) errs.push(`review.yaml: area "${a}" should be lower_snake_case`);
  for (const k of ["max_findings", "max_nits"] as const) {
    if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 50) errs.push(`review.yaml: ${k} must be a whole number from 0 to 50`);
  }
  for (const k of ["first_time", "maintainer", "default"] as const) {
    if (!TONES.includes(r.tone?.[k])) errs.push(`review.yaml: tone.${k} must be one of ${TONES.join(", ")}`);
  }
  const risk = r.risk;
  if (!risk) errs.push("review.yaml: risk is required");
  else {
    for (const k of ["high_over_lines", "low_max_lines"] as const) {
      if (!Number.isInteger(risk[k]) || risk[k] < 0) errs.push(`review.yaml: risk.${k} must be a whole number`);
    }
    if (risk.low_max_lines > risk.high_over_lines) errs.push("review.yaml: risk.low_max_lines must not exceed risk.high_over_lines");
    for (const k of ["high_paths", "low_paths"] as const) {
      if (!Array.isArray(risk[k]) || risk[k].some((g) => typeof g !== "string" || !g.trim())) errs.push(`review.yaml: risk.${k} must be a list of globs`);
    }
  }
  for (const [i, p] of (r.path_rules ?? []).entries()) {
    if (typeof p.glob !== "string" || !p.glob.trim() || typeof p.note !== "string" || !p.note.trim()) errs.push(`review.yaml: path_rules[${i}] needs a glob and a note`);
    if (p.repo !== undefined && !REPO_RE.test(String(p.repo))) errs.push(`review.yaml: path_rules[${i}].repo "${p.repo}" should be owner/name`);
  }
  return errs;
}

export function validate(cfg = loadAll()): string[] {
  const { network, models, permissions, schedules, mcp, specs, people, peopleIds, discord, review } = cfg;
  const errs: string[] = [];

  for (const [name, id] of Object.entries(discord.channels ?? {})) {
    if (id === undefined || id === null || id === "") continue;
    if (typeof id === "number") errs.push(`discord channel ${name}: quote the id, it is too long to be a number`);
    else if (!/^\d{5,20}$/.test(id)) errs.push(`discord channel ${name}: "${id}" should be digits only`);
  }

  const maxRisk = permissions.discord_approval_max_risk ?? "none";
  if (!["none", "low", "medium"].includes(maxRisk)) errs.push(`discord_approval_max_risk must be none, low or medium, not "${maxRisk}"`);

  const app = permissions.approvals_app ?? "both";
  if (!["discord", "telegram", "both"].includes(app)) errs.push(`approvals_app must be discord, telegram or both, not "${app}"`);

  for (const [k, v] of Object.entries(permissions.action_kinds)) {
    if (!["github", "discord", "discord_ops", "discord_dm", "vimeo", "manual", "task"].includes(v.executor)) errs.push(`action kind ${k}: unknown executor "${v.executor}"`);
    // Only kinds the gateway has its own safety checks for may skip the owner.
    if (v.auto && !AUTO_KINDS.includes(k)) errs.push(`action kind ${k}: auto is only allowed for ${AUTO_KINDS.join(" and ")}`);
  }
  errs.push(...validateReview(review));
  const cap = network.budgets.member_daily_messages;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) errs.push("network.yaml: budgets.member_daily_messages must be a whole number, 0 or more");
  const wakes = network.budgets.follow_up_daily_wakes;
  if (wakes !== undefined && !(Number.isInteger(wakes) && wakes >= 0 && wakes <= 50)) errs.push("network.yaml: budgets.follow_up_daily_wakes must be a whole number from 0 to 50");
  const wakeUsd = network.budgets.follow_up_budget_usd;
  if (wakeUsd !== undefined && !(typeof wakeUsd === "number" && wakeUsd > 0 && wakeUsd <= 3)) errs.push("network.yaml: budgets.follow_up_budget_usd must be more than 0 and at most 3");
  for (const [trigger, w] of Object.entries(network.budgets.github_wakes ?? {})) {
    if (!(GITHUB_WAKES as readonly string[]).includes(trigger)) errs.push(`network.yaml: budgets.github_wakes.${trigger}: unknown trigger; use ${GITHUB_WAKES.join(", ")}`);
    else if (!(Number.isInteger(w?.daily) && w.daily >= 0 && w.daily <= 50)) errs.push(`network.yaml: budgets.github_wakes.${trigger}.daily must be a whole number from 0 to 50`);
    else if (!(typeof w.usd === "number" && w.usd > 0 && w.usd <= 3)) errs.push(`network.yaml: budgets.github_wakes.${trigger}.usd must be more than 0 and at most 3`);
  }

  const own = network.github.network_repo;
  if (!REPO_RE.test(String(own))) errs.push(`github.network_repo: "${own}" should be owner/name`);
  else {
    if (network.github.sandbox_repo === own) errs.push(`github.sandbox_repo: ${own} is the network's own repo (decision 51)`);
    if ((network.github.repos ?? []).includes(own)) errs.push(`github.repos: ${own} is the network's own repo (decision 51)`);
  }
  if ((network.github.repos ?? []).includes(network.github.sandbox_repo)) errs.push(`github.repos: ${network.github.sandbox_repo} is the sandbox repo, not a repo in scope (decision 51)`);
  for (const k of ["mechanic_small_usd", "mechanic_large_usd"] as const) {
    const v = network.budgets[k];
    if (!(typeof v === "number" && v > 0 && v <= 10)) errs.push(`network.yaml: budgets.${k} must be more than 0 and at most 10`);
  }
  const si = network.self_improvement;
  if (!si) errs.push("network.yaml: self_improvement is required");
  else {
    if (si.since !== null && !(typeof si.since === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]+)?$/.test(si.since) && !Number.isNaN(Date.parse(si.since)))) errs.push("self_improvement.since must be an ISO date or null");
    if (!(Number.isInteger(si.stale_days) && si.stale_days >= 1 && si.stale_days <= 365)) errs.push("self_improvement.stale_days must be a whole number from 1 to 365");
    for (const [k, max] of [["proposal_gap_days", 30], ["min_decided", 100], ["min_days", 60]] as const) {
      const v = si[k];
      if (v !== undefined && !(Number.isInteger(v) && v >= 0 && v <= max)) errs.push(`self_improvement.${k} must be a whole number from 0 to ${max}`);
    }
    const a = si.commit_author;
    if (!a || typeof a.name !== "string" || !a.name.trim() || typeof a.email !== "string" || !a.email.includes("@")) errs.push("self_improvement.commit_author needs a name and an email");
    else if (si.since !== null && /[<>]/.test(a.email)) errs.push("self_improvement.commit_author.email is still a placeholder: set the App's bot email before switching the loop on");
  }

  const repos = network.github.repos ?? [];
  if (!Array.isArray(repos)) errs.push("github.repos must be a list");
  else for (const r of repos) if (!REPO_RE.test(String(r))) errs.push(`github.repos: "${r}" should be owner/name`);
  if (!readText("context/accord.md").includes(REPOS_MARKER)) errs.push(`context/accord.md: keep the line ${REPOS_MARKER}; deploy fills in the repos there`);

  const seenIds = new Set<string>();
  for (const [i, p] of (people.people ?? []).entries()) {
    const who = p.name || `people[${i}]`;
    if (!p.name) errs.push(`people[${i}]: name is required`);
    const roles = rolesOf(p.role);
    if (!roles.length) errs.push(`${who}: role is required`);
    for (const r of roles) if (!PERSON_ROLES.includes(r)) errs.push(`${who}: role "${r}" must be one of ${PERSON_ROLES.join(", ")}`);
    if (p.maintains !== undefined) {
      if (!Array.isArray(p.maintains)) errs.push(`${who}: maintains must be a list of repos`);
      else {
        if (!roles.includes("maintainer")) errs.push(`${who}: maintains is set but maintainer is not one of their roles`);
        for (const r of p.maintains) if (!/^([\w.-]+\/)?[\w.-]+$/.test(String(r))) errs.push(`${who}: "${r}" is not a repo name`);
      }
    }
    if (p.github && !/^[A-Za-z0-9-]{1,39}$/.test(p.github)) errs.push(`${who}: "${p.github}" is not a GitHub login`);
    for (const platform of ["discord", "telegram"] as const) {
      if (p[platform] !== undefined) errs.push(`${who}: move the ${platform} id to config/people.ids.yaml; ids stay out of the repo`);
    }
  }

  // Platform ids live in the git-ignored config/people.ids.yaml, keyed by name.
  const listed = new Set((people.people ?? []).map((p) => p.name));
  for (const [who, ids] of Object.entries(peopleIds)) {
    if (!listed.has(who)) errs.push(`config/people.ids.yaml: "${who}" is not a name in config/people.yaml`);
    for (const platform of ["discord", "telegram"] as const) {
      const id = ids?.[platform];
      if (id === undefined || id === "") continue;
      if (typeof id === "number" && platform === "discord") errs.push(`${who}: quote the Discord id, it is too long to be a number`);
      if (!/^\d{5,20}$/.test(String(id))) errs.push(`${who}: ${platform} id "${id}" should be digits only`);
      const key = `${platform}:${id}`;
      if (seenIds.has(key)) errs.push(`${who}: ${platform} id ${id} is listed twice`);
      seenIds.add(key);
    }
  }
  const names = Object.keys(network.agents);

  for (const n of names) {
    const spec = specs[n];
    if (!spec) errs.push(`agents/${n}.md is missing`);
    else if (spec.phase !== network.agents[n]) errs.push(`${n}: spec phase ${spec.phase} ≠ network.yaml phase ${network.agents[n]}`);
    const m = models.agents[n];
    if (!m) errs.push(`${n}: no entry in models.yaml`);
    else {
      if (!models.tiers[m.default]) errs.push(`${n}: unknown default tier "${m.default}"`);
      if (m.effort !== undefined && !EFFORTS.includes(m.effort)) errs.push(`${n}: effort must be one of ${EFFORTS.join(", ")}`);
      for (const [task, t] of Object.entries(m.tasks ?? {})) {
        if (typeof t !== "object" || !t) errs.push(`${n}.${task}: write a task as { tier, effort }`);
        else {
          if (!models.tiers[t.tier]) errs.push(`${n}.${task}: unknown tier "${t.tier}"`);
          if (t.effort !== undefined && !EFFORTS.includes(t.effort)) errs.push(`${n}.${task}: effort must be one of ${EFFORTS.join(", ")}`);
        }
      }
    }
    const p = permissions.agents[n];
    if (!p) {
      errs.push(`${n}: no entry in permissions.yaml`);
      continue;
    }
    for (const k of p.requestable) if (!permissions.action_kinds[k]) errs.push(`${n}: unknown action kind "${k}"`);
    if (p.networking !== undefined && !["limited", "open"].includes(p.networking)) errs.push(`${n}: networking must be limited or open`);
    // Unrestricted outbound access only where there are no credentials or shell to misuse it.
    const hasMcp = Array.isArray(p.mcp_servers) ? p.mcp_servers.length > 0 : Object.keys(p.mcp_servers).length > 0;
    if (p.networking === "open" && (hasMcp || p.builtin_tools.includes("bash"))) errs.push(`${n}: open networking is only for agents with no MCP servers and no bash`);
    for (const peer of p.reads_memory_of ?? []) {
      if (peer === n) errs.push(`${n}: reads_memory_of cannot name itself`);
      else if (network.agents[peer] === undefined) errs.push(`${n}: reads_memory_of names unknown agent "${peer}"`);
      else if (network.agents[peer] > network.agents[n]) errs.push(`${n}: reads_memory_of "${peer}" starts in phase ${network.agents[peer]}, after ${n}`);
    }
    for (const t of p.builtin_tools) if (!BUILTIN_TOOLS.includes(t)) errs.push(`${n}: unknown built-in tool "${t}"`);
    for (const [server, { mode }] of Object.entries(Array.isArray(p.mcp_servers) ? {} : p.mcp_servers)) {
      if (!mcp.servers[server]) errs.push(`${n}: unknown MCP server "${server}"`);
      if (!mcp.modes[mode]) errs.push(`${n}.${server}: unknown mode "${mode}"`);
    }
  }
  for (const s of Object.keys(specs)) if (!names.includes(s)) errs.push(`agents/${s}.md is not listed in network.yaml`);

  // The Chief of Staff must have no side effects: file tools for her own memory, nothing else (decision 40).
  const ada = permissions.agents.ada;
  if (ada && ((Array.isArray(ada.mcp_servers) ? ada.mcp_servers.length : Object.keys(ada.mcp_servers).length) || ada.builtin_tools.some((t) => !FILE_TOOLS.includes(t)))) {
    errs.push(`ada must have no MCP servers and no built-in tools other than ${FILE_TOOLS.join(", ")}`);
  }
  if (ada && (ada.networking ?? "limited") !== "limited") errs.push("ada must stay on limited networking");

  // Only Ada asks for spec changes; the gateway turns them into Mandla's tasks (decision 51).
  for (const [n, p] of Object.entries(permissions.agents)) {
    if (n !== "ada" && p.requestable.includes("spec.change")) errs.push(`${n}: only ada may request spec.change`);
  }
  // Mandla works in a sandbox on the network's code and holds no credentials (decision 51).
  const mech = permissions.agents.mandla;
  const mechTools = ["read", "write", "edit", "glob", "bash"];
  if (mech && ((Array.isArray(mech.mcp_servers) ? mech.mcp_servers.length : Object.keys(mech.mcp_servers).length) || mech.requestable.length || mech.builtin_tools.some((t) => !mechTools.includes(t)))) {
    errs.push("mandla must have no MCP servers, no requestable kinds, and only read, write, edit, glob and bash");
  }

  const seen = new Set<string>();
  for (const s of schedules.schedules) {
    if (seen.has(s.name)) errs.push(`schedule ${s.name}: duplicate name`);
    seen.add(s.name);
    if (!names.includes(s.agent)) errs.push(`schedule ${s.name}: unknown agent "${s.agent}"`);
    if (s.cron.trim().split(/\s+/).length !== 5) errs.push(`schedule ${s.name}: cron must have 5 fields`);
    const hour = s.cron.trim().split(/\s+/)[1];
    if (/^[123]$/.test(hour)) errs.push(`schedule ${s.name}: avoid 01:00–03:00 local (DST)`);
    if (!(s.budget_usd > 0 && s.budget_usd <= 10)) errs.push(`schedule ${s.name}: budget_usd must be between 0 and 10`);
    if ("tier" in s) errs.push(`schedule ${s.name}: name a task from models.yaml with task:, not a tier`);
    if (s.task !== undefined && !models.agents[s.agent]?.tasks?.[s.task]) errs.push(`schedule ${s.name}: ${s.agent} has no task "${s.task}" in models.yaml`);
  }
  // Mira's extra triage passes run only when something new was opened (decision 65).
  const checks = network.budgets.triage_checks;
  if (checks) {
    const daily = schedules.schedules.find((s) => s.name === TRIAGE_SCHEDULE);
    const after = daily ? cronTime(daily.cron) : null;
    if (!after) errs.push(`budgets.triage_checks needs a ${TRIAGE_SCHEDULE} schedule that runs once a day at a fixed time`);
    if (!(checks.usd > 0 && checks.usd <= 10)) errs.push("budgets.triage_checks: usd must be between 0 and 10");
    let last = after ?? "00:00";
    for (const t of checks.times ?? []) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) errs.push(`budgets.triage_checks: "${t}" should be HH:MM`);
      else if (t <= last) errs.push(`budgets.triage_checks: times must be in order and after the ${TRIAGE_SCHEDULE} run (${after})`);
      else last = t;
    }
  }
  return errs;
}

/** The daily triage pass in schedules.yaml; the gateway's extra passes follow it (decision 65). */
export const TRIAGE_SCHEDULE = "mira-triage";

/** "HH:MM" for a cron that runs once a day at a fixed time ("0 8 * * *"), else null. */
export function cronTime(cron: string): string | null {
  const [min, hour, ...rest] = cron.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(min ?? "") || !/^\d{1,2}$/.test(hour ?? "") || rest.join(" ") !== "* * *") return null;
  return `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
}

/** An agent's default model and effort, and its tasks', for the gateway's own sessions. */
function modelsOf(cfg: ReturnType<typeof loadAll>, n: string) {
  const m = cfg.models.agents[n];
  if (!m) return {};
  const tasks = Object.entries(m.tasks ?? {}).map(([task, t]) => [task, { model: cfg.models.tiers[t.tier], ...(t.effort ? { effort: t.effort } : {}) }]);
  return {
    model: cfg.models.tiers[m.default],
    ...(m.effort ? { effort: m.effort } : {}),
    ...(tasks.length ? { tasks: Object.fromEntries(tasks) } : {}),
  };
}

function triageChecks(cfg: ReturnType<typeof loadAll>) {
  const checks = cfg.network.budgets.triage_checks;
  const daily = cfg.schedules.schedules.find((s) => s.name === TRIAGE_SCHEDULE);
  const after = daily && cronTime(daily.cron);
  if (!checks?.times?.length || !daily || !after) return {};
  return { triage_checks: { after, times: checks.times, budget_cents: Math.round(checks.usd * 100) } };
}

export function compile(cfg = loadAll()) {
  const { network, permissions, specs, people, discord } = cfg;
  return {
    current_phase: network.network.current_phase,
    timezone: network.network.timezone,
    monthly_credit_usd: network.budgets.monthly_credit_usd,
    member_daily_messages: network.budgets.member_daily_messages ?? 20,
    schedules_enabled: network.network.schedules_enabled ?? false,
    follow_up: {
      daily_wakes: network.budgets.follow_up_daily_wakes ?? 5,
      budget_cents: Math.round((network.budgets.follow_up_budget_usd ?? 0.5) * 100),
    },
    ...triageChecks(cfg),
    github_wakes: Object.fromEntries(
      Object.entries(network.budgets.github_wakes ?? {}).map(([trigger, w]) => [trigger, { daily: w.daily, budget_cents: Math.round(w.usd * 100) }]),
    ),
    sandbox_repo: network.github.sandbox_repo,
    network_repo: network.github.network_repo,
    self_improvement: {
      since: network.self_improvement?.since ?? null,
      stale_days: network.self_improvement?.stale_days ?? 30,
      proposal_gap_days: network.self_improvement?.proposal_gap_days ?? 7,
      min_decided: network.self_improvement?.min_decided ?? 10,
      min_days: network.self_improvement?.min_days ?? 14,
      commit_author: network.self_improvement?.commit_author,
      task_cents: {
        small: Math.round((network.budgets.mechanic_small_usd ?? 1) * 100),
        large: Math.round((network.budgets.mechanic_large_usd ?? 5) * 100),
      },
    },
    repos: network.github.repos ?? [],
    action_kinds: permissions.action_kinds,
    discord_approval_max_risk: permissions.discord_approval_max_risk ?? "none",
    approvals_app: permissions.approvals_app ?? "both",
    review_check_required: permissions.review_check_required ?? false,
    review: { ...cfg.review, path_rules: cfg.review.path_rules ?? [] },
    model_tiers: cfg.models.tiers,
    discord_channels: Object.fromEntries(
      Object.entries(discord.channels ?? {}).filter(([, id]) => id !== undefined && id !== null && id !== "").map(([k, id]) => [k, String(id)]),
    ),
    people: (people.people ?? []).map((p) => ({
      name: p.name,
      roles: rolesOf(p.role),
      ...(p.maintains?.length ? { maintains: p.maintains.map((r) => fullRepo(String(r), network.github.org)) } : {}),
      ...(p.github ? { github: p.github } : {}),
    })),
    agents: Object.fromEntries(
      Object.keys(network.agents).map((n) => [
        n,
        {
          name: n,
          title: specs[n].title,
          phase: network.agents[n],
          requestable: permissions.agents[n].requestable,
          ...modelsOf(cfg, n),
        },
      ]),
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadAll();
  const errs = validate(cfg);
  if (errs.length) {
    console.error(`Config invalid:\n- ${errs.join("\n- ")}`);
    process.exit(1);
  }
  if (!process.argv.includes("--check")) {
    const out = join(ROOT, "gateway/src/generated/network.json");
    writeFileSync(out, JSON.stringify(compile(cfg), null, 2) + "\n");
    console.log(`Wrote ${out}`);
  } else {
    console.log("Config valid.");
  }
}
