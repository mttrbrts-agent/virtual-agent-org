import { describe, expect, it } from "vitest";
import { approve, markDone, reject, stop } from "../src/controls";
import { handleTool, ToolError } from "../src/tools";
import { fakeGitHub, makeTestCtx } from "./helpers";

describe("request_action", () => {
  it("refuses kinds the agent may not request", async () => {
    const { ctx } = makeTestCtx();
    await expect(
      handleTool(ctx, "mira", "sesn_x", "request_action", {
        kind: "github.release", target: "a/b#1", summary: "s", rationale: "r", risk: "low",
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("queues, raises risk to the kind's floor, sends a card, and never blocks", async () => {
    const { ctx, fakes } = makeTestCtx();
    const out = await handleTool(ctx, "mira", "sesn_x", "request_action", {
      kind: "linkedin.post", target: "accordproject/virtual-agent-org-sandbox#3", summary: "Merge docs fix", rationale: "CI green", risk: "low",
    });
    expect(out).toMatch(/^Queued as D-1\./);
    const d = await ctx.db.getDecision("D-1");
    expect(d?.risk).toBe("medium");
    expect(fakes.sent[0].text).toContain("D-1 · Mira · linkedin.post");
  });
});

describe("tool ownership and controls", () => {
  it("keeps Ada's tools for Ada", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "mira", "s", "send_to_matt", { text: "hi" })).rejects.toThrow(/not available to mira/);
  });

  it("refuses to assign to an agent from a later phase", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "rosa", title: "t", objective: "o", output: "x", done_when: "d", effort: "small" })).rejects.toThrow(/phase 2/);
  });

  it("assigns a task by starting a session for the agent", async () => {
    const { ctx, fakes } = makeTestCtx();
    const out = await handleTool(ctx, "ada", "s", "assign_task", {
      agent: "mira",
      title: "Triage",
      objective: "Clear the sandbox queue",
      output: "a status report",
      done_when: "every open PR has a response",
      boundaries: "sandbox only",
      effort: "small",
    });
    expect(out).toBe("Assigned T-1 to Mira (small effort, $0.30 cap).");
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.agentId).toBe("agent_mira");
    expect(create.budgetCents).toBe(30);
    expect(create.text).toContain("Task T-1");
    expect(create.text).toContain("Done when: every open PR has a response");
    expect(create.text).toContain("Out of scope: sandbox only");
    expect(create.text).toMatch(/Aim for about 10 tool calls/);
    expect((await ctx.db.openTasks("mira"))[0].status).toBe("running");
  });

  it("stop interrupts sessions, rejects open decisions, and blocks further tool use", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_live", agent: "mira", origin: "deployment" });
    await handleTool(ctx, "mira", "sesn_live", "request_action", {
      kind: "github.comment", target: "accordproject/virtual-agent-org-sandbox#1", summary: "s", rationale: "r", risk: "low", payload: { text: "t" },
    });
    const msg = await stop(ctx, "mira");
    expect(msg).toContain("1 session(s) interrupted, 1 open decision(s) rejected");
    expect(fakes.calls.some((c) => c.method === "pauseDeployment" && c.args[0] === "dep_mira")).toBe(true);
    await expect(handleTool(ctx, "mira", "sesn_live", "report_status", { done: [], doing: [], blocked: [] })).rejects.toThrow(
      /stopped/,
    );
  });
});

