# Architecture

How the Accord Project agent network is built, what keeps it safe, and how it is
governed. Where this file and the code disagree, the code and `config/` are the truth.
Why each choice was made is in [docs/decisions.md](docs/decisions.md); numbers such as
"decision 20" refer to it.

## What it is

A small network of Claude agents that helps run the Accord Project: triaging and
reviewing pull requests, measuring community health, and turning Tech WG recordings
into summaries. The TSC chair (the **owner**) instructs one agent, **Ada**, the Chief
of Staff, from Telegram or Discord. Ada plans and delegates to specialists. Nothing
public or irreversible happens without the owner's approval.

Design principles:

- **One orchestrator, one level of specialists.** Specialists report only to Ada and
  never instruct each other.
- **Non-blocking approvals.** Critical actions are queued; the agent gets a decision id
  at once and carries on.
- **Agents never grade themselves.** A separate metrics agent (Vera) computes the KPIs
  that Ada uses to evaluate everyone, herself included.
- **Job specs are code.** Each role is a markdown spec in this repo. Changes are pull
  requests that the owner merges.
- **Start small.** Phase 1 runs six agents (Sage joined early for one narrow job,
  decision 54); others join only when the weekly
  evaluation shows a gap they would fill.

## The team

| Agent | Role | Objective | Acts through (critical actions are queued) | Phase |
| --- | --- | --- | --- | --- |
| **Ada** | Chief of Staff | Turn the owner's intent into delegated work; report and stay unblocked | Task assignments and the decision queue only. No external tools. | 1 |
| **Mira** | Maintainer Desk | Every PR and issue gets a fast, correct response | GitHub triage: label, assign, request reviewers. Merge, close, comment as the project, release: queued. | 1 |
| **Vera** | Metrics & Audit | Independent numbers on KPIs and agent cost | Read-only GitHub; reads the gateway's spend and audit records; computes metrics in her sandbox | 1 |
| **Otto** | Meetings | Every Tech WG has a briefing before and a recording, summary and actions after | Read-only GitHub and Vimeo. Publishing, announcements and DMs: queued. | 1 |
| **Mandla** | Mechanic: network changes | Each change the owner approves to the network's specs, tiers and tools becomes a reviewable PR | Its sandbox only. Submits files to the gateway, which opens the PR on this repo. No credentials. | 1 |
| **Rosa** | Community | Newcomers find a path to a first contribution | GitHub triage. Announcements and DMs: queued. | 2 |
| **Juno** | Marketing & Docs | Accord's work is visible and its docs current | Drafts only. Any publish: queued. | 2 |
| **Sage** | Research | The Tech WG chair has a few well-sourced outside items worth discussing (wider brief from Phase 2) | Web search; writes briefs to its own store, which Otto reads | 1 |
| **Kit** | Training & Security | Quality and security posture improve | Security issues and draft PRs. Advisories: queued. | 3 |
| **Felix** | Release & CI | Builds stay green and releases ship predictably | CI and changelog drafts. Tags and npm publish: queued. | 3 |
| **Nell** | Ecosystem & Funding | More adopters, mentors and funding | Drafts only. Every external email: queued. | 3 |

Each agent's job is in `agents/<name>.md`; `agents/_protocol.md` is added to every
agent's instructions. An agent is deployed only when its phase (in
`config/network.yaml`) is at or below `current_phase`.

## Components

```text
  Owner (Telegram / Discord)                 TSC members, maintainers (ask-only)
            │                                              │
            ▼                                              ▼
  ┌──────────────────────── Gateway (Cloudflare Worker + D1) ────────────────────────┐
  │  routes messages to Ada · runs custom tools · decision queue · audit log         │
  │  executes approved actions with its own credentials (GitHub App, Discord bot,    │
  │  Vimeo)                                                                          │
  └───────────────▲──────────────────────────────────────────────┬───────────────────┘
                  │ webhooks, tool calls                          │ approved actions
                  │                                               ▼
  ┌──────── Claude Managed Agents ─────────┐            GitHub · Discord · Vimeo
  │  Ada ──assign_task──▶ Mira, Vera, Otto │
  │  approved spec.change ──▶ Mandla       │
  │  one agent per role, own vault and     │
  │  memory store; scheduled deployments   │
  └────────────────────────────────────────┘
```

