import { describe, expect, it } from "vitest";
import { messageAgent } from "../src/agents";
import { handleUpdate } from "../src/commands";
import { handleInteraction } from "../src/discordInteractions";
import { schemaProblems } from "../src/schema";
import { TOOLS, toolsForAgent } from "../src/toolDefs";
import { handleTool } from "../src/tools";
import { HEAD, fakeGitHub, makeTestCtx } from "./helpers";

const T = "accordproject/concerto#12";
const JANE_TG = 88;
const JANE_DC = "123456789012345678";
const OWNER_DC = "111111111111111111";

const tg = (from: number, text: string, chat = from) => ({
  update_id: 1,
  message: { message_id: 1, from: { id: from }, chat: { id: chat, type: chat === from ? "private" : "group" }, text },
});
const created = (fakes: { calls: { method: string; args: unknown[] }[] }) =>
  fakes.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as { text: string });
const discord = async (ctx: any, user: string, name: string, options: Record<string, string>) => {
  const pending: Promise<unknown>[] = [];
  const res: any = await handleInteraction(
    ctx,
    { type: 2, token: "tok", member: { user: { id: user } }, data: { name, options: Object.entries(options).map(([name, value]) => ({ name, value })) } },
    (p) => pending.push(p),
  );
  await Promise.all(pending);
  return res;
};

describe("tool schemas", () => {
  it("checks types, required fields, enums, ranges and nested items", () => {
    const schema = TOOLS.request_review_check.input_schema;
    expect(schemaProblems(schema, { target: T, sha: "abc1234", findings: [] })).toEqual([]);
    expect(schemaProblems(schema, { target: 12, findings: [{ severity: "major", area: "tests", summary: "x", line: 1.5 }] })).toEqual([
      "sha is required",
      "target must be a string, not number",
      "findings[0].line must be a whole number, not number",
      "findings[0].severity must be one of blocking, should-fix, nit",
    ]);
    expect(schemaProblems(TOOLS.vimeo_recordings.input_schema, { limit: 80 })).toEqual(["limit must be at most 50"]);
    expect(schemaProblems(TOOLS.report_status.input_schema, "done")).toEqual(["input must be an object, not string"]);
  });

  it("treats null as not given for optional fields, and allows extra fields", () => {
    expect(schemaProblems(TOOLS.submit_review.input_schema, { target: T, summary: "s", findings: [{ severity: "nit", area: "docs", summary: "x", line: null, path: null }], extra: 1 })).toEqual([]);
  });

  it("refuses a malformed call before the handler runs, with every problem listed", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "request_action", { kind: "github.comment", target: T, summary: "s", rationale: "r", risk: "huge" })).rejects.toThrow(
      /Fix the input and call again:\n- risk must be one of low, medium, high/,
    );
    expect(await ctx.db.getDecision("D-1")).toBeNull();
  });

  it("gives each agent the common tools first, then only its own", () => {
    const names = (a: string) => toolsForAgent(a).map((t) => t.name);
    expect(names("ada").slice(0, 3)).toEqual(["request_action", "report_status", "get_decisions"]);
    expect(names("ada")).toContain("assign_task");
    expect(names("mira")).not.toContain("assign_task");
    expect(names("mira")).toContain("submit_review");
    expect(names("rosa")).toEqual(["request_action", "report_status", "get_decisions"]);
    expect(toolsForAgent("otto").every((t) => t.type === "custom" && t.input_schema.type === "object")).toBe(true);
  });

  it("still refuses another agent's tools", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "assign_task", {})).rejects.toThrow(/assign_task is not available to mira/);
  });
});

