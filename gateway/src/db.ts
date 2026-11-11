// Data access for the gateway's D1 database.

import type { Tokens } from "./managed";

/** lapsed: the gateway closed it because GitHub moved on, e.g. the PR merged or got new commits (decision 62). */
export type DecisionStatus = "open" | "approved" | "rejected" | "executed" | "failed" | "lapsed";
export type AgentStatus = "active" | "paused" | "stopped" | "revoked";

/** Decision kinds that say nothing about an agent's judgement, left out of approval measures. */
export const NOT_JUDGEMENT = ["tool.confirm", "github.review", "github.approve_ci"];

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
  /** A merge card's checks as the gateway last re-ran them, and when (decision 62). */
  checks_now: string | null;
  checks_at: string | null;
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
  kind: "task" | "review_check" | "change";
  review_target: string | null;
  review_sha: string | null;
  /** The task or decision (T-12, D-41) this task was assigned to follow up, if any. */
  follows_up: string | null;
  /** Why the gateway left it blocked, when its session stopped without finishing (decision 53). */
  blocked_reason: string | null;
  created_at: string;
}

export interface Change {
  id: string;
  seq: number;
  /** The agent changed, or 'network'. */
  agent: string;
  decision_id: string;
  change_type: string;
  measure: string;
  tool: string | null;
  /** Decision kinds named in the evidence (JSON array). */
  kinds: string;
  state: "building" | "pr_open" | "live" | "measured" | "closed";
  task_id: string | null;
  pr_url: string | null;
  pr_opened_at: string | null;
  live_at: string | null;
  measured_at: string | null;
  before: number | null;
  after: number | null;
  before_cases: number | null;
  after_cases: number | null;
  verdict: "better" | "same" | "worse" | "too_little_data" | null;
  overlaps: string | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
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

/** One GitHub delivery the gateway used (decision 62). Holds no text from GitHub. */
export interface GitHubEvent {
  delivery: string;
  target: string;
  event: string;
  action: string;
  actor: string | null;
  association: string | null;
  sha: string | null;
  detail: string | null;
}

export type WakeTrigger = "review" | "merge" | "first_response";

/** Work the gateway will start for an agent when an event calls for it (decision 62). */
export interface Wake {
  id: number;
  trigger: WakeTrigger;
  target: string;
  sha: string;
  agent: string;
  due_at: string;
  status: "pending" | "starting" | "started" | "dropped";
  reason: string | null;
  session_id: string | null;
  created_at: string;
}

/** A message an agent sent to someone, kept so a reply reaches the session that wrote it. */
export interface SentMessage {
  id: number;
  platform: "telegram" | "discord";
  recipient: string;
  message_id: string | null;
  agent: string;
  session_id: string | null;
  text: string;
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
  origin: "telegram" | "discord" | "task" | "deployment" | "follow_up" | "github";
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

  async next(counter: "decision" | "task" | "review" | "finding" | "change"): Promise<number> {
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
        "SELECT id, ts, agent, session_id, event_type, tool, permission, substr(detail, 1, 300) AS detail FROM audit " +
          "WHERE ts >= ? AND ts < ? AND (permission = 'deny' OR event_type = 'gateway.tool_denied') ORDER BY id LIMIT ?",
      )
      .bind(since, until, limit)
      .all<{ id: number; ts: string; agent: string | null; session_id: string | null; event_type: string; tool: string | null; permission: string | null; detail: string | null }>()
      .then((r) => r.results);
  }

  /** Custom tool calls the gateway refused for bad input. */
  refusals(since: string, until: string, limit = 200) {
    return this.db
      .prepare(
        "SELECT id, ts, agent, session_id, event_type, tool, permission, substr(detail, 1, 300) AS detail FROM audit " +
          "WHERE ts >= ? AND ts < ? AND event_type = 'gateway.tool_refused' ORDER BY id LIMIT ?",
      )
      .bind(since, until, limit)
      .all<{ id: number; ts: string; agent: string | null; session_id: string | null; event_type: string; tool: string | null; permission: string | null; detail: string | null }>()
      .then((r) => r.results);
  }