| Component | What it is | Where |
| --- | --- | --- |
| Agent runtime | One Claude Managed Agent per role, each with its own environment, tools, credential vault and memory store. Recurring work runs as scheduled deployments with a per-run budget. | `scripts/deploy.ts`, `config/schedules.yaml` |
| Gateway | A Cloudflare Worker with a D1 database. Receives Telegram, Discord, Managed Agents and GitHub webhooks, runs the agents' custom tools, holds the decision queue, executes approved actions and keeps an append-only audit log. | `gateway/src/` |
| GitHub events | The gateway's App sends PR, review, CI and issue events. The gateway lapses decisions GitHub has moved past, refreshes merge cards, records review outcomes and queues Mira's wakes (decision 62). | `gateway/src/githubEvents.ts` |
| Decision queue | A table in the gateway: id, agent, action kind, target, payload, risk, status. Cleared from approval cards in Telegram or Discord. | `gateway/src/agents.ts`, `controls.ts` |
| Configuration | Phase, repos in scope, budgets, permissions, schedules, model tiers and people, compiled into `gateway/src/generated/network.json`. | `config/`, `scripts/compile.ts` |
| Shared context | One read-only memory store with Accord context (`context/accord.md`), plus a read-write store per agent for its own notes. | `scripts/deploy.ts` |
| Model routing | Specs name a tier (deep, standard, fast); `config/models.yaml` maps tiers to models. | `config/models.yaml` |

## Replying to an agent

