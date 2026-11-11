import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeployedConfig, NetworkConfig } from "../src/config";
import type { Ctx } from "../src/context";
import { Db } from "../src/db";
import type { Env } from "../src/env";
import type { GitHub, RepoRef } from "../src/github";
import type { DiscordBot } from "../src/discordBot";
import type { ManagedClient } from "../src/managed";
import type { Telegram } from "../src/telegram";

/** Enough of the D1 API, backed by in-memory SQLite, to run the real queries. */
export function memoryD1(): D1Database {
  const sqlite = new Database(":memory:");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url).href);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(dir + f, "utf8"));
  const make = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => make(sql, a),
    first: async () => sqlite.prepare(sql).get(...(args as any[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as any[]));
      return { meta: { changes: r.changes } };
    },
  });
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

export const NETWORK: NetworkConfig = {
  current_phase: 1,
  timezone: "Europe/London",
  monthly_credit_usd: 200,
  sandbox_repo: "accordproject/virtual-agent-org-sandbox",
  network_repo: "accordproject/virtual-agent-org",
  repos: ["accordproject/concerto"],
  action_kinds: {
    "github.merge": { risk: "medium", executor: "github" },
    "github.comment": { risk: "low", executor: "github" },
    "discord.announce": { risk: "medium", executor: "discord" },
    "discord.ops": { risk: "low", executor: "discord_ops" },
    "vimeo.publish": { risk: "medium", executor: "vimeo" },
    "linkedin.post": { risk: "medium", executor: "manual" },
    "github.approve_ci": { risk: "low", executor: "github", auto: true },
    "github.review": { risk: "low", executor: "github", auto: true },
    "spec.change": { risk: "low", executor: "task" },
  },
  discord_approval_max_risk: "medium",
  schedules_enabled: true,
  follow_up: { daily_wakes: 5, budget_cents: 50 },
  self_improvement: {
    since: null,
    stale_days: 30,
    commit_author: { name: "virtual-agent-org-gateway[bot]", email: "1+virtual-agent-org-gateway[bot]@users.noreply.github.com" },
    task_cents: { small: 100, large: 500 },
  },
  model_tiers: { deep: "claude-opus-5-5", standard: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
  people: [
    { name: "Matt Roberts", roles: ["owner"], github: "mttrbrts", telegram: "555" },
    { name: "Jane Doe", roles: ["tsc_member"], github: "janedoe", telegram: "88", discord: "123456789012345678" },
    { name: "Sam Lee", roles: ["tsc_member", "maintainer"], maintains: ["accordproject/concerto"], github: "samlee", telegram: "66" },
    { name: "Ali Khan", roles: ["maintainer"], github: "alikhan", discord: "223456789012345678" },
  ],
  agents: {
    ada: { name: "ada", title: "Chief of Staff", phase: 1, requestable: ["spec.change"] },
    mira: { name: "mira", title: "Maintainer Desk", phase: 1, requestable: ["github.merge", "github.comment", "github.approve_ci", "discord.ops", "linkedin.post"], model: "claude-sonnet-5-5" },
    otto: { name: "otto", title: "Meetings", phase: 1, requestable: ["vimeo.publish", "discord.announce"] },
    mandla: { name: "mandla", title: "Mechanic", phase: 1, requestable: [] },
    rosa: { name: "rosa", title: "Community", phase: 2, requestable: [] },
  },
};

export const DEPLOYED: DeployedConfig = {
  agents: {
    ada: { agent_id: "agent_ada", environment_id: "env_1", vault_ids: [], memory_store_ids: ["mem_ada", "mem_shared"], session_budget_cents: 150 },
    mira: { agent_id: "agent_mira", environment_id: "env_1", vault_ids: ["vlt_mira"], memory_store_ids: ["mem_mira"], session_budget_cents: 100 },
    otto: { agent_id: "agent_otto", environment_id: "env_1", vault_ids: [], memory_store_ids: [], session_budget_cents: 100 },
  },
  deployments: { "mira-triage": { id: "dep_mira", agent: "mira" } },
};

export const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

/** A PR as GitHub describes it, ready to merge unless the test says otherwise. */
export interface FakePr {
  head: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  files: string[];
  additions: number;
  deletions: number;
  author: string;
  association: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: string;
  reviews: { login: string; state: "APPROVED" | "CHANGES_REQUESTED"; association?: string }[];
  unresolved: number;
  rollup: string | null;
  labels: string[];
  /** The repo's own labels. */
  repoLabels: string[];
  runs: { id: number; workflow_id: number; event: string; status: string; conclusion: string | null }[] | null;
  /** The repo's workflow files on the default branch; null makes reading them fail. */
  workflows: { path: string; text: string }[] | null;
}

/** An ordinary CI workflow: fork PRs' CI is safe to approve. */
export const SAFE_WORKFLOW = { path: ".github/workflows/ci.yml", text: "on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n" };

/** A fake GitHub client for the gateway's PR reads and writes. Records reviews and merges. */
export function fakeGitHub(pr: Partial<FakePr> = {}) {
  const p: FakePr = {
    head: HEAD,
    state: "OPEN",
    draft: false,
    files: ["src/parser.ts", "test/parser.test.ts"],
    additions: 30,
    deletions: 10,
    author: "contrib",
    association: "CONTRIBUTOR",
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    reviews: [{ login: "samlee", state: "APPROVED" }],
    unresolved: 0,
    rollup: "SUCCESS",
    labels: [],
    repoLabels: ["ai/kind:bugfix", "ai/kind:docs", "ai/kind:feature", "ai/risk:low", "bug", "dependencies"],
    runs: [{ id: 1, workflow_id: 10, event: "pull_request", status: "completed", conclusion: "success" }],
    workflows: [SAFE_WORKFLOW],
    ...pr,
  };
  const posted: { commit_id: string; body: string; comments: { path: string; line: number; body: string }[] }[] = [];
  const merged: { method: string; sha?: string }[] = [];
  const proposed: [RepoRef, Parameters<GitHub["proposeChange"]>[1]][] = [];
  const gh = {
    pr: p,
    posted,
    merged,
    proposed,
    /** Set to an error message to make proposeChange fail. */
    failPropose: null as string | null,
    rejectInline: false,
    rejectLabels: false,
    prDetail: async () => ({
      state: p.state,
      isDraft: p.draft,
      title: "Fix the parser",
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      headRefOid: p.head,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.files.length,
      mergeable: p.mergeable,
      mergeStateStatus: p.mergeState,
      reviewDecision: p.reviews.some((r) => r.state === "CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : p.reviews.length ? "APPROVED" : "REVIEW_REQUIRED",
      authorAssociation: p.association,
      author: { login: p.author },
      latestOpinionatedReviews: { nodes: p.reviews.map((r) => ({ state: r.state, authorAssociation: r.association ?? "MEMBER", author: { login: r.login } })) },
      reviewThreads: { totalCount: p.unresolved, nodes: Array.from({ length: p.unresolved }, () => ({ isResolved: false })) },
      commits: { nodes: [{ commit: { statusCheckRollup: p.rollup ? { state: p.rollup } : null } }] },
    }),
    pullFiles: async () => p.files,
    workflowFiles: async () => {
      if (!p.workflows) throw new Error("GitHub GraphQL: Resource not accessible by integration");
      return p.workflows;
    },
    runsAt: async () => (p.runs ? p.runs.map((r) => ({ name: `wf${r.workflow_id}`, ...r })) : null),
    /** Open PRs as the queue lists them; tests set it to match a fork's workflow run. */
    openPullsList: [] as { number: number; headRefOid: string }[],
    openPulls: async () => gh.openPullsList,
    issueState: async () => ({ state: p.state === "OPEN" ? "open" : p.state === "MERGED" ? "merged" : "closed", pr: true }),
    pull: async () => ({ head: { sha: p.head, repo: null }, base: { repo: { full_name: "accordproject/concerto" } }, state: p.state === "OPEN" ? "open" : "closed" }),
    createReview: async (_r: unknown, review: (typeof posted)[number]) => {
      if (gh.rejectInline && review.comments.length) throw new Error("GitHub POST /reviews: 422 Line could not be resolved");
      posted.push(review);
      return { html_url: `https://github.com/accordproject/concerto/pull/12#pullrequestreview-${posted.length}` };
    },
    labels: async () => {
      if (gh.rejectLabels) throw new Error("GitHub GET /labels: 403 Resource not accessible by integration");
      return [...p.labels];
    },
    addLabels: async (_r: unknown, names: string[]) => {
      p.labels.push(...names.filter((n) => !p.labels.includes(n)));
    },
    removeLabel: async (_r: unknown, name: string) => {
      p.labels = p.labels.filter((l) => l !== name);
    },
    repoLabels: async () => [...p.repoLabels],
    merge: async (_r: unknown, method: string, sha?: string) => {
      merged.push({ method, sha });
      return { merged: true, sha: "feedface00" };
    },
    proposeChange: async (r: RepoRef, change: Parameters<GitHub["proposeChange"]>[1]) => {
      if (gh.failPropose) throw new Error(gh.failPropose);
      proposed.push([r, change]);
      const number = proposed.length;
      return { html_url: `https://github.com/${r.owner}/${r.repo}/pull/${number}`, number };
    },
  };
  return gh;
}

export interface Fakes {
  sent: { chatId: number; text: string; opts?: unknown }[];
  discord: string[];
  ops: { text: string; ids: string[] }[];
  dms: { user: string; content: string; buttons?: unknown[]; embeds?: { title?: string; description: string }[] }[];
  dcEdits: { channelId: string; messageId: string; content: string; buttons?: unknown[] }[];
  originals: { token: string; content: string; embeds?: { title?: string; description: string }[] }[];
  calls: { method: string; args: unknown[] }[];
  events: Record<string, any[]>;
  sessions: Record<string, any>;
}

export function makeTestCtx(overrides: Partial<Ctx> = {}): { ctx: Ctx; fakes: Fakes } {
  const fakes: Fakes = { sent: [], discord: [], ops: [], dms: [], dcEdits: [], originals: [], calls: [], events: {}, sessions: {} };
  let dmId = 0;
  const dc = {
    dm: async (user: string, p: { content: string; buttons?: unknown[]; embeds?: any[] }) => {
      fakes.dms.push({ user, ...p });
      return { channelId: `dm-${user}`, messageId: `m${++dmId}` };
    },
    edit: async (channelId: string, messageId: string, p: { content: string; buttons?: unknown[] }) => {
      fakes.dcEdits.push({ channelId, messageId, ...p });
    },
    editOriginal: async (token: string, p: string | { content: string; embeds?: any[] }) => {
      fakes.originals.push({ token, ...(typeof p === "string" ? { content: p } : p) });
    },
  } as unknown as DiscordBot;
  let msgId = 100;
  let sesn = 0;
  const tg = {
    send: async (chatId: number, text: string, opts?: unknown) => {
      fakes.sent.push({ chatId, text, opts });
      return ++msgId;
    },
    edit: async () => undefined,
    answerCallback: async () => undefined,
  } as unknown as Telegram;

  const record = (method: string) => async (...args: unknown[]) => {
    fakes.calls.push({ method, args });
    return {};
  };
  const managed = {
    createSession: async (p: unknown) => {
      fakes.calls.push({ method: "createSession", args: [p] });
      const id = `sesn_${++sesn}`;
      fakes.sessions[id] = { id, status: "running" };
      return { id, status: "running" };
    },
    retrieveSession: async (id: string) => fakes.sessions[id],
    listEvents: async (id: string) => fakes.events[id] ?? [],
    sendMessage: record("sendMessage"),
    sendToolResult: record("sendToolResult"),
    sendToolConfirmation: record("sendToolConfirmation"),
    interrupt: record("interrupt"),
    pauseDeployment: record("pauseDeployment"),
    unpauseDeployment: record("unpauseDeployment"),
    archiveVault: record("archiveVault"),
  } as unknown as ManagedClient;

  const env = { OWNER_TELEGRAM_ID: "42", TSC_TELEGRAM_IDS: "77" } as Env;
  const ctx: Ctx = {
    env,
    db: new Db(memoryD1()),
    tg,
    managed,
    network: NETWORK,
    deployed: DEPLOYED,
    ownerChatId: 42,
    github: async () => {
      throw new Error("no github in tests");
    },
    dc,
    ownerDiscordId: "111111111111111111",
    discord: {
      configured: true,
      post: async (text: string) => {
        fakes.discord.push(text);
        return 1;
      },
    },
    discordOps: {
      configured: true,
      post: async (text: string, ids: string[]) => {
        fakes.ops.push({ text, ids });
        return 1;
      },
    },
    vimeo: () => {
      throw new Error("no vimeo in tests");
    },
    dryRun: true,
    ...overrides,
  };
  return { ctx, fakes };
}
