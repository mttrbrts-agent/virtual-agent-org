// Deploys the network to Claude Managed Agents and records the resulting IDs in
// gateway/src/generated/deployed.json (commit that file; it holds no secrets).
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/deploy.ts --dry-run   # print what would change
//   ANTHROPIC_API_KEY=... npx tsx scripts/deploy.ts             # apply
//   ANTHROPIC_API_KEY=... npx tsx scripts/deploy.ts --rotate-credentials
//       # replace each agent's vault with one holding the tokens now in the environment
//
// Only agents whose phase <= network.current_phase are created or updated.
// Idempotent: existing resources are updated in place (agents get a new version).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployedConfig } from "../gateway/src/config";
import { ManagedClient } from "../gateway/src/managed";
import { toolsForAgent } from "../gateway/src/toolDefs";
import { compile, validate } from "./compile";
import { ROOT, loadAll, readText } from "./lib";
import { memorySection, memoryStoreIds } from "./memory";
import { renderContext } from "./repos";

const DRY = process.argv.includes("--dry-run");
const ROTATE = process.argv.includes("--rotate-credentials");
const STATE_PATH = join(ROOT, "gateway/src/generated/deployed.json");
/** Where evaluation/rubric.md goes in the shared memory store; agents/ada.md names the mounted path. */
const RUBRIC_PATH = "/reference/rubric.md";
/** Where skills/pr-review/SKILL.md goes in the shared memory store; Mira's spec and the review check's brief name the mounted path. */
const PR_REVIEW_SKILL_PATH = "/reference/skills/pr-review.md";

interface State extends DeployedConfig {
  environment_id?: string;
  /** Unrestricted outbound access, for agents with `networking: open` (decision 54). */
  open_environment_id?: string;
  shared_memory_store_id?: string;
}

const cfg = loadAll();
const errs = validate(cfg);
if (errs.length) {
  console.error(`Config invalid:\n- ${errs.join("\n- ")}`);
  process.exit(1);
}
const phase = cfg.network.network.current_phase;
const tz = cfg.network.network.timezone;
const state: State = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { agents: {}, deployments: {} };

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey && !DRY) {
  console.error("Set ANTHROPIC_API_KEY (a Claude Console API key with Managed Agents access).");
  process.exit(1);
}
const client = new ManagedClient(apiKey ?? "dry-run");

async function step<T>(label: string, payload: unknown, fn: () => Promise<T>): Promise<T | undefined> {
  if (DRY) {
    console.log(`\n# ${label}\n${JSON.stringify(payload, null, 2).slice(0, 1500)}`);
    return undefined;
  }
  console.log(`- ${label}`);
  return fn();
}

function systemPrompt(agent: string): string {
  const spec = cfg.specs[agent];
  const parts = [readText("agents/_protocol.md"), spec.body];
  if (agent === "vera") {
    parts.push("## Scorecard schema\n\nEvery scorecard you pass to `write_scorecard` must follow this JSON Schema.\n\n```json\n" +
      readText("evaluation/scorecard.schema.json").trim() + "\n```");
  }
  parts.push(memorySection(agent, cfg.permissions.agents[agent].reads_memory_of ?? []));
  parts.push(rosterSection());
  parts.push(`## Your configuration\n\nAgent: ${agent}. Requestable actions: ${cfg.permissions.agents[agent].requestable.join(", ") || "none"}.`);
  return parts.join("\n\n---\n\n");
}