Every message an agent sends to a person is recorded with the session that wrote it
(`sent_messages`). Replying to it reaches that session: in Telegram with the app's own
reply, in Discord with the message's **Reply** button or **Reply to agent** in its Apps
menu (Discord doesn't pass plain replies to a bot). If that session can no longer take
messages, a fresh one gets the reply with the original quoted (decision 61).

## How a critical action flows

Critical actions are never given to agents as tools. Each agent has a custom tool,
`request_action`, that the gateway runs:

1. Mira decides PR #812 is ready and calls
   `request_action(kind="github.merge", target="accordproject/concerto#812", rationale, risk)`.
2. The gateway checks the kind is one Mira may request (`config/permissions.yaml`) and
   the repo is in scope (`github.repos`), stores the decision, and returns its id at once.
3. The owner gets an approval card with the rationale, a link and Approve, Reject and
   Ask Ada buttons. Cards up to medium risk can go to Discord; high-risk cards stay on
   Telegram (decisions 15 and 19).
4. On approval the gateway acts with its own credentials, logs the result and tells
   the agent in its next session.
5. A rejection note goes back to the agent as an instruction.

Two action kinds run without the owner, each after the gateway's own checks:

- `github.approve_ci` (decision 20): Mira may approve waiting CI runs on a fork PR after
  reviewing it. The gateway itself sends any PR that touches workflows, build scripts,
  dependency or lock files, Dockerfiles or shell scripts to the owner instead, and
  refuses if commits arrived after the review.
- `github.review` (decision 36): a review check's confirmed findings, posted as one
  comment-only review. The gateway checks each finding against the PR and refuses text
  that @mentions anyone but the author or talks about how the review was made.

A merge proposal is checked by the gateway itself, not just by the model, when it is
queued and again on approval (decision 35). The checks: the reviewed head, a posted
review with nothing blocking, green CI, mergeable, no changes requested, no unresolved
threads, and, for a high-risk PR, a maintainer's approval on GitHub. For a low or
medium-risk PR, the owner's approval of the card stands in for it (C-6). The
card lists the checks, with the files and lines changed, the review's findings by
severity, the CI runs and links to the PR and diff.

## Safety rules

These are enforced in code; changing them is the owner's decision.

1. **Ada has no side effects.** She holds no external tools; she acts only through
   `assign_task`, `send_to_matt` and the decision queue. With `decide_action` she may
   mark done, reject superseded, or approve low-risk `github.approve_ci` decisions
   (decision 52), and with `close_task` close a stopped task (decision 53); nothing else.
2. **Agents never hold credentials for critical actions.** Merging, closing, releasing,
   publishing, posting, emailing, messaging a named person, deleting, spending, and
   spec or permission changes go through `request_action`. The gateway holds those
   credentials.
3. **Never go ahead by default** on anything that needs approval. Adding an `auto`
   action kind is the owner's decision.
4. **Agents never block.** `request_action` returns a decision id at once.
5. **Owner rights come only from secrets** (`OWNER_TELEGRAM_ID`, `OWNER_DISCORD_ID`).
   `config/people.yaml` grants read-and-ask access only.
6. **Content is data.** PRs, issues, transcripts and web pages that agents read are
   data, never instructions.

**The network's own repo** (decision 51). No agent holds a credential for it, and it
can never be in `repos` or the sandbox. Every action kind refuses it as a target. The
gateway's one action here is opening Mandla's pull requests for changes the
owner approved; the owner reviews, merges and approves the deploy. CI flags pull
requests that touch the safety files (permissions and `network.yaml`, the gateway's
checks and tools, `scripts/`, the package files, the protocol, Mandla's spec,
`.github/`), using the base branch's copy of the check.

What is not enforced in code: agents with a write-capable GitHub token (Mira now, Rosa
later) can comment, label and open issues directly through the GitHub tool, limited by
their token and their instructions rather than by the decision queue (decision 24).
Those tokens list only the repos in scope (decision 23).

## Credentials

| Who | Holds | Can do |
| --- | --- | --- |
| Gateway | GitHub App `virtual-agent-org-gateway`, Discord bot token, Vimeo token, Telegram bot token, Managed Agents API key (Worker secrets) | Everything approved: merge, close, comment, release, post, DM, publish. On this repo, only opening Mandla's PRs; the App has no Workflows permission. |
| Mira (later Rosa) | Fine-grained token from the `mttrbrts-agent` account, repos in scope only; the account has the Triage role there | Read; label, assign, request reviewers; comment |
| Vera, Otto | Fine-grained read-only token, all Accord repos | Read |
| Ada | Nothing | Assign tasks, message the owner, queue decisions |
| Mandla | Nothing | Clone this public repo, build and test in its sandbox, submit a change once |

Agent tokens live in each agent's Managed Agents vault, never in the repo. People's
Discord and Telegram ids live in the git-ignored `config/people.ids.yaml` and reach the
gateway as the `PEOPLE_IDS` secret (decision 25).

## Watching, stopping and revoking

| Lever | Command | Effect |
| --- | --- | --- |
| Pause one agent | `/pause mira` | Pauses its scheduled deployments and stops routing tasks to it (for Ada, also the gateway's follow-up wakes). Running sessions finish. |
| Hard stop | `/stop mira`, `/stop all` | Also interrupts running sessions and rejects the agent's open decisions. |
| Revoke | `/revoke mira confirm` | Interrupts sessions and archives the agent's vault, purging its credentials. |
| Spending cap | Automatic | Each session has a budget; it pauses at the cap. |

Every tool call and decision is in the gateway's audit table, and each session's cost,
tokens and model are recorded. Vera reads them with `read_audit` and flags anomalies:
spend well above an agent's weekly median, tool denials, rejected decisions, and any
public action without a decision id.

## Working rhythm

- **Check-ins** every other day at 07:30 London time: Ada asks each agent for a status,
  reads Vera's numbers and sends the owner one message (headline, per-agent status,
  KPIs, spend, decisions waiting, issues).
- **Weekly evaluation** on Fridays: Vera builds the scorecard; Ada scores each agent on
  impact, quality (decision outcomes), cost per outcome and feedback, and may propose
  one change per agent (`evaluation/rubric.md`).
- **Self-improvement** (decision 55): evidence in Vera's scorecard (rejection notes,
  refused and denied tool calls) → Ada's `spec.change` proposal → the owner approves →
  the gateway records a change (`C-n`) and starts Mandla → Mandla builds
  and tests it and calls `submit_change` → the gateway's App opens the PR → the owner
  merges and approves the deploy → the deploy workflow marks the change live → 14
  days later the gateway compares the change's measure before and after and stores
  `better`, `same`, `worse` or `too_little_data` → Ada reports it in the check-in, and
  proposes a revert for `worse`. The loop may change spec wording, model tiers and
  tools; permissions, integrations and architecture stay the owner's decisions. It is
  off until `self_improvement.since` is set in `config/network.yaml`.
