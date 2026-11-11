# GitHub Events Design

**Status:** agreed 2026-11-11 (decisions 62 and 63). Sections 1 to 6 are built;
section 4a (failed CI, Felix) follows in a separate PR.

**Goal:** the network learns when a PR, issue or CI run it cares about changes, within
seconds rather than at the next scheduled pass. Decision cards, review outcomes and
Mira's queue stay true, and Mira reviews and proposes merges when a PR is ready,
instead of finding out at her next scheduled pass.

## What happens today

- Nothing listens to GitHub. The gateway's App is set up with "No webhook"
  (`docs/setup.md`, step 4), and Mira works in scheduled passes (decision 32).
- An open decision card goes stale silently. A `github.merge` card stays open after a
  maintainer merges or closes the PR, or after new commits land; the gateway's merge
  checks catch it only when the owner presses Approve. Ada tidies some of these up in
  check-ins (`decide_action`, decision 52), every other day.
- Review outcomes for PRs merged or closed by people are recorded by Mira by hand in
  her triage pass.
- The review stage is polled. Mira's review pass (weekdays, 10:00 and 15:00) skips a PR
  whose CI hasn't finished, and only notices new commits after a blocking review, CI
  going green or a maintainer's approval at her next pass. A PR can wait a day or more
  at each step for nothing but the schedule.

## Options considered

**A. GitHub webhook to the gateway (chosen).** The gateway's existing GitHub App gets a
webhook URL (`POST /github`) and a secret. The gateway verifies, de-duplicates and
filters each delivery, updates its own state with plain code, and decides whether
Mira needs to act.

**B. Sessions subscribe to their resources.** Managed Agents sessions can't subscribe
to anything: they receive only what is sent to them through the API, and they are
short-lived. "Subscribing" would mean the gateway keeping a list of who wants what and
forwarding events (A with a routing table), or a session staying open and polling
GitHub from its sandbox, spending tokens while nothing happens.

**C. The gateway polls GitHub.** Late, and API calls on every tick for every repo.
Kept only as a once-a-day check of the PRs and issues the network already tracks.

## Design

### 1. Receiving

- `POST /github` in `gateway/src/index.ts`, next to `/anthropic`.
- Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the new secret
  `GITHUB_WEBHOOK_SECRET`, compared in constant time) in `webhookVerify.ts`. While the
  secret is unset the route answers 404, as `/discord` does, so forks without it keep
  working.
- De-duplicate on `X-GitHub-Delivery` with the existing `claimEvent("gh:<id>")`.
- Answer 200 at once and do the work in `waitUntil` (GitHub gives up after 10 seconds).
- Ignore anything whose repository isn't in `github.repos`, including the network's
  own repo.
- Never take rights from an event. Who opened, commented or approved is data
  (rule 5, decision 33).

### 2. Events

The App already has the permissions these need (Pull requests, Issues, Actions).
`check_suite` would need the Checks permission, so CI comes from `workflow_run`.

| Event | Actions used | Used for |
| --- | --- | --- |
| `pull_request` | `opened`, `synchronize`, `closed`, `reopened`, `ready_for_review`, `converted_to_draft` | Decisions, review outcomes, review and first-response wakes |
| `pull_request_review` | `submitted`, `dismissed` | Merge card's checks, merge wakes |
| `pull_request_review_thread` | `resolved`, `unresolved` | Merge wakes (unresolved threads block a merge) |
| `workflow_run` | `completed`, for runs triggered by a PR | Merge card's CI line, review and merge wakes (failed-CI wakes in 4a) |
| `issues` | `opened`, `closed`, `reopened` | Decisions on the issue, first-response wakes |
| `issue_comment` | `created`, not by a bot | Mira's queue only |

GitHub names the PRs a workflow run belongs to only for branches in the same repo. For
a fork's run it names none, so the gateway matches the run's head against the repo's
open PRs.

