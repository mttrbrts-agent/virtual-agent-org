// Data access for the gateway's D1 database.

import type { Tokens } from "./managed";

export type DecisionStatus = "open" | "approved" | "rejected" | "executed" | "failed";
export type AgentStatus = "active" | "paused" | "stopped" | "revoked";

export interface Decision {
  id: string;
  seq: number;
  agent: string;
  kind: string;
  target: string;
  summary: string;
  rationale: string;
  risk: string;
  payload: string;
  status: DecisionStatus;
  note: string | null;
  result: string | null;
  session_id: string | null;
  tool_use_id: string | null;
  tg_message_id: number | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

export interface Task {
  id: string;
  agent: string;
  title: string;
  brief: string;
  priority: string;
  due: string | null;
  status: string;
  session_id: string | null;
  /** review_check only when the gateway started it for one PR at one commit (decision 2A). */
  kind: "task" | "review_check";
  review_target: string | null;
  review_sha: string | null;
  /** The task or decision (T-12, D-41) this task was assigned to follow up, if any. */
  follows_up: string | null;
  created_at: string;
}

export interface Review {
  id: string;
  target: string;
  sha: string;
  risk: string;
  verdict: "approve" | "comment" | "request_changes";
  decision_id: string | null;
  url: string | null;
  merge_decision_id: string | null;
  outcome: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  review_id: string;
  target: string;
  path: string | null;
  line: number | null;
  severity: string;
  area: string;
  summary: string;
  outcome: string | null;
  outcome_note: string | null;
  created_at: string;
}

/**
 * Who a session acts for. A member's conversation, and any task assigned from it,
 * is member:<platform>:<name>; "unknown" marks conversations from before this was kept.
 */
export type StartedBy = "owner" | "schedule" | "unknown" | `member:${string}`;

export interface SessionRow {
  id: string;
  agent: string;
  origin: "telegram" | "discord" | "task" | "deployment" | "follow_up";
  chat_id: number | null;
  discord_user: string | null;
  task_id: string | null;
  status: string;
  cost_cents: number;
  started_by: StartedBy;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export class Db {
  constructor(private db: D1Database) {}

  // ---- counters -----------------------------------------------------------

  async next(counter: "decision" | "task" | "review" | "finding"): Promise<number> {
    const row = await this.db
      .prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value")
      .bind(counter)
      .first<{ value: number }>();
    if (!row) throw new Error(`counter ${counter} missing`);
    return row.value;
  }

  // ---- agents -------------------------------------------------------------

  async agentStatus(name: string): Promise<AgentStatus> {
    const row = await this.db.prepare("SELECT status FROM agents WHERE name = ?").bind(name).first<{ status: AgentStatus }>();
    return row?.status ?? "active";
  }

  async setAgentStatus(name: string, status: AgentStatus) {
    await this.db
      .prepare(
        "INSERT INTO agents (name, status, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(name, status)
      .run();
  }

  async allAgentStatuses(): Promise<Record<string, AgentStatus>> {
    const { results } = await this.db.prepare("SELECT name, status FROM agents").all<{ name: string; status: AgentStatus }>();
    return Object.fromEntries(results.map((r) => [r.name, r.status]));
  }

  // ---- sessions -----------------------------------------------------------

  async upsertSession(s: Partial<SessionRow> & { id: string; agent: string; origin: SessionRow["origin"] }) {
    await this.db
      .prepare(
        "INSERT INTO sessions (id, agent, origin, chat_id, discord_user, task_id, status, started_by, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO NOTHING",
      )
      .bind(s.id, s.agent, s.origin, s.chat_id ?? null, s.discord_user ?? null, s.task_id ?? null, s.status ?? "running", s.started_by ?? "schedule", s.model ?? null)
      .run();
  }

  /** Marks a conversation as a member's once one speaks in it; it stays marked. */
  async markMemberSession(id: string, startedBy: StartedBy) {
    if (!startedBy.startsWith("member:")) return;
    await this.db.prepare("UPDATE sessions SET started_by = ? WHERE id = ? AND started_by NOT LIKE 'member:%'").bind(startedBy, id).run();
  }

  /** Counts one more message from a member today (UTC) and returns today's total. */
  async countMemberMessage(person: string): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO member_messages (person, day, count) VALUES (?, date('now'), 1) " +
          "ON CONFLICT(person, day) DO UPDATE SET count = count + 1 RETURNING count",
      )
      .bind(person)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }

