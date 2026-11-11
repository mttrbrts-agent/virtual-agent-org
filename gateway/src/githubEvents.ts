// GitHub events (decision 62): what the gateway's App tells it about the repos in scope.
// The gateway updates its own records in plain code: it lapses open decisions that can
// no longer run, refreshes merge cards' checks, records review outcomes, and queues
// work for Mira. Lapsing only ever closes a decision; nothing here approves or runs one.
// Events carry no rights (decision 33), and the gateway keeps no text from them.

import { inScope, safeJson } from "./actions";
import { AgentUnavailable, refreshDecisionCard, startSession } from "./agents";
import type { Ctx } from "./context";
import type { GitHubEvent, Wake } from "./db";
import { parseTarget, type RepoRef } from "./github";
import { FIRST_TIME, checklist, failed, mergeChecks, prFacts, type PrFacts } from "./review";

/** Decision kinds about one PR or issue that closing it makes pointless. */
export const ENDED_BY_CLOSE = ["github.merge", "github.close", "github.approve_ci", "github.comment"];
/** Decision kinds tied to one head commit (payload.sha). */
export const TIED_TO_HEAD = ["github.merge", "github.approve_ci"];

/** Minutes a review waits after a push or a new PR, so CI can start; CI finishing brings it forward. */
export const REVIEW_DELAY = 30;
/** Minutes a first response waits, in case the PR or issue is closed or edited at once. */
export const FIRST_RESPONSE_DELAY = 10;
/** How long a review waits on CI that hasn't finished, and how often it looks again. */
export const CI_WAIT = { hours: 24, minutes: 15 };
/**
 * Wakes the cron starts per run; PRs and issues the daily check reads per run, and in
 * all. Each costs up to four GitHub calls, so the check spreads over several runs
 * rather than exhaust one run's subrequests.
 */
export const WAKE_LIMIT = 10;
export const DAILY_CHECK = { perRun: 12, total: 100 };
/** A wake claimed this long ago that never started (the Worker stopped mid-start) is dropped. */
export const STUCK_MINUTES = 30;

type Payload = Record<string, any>;

/** An event the gateway uses, and whether the PR or issue was opened by a bot. */
export interface Normalised {
  event: GitHubEvent;
  authorBot: boolean;
}

const PR_ACTIONS = ["opened", "synchronize", "closed", "reopened", "ready_for_review", "converted_to_draft"];
const isBot = (user: Payload | undefined) => user?.type === "Bot" || String(user?.login ?? "").endsWith("[bot]");

/**
 * The PRs and issues a delivery is about, in the repos in scope. Empty for anything
 * the gateway doesn't use, including everything from the network's own repo.
 */
export async function normalise(ctx: Ctx, name: string, delivery: string, p: Payload): Promise<Normalised[]> {
  const full = String(p.repository?.full_name ?? "");
  const repo = parseTarget(full);
  if (!repo || !inScope(ctx, repo)) return [];
  const action = String(p.action ?? "");
  const actor = p.sender?.login ? String(p.sender.login) : null;
  const one = (number: number, e: Partial<GitHubEvent>, authorBot = false): Normalised[] => [
    {
      event: { delivery, target: `${full}#${number}`.toLowerCase(), event: name, action, actor, association: null, sha: null, detail: null, ...e },
      authorBot,
    },
  ];
  const pr = p.pull_request;
  switch (name) {
    case "pull_request":
      if (!PR_ACTIONS.includes(action)) return [];
      return one(
        pr.number,
        { sha: pr.head?.sha ?? null, association: pr.author_association ?? null, detail: action === "closed" ? (pr.merged ? "merged" : "closed") : null },
        isBot(pr.user),
      );
    case "pull_request_review":
      if (!["submitted", "dismissed"].includes(action)) return [];
      return one(pr.number, { sha: p.review?.commit_id ?? pr.head?.sha ?? null, detail: String(p.review?.state ?? "").toLowerCase() || null });
    case "pull_request_review_thread":
      if (!["resolved", "unresolved"].includes(action)) return [];
      return one(pr.number, {});
    case "issues":
      if (!["opened", "closed", "reopened"].includes(action) || p.issue?.pull_request) return [];
      return one(p.issue.number, { association: p.issue.author_association ?? null, detail: action === "closed" ? String(p.issue.state_reason ?? "closed") : null }, isBot(p.issue.user));
    case "issue_comment":
      if (action !== "created" || isBot(p.comment?.user)) return [];
      return one(p.issue.number, { association: p.comment?.author_association ?? null });
    case "workflow_run": {
      const run = p.workflow_run;
      if (action !== "completed" || !["pull_request", "pull_request_target"].includes(run?.event)) return [];
      const numbers = await runPulls(ctx, repo, run);
      return numbers.flatMap((n) => one(n, { sha: run.head_sha, detail: run.conclusion ?? null }));
    }
    default:
      return [];
  }
}

