import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, validate } from "./compile";
import { loadAll } from "./lib";

const withPeople = (people: object[], peopleIds: object) => ({ ...loadAll(), people: { people }, peopleIds }) as ReturnType<typeof loadAll>;

test("validate keeps platform ids out of people.yaml", () => {
  const errs = validate(withPeople([{ name: "Kim Park", role: "maintainer", discord: "323456789012345678" }], {}));
  assert.ok(errs.includes("Kim Park: move the discord id to config/people.ids.yaml; ids stay out of the repo"));
});

test("validate checks people.ids.yaml names and ids", () => {
  const errs = validate(withPeople([{ name: "Kim Park", role: "maintainer" }], { "Kim Park": { telegram: "12ab" }, "Nobody": { discord: "323456789012345678" } }));
  assert.ok(errs.includes('Kim Park: telegram id "12ab" should be digits only'));
  assert.ok(errs.includes('config/people.ids.yaml: "Nobody" is not a name in config/people.yaml'));
});

test("compile leaves platform ids out of network.json", () => {
  const out = compile(withPeople([{ name: "Kim Park", role: "maintainer", github: "kimpark" }], { "Kim Park": { discord: "323456789012345678" } }));
  assert.deepEqual(out.people, [{ name: "Kim Park", roles: ["maintainer"], github: "kimpark" }]);
});

test("validate allows auto only for the kinds the gateway checks itself", () => {
  const cfg = loadAll();
  const permissions = { ...cfg.permissions, action_kinds: { ...cfg.permissions.action_kinds, "github.merge": { risk: "medium" as const, executor: "github" as const, auto: true } } };
  assert.ok(validate({ ...cfg, permissions }).includes("action kind github.merge: auto is only allowed for github.approve_ci and github.review"));
  assert.deepEqual(validate(cfg), []);
});

test("validate checks review.yaml", () => {
  const cfg = loadAll();
  const review = { ...cfg.review, max_nits: -1, tone: { ...cfg.review.tone, first_time: "chirpy" }, risk: { ...cfg.review.risk, low_max_lines: 900 }, path_rules: [{ glob: "", note: "x" }] };
  const errs = validate({ ...cfg, review });
  assert.ok(errs.includes("review.yaml: max_nits must be a whole number from 0 to 50"));
  assert.ok(errs.includes("review.yaml: tone.first_time must be one of welcoming, neutral, terse"));
  assert.ok(errs.includes("review.yaml: risk.low_max_lines must not exceed risk.high_over_lines"));
  assert.ok(errs.includes("review.yaml: path_rules[0] needs a glob and a note"));
});

test("compile passes the review settings to the gateway", () => {
  const out = compile(loadAll());
  assert.equal(out.review.max_nits, 3);
  assert.ok(out.review.risk.high_paths.includes(".github/**"));
  assert.ok(out.action_kinds["github.review"].auto);
});

test("validate lets ada have file tools for her memory and nothing else", () => {
  const cfg = loadAll();
  const withAda = (builtin_tools: string[], mcp_servers: object = []) =>
    validate({ ...cfg, permissions: { ...cfg.permissions, agents: { ...cfg.permissions.agents, ada: { ...cfg.permissions.agents.ada, builtin_tools, mcp_servers } } } } as typeof cfg);
  const err = "ada must have no MCP servers and no built-in tools other than read, write, edit, glob";
  assert.ok(!withAda(["read", "write", "edit", "glob"]).includes(err));
  assert.ok(withAda(["read", "bash"]).includes(err));
  assert.ok(withAda(["web_fetch"]).includes(err));
  assert.ok(withAda([], { github: { mode: "read" } }).includes(err));
});

test("validate checks reads_memory_of", () => {
  const cfg = loadAll();
  const ottoReads = (reads_memory_of: string[]) =>
    validate({ ...cfg, permissions: { ...cfg.permissions, agents: { ...cfg.permissions.agents, otto: { ...cfg.permissions.agents.otto, reads_memory_of } } } });
  assert.ok(ottoReads(["nobody"]).includes('otto: reads_memory_of names unknown agent "nobody"'));
  assert.ok(ottoReads(["otto"]).includes("otto: reads_memory_of cannot name itself"));
  assert.ok(ottoReads(["kit"]).includes('otto: reads_memory_of "kit" starts in phase 3, after otto'));
  assert.ok(!ottoReads(["mira"]).some((e) => e.includes("reads_memory_of")));
});

