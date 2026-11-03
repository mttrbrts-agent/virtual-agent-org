import { describe, expect, it } from "vitest";
import { housekeeping, processSession } from "../src/sessions";
import { makeTestCtx } from "./helpers";

describe("session processing", () => {
  it("answers custom tools once, queues ask-permission calls, and forwards Telegram replies", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.sesn_t = { id: "sesn_t", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "requires_action" } };
    await ctx.db.upsertSession({ id: "sesn_t", agent: "mira", origin: "telegram", chat_id: 42 });
    fakes.events.sesn_t = [
      { id: "e1", type: "agent.message", content: [{ type: "text", text: "On it." }] },
      { id: "e2", type: "agent.custom_tool_use", name: "report_status", input: { done: ["a"], doing: [], blocked: [] } },
      { id: "e3", type: "agent.mcp_tool_use", name: "mcp__github__merge", evaluated_permission: "ask", input: {} },
    ];
    await processSession(ctx, "sesn_t");
    await processSession(ctx, "sesn_t"); // idempotent

    expect(fakes.calls.filter((c) => c.method === "sendToolResult")).toHaveLength(1);
    expect(fakes.sent.filter((s) => s.text === "Mira: On it.")).toHaveLength(1);
    const open = await ctx.db.listDecisions({ status: "open" });
    expect(open.map((d) => d.kind)).toEqual(["tool.confirm"]);
    expect((await ctx.db.latestStatuses("mira"))[0].done).toEqual(["a"]);
  });

  it("returns tool errors to the agent instead of failing", async () => {
    const { ctx, fakes } = makeTestCtx();
    fakes.sessions.s2 = { id: "s2", status: "idle", agent: "agent_mira", stop_reason: { type: "requires_action" } };
    fakes.events.s2 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "x" } }];
    await processSession(ctx, "s2");
    const r = fakes.calls.find((c) => c.method === "sendToolResult")!;
    expect(r.args[2]).toMatch(/^Error: send_to_matt is not available to mira/);
    // Refusals on permission grounds are logged as denials (decision 48).
    const denied = await (ctx.db as any).db.prepare("SELECT tool, permission FROM audit WHERE event_type = 'gateway.tool_denied'").all();
    expect(denied.results).toEqual([{ tool: "send_to_matt", permission: "deny" }]);
  });

  it("records a scheduled session's tokens and default model, and never lowers them", async () => {
    const { ctx, fakes } = makeTestCtx();
    const usage = { list_cost: { amount: "42", currency: "USD" }, input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50 };
    fakes.sessions.s4 = { id: "s4", status: "running", agent: { id: "agent_mira" }, usage };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({
      origin: "deployment", model: "claude-sonnet-5-5", cost_cents: 42, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 9000, cache_write_tokens: 50,
    });
    fakes.sessions.s4 = { id: "s4", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" }, usage: { input_tokens: 10 } };
    await processSession(ctx, "s4");
    expect(await ctx.db.getSession("s4")).toMatchObject({ cost_cents: 42, input_tokens: 1200, status: "idle:end_turn" });
  });
});

describe("sessions that are waiting", () => {
  it("starts a fresh session when the last one is paused on a tool call", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"Invalid user.message event at events[0]: waiting on responses to events [sevt_1]"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "are you there?", "owner");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
    // and the next message continues the new session, not the paused one
    (ctx.managed as any).sendMessage = async (id: string) => fakes.calls.push({ method: "sendMessage", args: [id] });
    await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "thanks", "owner");
    expect(fakes.calls.at(-1)).toEqual({ method: "sendMessage", args: [second] });
  });

  it("does not hide other errors when continuing a session", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx } = makeTestCtx();
    await messageAgent(ctx, "ada", { telegram: 42 }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(500, "boom", "/sessions/x/events");
    };
    await expect(messageAgent(ctx, "ada", { telegram: 42 }, "again", "owner")).rejects.toThrow(/500/);
  });

  it("answers a tool call even when the gateway fails unexpectedly", async () => {
    const { ctx, fakes } = makeTestCtx();
    ctx.tg = { ...ctx.tg, send: async () => { throw new Error("Telegram down"); } } as any;
    fakes.sessions.s3 = { id: "s3", status: "idle", agent: "agent_ada", stop_reason: { type: "requires_action" } };
    fakes.events.s3 = [{ id: "e1", type: "agent.custom_tool_use", name: "send_to_matt", input: { text: "check-in" } }];
    await processSession(ctx, "s3");
    const r = fakes.calls.find((c) => c.method === "sendToolResult")!;
    expect(r.args[1]).toBe("e1");
    expect(r.args[2]).toMatch(/^Error: the gateway could not run send_to_matt: Telegram down/);
  });
});