/**
 * The PRs a workflow run belongs to. GitHub names them for branches in the repo; for a
 * fork it names none, so the gateway finds the open PR with that head.
 */
async function runPulls(ctx: Ctx, repo: RepoRef, run: Payload): Promise<number[]> {
  const listed = (run.pull_requests ?? []).filter((x: Payload) => x.base?.repo?.id === undefined || x.base.repo.id === run.repository?.id);
  if (listed.length) return listed.map((x: Payload) => Number(x.number));
  const open = await (await ctx.github()).openPulls(repo);
  return open.filter((x) => x.headRefOid === run.head_sha).map((x) => x.number);
}

/** Records one event and applies it. Never throws: a failure is audited, and the daily check catches up. */
export async function applyEvent(ctx: Ctx, n: Normalised): Promise<void> {
  const e = n.event;
  try {
    await ctx.db.recordGitHubEvent(e);
    const first = FIRST_TIME.includes((e.association ?? "").toUpperCase()) && !n.authorBot;
    switch (`${e.event}.${e.action}`) {
      case "pull_request.closed":
      case "issues.closed": {
        // Deliveries can arrive late or out of order: a close processed after a reopen
        // must not lapse decisions on what is open again, so ask GitHub how it is now.
        const { state } = await (await ctx.github()).issueState(parseTarget(e.target) as Required<RepoRef>);
        if (state !== "open") await onClosed(ctx, e.target, state, e.actor);
        break;
      }
      case "pull_request.synchronize": {
        // Likewise a late push: lapse and review against the head as it is now.
        const pr = await (await ctx.github()).pull(parseTarget(e.target) as Required<RepoRef>);
        if (pr.state !== "open") break;
        await lapseOldHeads(ctx, e.target, pr.head.sha);
        await queueReview(ctx, e.target, pr.head.sha, REVIEW_DELAY);
        break;
      }
      case "pull_request.opened":
      case "pull_request.reopened":
      case "pull_request.ready_for_review":
        await queueReview(ctx, e.target, e.sha!, REVIEW_DELAY);
        if (e.action === "opened" && first) await queueFirstResponse(ctx, e.target);
        break;
      case "issues.opened":
        if (first) await queueFirstResponse(ctx, e.target);
        break;
      case "workflow_run.completed":
        if (e.detail === "success") await queueReview(ctx, e.target, e.sha!, 0);
        await onPrMoved(ctx, e.target);
        break;
      case "pull_request_review.submitted":
      case "pull_request_review.dismissed":
      case "pull_request_review_thread.resolved":
      case "pull_request_review_thread.unresolved":
        await onPrMoved(ctx, e.target);
        break;
    }
    await ctx.db.audit({ event_type: `github.${e.event}.${e.action}`, detail: { target: e.target, delivery: e.delivery, ...(e.detail ? { detail: e.detail } : {}) } });
  } catch (err) {
    await ctx.db
      .audit({ event_type: "gateway.github_event_error", detail: { target: e.target, event: `${e.event}.${e.action}`, error: err instanceof Error ? err.message : String(err) } })
      .catch(() => undefined);
  }
}

/** A PR or issue was merged or closed: its open decisions lapse, its review gets an outcome, its wakes are dropped. */
export async function onClosed(ctx: Ctx, target: string, how: "merged" | "closed", actor: string | null) {
  const by = actor ? ` by ${actor}` : "";
  for (const d of await ctx.db.openDecisionsOn(target)) {
    if (ENDED_BY_CLOSE.includes(d.kind)) await lapse(ctx, d.id, d.agent, `${how} on GitHub${by}`);
  }
  const review = await ctx.db.latestReview(target);
  if (review && !review.outcome) await ctx.db.setReviewOutcome(target, how, `${how} on GitHub${by}`);
  await ctx.db.dropWakesFor(target, `${how} on GitHub`);
}

/** New commits: decisions made for an older head lapse, since the gateway's head check would refuse them. */
export async function lapseOldHeads(ctx: Ctx, target: string, head: string) {
  for (const d of await ctx.db.openDecisionsOn(target)) {
    const sha = String(safeJson(d.payload).sha ?? "");
    if (TIED_TO_HEAD.includes(d.kind) && sha && !head.startsWith(sha)) {
      await lapse(ctx, d.id, d.agent, `new commits: the head is now ${head.slice(0, 7)}, this was for ${sha.slice(0, 7)}`);
    }
  }
}