test("validate checks networking", () => {
  const cfg = loadAll();
  const withNet = (agent: string, networking: string) =>
    validate({ ...cfg, permissions: { ...cfg.permissions, agents: { ...cfg.permissions.agents, [agent]: { ...cfg.permissions.agents[agent], networking } } } } as typeof cfg);
  assert.ok(withNet("sage", "wide").includes("sage: networking must be limited or open"));
  assert.ok(withNet("ada", "open").includes("ada must stay on limited networking"));
  assert.ok(!withNet("sage", "open").some((e) => e.includes("networking")));
  assert.ok(withNet("vera", "open").includes("vera: open networking is only for agents with no MCP servers and no bash"));
  assert.ok(withNet("mira", "open").includes("mira: open networking is only for agents with no MCP servers and no bash"));
});

test("compile carries the member message allowance, and validate checks it", () => {
  const cfg = loadAll();
  assert.equal(compile(cfg).member_daily_messages, 20);
  const network = { ...cfg.network, budgets: { ...cfg.network.budgets, member_daily_messages: 2.5 } };
  assert.ok(validate({ ...cfg, network }).includes("network.yaml: budgets.member_daily_messages must be a whole number, 0 or more"));
});

test("compile carries the follow-up wake limits and the schedules switch, and validate checks them", () => {
  const cfg = loadAll();
  const out = compile(cfg);
  assert.deepEqual(out.follow_up, { daily_wakes: 5, budget_cents: 50 });
  assert.equal(out.schedules_enabled, cfg.network.network.schedules_enabled ?? false);
  const bad = (budgets: object) => validate({ ...cfg, network: { ...cfg.network, budgets: { ...cfg.network.budgets, ...budgets } } });
  assert.ok(bad({ follow_up_daily_wakes: -1 }).includes("network.yaml: budgets.follow_up_daily_wakes must be a whole number from 0 to 50"));
  assert.ok(bad({ follow_up_daily_wakes: 1.5 }).includes("network.yaml: budgets.follow_up_daily_wakes must be a whole number from 0 to 50"));
  assert.ok(bad({ follow_up_budget_usd: 0 }).includes("network.yaml: budgets.follow_up_budget_usd must be more than 0 and at most 3"));
  assert.ok(bad({ follow_up_budget_usd: 5 }).includes("network.yaml: budgets.follow_up_budget_usd must be more than 0 and at most 3"));
  assert.deepEqual(bad({ follow_up_daily_wakes: 0, follow_up_budget_usd: 0.25 }), validate(cfg));
});

test("compile carries the GitHub wake caps and budgets, and validate checks them", () => {
  const cfg = loadAll();
  assert.deepEqual(compile(cfg).github_wakes, {
    review: { daily: 6, budget_cents: 100 },
    merge: { daily: 6, budget_cents: 50 },
    first_response: { daily: 10, budget_cents: 50 },
  });
  const bad = (github_wakes: object) => validate({ ...cfg, network: { ...cfg.network, budgets: { ...cfg.network.budgets, github_wakes } } });
  assert.ok(bad({ release: { daily: 1, usd: 1 } }).includes("network.yaml: budgets.github_wakes.release: unknown trigger; use review, merge, first_response"));
  assert.ok(bad({ review: { daily: -1, usd: 1 } }).includes("network.yaml: budgets.github_wakes.review.daily must be a whole number from 0 to 50"));
  assert.ok(bad({ merge: { daily: 2, usd: 4 } }).includes("network.yaml: budgets.github_wakes.merge.usd must be more than 0 and at most 3"));
  assert.deepEqual(bad({ review: { daily: 0, usd: 1 } }), validate(cfg));
});

test("validate keeps the network repo out of repos and the sandbox", () => {
  const cfg = loadAll();
  const repo = cfg.network.github.network_repo;
  const withRepos = (repos: string[], sandbox_repo = cfg.network.github.sandbox_repo) =>
    validate({ ...cfg, network: { ...cfg.network, github: { ...cfg.network.github, repos, sandbox_repo } } });
  const err = `github.repos: ${repo} is the network's own repo (decision 51)`;
  assert.ok(withRepos([...cfg.network.github.repos, repo]).includes(err));
  assert.ok(withRepos(cfg.network.github.repos, repo).includes(`github.sandbox_repo: ${repo} is the network's own repo (decision 51)`));
  const sandbox = cfg.network.github.sandbox_repo;
  assert.ok(withRepos([...cfg.network.github.repos, sandbox]).includes(`github.repos: ${sandbox} is the sandbox repo, not a repo in scope (decision 51)`));
});