describe("get_decisions (C-3)", () => {
  const seed = async (ctx: any) => {
    const a = await ctx.db.createDecision({ agent: "mira", kind: "github.comment", target: T, summary: "Comment", rationale: "r", risk: "low", payload: { text: "Thanks" } });
    const b = await ctx.db.createDecision({ agent: "otto", kind: "discord.announce", target: "announcements", summary: "Announce", rationale: "r", risk: "medium", payload: { text: "Hi" } });
    await ctx.db.decide(b.id, "rejected", "Not this week");
    return { a, b };
  };
  const call = async (ctx: any, agent: string, status: string) => JSON.parse(await handleTool(ctx, agent, "s", "get_decisions", { status }));

  it("shows Vera every agent's decisions, with who asked and when", async () => {
    const { ctx } = makeTestCtx();
    const { a, b } = await seed(ctx);
    const all = await call(ctx, "vera", "all");
    expect(all.map((d: any) => [d.id, d.agent, d.status])).toEqual([
      [a.id, "mira", "open"],
      [b.id, "otto", "rejected"],
    ]);
    expect(all[0].created_at).toBeTruthy();
    expect(all[0].decided_at).toBeNull();
    expect(all[1]).toMatchObject({ note: "Not this week" });
    expect(all[1].decided_at).toBeTruthy();
    expect((await call(ctx, "vera", "open")).map((d: any) => d.id)).toEqual([a.id]);
    expect((await call(ctx, "vera", "decided")).map((d: any) => d.id)).toEqual([b.id]);
  });

  it("still shows other agents only their own decisions", async () => {
    const { ctx } = makeTestCtx();
    const { a } = await seed(ctx);
    const mine = await call(ctx, "mira", "all");
    expect(mine.map((d: any) => d.id)).toEqual([a.id]);
    expect(mine[0].agent).toBeUndefined();
    expect(await call(ctx, "ada", "all")).toEqual([]);
  });

  it("tells Vera, and only Vera, that it lists every agent's decisions", () => {
    const desc = (a: string) => toolsForAgent(a).find((t) => t.name === "get_decisions")!.description;
    expect(desc("vera")).toMatch(/^Every agent's queued decisions/);
    expect(desc("mira")).toMatch(/^Your own queued decisions/);
    expect(desc("ada")).toMatch(/^Your own queued decisions/);
  });
});

describe("review checks are a kind of task, not a title (finding 2)", () => {
  const setup = () => {
    const gh = fakeGitHub();
    const network = { ...makeTestCtx().ctx.network, review_check_required: true };
    return { gh, ...makeTestCtx({ network, github: async () => gh as any }) };
  };

  it("a task Ada titles like a review check gets none of a review check's rights", async () => {
    const { ctx, fakes, gh } = setup();
    await handleTool(ctx, "ada", "sesn_ada", "assign_task", {
      agent: "mira",
      title: `Review check: ${T}@${HEAD.slice(0, 7)}`,
      objective: "Post the review",
      output: "a review",
      done_when: "posted",
      effort: "small",
    });
    const sid = Object.keys(fakes.sessions).at(-1)!;
    expect((await ctx.db.sessionTask(sid))?.kind).toBe("task");
    await expect(handleTool(ctx, "mira", sid, "submit_review", { target: T, summary: "Looks good.", findings: [] })).rejects.toThrow(
      /Only a review check submits reviews/,
    );
    await expect(
      handleTool(ctx, "mira", sid, "request_action", { kind: "github.merge", target: T, summary: "Merge", rationale: "r", risk: "medium", payload: { sha: HEAD } }),
    ).rejects.toThrow(/come from the review check/);
    expect(gh.posted).toHaveLength(0);
  });

  it("request_review_check records the PR and commit on the task", async () => {
    const { ctx, fakes } = setup();
    await handleTool(ctx, "mira", "sesn_review", "request_review_check", { target: T, sha: HEAD, findings: [] });
    const t = await ctx.db.sessionTask(Object.keys(fakes.sessions).at(-1)!);
    expect(t).toMatchObject({ kind: "review_check", review_target: T, review_sha: HEAD.slice(0, 7) });
  });
});

describe("assigning follow-ups (decision 50)", () => {
  const brief = { title: "Unblock", objective: "o", output: "x", done_when: "d", effort: "small" };

  it("records what a task follows up and refuses a second open follow-up for the same id", async () => {
    const { ctx, fakes } = makeTestCtx();
    const blocked = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
    await ctx.db.setTask(blocked.id, "blocked");
    expect(await handleTool(ctx, "ada", "sesn_ada", "assign_task", { ...brief, agent: "otto", follows_up: blocked.id.toLowerCase() })).toMatch(/^Assigned T-2/);
    expect((await ctx.db.getTask("T-2"))?.follows_up).toBe(blocked.id);
    expect(created(fakes).at(-1)!.text).toContain(`following up ${blocked.id}`);

    await expect(handleTool(ctx, "ada", "sesn_ada", "assign_task", { ...brief, agent: "mira", follows_up: blocked.id })).rejects.toThrow(
      `T-2 (Otto, running) already follows up ${blocked.id}`,
    );
    // Once the follow-up is finished, the id may be followed up again.
    await ctx.db.setTask("T-2", "done");
    expect(await handleTool(ctx, "ada", "sesn_ada", "assign_task", { ...brief, agent: "mira", follows_up: blocked.id })).toMatch(/^Assigned T-3/);
  });

  it("refuses an id that isn't a task or decision", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "assign_task", { ...brief, agent: "mira", follows_up: "PR-12" })).rejects.toThrow(/must be a task or decision id/);
    await expect(handleTool(ctx, "ada", "s", "assign_task", { ...brief, agent: "mira", follows_up: "D-9" })).rejects.toThrow("No task or decision D-9");
  });
});