async function lapse(ctx: Ctx, id: string, agent: string, why: string) {
  if (!(await ctx.db.lapse(id, why))) return;
  await ctx.db.audit({ agent, event_type: "gateway.decision_lapsed", detail: { id, why } });
  await refreshDecisionCard(ctx, id);
}

/**
 * CI finished, or a review or thread changed: open merge cards get their checks re-run,
 * and a reviewed PR whose merge checks now all pass gets a merge wake. Reads GitHub only
 * when there is a merge card or a merge to propose.
 */
export async function onPrMoved(ctx: Ctx, target: string, facts?: PrFacts) {
  const merges = (await ctx.db.openDecisionsOn(target)).filter((d) => d.kind === "github.merge");
  const review = await ctx.db.latestReview(target);
  const proposable = !!review && review.verdict !== "request_changes" && !review.merge_decision_id;
  if (!merges.length && !proposable) return;
  const ref = parseTarget(target) as Required<RepoRef>;
  const f = facts ?? (await prFacts(ctx, ref));
  await lapseOldHeads(ctx, target, f.sha);
  const atHead = await ctx.db.latestReview(f.target, f.sha);
  for (const d of merges) {
    const now = await ctx.db.getDecision(d.id);
    if (now?.status !== "open") continue;
    await ctx.db.setChecksNow(d.id, checklist(mergeChecks(f, String(safeJson(d.payload).sha ?? ""), atHead)));
    await refreshDecisionCard(ctx, d.id);
  }
  if (proposable && review!.sha === f.sha && !merges.length && !failed(mergeChecks(f, f.sha, review)).length) {
    await ctx.db.queueWake({ trigger: "merge", target, sha: f.sha, agent: "mira" });
  }
}

async function queueReview(ctx: Ctx, target: string, sha: string, delayMinutes: number) {
  if (!sha || (await ctx.db.latestReview(target, sha))) return;
  await ctx.db.queueWake({ trigger: "review", target, sha, agent: "mira", delayMinutes });
}

async function queueFirstResponse(ctx: Ctx, target: string) {
  await ctx.db.queueWake({ trigger: "first_response", target, agent: "mira", delayMinutes: FIRST_RESPONSE_DELAY });
}

/** Days of activity pr_queue shows for each PR. */
export const ACTIVITY_DAYS = 3;

/** What moved on one PR, from its events (oldest first), e.g. "2 pushes, 3 comments; CI failure". Empty if nothing did. */
export function activityLine(events: Pick<GitHubEvent, "event" | "action" | "detail">[]): string {
  const count = (event: string, action: string) => events.filter((e) => e.event === event && e.action === action).length;
  const n = (k: number, one: string, many: string) => (k ? [`${k} ${k === 1 ? one : many}`] : []);
  const parts = [
    ...n(count("pull_request", "synchronize"), "push", "pushes"),
    ...n(count("issue_comment", "created"), "comment", "comments"),
    ...n(count("pull_request_review", "submitted"), "review", "reviews"),
    ...n(count("pull_request_review_thread", "resolved"), "thread resolved", "threads resolved"),
  ];
  const ci = events.filter((e) => e.event === "workflow_run").at(-1)?.detail;
  if (!parts.length && !ci) return "";
  return `last ${ACTIVITY_DAYS} days: ${parts.join(", ") || "no pushes or comments"}${ci ? `; latest CI ${ci}` : ""}`;
}

// ---- starting the work ------------------------------------------------------------

type Verdict = { go: true; facts?: PrFacts } | { drop: string } | { wait: number; why: string };

/**
 * Starts the wakes that are due, within the guards: the trigger is on, schedules are
 * on (this is work nobody asked for), Mira is active, and the trigger's daily cap isn't
 * reached. Each wake is claimed with a daily slot in one statement, so overlapping cron
 * runs can't both start it, then re-reads the PR and is dropped if it no longer applies.
 * Never throws; every start, drop and delay is audited.
 */