describe("approvals", () => {
  const queue = async (ctx: any, kind: string, target: string, payload = {}) =>
    handleTool(ctx, kind === "vimeo.publish" ? "otto" : "mira", "s", "request_action", {
      kind, target, summary: "s", rationale: "r", risk: "low", payload,
    });

  it("executes GitHub actions in dry run only for in-scope repos", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "github.comment", "accordproject/virtual-agent-org-sandbox#3", { text: "Thanks!" });
    expect(await approve(ctx, "D-1")).toContain("DRY RUN");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
    expect(await approve(ctx, "D-1")).toBe("D-1 is not open.");

    // Out-of-scope targets are refused when requested, so nothing reaches the queue.
    await expect(queue(ctx, "github.comment", "someone/else#1", { text: "Thanks!" })).rejects.toThrow(/not in the configured repos/);
    expect(await ctx.db.getDecision("D-2")).toBeNull();
  });

  it("hands manual actions back to the owner until marked done", async () => {
    const { ctx } = makeTestCtx();
    await queue(ctx, "linkedin.post", "linkedin", { text: "Post text" });
    expect(await approve(ctx, "D-1")).toContain("Mark done");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("approved");
    await markDone(ctx, "D-1");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it("denies a paused tool call on rejection, then accepts a later note", async () => {
    const { ctx, fakes } = makeTestCtx();
    const d = await ctx.db.createDecision({
      agent: "mira", kind: "tool.confirm", target: "mcp__github__push", summary: "s", rationale: "r", risk: "high",
      session_id: "sesn_9", tool_use_id: "evt_9",
    });
    await reject(ctx, d.id);
    const conf = fakes.calls.find((c) => c.method === "sendToolConfirmation")!;
    expect(conf.args.slice(0, 3)).toEqual(["sesn_9", "evt_9", false]);
    expect(await reject(ctx, d.id, "Use a fork")).toBe(`Note added to ${d.id}.`);
    expect((await ctx.db.getDecision(d.id))?.note).toBe("Use a fork");
  });
});