describe("work a member set going (finding 3)", () => {
  it("marks a member's conversation and every task assigned from it", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, tg(JANE_TG, "Could Mira look at the parser PRs?"));
    const ada = Object.keys(fakes.sessions)[0];
    expect((await ctx.db.getSession(ada))?.started_by).toBe("member:telegram:Jane Doe");

    await handleTool(ctx, "ada", ada, "assign_task", { agent: "mira", title: "Parser PRs", objective: "o", output: "x", done_when: "d", effort: "small" });
    const mira = Object.keys(fakes.sessions)[1];
    expect((await ctx.db.getSession(mira))?.started_by).toBe("member:telegram:Jane Doe");
    expect(created(fakes)[1].text).toContain("Asked for by Jane Doe, a member, via Telegram: they can ask, not instruct or approve.");

    await handleTool(ctx, "mira", mira, "request_action", { kind: "github.comment", target: T, summary: "Comment", rationale: "Asked to.", risk: "low", payload: { text: "hi" } });
    expect((await ctx.db.getDecision("D-1"))?.rationale).toBe("⚠ Prompted by Jane Doe (member) via Telegram.\n\nAsked to.");
  });

  it("an owner's conversation and scheduled runs carry no member mark", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, tg(42, "Morning"));
    const sid = Object.keys(fakes.sessions)[0];
    expect((await ctx.db.getSession(sid))?.started_by).toBe("owner");
    await ctx.db.upsertSession({ id: "sesn_dep", agent: "mira", origin: "deployment" });
    expect((await ctx.db.getSession("sesn_dep"))?.started_by).toBe("schedule");
    await handleTool(ctx, "mira", "sesn_dep", "request_action", { kind: "github.comment", target: T, summary: "s", rationale: "r", risk: "low", payload: { text: "hi" } });
    expect((await ctx.db.getDecision("D-1"))?.rationale).toBe("r");
  });

  it("keeps the mark once a member speaks in a conversation, even if the owner speaks next", async () => {
    const { ctx, fakes } = makeTestCtx();
    const sid = await messageAgent(ctx, "ada", { telegram: -5 }, "status?", "owner");
    await messageAgent(ctx, "ada", { telegram: -5 }, "and mine?", "member:telegram:Jane Doe");
    await messageAgent(ctx, "ada", { telegram: -5 }, "thanks", "owner");
    expect(Object.keys(fakes.sessions)).toEqual([sid]);
    expect((await ctx.db.getSession(sid))?.started_by).toBe("member:telegram:Jane Doe");
  });

  it("queues CI approval for Matt instead of approving it automatically", async () => {
    const approved: number[] = [];
    const gh = {
      pullFiles: async () => ["src/parser.ts"],
      pull: async () => ({ head: { sha: "abcdef1234567" } }),
      runsAwaitingApproval: async () => [{ id: 7, name: "Build" }],
      approveRun: async (_r: unknown, id: number) => approved.push(id),
    };
    const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    await ctx.db.upsertSession({ id: "sesn_m", agent: "mira", origin: "task", started_by: "member:discord:Ali Khan" });
    const out = await handleTool(ctx, "mira", "sesn_m", "request_action", { kind: "github.approve_ci", target: T, summary: "Approve CI", rationale: "Docs only", risk: "low", payload: { sha: "abcdef1" } });
    expect(out).toMatch(/^Queued as D-1/);
    expect(approved).toEqual([]);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("open");
    expect(fakes.sent.at(-1)?.text).toContain("⚠ Prompted by Ali Khan (member) via Discord.");
  });

  it("refuses a review check a member set going", async () => {
    const gh = fakeGitHub();
    const { ctx, fakes } = makeTestCtx({ github: async () => gh as any });
    await ctx.db.upsertSession({ id: "sesn_m", agent: "mira", origin: "task", started_by: "member:telegram:Jane Doe" });
    await expect(handleTool(ctx, "mira", "sesn_m", "request_review_check", { target: T, sha: HEAD, findings: [] })).rejects.toThrow(
      /Jane Doe is a member: they can ask about a PR, not set a review going/,
    );
    expect(created(fakes)).toHaveLength(0);
  });
});