function rosterSection(): string {
  const label: Record<string, string> = { owner: "TSC chair (Matt, the owner)", tsc_member: "TSC member", maintainer: "maintainer" };
  const rows = (compile(cfg).people ?? []).map((p) => {
    const roles = p.roles.map((r) => label[r] ?? r).join(", ");
    return `| ${p.name} | ${p.github ? `@${p.github}` : "—"} | ${roles} | ${p.maintains?.join(", ") || "—"} |`;
  });
  return [
    "## People",
    "",
    "Who's who in the project. Maintainers review and merge: request their review (GitHub's reviewer request,",
    "not an @mention) on PRs in repos they maintain, or from any listed maintainer when a repo has none.",
    "Don't @mention the people below in public text. When one of them needs to know something that shouldn't be public,",
    "request discord.ops with payload {text, mention: [their GitHub logins]}: it posts to the private #agent-ops channel and pings them.",
    "",
    "| Name | GitHub | Roles | Maintains |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function toolsFor(agent: string) {
  const p = cfg.permissions.agents[agent];
  const servers = Array.isArray(p.mcp_servers) ? {} : p.mcp_servers;
  const tools: unknown[] = [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: p.builtin_tools.map((name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } })),
    },
  ];
  const mcpServers: unknown[] = [];
  for (const [name, { mode }] of Object.entries(servers)) {
    const server = cfg.mcp.servers[name];
    if (!server.url) continue; // not configured yet
    mcpServers.push({ type: "url", name, url: server.url });
    tools.push({ type: "mcp_toolset", mcp_server_name: name, default_config: { permission_policy: { type: cfg.mcp.modes[mode] } } });
  }
  tools.push(...toolsForAgent(agent));
  return { tools, mcpServers };
}

async function ensureEnvironment(open: boolean) {
  if (!state.environment_id) {
    const body = {
      name: "virtual-agent-org",
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          // Also limits web_search and web_fetch, which run on Anthropic's servers: search drops
          // results from other hosts and fetch returns url_not_allowed (Managed Agents docs, environments).
          allowed_hosts: ["api.github.com", "github.com", "raw.githubusercontent.com", "mttrbrts.github.io"],
          allow_package_managers: true,
          allow_mcp_servers: true,
        },
      },
    };
    const env = await step("create environment", body, () => client.createEnvironment(body));
    if (env) state.environment_id = env.id;
  }
  // Sage searches the open web, so it gets its own environment; every other agent stays limited.
  if (open && !state.open_environment_id) {
    // VERIFY: the unrestricted networking body (taken from the docs' mode table; no example given).
    const body = { name: "virtual-agent-org-open", config: { type: "cloud", networking: { type: "unrestricted" } } };
    const env = await step("create open environment", body, () => client.createEnvironment(body));
    if (env) state.open_environment_id = env.id;
  }
}

/** context/accord.md with the repos in scope filled in from config/network.yaml. */
function sharedContext(): string {
  const { repos, sandbox_repo } = cfg.network.github;
  return renderContext(readText("context/accord.md"), repos ?? [], sandbox_repo);
}

async function ensureSharedMemory() {
  if (!state.shared_memory_store_id) {
    const store = await step("create shared memory store", {}, () =>
      client.createMemoryStore("virtual-agent-org-shared", "Accord Project shared context (read-only for agents)"),
    );
    if (store) state.shared_memory_store_id = store.id;
  }
  // Creates the file the first time and replaces its content on later deploys.
  if (state.shared_memory_store_id) {
    const r = await step("write /context/accord.md", {}, () =>
      client.upsertMemory(state.shared_memory_store_id!, "/context/accord.md", sharedContext()),
    );
    if (r) console.log(`  ${r.updated ? "updated" : "created"} ${r.id}`);
    // Ada reads the rubric only for the weekly evaluation, so it stays out of her system
    // prompt, which every one of her sessions pays for (decision 65).
    const rubric = await step(`write ${RUBRIC_PATH}`, {}, () =>
      client.upsertMemory(state.shared_memory_store_id!, RUBRIC_PATH, readText("evaluation/rubric.md")),
    );
    if (rubric) console.log(`  ${rubric.updated ? "updated" : "created"} ${rubric.id}`);
    // Mira's review method: read at the start of each review, so triage passes don't pay for it.
    const skill = await step(`write ${PR_REVIEW_SKILL_PATH}`, {}, () =>
      client.upsertMemory(state.shared_memory_store_id!, PR_REVIEW_SKILL_PATH, readText("skills/pr-review/SKILL.md")),
    );
    if (skill) console.log(`  ${skill.updated ? "updated" : "created"} ${skill.id}`);
  }
}