  getSession(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  }

  /** Usage is cumulative, so a stale snapshot never lowers what is recorded. */
  async updateSession(id: string, status: string, costCents: number, tokens?: Tokens) {
    const t = tokens ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    await this.db
      .prepare(
        "UPDATE sessions SET status = ?, cost_cents = MAX(cost_cents, ?), input_tokens = MAX(input_tokens, ?), output_tokens = MAX(output_tokens, ?), " +
          "cache_read_tokens = MAX(cache_read_tokens, ?), cache_write_tokens = MAX(cache_write_tokens, ?), updated_at = datetime('now') WHERE id = ?",
      )
      .bind(status, costCents, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, id)
      .run();
  }

  async activeSessions(agent?: string): Promise<SessionRow[]> {
    const sql =
      "SELECT * FROM sessions WHERE status NOT IN ('terminated', 'done')" + (agent ? " AND agent = ?" : "");
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (await stmt.all<SessionRow>()).results;
  }

  /** The latest Telegram conversation with an agent, if it is recent enough to continue. */
  recentChatSession(agent: string, chatId: number, maxAgeHours = 6) {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE agent = ? AND origin = 'telegram' AND chat_id = ? " +
          "AND status NOT IN ('terminated', 'idle:budget_reached') AND updated_at > datetime('now', ?) ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .bind(agent, chatId, `-${maxAgeHours} hours`)
      .first<SessionRow>();
  }

  /** The latest Discord conversation with an agent, if it is recent enough to continue. */
  recentDiscordSession(agent: string, discordUser: string, maxAgeHours = 6) {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE agent = ? AND origin = 'discord' AND discord_user = ? " +
          "AND status NOT IN ('terminated', 'idle:budget_reached') AND updated_at > datetime('now', ?) ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .bind(agent, discordUser, `-${maxAgeHours} hours`)
      .first<SessionRow>();
  }

  async spendByAgent(sinceIso: string): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT agent, SUM(cost_cents) AS cents FROM sessions WHERE created_at >= ? GROUP BY agent")
      .bind(sinceIso)
      .all<{ agent: string; cents: number }>();
    return Object.fromEntries(results.map((r) => [r.agent, r.cents]));
  }

  // ---- agent audit (read_audit) --------------------------------------------
  // Times are D1's "YYYY-MM-DD HH:MM:SS" UTC; callers pass the same form.

  /** Sessions started in [since, until), summed by agent, model and origin. */
  sessionUsage(since: string, until: string) {
    return this.db
      .prepare(
        "SELECT agent, COALESCE(model, 'unknown') AS model, origin, COUNT(*) AS sessions, SUM(cost_cents) AS cost_cents, " +
          "SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, " +
          "SUM(cache_write_tokens) AS cache_write_tokens FROM sessions WHERE created_at >= ? AND created_at < ? GROUP BY agent, model, origin ORDER BY agent, model, origin",
      )
      .bind(since, until)
      .all<{ agent: string; model: string; origin: string; sessions: number; cost_cents: number } & Tokens>()
      .then((r) => r.results);
  }

  /** Spend per agent per UTC day the sessions started, for spotting spikes. */
  dailySpend(since: string, until: string) {
    return this.db
      .prepare(
        "SELECT date(created_at) AS day, agent, SUM(cost_cents) AS cost_cents FROM sessions WHERE created_at >= ? AND created_at < ? " +
          "GROUP BY day, agent ORDER BY day, agent",
      )
      .bind(since, until)
      .all<{ day: string; agent: string; cost_cents: number }>()
      .then((r) => r.results);
  }

  /** Decisions created in [since, until), excluding tool confirmations. */
  decisionsBetween(since: string, until: string) {
    return this.db
      .prepare(
        "SELECT id, agent, kind, target, status, note, created_at, decided_at, executed_at FROM decisions " +
          "WHERE created_at >= ? AND created_at < ? ORDER BY seq",
      )
      .bind(since, until)
      .all<Pick<Decision, "id" | "agent" | "kind" | "target" | "status" | "note" | "created_at" | "decided_at" | "executed_at">>()
      .then((r) => r.results);
  }