describe("sessions out of budget", () => {
  it("starts fresh when the session has spent its budget", async () => {
    const { ManagedAgentsError } = await import("../src/managed");
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx();
    const first = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "hello", "owner");
    (ctx.managed as any).sendMessage = async () => {
      throw new ManagedAgentsError(400, '{"error":{"message":"session budget reached: consumed list cost has met `budget.max_list_cost`"}}', "/sessions/x/events");
    };
    const second = await messageAgent(ctx, "ada", { discord: "111111111111111111" }, "still there?", "owner");
    expect(second).not.toBe(first);
    expect(fakes.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
  });

  it("doesn't continue a conversation that has used most of its budget, or one known to be spent", async () => {
    const { messageAgent } = await import("../src/agents");
    const { ctx, fakes } = makeTestCtx(); // Ada's session budget in the fixture is 150 cents
    const first = await messageAgent(ctx, "ada", { telegram: 42 }, "hello", "owner");
    await ctx.db.updateSession(first, "idle:end_turn", 125); // 83% spent
    const second = await messageAgent(ctx, "ada", { telegram: 42 }, "next", "owner");
    expect(second).not.toBe(first);
    await ctx.db.updateSession(second, "idle:budget_reached", 10);
    const third = await messageAgent(ctx, "ada", { telegram: 42 }, "and again", "owner");
    expect(third).not.toBe(second);
    expect(fakes.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});

describe("shared memory upsert", () => {
  it("updates the existing memory when the path is already taken", async () => {
    const { ManagedClient } = await import("../src/managed");
    const calls: { method: string; url: string; body: any; beta: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: String(init.method), url, body, beta: (init.headers as any)["anthropic-beta"] });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "memory_path_conflict_error", conflicting_path: "/context/accord.md", conflicting_memory_id: "mem_1" },
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ id: "mem_1" }));
    }) as unknown as typeof fetch;
    const r = await new ManagedClient("k", fake).upsertMemory("memstore_9", "/context/accord.md", "new text");
    expect(r).toEqual({ id: "mem_1", updated: true });
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/memory_stores/memstore_9/memories/mem_1");
    expect(calls[1].body).toEqual({ content: "new text" });
    expect(calls.every((c) => c.beta === "agent-memory-2026-07-22")).toBe(true);
  });

  it("does not swallow other errors", async () => {
    const { ManagedClient } = await import("../src/managed");
    const fake = (async () => new Response('{"error":{"type":"permission_error"}}', { status: 403 })) as unknown as typeof fetch;
    await expect(new ManagedClient("k", fake).upsertMemory("s", "/p", "x")).rejects.toThrow(/403/);
  });
});