async function ensureAgent(agent: string) {
  const existing = state.agents[agent];
  const m = cfg.models.agents[agent];
  const model = modelObject(m.default, m.effort);
  const { tools, mcpServers } = toolsFor(agent);
  const body = {
    name: `${agent}-virtual-agent-org`,
    description: `${cfg.specs[agent].title} in the Accord Project virtual agent org`,
    model,
    system: systemPrompt(agent),
    tools,
    mcp_servers: mcpServers,
    metadata: { network: "virtual-agent-org", role: agent },
  };

  // Own memory store and vault, created once.
  let memory = existing?.memory_store_ids?.[0];
  if (!memory) {
    const m = await step(`create memory store for ${agent}`, {}, () =>
      client.createMemoryStore(`${agent}-memory`, `${agent}'s working notes`),
    );
    memory = m?.id;
  }
  let vault = existing?.vault_ids?.[0];
  const servers = Array.isArray(cfg.permissions.agents[agent].mcp_servers) ? {} : cfg.permissions.agents[agent].mcp_servers;
  const needsVault = Object.keys(servers).some((s) => cfg.mcp.servers[s].url);

  // --rotate-credentials: replace the agent's vault with a new one holding the
  // tokens now in the environment. Refuses if a token is missing, so an agent is
  // never left without a credential it had.
  if (vault && ROTATE) {
    const missing = Object.keys(servers)
      .filter((s) => cfg.mcp.servers[s].url)
      .map((s) => cfg.mcp.servers[s].token_env.replace("<AGENT>", agent.toUpperCase()))
      .filter((env) => !process.env[env]);
    if (missing.length) throw new Error(`Cannot rotate ${agent}: set ${missing.join(", ")} first`);
    const old = vault;
    await step(`archive ${agent}'s old vault ${old}`, { vault: old }, () => client.archiveVault(old));
    vault = undefined;
  }
  if (!vault && needsVault) {
    const v = await step(`create vault for ${agent}`, {}, () => client.createVault(`${agent}-vault`, { role: agent }));
    vault = v?.id;
    for (const name of Object.keys(servers)) {
      const server = cfg.mcp.servers[name];
      const envName = server.token_env.replace("<AGENT>", agent.toUpperCase());
      const token = process.env[envName];
      if (!server.url) continue;
      if (!token) {
        console.warn(`  ${envName} not set: ${agent} has no ${name} credential yet`);
        continue;
      }
      await step(`add ${name} credential to ${agent}'s vault`, { mcp_server_url: server.url }, () =>
        client.addVaultCredential(vault!, {
          display_name: `${agent}-${name}`,
          auth: { type: "static_bearer", mcp_server_url: server.url, token },
        }),
      );
    }
  }

  const saved = existing?.agent_id
    ? await step(`update agent ${agent}`, body, () => client.updateAgent(existing.agent_id, body))
    : await step(`create agent ${agent}`, body, () => client.createAgent(body));

  const environment = cfg.permissions.agents[agent].networking === "open" ? state.open_environment_id : state.environment_id;
  if (saved && environment) {
    state.agents[agent] = {
      agent_id: saved.id,
      environment_id: environment,
      vault_ids: vault ? [vault] : [],
      memory_store_ids: [memory, state.shared_memory_store_id].filter(Boolean) as string[],
      session_budget_cents: agent === "ada" ? 150 : 100,
    };
  }
}

/**
 * Adds peer stores (`reads_memory_of`) after each agent's own and the shared one. Runs once
 * every agent exists, since a peer may be created later in the same deploy.
 */