  /** Tool calls refused by a permission policy or by the gateway. */
  denials(since: string, until: string, limit = 200) {
    return this.db
      .prepare(
        "SELECT ts, agent, session_id, event_type, tool, permission, substr(detail, 1, 300) AS detail FROM audit " +
          "WHERE ts >= ? AND ts < ? AND (permission = 'deny' OR event_type = 'gateway.tool_denied') ORDER BY id LIMIT ?",
      )
      .bind(since, until, limit)
      .all<{ ts: string; agent: string | null; session_id: string | null; event_type: string; tool: string | null; permission: string | null; detail: string | null }>()
      .then((r) => r.results);
  }

  /** External (built-in and MCP) tool calls, counted by agent, tool and permission. */
  toolCalls(since: string, until: string) {
    return this.db
      .prepare(
        "SELECT agent, event_type, tool, COALESCE(permission, 'none') AS permission, COUNT(*) AS calls FROM audit " +
          "WHERE ts >= ? AND ts < ? AND event_type IN ('agent.tool_use', 'agent.mcp_tool_use') GROUP BY agent, event_type, tool, permission ORDER BY agent, calls DESC",
      )
      .bind(since, until)
      .all<{ agent: string | null; event_type: string; tool: string | null; permission: string; calls: number }>()
      .then((r) => r.results);
  }

  // ---- events: idempotency ------------------------------------------------