export async function dispatchWakes(ctx: Ctx, limit = WAKE_LIMIT) {
  const stuck = await ctx.db.dropStuckWakes(STUCK_MINUTES);
  if (stuck) await ctx.db.audit({ event_type: "gateway.wakes_unstuck", detail: { dropped: stuck } });
  for (const w of await ctx.db.dueWakes(limit)) {
    try {
      const cfg = ctx.network.github_wakes?.[w.trigger];
      if (!cfg || cfg.daily <= 0) {
        await drop(ctx, w, `${w.trigger} wakes are off (budgets.github_wakes)`);
        continue;
      }
      if (!ctx.network.schedules_enabled) {
        await drop(ctx, w, "schedules are off (network.schedules_enabled)");
        continue;
      }
      const status = await ctx.db.agentStatus(w.agent);
      if (status !== "active") {
        await drop(ctx, w, `${w.agent} is ${status}`);
        continue;
      }
      const claim = await ctx.db.claimWake(w.id, w.trigger, cfg.daily);
      if (claim === "gone") continue; // another run has it
      if (claim === "cap") {
        await ctx.db.deferWake(w.id, `daily cap of ${cfg.daily} ${w.trigger} wakes reached`);
        continue;
      }
      const v = await recheck(ctx, w);
      if ("drop" in v) await drop(ctx, w, v.drop);
      else if ("wait" in v) await ctx.db.delayWake(w.id, v.wait, v.why);
      else await start(ctx, w, cfg.budget_cents, v.facts);
    } catch (err) {
      const why = err instanceof AgentUnavailable ? err.message : `error: ${err instanceof Error ? err.message : String(err)}`;
      await drop(ctx, w, why).catch(() => undefined);
    }
  }
}

async function drop(ctx: Ctx, w: Wake, why: string) {
  await ctx.db.dropWake(w.id, why);
  await ctx.db.audit({ agent: w.agent, event_type: "gateway.wake_dropped", detail: { trigger: w.trigger, target: w.target, sha: w.sha || undefined, why } });
}

/** Whether the wake still applies, by the PR as it is now. */
async function recheck(ctx: Ctx, w: Wake): Promise<Verdict> {
  const ref = parseTarget(w.target) as Required<RepoRef>;
  if (w.trigger === "first_response") {
    // Asks GitHub, not the events received: the close delivery may have been missed.
    const { state } = await (await ctx.github()).issueState(ref);
    return state === "open" ? { go: true } : { drop: `${state} before the first response` };
  }
  const f = await prFacts(ctx, ref);
  if (f.state !== "OPEN") return { drop: `the PR is ${f.state.toLowerCase()}` };
  if (f.draft) return { drop: "the PR is a draft" };
  if (!f.sha.startsWith(w.sha)) return { drop: `new commits: the head is now ${f.sha.slice(0, 7)}` };
  if (await ctx.db.reviewCheckActive(w.target)) return { drop: "a review check for this PR is already running" };
  const review = await ctx.db.latestReview(f.target, f.sha);
  if (w.trigger === "review") {
    if (review) return { drop: `already reviewed at ${f.sha.slice(0, 7)}` };
    if (f.ci === "failure") return { drop: "CI failed at this head" };
    // "none" means nothing has reported yet, not that CI passed: keep waiting.
    if (f.ci === "success") return { go: true, facts: f };
    const waited = (Date.now() - Date.parse(`${w.created_at.replace(" ", "T")}Z`)) / 3_600_000;
    return waited >= CI_WAIT.hours ? { drop: `CI still ${f.ci} after ${CI_WAIT.hours} hours` } : { wait: CI_WAIT.minutes, why: `CI is ${f.ci}` };
  }
  if (!review || review.verdict === "request_changes") return { drop: `no review with nothing blocking at ${f.sha.slice(0, 7)}` };
  if (review.merge_decision_id) return { drop: `a merge was already proposed (${review.merge_decision_id})` };
  if ((await ctx.db.openDecisionsOn(w.target)).some((d) => d.kind === "github.merge")) return { drop: "a merge card is already open" };
  const bad = failed(mergeChecks(f, f.sha, review));
  if (bad.length) return { drop: `merge checks fail: ${bad.map((c) => c.name).join(", ")}` };
  return { go: true, facts: f };
}

async function start(ctx: Ctx, w: Wake, budgetCents: number, f?: PrFacts) {
  let sessionId: string;
  if (w.trigger === "merge") {
    const sha7 = w.sha.slice(0, 7);
    const brief = mergeBrief(f!);
    const task = await ctx.db.createTask({ agent: w.agent, title: `Merge proposal: ${f!.target}@${sha7}`, brief, review: { target: f!.target, sha: sha7 } });
    try {
      sessionId = await startSession(ctx, w.agent, brief, "task", "schedule", { taskId: task.id, budgetCents });
    } catch (e) {
      await ctx.db.setTask(task.id, "failed");
      throw e;
    }
    await ctx.db.setTask(task.id, "running", sessionId);
  } else {
    sessionId = await startSession(ctx, w.agent, wakePrompt(w), "github", "schedule", { budgetCents });
  }
  await ctx.db.startWake(w.id, sessionId);
  await ctx.db.audit({ agent: w.agent, session_id: sessionId, event_type: "gateway.wake_started", detail: { trigger: w.trigger, target: w.target, sha: w.sha || undefined } });
}