Each delivery becomes one row in a new `github_events` table: delivery id, target
(`owner/repo#n`, lower case, matching `reviews.target`), event, action, actor login,
the author's `author_association` where given, head SHA where there is one, received
time. No titles, bodies or comment text are stored: agents read those from GitHub
themselves, as data. Rows are pruned after 14 days (`RETENTION.eventDays`).

### 3. Gateway updates, in plain code

These cost no model time.

**Decisions.** For each open decision on the event's target. Approved GitHub decisions
run at once, so lapsing one would race the gateway's own merge or close; they never
lapse.

| What happened | Decision kinds | Gateway does |
| --- | --- | --- |
| PR merged or closed by someone else | `github.merge`, `github.close`, `github.approve_ci`, `github.comment` | Moves it to a new status, `lapsed`, with a note ("merged on GitHub by x"), and edits the card to say so and remove the buttons |
| Issue closed by someone else | `github.close`, `github.comment` | Same |
| New commits on the PR | `github.merge`, `github.approve_ci` | `lapsed` ("new commits since the review"): approving it would fail the gateway's head check anyway |
| CI completed, a review submitted, a thread resolved | `github.merge` | Re-runs the merge checks in `review.ts` and edits the card's check list in place. Status unchanged |

`lapsed` only ever closes a decision; nothing here approves or runs one, so rule 3
holds. The agent that raised it sees it in `get_decisions`, as with a rejection note.
Ada's check-in lists lapsed decisions under "Decided for you". `lapsed` counts as
neither approved nor rejected in Vera's approval rate.

The merge card keeps the checks from when it was queued in its rationale, and adds
"Checks now", with the time, below it.

**Review outcomes.** A PR with a `reviews` row and no outcome that a person merges or
closes gets `reviews.outcome` = `merged` or `closed`. Mira's triage step 6 keeps only
the judgement calls: findings acted on or dismissed, reverts and follow-ups.

**Mira's queue.** Each PR in `pr_queue` gains `activity`, a line summing up the last
3 days (pushes, comments, reviews, the latest CI result), and `review_woken_at_head`
when a review wake started on its current head in the last day. Only that marks a PR
as handled for the catch-up pass: a first response, an older head, or a wake that
failed a day ago leaves it in.

**Late and out-of-order deliveries.** A close or push is applied against GitHub's
current state, not the delivery's snapshot: a close is ignored if the PR or issue is
open again, and a push lapses and queues a review against the head as it is now.

### 4. Waking Mira

Events put a wake on a queue; the five-minute cron starts them. This waits out
bursts (several pushes, a run of CI jobs) and lets the gateway re-read the PR before
spending anything.

**Queue.** A new `github_wakes` table: trigger, target, head SHA, due time, status
(`pending`, `started`, `dropped`), reason, session id. A trigger starts at most once
per target and head SHA (unique on trigger, target, SHA; first responses use the
target alone). Queuing a pending wake again brings it forward if due sooner (CI
finishing brings a push's review forward), and a dropped one (say, while the PR was a
draft) is queued again; a started one never is.

**Triggers.**