  /** Returns true the first time an event id is claimed. */
  async claimEvent(eventId: string): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)").bind(eventId).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async releaseEvent(eventId: string) {
    await this.db.prepare("DELETE FROM processed_events WHERE event_id = ?").bind(eventId).run();
  }

  // ---- decisions ----------------------------------------------------------

  async createDecision(d: {
    agent: string;
    kind: string;
    target: string;
    summary: string;
    rationale: string;
    risk: string;
    payload?: unknown;
    session_id?: string;
    tool_use_id?: string;
  }): Promise<Decision> {
    const seq = await this.next("decision");
    const id = `D-${seq}`;
    await this.db
      .prepare(
        "INSERT INTO decisions (id, seq, agent, kind, target, summary, rationale, risk, payload, session_id, tool_use_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        seq,
        d.agent,
        d.kind,
        d.target,
        d.summary,
        d.rationale,
        d.risk,
        JSON.stringify(d.payload ?? {}),
        d.session_id ?? null,
        d.tool_use_id ?? null,
      )
      .run();
    return (await this.getDecision(id))!;
  }

  getDecision(id: string) {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id.toUpperCase()).first<Decision>();
  }

  async listDecisions(filter: { status?: "open" | "decided" | "all"; agent?: string } = {}): Promise<Decision[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status === "open") where.push("status = 'open'");
    if (filter.status === "decided") where.push("status != 'open'");
    if (filter.agent) {
      where.push("agent = ?");
      args.push(filter.agent);
    }
    const sql =
      "SELECT * FROM decisions" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY seq ASC LIMIT 200";
    return (await this.db.prepare(sql).bind(...args).all<Decision>()).results;
  }

  /** Moves an open decision to approved/rejected. Returns false if it was not open. */
  async decide(id: string, status: "approved" | "rejected", note?: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE decisions SET status = ?, note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(status, note ?? null, id.toUpperCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** The latest decision from the same agent, for the same target, queued after this one. */
  async laterDecision(d: Pick<Decision, "agent" | "target" | "seq">): Promise<Decision | null> {
    return this.db
      .prepare("SELECT * FROM decisions WHERE agent = ? AND target = ? AND seq > ? ORDER BY seq DESC LIMIT 1")
      .bind(d.agent, d.target, d.seq)
      .first<Decision>();
  }

  async setNote(id: string, note: string) {
    await this.db.prepare("UPDATE decisions SET note = ? WHERE id = ?").bind(note, id.toUpperCase()).run();
  }

  async markExecuted(id: string, ok: boolean, result: string) {
    await this.db
      .prepare("UPDATE decisions SET status = ?, result = ?, executed_at = datetime('now') WHERE id = ?")
      .bind(ok ? "executed" : "failed", result, id.toUpperCase())
      .run();
  }

  async setDiscordMessage(id: string, channelId: string, messageId: string) {
    await this.db
      .prepare("UPDATE decisions SET discord_channel_id = ?, discord_message_id = ? WHERE id = ?")
      .bind(channelId, messageId, id)
      .run();
  }

  async setDecisionMessage(id: string, messageId: number) {
    await this.db.prepare("UPDATE decisions SET tg_message_id = ? WHERE id = ?").bind(messageId, id).run();
  }

  // ---- tasks --------------------------------------------------------------

  async createTask(t: {
    agent: string;
    title: string;
    brief: string;
    priority?: string;
    due?: string;
    review?: { target: string; sha: string };
    follows_up?: string;
  }): Promise<Task> {
    const seq = await this.next("task");
    const id = `T-${seq}`;
    await this.db
      .prepare("INSERT INTO tasks (id, seq, agent, title, brief, priority, due, kind, review_target, review_sha, follows_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, seq, t.agent, t.title, t.brief, t.priority ?? "normal", t.due ?? null, t.review ? "review_check" : "task", t.review?.target ?? null, t.review?.sha ?? null, t.follows_up ?? null)
      .run();
    return (await this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>())!;
  }

  /** The task a session was started for, if any. */
  async sessionTask(sessionId: string): Promise<Task | null> {
    return this.db
      .prepare("SELECT t.* FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?")
      .bind(sessionId)
      .first<Task>();
  }

  async setTask(id: string, status: string, sessionId?: string) {
    await this.db
      .prepare("UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id), updated_at = datetime('now') WHERE id = ?")
      .bind(status, sessionId ?? null, id)
      .run();
  }

  /**
   * Fails open and running tasks whose session is over (terminated, out of retries or
   * stale), or that never got a session in `days` days. Returns their ids.
   */
  async failAbandonedTasks(days: number): Promise<string[]> {
    const where =
      "status IN ('open', 'running') AND (session_id IN (SELECT id FROM sessions WHERE status IN ('terminated', 'done', 'stale', 'idle:retries_exhausted')) " +
      "OR (session_id IS NULL AND created_at < datetime('now', ?)))";
    const age = `-${days} days`;
    const { results } = await this.db.prepare(`SELECT id FROM tasks WHERE ${where} ORDER BY seq`).bind(age).all<{ id: string }>();
    if (!results.length) return [];
    await this.db.prepare(`UPDATE tasks SET status = 'failed', updated_at = datetime('now') WHERE ${where}`).bind(age).run();
    return results.map((r) => r.id);
  }

  getTask(id: string) {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id.toUpperCase()).first<Task>();
  }

  /** Tasks not finished: open, running, or blocked until someone follows them up. */
  async openTasks(agent?: string): Promise<Task[]> {
    const sql = "SELECT * FROM tasks WHERE status IN ('open', 'running', 'blocked')" + (agent ? " AND agent = ?" : "") + " ORDER BY seq";
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (await stmt.all<Task>()).results;
  }

  /** An unfinished task already assigned to follow up this task or decision id. */
  openFollowUpOf(subject: string) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE follows_up = ? AND status IN ('open', 'running', 'blocked') ORDER BY seq LIMIT 1")
      .bind(subject.toUpperCase())
      .first<Task>();
  }

  // ---- follow-up wakes (decision 50) --------------------------------------

  /**
   * Claims the one wake allowed for a task or decision id, if today's wakes (UTC) are
   * under the cap. One statement, so two passes can't both claim it or pass the cap.
   */
  async claimFollowUp(subject: string, agent: string, dailyCap: number): Promise<"claimed" | "duplicate" | "cap"> {
    const r = await this.db
      .prepare(
        "INSERT INTO follow_ups (subject, agent) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM follow_ups WHERE subject = ?) " +
          "AND (SELECT COUNT(*) FROM follow_ups WHERE status != 'failed' AND created_at >= date('now')) < ?",
      )
      .bind(subject, agent, subject, dailyCap)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return "claimed";
    const seen = await this.db.prepare("SELECT 1 AS x FROM follow_ups WHERE subject = ?").bind(subject).first();
    return seen ? "duplicate" : "cap";
  }

  async setFollowUp(subject: string, status: "started" | "failed", sessionId?: string) {
    await this.db
      .prepare("UPDATE follow_ups SET status = ?, session_id = COALESCE(?, session_id) WHERE subject = ?")
      .bind(status, sessionId ?? null, subject)
      .run();
  }

  // ---- reviews and findings (decisions 35 and 36) -------------------------

  async createReview(r: {
    target: string;
    sha: string;
    risk: string;
    verdict: string;
    decision_id: string;
    url: string | null;
    findings: { path: string | null; line: number | null; severity: string; area: string; summary: string }[];
  }): Promise<Review> {
    const seq = await this.next("review");
    const id = `R-${seq}`;
    const target = r.target.toLowerCase();
    await this.db
      .prepare("INSERT INTO reviews (id, seq, target, sha, risk, verdict, decision_id, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, seq, target, r.sha, r.risk, r.verdict, r.decision_id, r.url)
      .run();
    for (const f of r.findings) {
      const fseq = await this.next("finding");
      await this.db
        .prepare("INSERT INTO review_findings (id, seq, review_id, target, path, line, severity, area, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`F-${fseq}`, fseq, id, target, f.path, f.line, f.severity, f.area, f.summary)
        .run();
    }
    return (await this.db.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first<Review>())!;
  }

  /** The newest review of a PR, at one head commit if sha is given. */
  latestReview(target: string, sha?: string) {
    const sql = "SELECT * FROM reviews WHERE target = ?" + (sha ? " AND sha = ?" : "") + " ORDER BY seq DESC LIMIT 1";
    const args = sha ? [target.toLowerCase(), sha] : [target.toLowerCase()];
    return this.db.prepare(sql).bind(...args).first<Review>();
  }

  /** "owner/repo#12@sha" for every review in a repo. */
  async reviewedHeads(repo: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT target, sha FROM reviews WHERE target LIKE ?")
      .bind(`${repo.toLowerCase()}#%`)
      .all<{ target: string; sha: string }>();
    return new Set(results.map((r) => `${r.target}@${r.sha}`));
  }

  async linkMerge(reviewId: string, decisionId: string) {
    await this.db.prepare("UPDATE reviews SET merge_decision_id = ? WHERE id = ?").bind(decisionId, reviewId).run();
  }

  /** Records what happened to the newest review of a PR. Returns false if it was never reviewed. */
  async setReviewOutcome(target: string, outcome: string, note?: string): Promise<boolean> {
    const r = await this.latestReview(target);
    if (!r) return false;
    await this.db
      .prepare("UPDATE reviews SET outcome = ?, outcome_note = ?, outcome_at = datetime('now') WHERE id = ?")
      .bind(outcome, note ?? null, r.id)
      .run();
    return true;
  }

  async listFindings(f: { open?: boolean; repo?: string; days?: number } = {}): Promise<Finding[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.open) where.push("outcome IS NULL");
    if (f.repo) {
      where.push("target LIKE ?");
      args.push(`${f.repo.toLowerCase()}#%`);
    }
    if (f.days) {
      where.push("created_at >= datetime('now', ?)");
      args.push(`-${f.days} days`);
    }
    const sql = "SELECT * FROM review_findings" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY seq ASC LIMIT 200";
    return (await this.db.prepare(sql).bind(...args).all<Finding>()).results;
  }

  async setFindingOutcome(id: string, outcome: string, note?: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE review_findings SET outcome = ?, outcome_note = ?, outcome_at = datetime('now') WHERE id = ?")
      .bind(outcome, note ?? null, id.toUpperCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** How posted findings fared, and what became of reviewed PRs, over the last `days`. */
  async reviewStats(days = 90) {
    const since = `-${days} days`;
    const findings = (
      await this.db
        .prepare(
          "SELECT area, severity, COUNT(*) AS posted, SUM(outcome = 'acted') AS acted, SUM(outcome = 'dismissed') AS dismissed " +
            "FROM review_findings WHERE created_at >= datetime('now', ?) GROUP BY area, severity ORDER BY area, severity",
        )
        .bind(since)
        .all<{ area: string; severity: string; posted: number; acted: number; dismissed: number }>()
    ).results;
    const reviews = (
      await this.db
        .prepare(
          "SELECT r.risk, r.verdict, COUNT(*) AS reviews, SUM(d.status IN ('approved', 'executed')) AS merges_approved, " +
            "SUM(d.status = 'rejected') AS merges_rejected, SUM(r.outcome = 'merged') AS merged, SUM(r.outcome = 'closed') AS closed, " +
            "SUM(r.outcome IN ('reverted', 'follow_up')) AS reverted_or_fixed " +
            "FROM reviews r LEFT JOIN decisions d ON d.id = r.merge_decision_id WHERE r.created_at >= datetime('now', ?) " +
            "GROUP BY r.risk, r.verdict ORDER BY r.risk, r.verdict",
        )
        .bind(since)
        .all<Record<string, string | number>>()
    ).results;
    return { days, findings, reviews };
  }

  // ---- statuses, scorecards, evaluations ----------------------------------

  async addStatus(s: { agent: string; session_id: string; done: string[]; doing: string[]; blocked: string[]; notes?: string }) {
    await this.db
      .prepare("INSERT INTO statuses (agent, session_id, done, doing, blocked, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(s.agent, s.session_id, JSON.stringify(s.done), JSON.stringify(s.doing), JSON.stringify(s.blocked), s.notes ?? null)
      .run();
  }

  /** What a session's last report_status listed as blocked, or null if it never reported. */
  async sessionBlockers(sessionId: string): Promise<string[] | null> {
    const r = await this.db
      .prepare("SELECT blocked FROM statuses WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .bind(sessionId)
      .first<{ blocked: string }>();
    return r ? (JSON.parse(r.blocked) as string[]) : null;
  }

  async latestStatuses(agent?: string) {
    const sql =
      "SELECT s.* FROM statuses s JOIN (SELECT agent, MAX(id) AS id FROM statuses GROUP BY agent) m ON s.id = m.id" +
      (agent ? " WHERE s.agent = ?" : "");
    const stmt = agent ? this.db.prepare(sql).bind(agent) : this.db.prepare(sql);
    return (
      await stmt.all<{ agent: string; done: string; doing: string; blocked: string; notes: string | null; created_at: string }>()
    ).results.map((r) => ({
      agent: r.agent,
      at: r.created_at,
      done: JSON.parse(r.done) as string[],
      doing: JSON.parse(r.doing) as string[],
      blocked: JSON.parse(r.blocked) as string[],
      notes: r.notes,
    }));
  }

  async putScorecard(period: string, body: unknown) {
    await this.db
      .prepare("INSERT INTO scorecards (period, body) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET body = excluded.body, created_at = datetime('now')")
      .bind(period, JSON.stringify(body))
      .run();
  }

  async getScorecard(period?: string) {
    const row = period
      ? await this.db.prepare("SELECT * FROM scorecards WHERE period = ?").bind(period).first<{ period: string; body: string }>()
      : await this.db.prepare("SELECT * FROM scorecards ORDER BY created_at DESC LIMIT 1").first<{ period: string; body: string }>();
    return row ? { period: row.period, scorecard: JSON.parse(row.body) } : null;
  }

  async putEvaluation(e: { agent: string; week: string; scores: unknown; evidence: string; proposal?: string }) {
    await this.db
      .prepare(
        "INSERT INTO evaluations (agent, week, scores, evidence, proposal) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(agent, week) DO UPDATE SET scores = excluded.scores, evidence = excluded.evidence, proposal = excluded.proposal",
      )
      .bind(e.agent, e.week, JSON.stringify(e.scores), e.evidence, e.proposal ?? null)
      .run();
  }

  // ---- audit and telegram state -------------------------------------------

  async audit(a: {
    agent?: string;
    session_id?: string;
    event_id?: string;
    event_type: string;
    tool?: string;
    permission?: string;
    detail?: unknown;
  }) {
    await this.db
      .prepare("INSERT INTO audit (agent, session_id, event_id, event_type, tool, permission, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        a.agent ?? null,
        a.session_id ?? null,
        a.event_id ?? null,
        a.event_type,
        a.tool ?? null,
        a.permission ?? null,
        a.detail === undefined ? null : JSON.stringify(a.detail).slice(0, 4000),
      )
      .run();
  }

  async addPendingReply(messageId: number, chatId: number, kind: string, ref: string) {
    await this.db
      .prepare("INSERT OR REPLACE INTO pending_replies (message_id, chat_id, kind, ref) VALUES (?, ?, ?, ?)")
      .bind(messageId, chatId, kind, ref)
      .run();
  }

  async takePendingReply(messageId: number) {
    const row = await this.db
      .prepare("SELECT * FROM pending_replies WHERE message_id = ?")
      .bind(messageId)
      .first<{ kind: string; ref: string; chat_id: number }>();
    if (row) await this.db.prepare("DELETE FROM pending_replies WHERE message_id = ?").bind(messageId).run();
    return row;
  }

  // ---- runtime: tool results, sweeping and retention ------------------------

  /** The answer already given to a custom tool call, if any. */
  async toolResult(eventId: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT result FROM tool_results WHERE event_id = ?").bind(eventId).first<{ result: string }>();
    return row?.result ?? null;
  }

  async saveToolResult(eventId: string, result: string) {
    await this.db.prepare("INSERT OR REPLACE INTO tool_results (event_id, result) VALUES (?, ?)").bind(eventId, result).run();
  }

  async markEventDone(eventId: string) {
    await this.db.prepare("UPDATE processed_events SET done = 1 WHERE event_id = ?").bind(eventId).run();
  }

  /** True when a claimed event is handled, or was claimed long enough ago that whoever claimed it has finished or released it. */
  async claimSettled(eventId: string, minutes = 5): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM processed_events WHERE event_id = ? AND (done = 1 OR ts < datetime('now', ?))")
      .bind(eventId, `-${minutes} minutes`)
      .first<{ ok: number }>();
    return !!row;
  }

  /** The last event of a session handled along with every event before it. */
  async eventsDoneThrough(sessionId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT events_done_through FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ events_done_through: string | null }>();
    return row?.events_done_through ?? null;
  }

  async setEventsDoneThrough(sessionId: string, eventId: string) {
    await this.db.prepare("UPDATE sessions SET events_done_through = ? WHERE id = ?").bind(eventId, sessionId).run();
  }

  /**
   * Sessions the sweeper should look at, least recently updated first. Finished,
   * spent and stale sessions are left out; a webhook still wakes any of them.
   */
  async sweepableSessions(limit: number): Promise<SessionRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM sessions WHERE status NOT IN ('terminated', 'done', 'stale', 'idle:end_turn', 'idle:budget_reached') " +
          "ORDER BY updated_at ASC, rowid ASC LIMIT ?",
      )
      .bind(limit)
      .all<SessionRow>();
    return results;
  }

  /** Marks idle sessions nobody has touched for `days` as stale. Returns how many. */
  async markStaleSessions(days: number): Promise<number> {
    const r = await this.db
      .prepare("UPDATE sessions SET status = 'stale' WHERE status LIKE 'idle:%' AND updated_at < datetime('now', ?)")
      .bind(`-${days} days`)
      .run();
    return r.meta?.changes ?? 0;
  }

  /** Deletes event claims and tool results older than `eventDays`, and audit rows older than `auditDays`. */
  async prune(eventDays: number, auditDays: number): Promise<{ events: number; tool_results: number; audit: number }> {
    const del = async (sql: string, days: number) =>
      (await this.db.prepare(sql).bind(`-${days} days`).run()).meta?.changes ?? 0;
    return {
      events: await del("DELETE FROM processed_events WHERE ts < datetime('now', ?)", eventDays),
      tool_results: await del("DELETE FROM tool_results WHERE created_at < datetime('now', ?)", eventDays),
      audit: await del("DELETE FROM audit WHERE ts < datetime('now', ?)", auditDays),
    };
  }
}