  /** Status reports in [since, until) that listed blockers, cited as status:<id>. */
  blockedReports(since: string, until: string, limit = 200) {
    return this.db
      .prepare("SELECT id, agent, blocked, created_at FROM statuses WHERE created_at >= ? AND created_at < ? AND blocked != '[]' ORDER BY id LIMIT ?")
      .bind(since, until, limit)
      .all<{ id: number; agent: string; blocked: string; created_at: string }>()
      .then((r) =>
        r.results.map((s) => ({ id: `status:${s.id}`, agent: s.agent, blockers: JSON.parse(s.blocked) as string[], created_at: s.created_at })).filter((s) => s.blockers.length),
      );
  }

  /** Review findings dismissed in [since, until). */
  dismissedFindings(since: string, until: string, limit = 200) {
    return this.db
      .prepare(
        "SELECT id, target, area, summary, outcome_note FROM review_findings " +
          "WHERE outcome = 'dismissed' AND outcome_at >= ? AND outcome_at < ? ORDER BY seq LIMIT ?",
      )
      .bind(since, until, limit)
      .all<Pick<Finding, "id" | "target" | "area" | "summary" | "outcome_note">>()
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

  // ---- GitHub events and wakes (decision 62) --------------------------------

  async recordGitHubEvent(e: GitHubEvent) {
    await this.db
      .prepare("INSERT OR IGNORE INTO github_events (delivery, target, event, action, actor, association, sha, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(e.delivery, e.target.toLowerCase(), e.event, e.action, e.actor, e.association, e.sha, e.detail)
      .run();
  }

  /** What happened on the PRs and issues of a repo since `since`, oldest first. */
  async githubActivity(repo: string, since: string): Promise<GitHubEvent[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM github_events WHERE target LIKE ? AND received_at >= ? ORDER BY received_at ASC LIMIT 500")
      .bind(`${repo.toLowerCase()}#%`, since)
      .all<GitHubEvent>();
    return results;
  }

  /**
   * Queues a wake, once per trigger, target and head. Queuing one that is already
   * pending brings it forward if this one is due sooner. One that was dropped (say,
   * while the PR was a draft) is queued again as new, so its wait for CI starts over;
   * one that started never is. True if queued.
   */
  async queueWake(w: { trigger: WakeTrigger; target: string; sha?: string; agent: string; delayMinutes?: number }): Promise<boolean> {
    const r = await this.db
      .prepare(
        "INSERT INTO github_wakes (trigger, target, sha, agent, due_at) VALUES (?, ?, ?, ?, datetime('now', ?)) " +
          "ON CONFLICT (trigger, target, sha) DO UPDATE SET due_at = excluded.due_at, status = 'pending', reason = NULL, " +
          "created_at = CASE WHEN github_wakes.status = 'dropped' THEN datetime('now') ELSE github_wakes.created_at END " +
          "WHERE github_wakes.status = 'dropped' OR (github_wakes.status = 'pending' AND excluded.due_at < github_wakes.due_at)",
      )
      .bind(w.trigger, w.target.toLowerCase(), w.sha ?? "", w.agent, `+${w.delayMinutes ?? 0} minutes`)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Whether a review check for this PR is open or running. */
  async reviewCheckActive(target: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM tasks WHERE kind = 'review_check' AND lower(review_target) = ? AND status IN ('open', 'running') LIMIT 1")
      .bind(target.toLowerCase())
      .first();
    return !!row;
  }

  async dueWakes(limit: number): Promise<Wake[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM github_wakes WHERE status = 'pending' AND due_at <= datetime('now') ORDER BY due_at ASC, id ASC LIMIT ?")
      .bind(limit)
      .all<Wake>();
    return results;
  }

  /**
   * Claims a pending wake and one of its trigger's daily slots (UTC) in one statement,
   * so overlapping cron runs can't both start it or both pass the cap. A claimed wake
   * is 'starting' until it starts, is dropped, or is handed back to wait.
   */
  async claimWake(id: number, trigger: WakeTrigger, dailyCap: number): Promise<"claimed" | "cap" | "gone"> {
    const r = await this.db
      .prepare(
        "UPDATE github_wakes SET status = 'starting', started_at = datetime('now') WHERE id = ? AND status = 'pending' " +
          "AND (SELECT COUNT(*) FROM github_wakes WHERE trigger = ? AND status IN ('starting', 'started') AND started_at >= date('now')) < ?",
      )
      .bind(id, trigger, dailyCap)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return "claimed";
    const row = await this.db.prepare("SELECT status FROM github_wakes WHERE id = ?").bind(id).first<{ status: string }>();
    return row?.status === "pending" ? "cap" : "gone";
  }

  /** Hands a claimed wake back to wait `minutes`, e.g. while CI is still running; it no longer holds a daily slot. */
  async delayWake(id: number, minutes: number, reason: string) {
    await this.db
      .prepare("UPDATE github_wakes SET status = 'pending', started_at = NULL, due_at = datetime('now', ?), reason = ? WHERE id = ? AND status IN ('pending', 'starting')")
      .bind(`+${minutes} minutes`, reason, id)
      .run();
  }

  async startWake(id: number, sessionId: string) {
    await this.db.prepare("UPDATE github_wakes SET status = 'started', session_id = ? WHERE id = ?").bind(sessionId, id).run();
  }

  /** Drops a wake that hasn't started; a claimed one gives its daily slot back. */
  async dropWake(id: number, reason: string) {
    await this.db
      .prepare("UPDATE github_wakes SET status = 'dropped', started_at = NULL, reason = ? WHERE id = ? AND status IN ('pending', 'starting')")
      .bind(reason, id)
      .run();
  }

  /** Drops claims a cron run never finished (the Worker stopped mid-start). Returns how many. */
  async dropStuckWakes(minutes: number): Promise<number> {
    const r = await this.db
      .prepare("UPDATE github_wakes SET status = 'dropped', started_at = NULL, reason = 'claimed but never started' WHERE status = 'starting' AND started_at < datetime('now', ?)")
      .bind(`-${minutes} minutes`)
      .run();
    return r.meta?.changes ?? 0;
  }

  /** Drops every pending wake for a PR or issue, e.g. once it closes. */
  async dropWakesFor(target: string, reason: string): Promise<number> {
    const r = await this.db.prepare("UPDATE github_wakes SET status = 'dropped', reason = ? WHERE target = ? AND status = 'pending'").bind(reason, target.toLowerCase()).run();
    return r.meta?.changes ?? 0;
  }

  /** Puts a pending wake off until midnight UTC, when the daily cap resets. */
  async deferWake(id: number, reason: string) {
    await this.db.prepare("UPDATE github_wakes SET due_at = datetime(date('now', '+1 day')), reason = ? WHERE id = ? AND status = 'pending'").bind(reason, id).run();
  }

  /** "owner/repo#12@sha" for each review wake started at that head since `since`. */
  async reviewWokenHeads(repo: string, since: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT target, sha FROM github_wakes WHERE trigger = 'review' AND target LIKE ? AND status = 'started' AND started_at >= ?")
      .bind(`${repo.toLowerCase()}#%`, since)
      .all<{ target: string; sha: string }>();
    return new Set(results.map((r) => `${r.target}@${r.sha}`));
  }

  /**
   * Open PRs and issues the network tracks, for the daily check: targets of open GitHub
   * decisions, PRs whose latest review has no outcome, and pending wakes. Those checked
   * least recently come first, never-checked ones first of all, so a long list rotates.
   */
  async trackedTargets(limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        "SELECT t.target, MIN(t.at) AS at, c.checked_at FROM (" +
          "SELECT lower(target) AS target, created_at AS at FROM decisions WHERE status = 'open' AND kind LIKE 'github.%' AND target LIKE '%#%' " +
          "UNION ALL SELECT r.target, r.created_at AS at FROM reviews r WHERE r.outcome IS NULL AND r.seq = (SELECT MAX(seq) FROM reviews x WHERE x.target = r.target) " +
          "UNION ALL SELECT target, created_at AS at FROM github_wakes WHERE status = 'pending'" +
          ") t LEFT JOIN github_checks c ON c.target = t.target GROUP BY t.target ORDER BY c.checked_at IS NOT NULL, c.checked_at ASC, at ASC LIMIT ?",
      )
      .bind(limit)
      .all<{ target: string }>();
    return results.map((r) => r.target);
  }

  async markChecked(target: string) {
    await this.db
      .prepare("INSERT INTO github_checks (target, checked_at) VALUES (?, datetime('now')) ON CONFLICT (target) DO UPDATE SET checked_at = excluded.checked_at")
      .bind(target.toLowerCase())
      .run();
  }

  /** How many event ids starting with `prefix` were claimed, e.g. one day's daily-check targets. */
  async countClaims(prefix: string): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM processed_events WHERE event_id LIKE ?").bind(`${prefix}%`).first<{ n: number }>();
    return row?.n ?? 0;
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

  /** Decided decisions (approved, executed, failed or rejected) for one agent, or all when null, leaving out some kinds. */
  async countDecided(agent: string | null, excludeKinds: string[] = []): Promise<number> {
    const where = ["status IN ('approved', 'executed', 'failed', 'rejected')"];
    const args: unknown[] = [];
    if (agent) {
      where.push("agent = ?");
      args.push(agent);
    }
    if (excludeKinds.length) {
      where.push(`kind NOT IN (${excludeKinds.map(() => "?").join(",")})`);
      args.push(...excludeKinds);
    }
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${where.join(" AND ")}`).bind(...args).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The newest decision of `kind` for `target` requested since `since`, whatever its status. */
  latestDecisionFor(kind: string, target: string, since: string) {
    return this.db
      .prepare("SELECT * FROM decisions WHERE kind = ? AND target = ? AND created_at >= ? ORDER BY seq DESC LIMIT 1")
      .bind(kind, target, since)
      .first<Decision>();
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

  /** Open decisions on a PR or issue. Approved GitHub decisions run at once, so only open ones can lapse. */
  async openDecisionsOn(target: string): Promise<Decision[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM decisions WHERE lower(target) = ? AND status = 'open' ORDER BY seq ASC")
      .bind(target.toLowerCase())
      .all<Decision>();
    return results;
  }

  /** Closes a decision GitHub has moved past (decision 62). Returns false if it was no longer open. */
  async lapse(id: string, note: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE decisions SET status = 'lapsed', note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(note, id.toUpperCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async setChecksNow(id: string, checks: string) {
    await this.db.prepare("UPDATE decisions SET checks_now = ?, checks_at = datetime('now') WHERE id = ?").bind(checks, id.toUpperCase()).run();
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
    kind?: "change";
  }): Promise<Task> {
    const seq = await this.next("task");
    const id = `T-${seq}`;
    await this.db
      .prepare("INSERT INTO tasks (id, seq, agent, title, brief, priority, due, kind, review_target, review_sha, follows_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, seq, t.agent, t.title, t.brief, t.priority ?? "normal", t.due ?? null, t.review ? "review_check" : (t.kind ?? "task"), t.review?.target ?? null, t.review?.sha ?? null, t.follows_up ?? null)
      .run();
    return (await this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>())!;
  }

  // ---- changes ------------------------------------------------------------

  async createChange(c: { agent: string; decision_id: string; change_type: string; measure: string; tool?: string; kinds: string[] }): Promise<Change> {
    const seq = await this.next("change");
    const id = `C-${seq}`;
    await this.db
      .prepare("INSERT INTO changes (id, seq, agent, decision_id, change_type, measure, tool, kinds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, seq, c.agent, c.decision_id, c.change_type, c.measure, c.tool ?? null, JSON.stringify(c.kinds))
      .run();
    return (await this.getChange(id))!;
  }

  async getChange(id: string): Promise<Change | null> {
    return this.db.prepare("SELECT * FROM changes WHERE id = ?").bind(id).first<Change>();
  }

  async changeForTask(taskId: string): Promise<Change | null> {
    return this.db.prepare("SELECT * FROM changes WHERE task_id = ?").bind(taskId).first<Change>();
  }

  async updateChange(id: string, fields: Partial<Omit<Change, "id" | "seq">>): Promise<void> {
    const entries = Object.entries(fields).filter(([k, v]) => v !== undefined && k !== "updated_at");
    const sets = [...entries.map(([k]) => `${k} = ?`), "updated_at = datetime('now')"];
    await this.db
      .prepare(`UPDATE changes SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...entries.map(([, v]) => v), id)
      .run();
  }

  /** When the network was last deployed (the deploy workflow records each one), or null. */
  async lastDeployAt(): Promise<string | null> {
    const r = await this.db.prepare("SELECT ts FROM deploys ORDER BY ts DESC, rowid DESC LIMIT 1").first<{ ts: string }>();
    return r?.ts ?? null;
  }

  async changesIn(states: Change["state"][]): Promise<Change[]> {
    if (!states.length) return [];
    const res = await this.db
      .prepare(`SELECT * FROM changes WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY seq`)
      .bind(...states)
      .all<Change>();
    return res.results;
  }

  /**
   * Ids of other changes that went live in [from, to] and share `agent`'s figures: its own
   * and the network's, or every agent's when `agent` is the network.
   */
  async changesLiveBetween(agent: string, exceptId: string, from: string, to: string): Promise<string[]> {
    const res = await this.db
      .prepare("SELECT id FROM changes WHERE (? = 'network' OR agent IN (?, 'network')) AND id != ? AND live_at >= ? AND live_at <= ? ORDER BY seq")
      .bind(agent, agent, exceptId, from, to)
      .all<{ id: string }>();
    return res.results.map((r) => r.id);
  }

  /** Changes still open, plus those measured or closed since `since`; one agent's, or all. */
  async recentChanges(since: string, agent?: string): Promise<Change[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM changes WHERE (state NOT IN ('measured', 'closed') OR COALESCE(measured_at, updated_at) >= ?)" +
          (agent ? " AND agent = ?" : "") + " ORDER BY seq",
      )
      .bind(...(agent ? [since, agent] : [since]))
      .all<Change>();
    return res.results;
  }