describe("following up blocked tasks (decision 50)", () => {
  const audit = async (ctx: any, type: string) =>
    (await ctx.db.db.prepare("SELECT detail FROM audit WHERE event_type = ? ORDER BY id").bind(type).all()).results.map((r: any) => JSON.parse(r.detail));
  const adaWakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");

  /** A task for an agent whose session ends its turn after reporting `blocked` (or not reporting, for null). */
  async function finish(ctx: any, fakes: any, blocked: string[] | null, o: { agent?: string; sid?: string; follows_up?: string } = {}) {
    const agent = o.agent ?? "mira";
    const sid = o.sid ?? `sesn_${agent}_task`;
    const task = await ctx.db.createTask({ agent, title: "Chase the parser PRs", brief: "b", ...(o.follows_up ? { follows_up: o.follows_up } : {}) });
    await ctx.db.upsertSession({ id: sid, agent, origin: "task", task_id: task.id, started_by: "owner" });
    await ctx.db.setTask(task.id, "running", sid);
    fakes.sessions[sid] = { id: sid, status: "idle", agent: { id: `agent_${agent}` }, stop_reason: { type: "end_turn" } };
    fakes.events[sid] = blocked
      ? [{ id: `${sid}_e1`, type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked } }]
      : [];
    await processSession(ctx, sid);
    return task.id as string;
  }

  it("marks a task done when its last report lists no blockers, and doesn't wake Ada", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, []);
    expect((await ctx.db.getTask(id))?.status).toBe("done");
    const silent = await finish(ctx, fakes, null, { sid: "sesn_silent" });
    expect((await ctx.db.getTask(silent))?.status).toBe("done");
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("marks a task blocked when its last report lists blockers, keeps it open, and wakes Ada once", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["Needs a maintainer on concerto to review #812"]);
    expect((await ctx.db.getTask(id))?.status).toBe("blocked");
    expect((await ctx.db.openTasks("mira")).map((t) => t.id)).toEqual([id]);

    const wakes = adaWakes(fakes);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].args[0].budgetCents).toBe(50);
    expect(wakes[0].args[0].text).toContain(`task ${id} for Mira`);
    expect(wakes[0].args[0].text).toContain("Needs a maintainer on concerto to review #812");
    expect(wakes[0].args[0].text).toContain('"Following up"');
    expect((await ctx.db.activeSessions("ada"))[0]).toMatchObject({ origin: "follow_up", started_by: "owner" });
    expect(await audit(ctx, "gateway.follow_up_woken")).toEqual([{ subject: id, of: "mira", started_by: "owner" }]);

    // Later passes over the same idle session change nothing.
    await processSession(ctx, "sesn_mira_task");
    expect(adaWakes(fakes)).toHaveLength(1);
  });

  it("uses the session's latest report, not an earlier one", async () => {
    const { ctx, fakes } = makeTestCtx();
    const task = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
    await ctx.db.upsertSession({ id: "sesn_two", agent: "mira", origin: "task", task_id: task.id });
    fakes.sessions.sesn_two = { id: "sesn_two", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
    fakes.events.sesn_two = [
      { id: "r1", type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked: ["CI red"] } },
      { id: "r2", type: "agent.custom_tool_use", name: "report_status", input: { done: ["CI green after retry"], doing: [], blocked: [] } },
    ];
    await processSession(ctx, "sesn_two");
    expect((await ctx.db.getTask(task.id))?.status).toBe("done");
  });

  it("shows blocked tasks in get_status and the status views", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["Waiting on D-3"]);
    const { handleTool } = await import("../src/tools");
    const st = JSON.parse(await handleTool(ctx, "ada", "sesn_x", "get_status", {}));
    expect(st.open_tasks.map((t: any) => [t.id, t.status])).toEqual([[id, "blocked"]]);
    const { gatherStatus, statusCards, statusPlain } = await import("../src/status");
    const s = await gatherStatus(ctx);
    expect(statusPlain(s)).toContain("tasks 1 (1 blocked)");
    expect(statusCards(s).embeds![1].description).toContain("1 open task (1 blocked)");
  });

  it("wakes Ada at most once per task", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await finish(ctx, fakes, ["x"]);
    const { wakeAda } = await import("../src/followUp");
    const task = (await ctx.db.getTask(id))!;
    expect(await wakeAda(ctx, { kind: "task", task, blockers: ["x"] })).toBe("skipped");
    expect(adaWakes(fakes)).toHaveLength(1);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["already woken for this id"]);
  });

  it("stops waking Ada at the daily cap", async () => {
    const network = { ...makeTestCtx().ctx.network, follow_up: { daily_wakes: 2, budget_cents: 50 } };
    const { ctx, fakes } = makeTestCtx({ network });
    for (const n of [1, 2, 3]) await finish(ctx, fakes, ["x"], { sid: `sesn_cap${n}` });
    expect(adaWakes(fakes)).toHaveLength(2);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => [d.subject, d.reason])).toEqual([["T-3", "daily cap of 2 wakes reached"]]);
  });

  it("never wakes a stopped or paused Ada, or when schedules are off, and says why", async () => {
    const { ctx, fakes } = makeTestCtx();
    await ctx.db.setAgentStatus("ada", "stopped");
    await finish(ctx, fakes, ["x"], { sid: "sesn_a" });
    await ctx.db.setAgentStatus("ada", "paused");
    await finish(ctx, fakes, ["x"], { sid: "sesn_b" });
    const off = makeTestCtx({ network: { ...makeTestCtx().ctx.network, schedules_enabled: false } });
    await finish(off.ctx, off.fakes, ["x"]);
    expect(adaWakes(fakes)).toHaveLength(0);
    expect(adaWakes(off.fakes)).toHaveLength(0);
    expect((await audit(ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["Ada is stopped", "Ada is paused"]);
    expect((await audit(off.ctx, "gateway.follow_up_skipped")).map((d: any) => d.reason)).toEqual(["schedules are off (network.schedules_enabled)"]);
    expect((await ctx.db.getTask("T-1"))?.status).toBe("blocked");
  });

  it("doesn't wake Ada about review checks", async () => {
    const { ctx, fakes } = makeTestCtx();
    const task = await ctx.db.createTask({ agent: "mira", title: "Review check", brief: "b", review: { target: "accordproject/concerto#1", sha: "abc1234" } });
    await ctx.db.upsertSession({ id: "sesn_rc", agent: "mira", origin: "task", task_id: task.id });
    fakes.sessions.sesn_rc = { id: "sesn_rc", status: "idle", agent: { id: "agent_mira" }, stop_reason: { type: "end_turn" } };
    fakes.events.sesn_rc = [{ id: "rc1", type: "agent.custom_tool_use", name: "report_status", input: { done: [], doing: [], blocked: ["head moved"] } }];
    await processSession(ctx, "sesn_rc");
    expect((await ctx.db.getTask(task.id))?.status).toBe("blocked");
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("keeps processing the session when waking Ada fails, and audits it", async () => {
    const { ctx, fakes } = makeTestCtx();
    const create = ctx.managed.createSession.bind(ctx.managed);
    (ctx.managed as any).createSession = async (p: any) => {
      if (p.agentId === "agent_ada") throw new Error("Managed Agents down");
      return create(p);
    };
    const id = await finish(ctx, fakes, ["x"]);
    expect((await ctx.db.getTask(id))?.status).toBe("blocked");
    expect(fakes.calls.filter((c) => c.method === "sendToolResult")).toHaveLength(1);
    expect(await audit(ctx, "gateway.follow_up_error")).toEqual([{ subject: id, of: "mira", error: "Managed Agents down" }]);
    // A failed wake isn't counted towards the daily cap.
    expect((await (ctx.db as any).db.prepare("SELECT status FROM follow_ups").all()).results).toEqual([{ status: "failed" }]);
  });

  it("closes a blocked task when its follow-up finishes", async () => {
    const { ctx, fakes } = makeTestCtx();
    const blocked = await finish(ctx, fakes, ["x"], { sid: "sesn_first" });
    const followUp = await finish(ctx, fakes, [], { agent: "otto", sid: "sesn_second", follows_up: blocked });
    expect((await ctx.db.getTask(followUp))?.status).toBe("done");
    expect((await ctx.db.getTask(blocked))?.status).toBe("done");
  });

  it("tells Ada when a blocked task was itself a follow-up", async () => {
    const { ctx, fakes } = makeTestCtx();
    const first = await finish(ctx, fakes, ["x"], { sid: "sesn_first" });
    await finish(ctx, fakes, ["still stuck"], { agent: "otto", sid: "sesn_second", follows_up: first });
    expect(adaWakes(fakes).at(-1).args[0].text).toContain(`It was itself a follow-up of ${first}: put it to Matt`);
  });
});

describe("tasks whose session stops without finishing (decision 53)", () => {
  const adaWakes = (fakes: any) => fakes.calls.filter((c: any) => c.method === "createSession" && c.args[0].agentId === "agent_ada");

  /** A running task for Mira whose session is in the given state. */
  async function started(ctx: any, fakes: any, sid: string, session: Record<string, unknown>) {
    const task = await ctx.db.createTask({ agent: "mira", title: "Chase the parser PRs", brief: "b" });
    await ctx.db.upsertSession({ id: sid, agent: "mira", origin: "task", task_id: task.id, started_by: "owner" });
    await ctx.db.setTask(task.id, "running", sid);
    fakes.sessions[sid] = { id: sid, agent: { id: "agent_mira" }, ...session };
    fakes.events[sid] = [];
    return task.id as string;
  }

  it("blocks a task whose session ran out of budget, and wakes Ada about it", async () => {
    const { ctx, fakes } = makeTestCtx();
    const id = await started(ctx, fakes, "sesn_b", { status: "idle", stop_reason: { type: "budget_reached" } });
    await processSession(ctx, "sesn_b");
    expect((await ctx.db.getTask(id))?.status).toBe("blocked");
    expect(adaWakes(fakes)[0].args[0].text).toContain("Ran out of its session budget before finishing");
  });

  it("fails a task whose session ended in error, without waking Ada", async () => {
    const { ctx, fakes } = makeTestCtx();
    const gone = await started(ctx, fakes, "sesn_t", { status: "terminated" });
    const retries = await started(ctx, fakes, "sesn_r", { status: "idle", stop_reason: { type: "retries_exhausted" } });
    await processSession(ctx, "sesn_t");
    await processSession(ctx, "sesn_r");
    expect((await ctx.db.getTask(gone))?.status).toBe("failed");
    expect((await ctx.db.getTask(retries))?.status).toBe("failed");
    expect(adaWakes(fakes)).toHaveLength(0);
  });

  it("leaves running and paused sessions' tasks alone", async () => {
    const { ctx, fakes } = makeTestCtx();
    const running = await started(ctx, fakes, "sesn_run", { status: "running" });
    const paused = await started(ctx, fakes, "sesn_p", { status: "idle", stop_reason: { type: "requires_action" } });
    await processSession(ctx, "sesn_run");
    await processSession(ctx, "sesn_p");
    expect((await ctx.db.getTask(running))?.status).toBe("running");
    expect((await ctx.db.getTask(paused))?.status).toBe("running");
  });

  it("fails old tasks at the tidy-up once their session is stale or gone", async () => {
    const { ctx } = makeTestCtx();
    const sql = (q: string) => (ctx.db as any).db.prepare(q).run();
    const task = async (sid: string | null, status: string) => {
      const t = await ctx.db.createTask({ agent: "mira", title: "t", brief: "b" });
      if (sid) {
        await ctx.db.upsertSession({ id: sid, agent: "mira", origin: "task", task_id: t.id, status });
        await ctx.db.setTask(t.id, "running", sid);
      }
      return t.id;
    };
    const stale = await task("sesn_old", "idle:budget_reached");
    const live = await task("sesn_live", "running");
    const recent = await task("sesn_new", "idle:budget_reached");
    const orphan = await task(null, "");
    await sql("UPDATE sessions SET updated_at = datetime('now', '-8 days') WHERE id = 'sesn_old'");
    await sql(`UPDATE tasks SET created_at = datetime('now', '-8 days') WHERE id = '${orphan}'`);
    await housekeeping(ctx);
    const status = async (id: string) => (await ctx.db.getTask(id))?.status;
    expect([await status(stale), await status(live), await status(recent), await status(orphan)]).toEqual(["failed", "running", "running", "failed"]);
    const row: any = await (ctx.db as any).db.prepare("SELECT detail FROM audit WHERE event_type = 'gateway.housekeeping'").first();
    expect(JSON.parse(row.detail).expired_tasks).toEqual([stale, orphan]);
  });
});