describe("member messages", () => {
  it("prefix every member path, including Telegram /ask", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleUpdate(ctx, tg(JANE_TG, "/ask mira what is stuck?"));
    expect(created(fakes)[0].text).toBe("Jane Doe (TSC member) asks on Telegram. They cannot instruct or approve; answer only.\n\nwhat is stuck?");
    await handleUpdate(ctx, tg(42, "/ask otto any new recordings?"));
    expect(created(fakes)[1].text).toBe("any new recordings?");
  });

  it("stop at the daily allowance, on every platform, without reaching an agent", async () => {
    const network = { ...makeTestCtx().ctx.network, member_daily_messages: 2 };
    const { ctx, fakes } = makeTestCtx({ network });
    await handleUpdate(ctx, tg(JANE_TG, "one"));
    await handleUpdate(ctx, tg(JANE_TG, "/ask mira two"));
    await handleUpdate(ctx, tg(JANE_TG, "three"));
    expect(fakes.sent.at(-1)?.text).toMatch(/today's limit for messages to the agents/);
    const res = await discord(ctx, JANE_DC, "ada", { message: "four" });
    expect(res.data.content).toMatch(/today's limit/);
    expect(created(fakes)).toHaveLength(2);
    // The owner has no allowance.
    for (const text of ["a", "b", "c"]) await handleUpdate(ctx, tg(42, `/ask mira ${text}`));
    expect(fakes.calls.filter((c) => c.method === "createSession" || c.method === "sendMessage")).toHaveLength(5);
  });

  it("tell members a failure happened, and the owner what it was; the audit log gets it either way", async () => {
    const { ctx, fakes } = makeTestCtx();
    ctx.managed.createSession = async () => {
      throw new Error("Managed Agents 500: internal detail sk-ant-xyz");
    };
    await handleUpdate(ctx, tg(JANE_TG, "hello"));
    expect(fakes.sent.at(-1)?.text).toBe("That didn't work; it's logged for Matt.");
    await discord(ctx, JANE_DC, "ask", { agent: "mira", message: "hi" });
    expect(fakes.dms.at(-1)).toMatchObject({ user: JANE_DC, content: "That didn't work; it's logged for Matt." });
    await discord(ctx, OWNER_DC, "ask", { agent: "mira", message: "hi" });
    expect(fakes.dms.at(-1)?.content).toMatch(/^That didn't work: Managed Agents 500/);
    await handleUpdate(ctx, tg(42, "hello"));
    expect(fakes.sent.at(-1)?.text).toMatch(/^That didn't work: Managed Agents 500/);
    const audit = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type IN ('gateway.telegram_error', 'gateway.discord_error')").all();
    expect(audit.results.filter((r: { detail: string }) => r.detail.includes("internal detail"))).toHaveLength(4);
  });
});

describe("read_audit (decision 47)", () => {
  const sql = (ctx: any, q: string, ...args: unknown[]) => ctx.db.db.prepare(q).bind(...args).run();
  const today = () => new Date().toISOString().slice(0, 10);

  it("sums spend, tokens and models per agent, and lists decisions, actions and denials", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.upsertSession({ id: "s1", agent: "mira", origin: "task", model: "claude-sonnet-5-5" });
    await ctx.db.upsertSession({ id: "s2", agent: "mira", origin: "deployment", model: "claude-opus-5-5" });
    await ctx.db.upsertSession({ id: "s3", agent: "ada", origin: "telegram" });
    await ctx.db.updateSession("s1", "idle:end_turn", 40, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 500, cache_write_tokens: 5 });
    await ctx.db.updateSession("s2", "idle:end_turn", 110, { input_tokens: 300, output_tokens: 60, cache_read_tokens: 0, cache_write_tokens: 0 });
    await ctx.db.updateSession("s3", "idle:end_turn", 7);

    const merge = await ctx.db.createDecision({ agent: "mira", kind: "github.comment", target: T, summary: "s", rationale: "r", risk: "low", payload: {} });
    await ctx.db.decide(merge.id, "approved");
    await ctx.db.markExecuted(merge.id, true, "ok");
    const no = await ctx.db.createDecision({ agent: "mira", kind: "github.merge", target: T, summary: "s", rationale: "r", risk: "medium", payload: {} });
    await ctx.db.decide(no.id, "rejected", "tests are thin");
    await ctx.db.createDecision({ agent: "mira", kind: "tool.confirm", target: "bash", summary: "s", rationale: "r", risk: "high", payload: {} });
    await ctx.db.audit({ agent: "mira", event_type: "agent.mcp_tool_use", tool: "mcp__github__get_pr", permission: "allow" });
    await ctx.db.audit({ agent: "mira", event_type: "agent.tool_use", tool: "bash", permission: "deny", detail: { cmd: "rm" } });
    await ctx.db.audit({ agent: "otto", event_type: "gateway.tool_denied", tool: "read_audit", permission: "deny", detail: "read_audit is not available to otto" });

    const r = JSON.parse(await handleTool(ctx, "vera", "sv", "read_audit", { since: today() }));
    expect(r.agents.mira).toMatchObject({ sessions: 2, cost_cents: 150, input_tokens: 400, output_tokens: 80, cache_read_tokens: 500 });
    expect(r.agents.mira.by_model["claude-opus-5-5"]).toMatchObject({ sessions: 1, cost_cents: 110 });
    expect(r.agents.mira.by_origin.task.cost_cents).toBe(40);
    expect(r.agents.mira.decisions).toEqual({ executed: 1, rejected: 1 });
    expect(r.agents.ada.by_model.unknown.cost_cents).toBe(7);
    expect(r.daily_spend).toEqual([
      { day: today(), agent: "ada", cost_cents: 7 },
      { day: today(), agent: "mira", cost_cents: 150 },
    ]);
    expect(r.rejected).toEqual([{ id: no.id, agent: "mira", kind: "github.merge", target: T, note: "tests are thin" }]);
    expect(r.executed_actions.map((a: { id: string }) => a.id)).toEqual([merge.id]);
    expect(r.denials.map((d: { tool: string }) => d.tool)).toEqual(["bash", "read_audit"]);
    expect(r.tool_calls).toHaveLength(2);
  });

  it("read_audit lists refusals", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.audit({ agent: "vera", event_type: "gateway.tool_refused", tool: "record_evaluation", detail: "agent is required" });
    const r = JSON.parse(await handleTool(ctx, "vera", "sv", "read_audit", { since: today() }));
    expect(r.refusals.length).toBe(1);
    expect(r.refusals[0].tool).toBe("record_evaluation");
  });

  it("gives refusals and denials their audit row id, for audit:n evidence", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.audit({ agent: "mira", event_type: "agent.message" });
    await ctx.db.audit({ agent: "vera", event_type: "gateway.tool_refused", tool: "record_evaluation", detail: "agent is required" });
    await ctx.db.audit({ agent: "otto", event_type: "gateway.tool_denied", tool: "read_audit", permission: "deny", detail: "no" });
    const r = JSON.parse(await handleTool(ctx, "vera", "sv", "read_audit", { since: today() }));
    expect(r.refusals[0].id).toBe(2);
    expect(r.denials[0].id).toBe(3);
  });

  it("leaves out sessions outside the period", async () => {
    const { ctx } = makeTestCtx();
    await ctx.db.upsertSession({ id: "old", agent: "mira", origin: "task" });
    await ctx.db.updateSession("old", "idle:end_turn", 90);
    await sql(ctx, "UPDATE sessions SET created_at = '2026-01-10 12:00:00' WHERE id = 'old'");
    const r = JSON.parse(await handleTool(ctx, "vera", "sv", "read_audit", { since: "2026-01-11", until: "2026-02-01" }));
    expect(r.agents).toEqual({});
    const r2 = JSON.parse(await handleTool(ctx, "vera", "sv", "read_audit", { since: "2026-01-10", until: "2026-01-11" }));
    expect(r2.agents.mira.cost_cents).toBe(90);
  });

  it("is Vera's alone, and refuses bad or overlong periods", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "read_audit", { since: "2026-10-01" })).rejects.toThrow(/not available to ada/);
    await expect(handleTool(ctx, "vera", "s", "read_audit", { since: "last week" })).rejects.toThrow(/must be an ISO date/);
    await expect(handleTool(ctx, "vera", "s", "read_audit", { since: "2026-01-01", until: "2026-06-01" })).rejects.toThrow(/92 days or fewer/);
    await expect(handleTool(ctx, "vera", "s", "read_audit", { since: "2026-02-01", until: "2026-01-01" })).rejects.toThrow(/before until/);
  });

  it("records the model a session was started on", async () => {
    const { ctx } = makeTestCtx();
    const a = await messageAgent(ctx, "mira", { telegram: 42 }, "hi", "owner");
    expect((await ctx.db.getSession(a))?.model).toBe("claude-sonnet-5-5");
    const { startSession } = await import("../src/agents");
    const b = await startSession(ctx, "mira", "check", "task", "owner", { model: { id: "claude-opus-5-5", effort: "high" } });
    expect((await ctx.db.getSession(b))?.model).toBe("claude-opus-5-5");
  });
});