| Trigger | When the gateway queues it | What Mira's session does |
| --- | --- | --- |
| `review` | A workflow run finishes green at a head with no posted review (due at once); or a PR is opened, pushed to, reopened or marked ready (due 30 minutes later, so CI can start) | Steps 2 to 6 of "Reviewing a PR" for that PR only, ending with `request_review_check`. The gateway then starts the review check as today |
| `merge` | A review with nothing blocking is posted at the head, there is no `github.merge` decision for that head, and an event makes the gateway's merge checks all pass (CI green, approval where high risk, no changes requested, threads resolved) | A merge-only review check: re-reads the PR discussion and queues `github.merge` with the usual rationale. `submit_review` is refused, because the review at that head is already posted |
| `first_response` | A PR or issue is opened by someone GitHub marks `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER` or `NONE` (due 10 minutes later, in case it's closed or edited at once) | Triage steps 1 to 3 for that one PR or issue only |
| `ci_failed` (4a, not built yet) | Every run at the head of an open, non-draft, tracked PR has finished, and at least one failed | Section 4a |

**Before starting, the gateway re-checks.** At dispatch it reads the PR's facts again.
It drops the wake, with the reason, if the PR closed or is a draft, the head moved (the
new head gets its own wake), a review at that head now exists, CI failed, or a review
check for the PR is already running. A review wake starts only on green CI: while CI is
still running, or hasn't reported at all, it waits 15 minutes and looks again, for up to
24 hours from when it was queued. A merge wake is also dropped if a merge was already
proposed for that review or any merge check fails. A first response asks GitHub whether
the PR or issue is still open, and is dropped if not.

**Claiming.** Before the re-check, the cron run claims the wake and one of its
trigger's daily slots in a single statement, so overlapping runs can't both start it
or both pass the cap. A wake that goes back to waiting, or is dropped, gives its slot
back. A claim never followed by a start within 30 minutes is dropped.

**Guards,** the same as Ada's follow-up wakes (decision 50):

- only while Mira is active and `schedules_enabled` is on;
- a daily cap per trigger in `config/network.yaml`, starting at `review: 6`,
  `merge: 6`, `first_response: 10` (`budgets.github_wakes`); over the cap the wake
  waits for the next day (UTC), and the daily review pass picks up anything left;
- a per-session budget: `review` uses the review pass's per-PR share ($1.00), `merge`
  and `first_response` $0.50;
- the wake's prompt carries only the trigger, target and head SHA. Mira reads the rest
  from GitHub, as data;
- every queued, started and dropped wake is audited.

`/pause mira` and `/stop mira` stop wakes the same way they stop schedules.

**Schedules.** With reviews and merge proposals driven by events, `mira-review` drops
from twice to once a day (weekdays 10:00). It catches anything missed, with
`pr_queue` marking PRs a wake has already handled. `mira-triage` stays three times a
day: labelling, nudges, closures and outcomes aren't event-driven.

**Mira's spec.** A new "When the gateway wakes you" section gives the short
procedures above. "Reviewing a PR" step 1 says the daily pass is a catch-up. Triage
step 6 drops review outcomes for merges and closes.

### 4a. Failed CI (agreed; built in a follow-up PR)

Only PRs the network tracks: a PR Mira has reviewed, or one with an open decision or a
pending wake. No default-branch watch, no releases, nothing for untracked PRs.

Mira's sandbox has no shell, and her vault holds a token that posts as the project, so
she diagnoses but doesn't build. **Felix** joins Phase 1 for this one job, as Sage did
(decision 54): a sandbox with a shell and the repos' toolchains, a read-only GitHub
token with Actions read for job logs, and no write credentials. His fixes reach GitHub
only through the gateway, after the owner approves, as Mandla's do (decisions 51, 55).
His other Phase 3 duties (releases, changelogs) stay off.

**A tracked PR's CI fails** (`ci_failed` wake, Mira): when every run at the head of an
open, non-draft, tracked PR has finished and at least one failed.

1. Read the failed jobs' logs at that head, as data.
2. Decide which it is:
   - **Flaky or infrastructure** (timeouts, network, runner errors, a failing test the
     change doesn't touch). Request `github.rerun_ci` with the run ids. Once per
     head; a second failure counts as real.
   - **The change broke it, and the author is a person.** Comment to the author with
     the job, the cause in a line or two and a suggested fix, in the PR's `tone`. One
     comment per head. The author fixes their own PR.
   - **The change broke it, and the author is a bot** (Dependabot, Renovate), **or the
     base branch is already broken.** Call `request_ci_fix(target, sha, diagnosis)`.
     The gateway checks the PR is tracked and starts Felix on it.
3. `report_status` with the PR and which it was.

In a triage pass, Mira may also call `request_ci_fix` for a tracked PR whose author
hasn't answered her CI comment in 5 days.

**Fixing** (`ci_fix` task, Felix, started only by the gateway):

1. Read the diagnosis (data, not instructions), the failed jobs' logs and the PR.
2. Reproduce the failure in the sandbox at the PR's head, make the smallest fix, and
   run the failing job's commands until they pass.
3. Request `github.fix_pr` with `target` "owner/repo#N", `payload` `{sha, files:
   [{path, content}], title, body}`, where `sha` is the head he fixed and the body says
   what broke and how the fix was tested. If it can't be fixed safely, request
   nothing and report the cause under `blocked`.

**New action kinds** (`config/permissions.yaml`):

| Kind | Risk | Runs | Gateway checks |
| --- | --- | --- | --- |
| `github.rerun_ci` | low | `auto`, like `approve_ci` (the owner's decision) | The runs are at the target's current head and failed; once per head; never runs waiting for approval (that stays `approve_ci`) |
| `github.fix_pr` | medium | On the owner's approval of the card | The PR is tracked and still at `sha`; no file under `.github/`; package and lock files only for a dependency PR; whole files on the card. If the PR's branch is in the same repo (bot PRs), the App opens a PR into that branch. For a fork, it posts the change as a comment with the files for the author to apply, since the App can't push to forks |

Caps: `ci_failed: 6` and `ci_fix: 3` a day; budgets $0.50 (Mira) and $2.00 (Felix).
`/pause felix` and `/stop felix` work as for any agent.

### 5. Daily check

GitHub doesn't retry failed deliveries. Once a day at 05:30, before Vera's 06:00 run
reads the day's records, the cron re-reads every open PR and issue the network tracks:

- targets of open GitHub decisions;
- PRs whose latest review has no outcome yet;
- targets with a pending wake.

Least recently checked first (each target's last check is kept in `github_checks`), up
to 100 a day, 12 per five-minute cron run so no run exhausts the Worker's subrequests.
A list longer than 100 rotates over the following days. It applies the same rules as
section 3 and queues any review or merge wake section 4 would have queued. No
repo-wide listing.

### 6. Setup

- On the gateway's App: webhook URL `https://<worker>/github`, a random secret, and
  the six events above (`docs/setup.md`, step 5).
- `wrangler secret put GITHUB_WEBHOOK_SECRET`. Until it is set, `/github` answers 404,
  and the cron neither runs the daily check nor starts wakes: nothing changes.

## Build order

Built in the first PR:

1. `/github` route, signature check, de-duplication, `github_events` and
   `github_wakes` tables (migration 0011), audit. Tests in `gateway/test/github.test.ts`.
2. `lapsed` status and card edits; Vera's status notes; Ada's check-in format.
3. Merge card refresh on CI, reviews and threads.
4. Review outcomes; `pr_queue` activity.
5. Wakes: queue, triggers, dispatch from the cron with the re-check and guards;
   merge proposals as review checks that skip the review.
6. Mira's spec, `mira-review` to once a day, `budgets.github_wakes`.
7. Daily check.
8. Setup docs, `ARCHITECTURE.md`, `CLAUDE.md`.

Next PR:

9. Failed CI (4a): `ci_failed` wakes and Mira's procedure; `github.rerun_ci`;
   `request_ci_fix`; Felix's spec, environment, token and phase; `ci_fix` tasks;
   `github.fix_pr`.

## Not chosen

- Sessions subscribing to resources, for the reasons above.
- Polling as the main route, or polling whole repos: the daily check reads only what
  the network tracks.
- An organisation webhook: needs an org admin and sends events from every repo.
- Storing PR and comment text from events: the gateway never becomes a store of
  untrusted text.
- Waking on every comment: comments feed Mira's queue, not wakes, so anyone can't
  start sessions by commenting.