  /** Changes measured in [since, until). */
  async changesMeasured(since: string, until: string): Promise<Change[]> {
    const res = await this.db
      .prepare("SELECT * FROM changes WHERE measured_at >= ? AND measured_at < ? ORDER BY seq")
      .bind(since, until)
      .all<Change>();
    return res.results;
  }

  /**
   * One side of a change's measure over [since, until): the figure, and how many cases it
   * rests on. `agent: "network"` counts every agent. Decisions count by when they were decided.
   */
  async measureWindow(
    m: { agent: string; measure: string; tool?: string; kinds: string[] },
    since: string,
    until: string,
  ): Promise<{ value: number | null; cases: number }> {
    const agent = m.agent === "network" ? null : m.agent;
    const ratio = (n: number, cases: number) => ({ value: cases ? n / cases : null, cases });

    if (m.measure === "tool_refusals") {
      const row = await this.db
        .prepare(
          "SELECT SUM(event_type = 'agent.custom_tool_use') AS calls, SUM(event_type IN ('gateway.tool_refused', 'gateway.tool_denied')) AS refused " +
            "FROM audit WHERE tool = ? AND ts >= ? AND ts < ?" + (agent ? " AND agent = ?" : ""),
        )
        .bind(m.tool ?? "", since, until, ...(agent ? [agent] : []))
        .first<{ calls: number | null; refused: number | null }>();
      return ratio(row?.refused ?? 0, row?.calls ?? 0);
    }

    const where = ["status IN ('approved', 'executed', 'failed', 'rejected')", "decided_at >= ?", "decided_at < ?"];
    const args: unknown[] = [since, until];
    if (agent) {
      where.push("agent = ?");
      args.push(agent);
    }
    if (m.measure === "repeat_rejections") {
      if (!m.kinds.length) return { value: null, cases: 0 };
      where.push(`kind IN (${m.kinds.map(() => "?").join(",")})`);
      args.push(...m.kinds);
    } else {
      where.push(`kind NOT IN (${NOT_JUDGEMENT.map(() => "?").join(",")})`);
      args.push(...NOT_JUDGEMENT);
    }
    const d = await this.db
      .prepare(
        "SELECT COUNT(*) AS decided, SUM(status IN ('approved', 'executed', 'failed')) AS approved, SUM(status = 'rejected') AS rejected " +
          `FROM decisions WHERE ${where.join(" AND ")}`,
      )
      .bind(...args)
      .first<{ decided: number; approved: number | null; rejected: number | null }>();
    const decided = d?.decided ?? 0;
    const approved = d?.approved ?? 0;
    if (m.measure === "approval_rate") return ratio(approved, decided);
    if (m.measure === "repeat_rejections") return ratio(d?.rejected ?? 0, decided);

    // cost_per_approval: list cost of the sessions started in the window per approved decision.
    const cost = await this.db
      .prepare("SELECT SUM(cost_cents) AS cents FROM sessions WHERE created_at >= ? AND created_at < ?" + (agent ? " AND agent = ?" : ""))
      .bind(since, until, ...(agent ? [agent] : []))
      .first<{ cents: number | null }>();
    return ratio(cost?.cents ?? 0, approved);
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
   * Blocks open and running tasks whose session is over (terminated, out of retries or
   * stale), or that never got a session in `days` days, with the reason. Returns their ids.
   */
  async blockAbandonedTasks(days: number, why: { ended: string; idle: string; unstarted: string }): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        "SELECT t.id, s.status AS session_status FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id " +
          "WHERE t.status IN ('open', 'running') AND (s.status IN ('terminated', 'done', 'stale', 'idle:retries_exhausted') " +
          "OR (t.session_id IS NULL AND t.created_at < datetime('now', ?))) ORDER BY t.seq",
      )
      .bind(`-${days} days`)
      .all<{ id: string; session_status: string | null }>();
    for (const r of results) {
      const reason = r.session_status === "stale" ? why.idle : r.session_status ? why.ended : why.unstarted;
      await this.db
        .prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(reason, r.id)
        .run();
    }
    return results.map((r) => r.id);
  }

  async setBlockedReason(id: string, reason: string) {
    await this.db.prepare("UPDATE tasks SET blocked_reason = ? WHERE id = ?").bind(reason, id).run();
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

  /** One review's findings, in the order they were posted. */
  async reviewFindings(reviewId: string): Promise<Finding[]> {
    const { results } = await this.db.prepare("SELECT * FROM review_findings WHERE review_id = ? ORDER BY seq ASC").bind(reviewId).all<Finding>();
    return results;
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

  // ---- messages agents send to people, so replies reach the right session ----

  /** Records a message before it's sent; returns the id a Discord Reply button carries. */
  async recordSent(m: { platform: "telegram" | "discord"; recipient: string; agent: string; session_id?: string | null; text: string }): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO sent_messages (platform, recipient, agent, session_id, text) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(m.platform, m.recipient, m.agent, m.session_id ?? null, m.text.slice(0, 4000))
      .first<{ id: number }>();
    return row!.id;
  }

  async setSentMessageId(id: number, messageId: string | number) {
    await this.db.prepare("UPDATE sent_messages SET message_id = ? WHERE id = ?").bind(String(messageId), id).run();
  }

  getSent(id: number) {
    return this.db.prepare("SELECT * FROM sent_messages WHERE id = ?").bind(id).first<SentMessage>();
  }

  findSent(platform: "telegram" | "discord", recipient: string | number, messageId: string | number) {
    return this.db
      .prepare("SELECT * FROM sent_messages WHERE platform = ? AND recipient = ? AND message_id = ? ORDER BY id DESC LIMIT 1")
      .bind(platform, String(recipient), String(messageId))
      .first<SentMessage>();
  }

  /** Sends a session's later replies to whoever answered one of its messages. */
  async setReplyTarget(sessionId: string, to: { telegram: number } | { discord: string }) {
    if ("telegram" in to) await this.db.prepare("UPDATE sessions SET chat_id = ? WHERE id = ?").bind(to.telegram, sessionId).run();
    else await this.db.prepare("UPDATE sessions SET discord_user = ? WHERE id = ?").bind(to.discord, sessionId).run();
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

  /**
   * Sessions still at work: running, or waiting on a tool result or a confirmation.
   * Least recently updated first, so a refresh reaches the stalest ones.
   */
  async liveSessions(limit = 100): Promise<(SessionRow & { created_at: string })[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM sessions WHERE status IN ('running', 'rescheduling', 'idle:requires_action') " +
          "ORDER BY updated_at ASC, rowid ASC LIMIT ?",
      )
      .bind(limit)
      .all<SessionRow & { created_at: string }>();
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
  async prune(eventDays: number, auditDays: number): Promise<{ events: number; tool_results: number; audit: number; sent_messages: number; github_events: number; github_wakes: number }> {
    const del = async (sql: string, days: number) =>
      (await this.db.prepare(sql).bind(`-${days} days`).run()).meta?.changes ?? 0;
    return {
      events: await del("DELETE FROM processed_events WHERE ts < datetime('now', ?)", eventDays),
      tool_results: await del("DELETE FROM tool_results WHERE created_at < datetime('now', ?)", eventDays),
      audit: await del("DELETE FROM audit WHERE ts < datetime('now', ?)", auditDays),
      sent_messages: await del("DELETE FROM sent_messages WHERE created_at < datetime('now', ?)", auditDays),
      github_events: await del("DELETE FROM github_events WHERE received_at < datetime('now', ?)", eventDays),
      github_wakes: await del("DELETE FROM github_wakes WHERE status != 'pending' AND created_at < datetime('now', ?)", auditDays),
    };
  }
}