function linkPeerStores(agents: string[]) {
  for (const a of agents) {
    const reads = cfg.permissions.agents[a].reads_memory_of ?? [];
    const dep = state.agents[a];
    if (!reads.length) continue;
    const byAgent = Object.fromEntries(reads.map((peer) => [peer, state.agents[peer]?.memory_store_ids?.[0]]));
    const { ids, missing } = memoryStoreIds(reads, { own: dep?.memory_store_ids?.[0], shared: state.shared_memory_store_id, byAgent });
    for (const peer of missing) console.warn(`  ${a} reads ${peer}'s store, but ${peer} has none yet; deploy again once it does`);
    if (DRY) console.log(`\n# link memory stores for ${a}\n${JSON.stringify({ reads, ids })}`);
    else if (dep) dep.memory_store_ids = ids;
  }
}

/** The agent's `model`: the tier's model id, with an effort level when models.yaml sets one (decision 65). */
function modelObject(tier: string, effort?: string): { id: string; effort?: string } {
  return { id: cfg.models.tiers[tier], ...(effort ? { effort } : {}) };
}

async function ensureDeployment(s: (typeof cfg.schedules.schedules)[number]) {
  const dep = state.agents[s.agent];
  if (!dep && !DRY) return;
  // A task's override replaces the agent's model object in full, effort included.
  const task = s.task ? cfg.models.agents[s.agent].tasks![s.task] : undefined;
  const id = dep?.agent_id ?? `<${s.agent}>`;
  const body = {
    name: s.name,
    agent: task ? { type: "agent_with_overrides", id, model: modelObject(task.tier, task.effort) } : id, // VERIFY overrides on deployments
    environment_id: dep?.environment_id ?? state.environment_id,
    schedule: { type: "cron", expression: s.cron, timezone: tz },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: s.prompt.trim() }] }],
    budget: { type: "limit", max_list_cost: { amount: String(Math.round(s.budget_usd * 100)), currency: "USD" } },
    // VERIFY: field names for deployment resources (assumed to match sessions).
    vault_ids: dep?.vault_ids ?? [],
    resources: (dep?.memory_store_ids ?? []).map((id, i) => ({
      type: "memory_store",
      memory_store_id: id,
      access: i === 0 ? "read_write" : "read_only",
    })),
  };
  const existing = state.deployments[s.name];
  const saved = existing
    ? await step(`update deployment ${s.name}`, body, () => client.updateDeployment(existing.id, body))
    : await step(`create deployment ${s.name}`, body, () => client.createDeployment(body));
  if (saved) state.deployments[s.name] = { id: saved.id, agent: s.agent };
}

async function main() {
  writeFileSync(join(ROOT, "gateway/src/generated/network.json"), JSON.stringify(compile(cfg), null, 2) + "\n");
  console.log(`Deploying phase ${phase}${DRY ? " (dry run)" : ""}`);

  const agents = Object.entries(cfg.network.agents)
    .filter(([, p]) => p <= phase)
    .map(([n]) => n);
  if (!agents.length) {
    console.log("No agents are in scope for this phase. Raise network.current_phase to deploy.");
    return;
  }
  await ensureEnvironment(agents.some((a) => cfg.permissions.agents[a].networking === "open"));
  await ensureSharedMemory();
  for (const a of agents) await ensureAgent(a);
  linkPeerStores(agents);
  if (cfg.network.network.schedules_enabled) {
    for (const s of cfg.schedules.schedules.filter((s) => agents.includes(s.agent))) await ensureDeployment(s);
  } else {
    console.log("Schedules are off (network.schedules_enabled: false); no scheduled deployments created.");
  }

  if (!DRY) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    console.log(`\nWrote ${STATE_PATH}. Commit it, then run: npm run gateway:deploy`);
  }
}

main().catch((e) => {
  // Save partial progress so a re-run updates rather than duplicates.
  if (!DRY) writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.error(e);
  process.exit(1);
});