test("validate lets only ada request spec.change", () => {
  const cfg = loadAll();
  const mira = cfg.permissions.agents.mira;
  const permissions = { ...cfg.permissions, agents: { ...cfg.permissions.agents, mira: { ...mira, requestable: [...mira.requestable, "spec.change"] } } };
  assert.ok(validate({ ...cfg, permissions }).includes("mira: only ada may request spec.change"));
});

test("validate keeps Mandla without credentials", () => {
  const cfg = loadAll();
  const err = "mandla must have no MCP servers, no requestable kinds, and only read, write, edit, glob and bash";
  const withMandla = (patch: object) =>
    validate({ ...cfg, permissions: { ...cfg.permissions, agents: { ...cfg.permissions.agents, mandla: { ...cfg.permissions.agents.mandla, ...patch } } } } as typeof cfg);
  assert.ok(!validate(cfg).includes(err));
  assert.ok(withMandla({ mcp_servers: { github: { mode: "read" } } }).includes(err));
  assert.ok(withMandla({ requestable: ["other"] }).includes(err));
  assert.ok(withMandla({ builtin_tools: ["read", "web_fetch"] }).includes(err));
});

test("validate checks self_improvement", () => {
  const cfg = loadAll();
  const si = (patch: object) => validate({ ...cfg, network: { ...cfg.network, self_improvement: { ...cfg.network.self_improvement!, ...patch } } });
  assert.ok(si({ since: "soon" }).includes("self_improvement.since must be an ISO date or null"));
  assert.ok(!si({ since: "2026-11-10" }).includes("self_improvement.since must be an ISO date or null"));
  assert.ok(si({ stale_days: 0 }).includes("self_improvement.stale_days must be a whole number from 1 to 365"));
  assert.ok(si({ proposal_gap_days: -1 }).includes("self_improvement.proposal_gap_days must be a whole number from 0 to 30"));
  assert.ok(si({ min_decided: 1.5 }).includes("self_improvement.min_decided must be a whole number from 0 to 100"));
  assert.ok(si({ min_days: 61 }).includes("self_improvement.min_days must be a whole number from 0 to 60"));
  assert.ok(!si({ proposal_gap_days: 0, min_decided: 0, min_days: 0 }).some((e) => e.includes("whole number from 0")));
  const bad = (budgets: object) => validate({ ...cfg, network: { ...cfg.network, budgets: { ...cfg.network.budgets, ...budgets } } });
  assert.ok(bad({ mechanic_small_usd: 0 }).includes("network.yaml: budgets.mechanic_small_usd must be more than 0 and at most 10"));
  assert.ok(bad({ mechanic_large_usd: 11 }).includes("network.yaml: budgets.mechanic_large_usd must be more than 0 and at most 10"));
});

test("validate refuses the placeholder commit email once the loop is on", () => {
  const cfg = loadAll();
  const si = (patch: object) => validate({ ...cfg, network: { ...cfg.network, self_improvement: { ...cfg.network.self_improvement!, ...patch } } });
  const err = "self_improvement.commit_author.email is still a placeholder: set the App's bot email before switching the loop on";
  const placeholder = { name: "virtual-agent-org-gateway[bot]", email: "<app bot id>+virtual-agent-org-gateway[bot]@users.noreply.github.com" };
  assert.ok(!si({ since: null, commit_author: placeholder }).includes(err));
  assert.ok(si({ since: "2026-11-10", commit_author: placeholder }).includes(err));
  assert.ok(!si({ since: "2026-11-10", commit_author: { ...placeholder, email: "123456+virtual-agent-org-gateway[bot]@users.noreply.github.com" } }).includes(err));
});

test("compile emits the loop settings", () => {
  const all = loadAll();
  const out = compile(all);
  assert.deepEqual(out.self_improvement.task_cents, { small: 100, large: 500 });
  assert.equal(out.self_improvement.since, all.network.self_improvement?.since ?? null);
  const { proposal_gap_days, min_decided, min_days } = out.self_improvement;
  assert.deepEqual([proposal_gap_days, min_decided, min_days], [all.network.self_improvement?.proposal_gap_days ?? 7, all.network.self_improvement?.min_decided ?? 10, all.network.self_improvement?.min_days ?? 14]);
  assert.equal(out.network_repo, "accordproject/virtual-agent-org");
  assert.equal(out.agents.mandla.requestable.length, 0);
});