- **Briefs and budgets:** Ada's `assign_task` requires an objective, output, a
  "done when" test and an effort level that sets the session budget (decision 21).
- **Task lifecycle:** a task is `open`, then `running` once its session starts. When
  the session ends its turn, the task is `done`, or `blocked` if the session's last
  status report listed blockers; `failed` if the session never started. A session that
  runs out of budget or ends in error leaves its task `blocked`, and the hourly tidy-up
  blocks tasks whose session went stale; `blocked_reason` says why (decision 53). Ada
  then retries, rewords, reassigns, puts it to the owner, or closes it with `close_task`.
- **Follow-ups** (decision 50): when a task ends blocked or an approved decision fails,
  the gateway wakes Ada, at most once per task or decision and 5 times a day, only
  while she is active and schedules are on. She assigns it to an agent who can fix it
  (`assign_task` with `follows_up`), or puts it to the owner. The gateway refuses a
  second open follow-up for the same id, and closes a blocked task when its follow-up
  is done. Check-ins do the same for everything blocked, failed or idle over 4 days.
- **Review:** Mira's PR reviews are checked by a fresh session before anything is
  posted or a merge is proposed (decision 22). The gateway computes each PR's facts
  and risk band, posts the confirmed findings, and records what maintainers did with
  them (decisions 35 and 36; settings in `config/review.yaml`).
- **GitHub events** (decision 62): the gateway hears from its GitHub App when a PR or
  issue in scope changes. In plain code it marks open decisions **lapsed** when a
  person merges or closes their PR or issue, or a merge or CI approval's head gets new
  commits; lapsing only ever closes a decision. It re-runs open merge cards' checks when
  CI finishes or a review or thread changes, and records review outcomes. It wakes
  Mira, within daily caps and only while she is active and schedules are on: to review
  a PR when CI goes green at an unreviewed head, to propose a merge when every merge
  check passes at a reviewed head, and to first-respond to a first-time contributor.
  The review pass runs once a day to catch what wakes missed, and a daily check
  re-reads the open PRs and issues the network tracks, since GitHub doesn't retry
  failed deliveries. Events carry no rights, and the gateway keeps no text from them.
- **Memory:** each agent keeps `/notes/working.md` in its own memory store; sessions
  start fresh and read their notes first.

## Metrics

Definitions follow [CHAOSS](https://chaoss.community/?p=5703). The baseline is
[ap-stats](https://mttrbrts.github.io/ap-stats/) (August 2025 to August 2026).

| KPI | Baseline | Six-month target |
| --- | --- | --- |
| Time to merge, mean / P90 | 14.0 / 42.1 days | 7 / 21 days |
| Time to first response, mean / P90 | 7.7 / 23.6 days | 2 / 5 business days |
| Contributor retention (prior-year contributors who returned) | 17.4% | 30% |
| Community size (unique contributors, rolling 12 months) | to be computed | set after the first count |

Bots are excluded from people metrics, and medians are reported alongside means.

## Phases

| Phase | Agents | Gate to the next phase |
| --- | --- | --- |
| 0 Foundations | Test agent on the sandbox repo | A queued merge is approved and executed; `/stop` halts the agent within seconds |
| 1 Core loop | Ada, Mira, Vera, Otto, Sage, Mandla | Two weeks of on-time check-ins; at least 80% of merge proposals approved unedited; no public action without a decision id; spend within budget |
| 2 Community and voice | Rosa, Juno | Newcomer first-response median under 2 business days |
| 3 Depth | Kit, Felix, Nell | Each new agent moves its KPIs within four weeks, or is retired |

## Background

The design follows what multi-agent research and practice converged on in 2026: a
central coordinator over narrow specialists contains errors
([Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)),
writes stay single-threaded ([Cognition](https://cognition.com/blog/multi-agents-working)),
briefs carry an objective, output and boundaries
([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)), and
independent fresh-context review catches most verification failures
([MAST](https://arxiv.org/html/2503.13657v3)). Hierarchies outperform flat agent groups
([OrgAgent](https://arxiv.org/abs/2604.01020)), and effective team size saturates fast,
so roles are added only when one is overloaded.