describe("Ada deciding for Matt (decision 52)", () => {
  const T = "accordproject/concerto#12";
  const decide = (ctx: any, id: string, outcome: string, note = "n", session = "sesn_ada") =>
    handleTool(ctx, "ada", session, "decide_action", { id, outcome, note });
  const ciRequest = (ctx: any, risk = "low") =>
    handleTool(ctx, "mira", "sesn_m", "request_action", { kind: "github.approve_ci", target: T, summary: "Approve CI", rationale: "Read the diff: parser fix only", risk, payload: { sha: "abcdef1" } });
  const ciCtx = (files = ["src/parser.ts"]) => {
    const approved: number[] = [];
    const gh = {
      ...fakeGitHub({ files }),
      pull: async () => ({ head: { sha: "abcdef1234567" } }),
      runsAwaitingApproval: async () => [{ id: 7, name: "Build" }],
      approveRun: async (_r: unknown, id: number) => approved.push(id),
    };
    const t = makeTestCtx({ dryRun: false, github: async () => gh as any });
    return { ...t, approved };
  };

  it("marks done an approved decision waiting to be carried out, and nothing else", async () => {
    const { ctx } = makeTestCtx();
    await handleTool(ctx, "mira", "s", "request_action", { kind: "linkedin.post", target: "linkedin", summary: "s", rationale: "r", risk: "low", payload: { text: "Post" } });
    await expect(decide(ctx, "D-1", "done")).rejects.toThrow(/D-1 is open: you can mark done only an approved decision/);
    await approve(ctx, "D-1");
    expect(await decide(ctx, "D-1", "done", "Matt posted it on 2 Nov")).toBe('D-1 done. Report it under "Decided for you".');
    expect(await ctx.db.getDecision("D-1")).toMatchObject({ status: "executed", result: "Decided by Ada: Matt posted it on 2 Nov" });
  });

  it("rejects an open decision only when the same agent has since superseded it for the same target", async () => {
    const { ctx } = makeTestCtx();
    const comment = (target: string) =>
      handleTool(ctx, "mira", "s", "request_action", { kind: "github.comment", target, summary: "s", rationale: "r", risk: "low", payload: { text: "t" } });
    await comment(T);
    await comment("accordproject/concerto#13");
    await expect(decide(ctx, "D-1", "rejected")).rejects.toThrow(/no later decision from Mira for accordproject\/concerto#12/);
    await comment(T);
    expect(await decide(ctx, "D-1", "rejected", "D-3 has the corrected text")).toMatch(/^D-1 rejected/);
    expect(await ctx.db.getDecision("D-1")).toMatchObject({ status: "rejected", note: "Superseded by D-3. Decided by Ada: D-3 has the corrected text" });
    await expect(decide(ctx, "D-3", "rejected")).rejects.toThrow(/isn't superseded/);
  });

  it("approves a low-risk CI approval after the gateway's own checks, and runs it", async () => {
    const { ctx, approved } = ciCtx();
    await ctx.db.upsertSession({ id: "sesn_m", agent: "mira", origin: "task", started_by: "member:discord:Ali Khan" });
    await ciRequest(ctx);
    expect((await ctx.db.getDecision("D-1"))?.risk).toBe("low");
    expect(await decide(ctx, "D-1", "approved", "Mira read the diff: parser fix only")).toMatch(/^D-1 approved: /);
    expect(approved).toEqual([7]);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it("leaves to Matt CI approvals that are high risk or now touch CI files, and every other kind", async () => {
    const { ctx, approved } = ciCtx(["src/parser.ts", "package.json"]);
    await ctx.db.upsertSession({ id: "sesn_m", agent: "mira", origin: "task", started_by: "member:discord:Ali Khan" });
    await ciRequest(ctx);
    await expect(decide(ctx, "D-1", "approved")).rejects.toThrow(/put D-1 to Matt:\n- the PR changes package.json/);
    await ciRequest(ctx, "high");
    await expect(decide(ctx, "D-2", "approved")).rejects.toThrow(/high-risk github.approve_ci/);
    await handleTool(ctx, "mira", "s", "request_action", { kind: "github.comment", target: T, summary: "s", rationale: "r", risk: "low", payload: { text: "t" } });
    await expect(decide(ctx, "D-3", "approved")).rejects.toThrow(/low-risk github.comment: you may approve only/);
    expect(approved).toEqual([]);
    expect((await ctx.db.listDecisions({ status: "open" })).map((d) => d.id)).toEqual(["D-1", "D-2", "D-3"]);
  });

  it("decides nothing in a member's conversation, nor paused tool calls, and is Ada's alone", async () => {
    const { ctx } = makeTestCtx();
    const d = await ctx.db.createDecision({ agent: "mira", kind: "tool.confirm", target: "bash", summary: "s", rationale: "r", risk: "medium", session_id: "s1", tool_use_id: "t1" });
    await expect(decide(ctx, d.id, "rejected")).rejects.toThrow(/paused tool call/);
    await ctx.db.upsertSession({ id: "sesn_j", agent: "ada", origin: "telegram", started_by: "member:telegram:Jane Doe" });
    await expect(decide(ctx, d.id, "rejected", "n", "sesn_j")).rejects.toThrow(/Jane Doe is a member/);
    await expect(handleTool(ctx, "mira", "s", "decide_action", { id: d.id, outcome: "rejected", note: "n" })).rejects.toThrow(/not available to mira/);
    expect((await ctx.db.getDecision(d.id))?.status).toBe("open");
  });
});

describe("Ada closing tasks (decision 53)", () => {
  const close = (ctx: any, id: string, session = "sesn_ada") => handleTool(ctx, "ada", session, "close_task", { id, note: "duplicates T-34" });
  const task = async (ctx: any, sessionStatus?: string) => {
    const t = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
    if (sessionStatus) {
      await ctx.db.upsertSession({ id: `sesn_${t.id}`, agent: "mira", origin: "task", task_id: t.id, status: sessionStatus });
      await ctx.db.setTask(t.id, "running", `sesn_${t.id}`);
    }
    return t.id as string;
  };

  it("closes a task whose session has stopped, and audits why", async () => {
    const { ctx } = makeTestCtx();
    const id = await task(ctx, "idle:budget_reached");
    expect(await close(ctx, id)).toBe(`${id} closed. Report it under "Decided for you".`);
    expect((await ctx.db.getTask(id))?.status).toBe("cancelled");
    expect((await ctx.db.openTasks()).map((t) => t.id)).toEqual([]);
    const row: any = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'ada.closed_task'").first();
    expect(JSON.parse(row.detail)).toEqual({ task: id, of: "mira", note: "duplicates T-34" });
    await expect(close(ctx, id)).rejects.toThrow(/already cancelled/);
  });

  it("leaves running work, work waiting on a decision, and member conversations alone", async () => {
    const { ctx } = makeTestCtx();
    await expect(close(ctx, await task(ctx, "running"))).rejects.toThrow(/still running/);
    await expect(close(ctx, await task(ctx, "idle:requires_action"))).rejects.toThrow(/waiting on a decision/);
    await ctx.db.upsertSession({ id: "sesn_j", agent: "ada", origin: "telegram", started_by: "member:telegram:Jane Doe" });
    await expect(close(ctx, await task(ctx), "sesn_j")).rejects.toThrow(/Jane Doe is a member/);
    expect((await ctx.db.openTasks()).map((t) => t.status)).toEqual(["running", "running", "open"]);
  });
});

describe("following up failed decisions (decision 50)", () => {
  const adaWakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");
  const skipped = async (ctx: any) =>
    (await ctx.db.db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.follow_up_skipped'").all()).results.map((r: any) => JSON.parse(r.detail).reason);

  it("wakes Ada once when an approved decision fails to run", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_m", agent: "mira", origin: "deployment", started_by: "schedule" });
    const d = await ctx.db.createDecision({ agent: "mira", kind: "github.comment", target: "accordproject/concerto#4", summary: "Do a thing", rationale: "r", risk: "low", payload: {}, session_id: "sesn_m" });
    await approve(ctx, d.id);
    expect((await ctx.db.getDecision(d.id))?.status).toBe("failed");
    const wakes = adaWakes(fakes);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].args[0].text).toContain(`decision ${d.id} (Mira, github.comment on accordproject/concerto#4) was approved but failed`);
    expect((await ctx.db.activeSessions("ada"))[0]).toMatchObject({ origin: "follow_up", started_by: "schedule" });
  });

  it("wakes Ada when execution throws, and still answers the owner", async () => {
    const { ctx, fakes } = makeTestCtx({ dryRun: false });
    await handleTool(ctx, "mira", "s", "request_action", {
      kind: "github.comment", target: "accordproject/concerto#3", summary: "s", rationale: "r", risk: "low", payload: { text: "Thanks!" },
    });
    expect(await approve(ctx, "D-1")).toMatch(/^D-1 failed: .*no github in tests/);
    expect(adaWakes(fakes)).toHaveLength(1);
  });

  it("doesn't wake Ada about her own decisions, or for successes and manual actions", async () => {
    const { ctx, fakes } = makeTestCtx();
    const own = await ctx.db.createDecision({ agent: "ada", kind: "github.comment", target: "accordproject/concerto#5", payload: {}, summary: "s", rationale: "r", risk: "low" });
    await approve(ctx, own.id);
    expect((await ctx.db.getDecision(own.id))?.status).toBe("failed");
    const ok = await ctx.db.createDecision({ agent: "mira", kind: "github.comment", target: "accordproject/concerto#3", summary: "s", rationale: "r", risk: "low", payload: { text: "hi" } });
    await approve(ctx, ok.id);
    const manual = await ctx.db.createDecision({ agent: "mira", kind: "linkedin.post", target: "linkedin", summary: "s", rationale: "r", risk: "low", payload: { text: "hi" } });
    await approve(ctx, manual.id);
    expect(adaWakes(fakes)).toHaveLength(0);
    expect(await skipped(ctx)).toEqual(["Ada's own work"]);
  });

  it("doesn't wake a stopped Ada", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.setAgentStatus("ada", "stopped");
    const d = await ctx.db.createDecision({ agent: "mira", kind: "github.comment", target: "accordproject/concerto#6", payload: {}, summary: "s", rationale: "r", risk: "low" });
    expect(await approve(ctx, d.id)).toContain(d.id);
    expect(adaWakes(fakes)).toHaveLength(0);
    expect(await skipped(ctx)).toEqual(["Ada is stopped"]);
  });
});

describe("approval cards in one app", () => {
  const queue = (ctx: any, kind: string, risk = "low", text = "hi") =>
    handleTool(ctx, "mira", "s", "request_action", { kind, target: "accordproject/concerto#1", summary: "s", rationale: "r", risk, payload: { text } });
  const one = (o: any = {}) => makeTestCtx({ network: { ...makeTestCtx().ctx.network, approvals_app: "discord" }, ...o });

  it("sends Discord-approvable cards only to Discord", async () => {
    const { ctx, fakes } = one();
    await queue(ctx, "linkedin.post", "medium");
    expect(fakes.dms).toHaveLength(1);
    expect(fakes.sent).toHaveLength(0);
  });

  it("keeps high-risk cards on Telegram", async () => {
    const { ctx, fakes } = one();
    await queue(ctx, "linkedin.post", "high");
    expect(fakes.dms).toHaveLength(0);
    expect(fakes.sent).toHaveLength(1);
  });

  it("falls back to Telegram when Discord can't deliver", async () => {
    const { ctx, fakes } = one();
    ctx.dc = { dm: async () => { throw new Error("Discord down"); } } as any;
    await queue(ctx, "linkedin.post", "medium");
    expect(fakes.sent).toHaveLength(1);
  });

  it("still sends both with approvals_app: both", async () => {
    const { ctx, fakes } = makeTestCtx();
    await queue(ctx, "linkedin.post", "medium");
    expect(fakes.dms).toHaveLength(1);
    expect(fakes.sent).toHaveLength(1);
  });

  it("puts the full content in embeds instead of cutting it off", async () => {
    const { ctx, fakes } = one();
    const long = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`).join("\n"); // ~5,000 chars
    await queue(ctx, "linkedin.post", "medium", long);
    const dm = fakes.dms[0];
    expect(dm.content.length).toBeLessThanOrEqual(2000);
    expect(dm.content).not.toContain("Line 0");
    const all = dm.embeds!.map((e) => e.description).join("\n");
    expect(all).toContain("Line 0:");
    expect(all).toContain("Line 99:");
    expect(dm.embeds!.reduce((n, e) => n + e.description.length + (e.title?.length ?? 0), 0)).toBeLessThanOrEqual(6000);
  });
});

describe("structured briefs (decision 1B)", () => {
  it("requires the brief's fields and a valid effort", async () => {
    const { ctx } = makeTestCtx();
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "mira", title: "t", objective: "o", output: "x", effort: "small" })).rejects.toThrow(/done_when is required/);
    await expect(handleTool(ctx, "ada", "s", "assign_task", { agent: "mira", title: "t", objective: "o", output: "x", done_when: "d", effort: "huge" })).rejects.toThrow(/effort must be/);
  });

  it("sets the session budget from the effort", async () => {
    const { ctx, fakes } = makeTestCtx();
    await handleTool(ctx, "ada", "s", "assign_task", { agent: "otto", title: "t", objective: "o", output: "x", done_when: "d", effort: "large" });
    expect((fakes.calls.find((c) => c.method === "createSession")!.args[0] as any).budgetCents).toBe(300);
  });
});

describe("no duplicate replies in a conversation", () => {
  it("refuses send_to_matt when Matt is already in the conversation", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_chat", agent: "ada", origin: "telegram", chat_id: 42 });
    await expect(handleTool(ctx, "ada", "sesn_chat", "send_to_matt", { text: "Check-in" })).rejects.toThrow(/Matt gets your reply/);
    expect(fakes.sent).toHaveLength(0);
  });

  it("still sends from scheduled runs", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.upsertSession({ id: "sesn_dep", agent: "ada", origin: "deployment" });
    expect(await handleTool(ctx, "ada", "sesn_dep", "send_to_matt", { text: "Check-in" })).toBe("Sent.");
    expect(fakes.sent).toHaveLength(1);
  });
});