/** What a review or first-response wake tells Mira: the trigger, target and head, nothing from GitHub. */
export function wakePrompt(w: Pick<Wake, "trigger" | "target" | "sha">): string {
  if (w.trigger === "review") {
    return [
      `GitHub wake: review ${w.target} at ${w.sha.slice(0, 7)}. CI has finished and there is no review at this head.`,
      'Follow "When the gateway wakes you", Review, in your instructions, for this PR only. Then end the session.',
    ].join("\n");
  }
  return [
    `GitHub wake: first response to ${w.target}, opened by a first-time contributor.`,
    'Follow "When the gateway wakes you", First response, in your instructions, for this one PR or issue only. Then end the session.',
  ].join("\n");
}

/**
 * A merge proposal from a review check that skips the review: one with nothing blocking
 * is already posted at this head, and the gateway's merge checks now pass. It runs as a
 * review check, the only place a merge proposal may come from; submit_review refuses a
 * second review at the same head.
 */
export function mergeBrief(f: PrFacts): string {
  const sha7 = f.sha.slice(0, 7);
  return [
    `GitHub wake: ${f.target} at ${sha7} has a posted review with nothing blocking, and the gateway's merge checks now pass.`,
    "You are the review check for this head. The review is already posted: don't call submit_review.",
    "",
    `1. Call pr_facts for ${f.target}. If the head is no longer ${sha7}, or a merge check fails, stop and say so in report_status.`,
    `2. Queue request_action(kind="github.merge") with payload {sha: "${f.sha}", merge_method: "squash"}. Write the rationale so`,
    "   Matt can check the merge from the card alone:",
    "   - what the change does, in plain English, and any effect on public APIs, the build or dependencies;",
    "   - the discussion: the author's description, each review and comment with its author, resolved threads and how",
    "     they were resolved, and any open questions;",
    "   - the review decision id, and the CI run and its result.",
    "   If the gateway refuses, put the reasons in report_status; don't retry.",
    "3. Call report_status and end the session.",
  ].join("\n");
}

// ---- the daily check ----------------------------------------------------------------

/** The local date and whether it is past the daily check's time (05:30 in the network's timezone). */
export function dailyCheckDue(timezone: string, now = new Date()): { date: string; due: boolean } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, due: Number(parts.hour) * 60 + Number(parts.minute) >= 5 * 60 + 30 };
}

/**
 * GitHub doesn't retry failed deliveries, so once a day the gateway re-reads the open
 * PRs and issues the network tracks and applies the same rules. It never lists whole
 * repos. Runs from the five-minute cron: each run after 05:30 local time takes the
 * targets checked least recently, a few at a time, until the day's allowance is used or
 * none are left. Since the least recently checked go first, a list longer than the
 * allowance rotates over the following days instead of starving its newest targets.
 */
export async function dailyCheck(ctx: Ctx, now = new Date()) {
  const { date, due } = dailyCheckDue(ctx.network.timezone, now);
  if (!due) return;
  const claimed = `github-daily:${date}:`;
  let budget = Math.min(DAILY_CHECK.perRun, DAILY_CHECK.total - (await ctx.db.countClaims(claimed)));
  let checked = 0;
  const closed: string[] = [];
  const errors: string[] = [];
  for (const target of await ctx.db.trackedTargets(DAILY_CHECK.total)) {
    if (budget <= 0) break;
    const ref = parseTarget(target);
    if (!ref?.number || !inScope(ctx, ref)) continue;
    if (!(await ctx.db.claimEvent(`${claimed}${target}`))) continue;
    budget--;
    await ctx.db.markChecked(target);
    try {
      const { state, pr } = await (await ctx.github()).issueState(ref as Required<RepoRef>);
      checked++;
      if (state !== "open") {
        closed.push(target);
        await onClosed(ctx, target, state, null);
        continue;
      }
      if (!pr) continue;
      const f = await prFacts(ctx, ref as Required<RepoRef>);
      await lapseOldHeads(ctx, target, f.sha);
      await onPrMoved(ctx, target, f);
      if (!f.draft && f.ci === "success") await queueReview(ctx, target, f.sha, 0);
    } catch (err) {
      errors.push(`${target}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }
  if (checked || errors.length) await ctx.db.audit({ event_type: "gateway.github_daily_check", detail: { date, checked, closed, errors } });
}
