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
- **Start small.** Phase 1 runs four agents; others join only when the weekly
  evaluation shows a gap they would fill.

## The team

| Agent | Role | Objective | Acts through (critical actions are queued) | Phase |
| --- | --- | --- | --- | --- |
| **Ada** | Chief of Staff | Turn the owner's intent into delegated work; report and stay unblocked | Task assignments and the decision queue only. No external tools. | 1 |
| **Mira** | Maintainer Desk | Every PR and issue gets a fast, correct response | GitHub triage: label, assign, request reviewers. Merge, close, comment as the project, release: queued. | 1 |
| **Vera** | Metrics & Audit | Independent numbers on KPIs and agent cost | Read-only GitHub; reads the gateway's spend and audit records; computes metrics in her sandbox | 1 |
| **Otto** | Meetings | Every Tech WG has a briefing before and a recording, summary and actions after | Read-only GitHub and Vimeo. Publishing, announcements and DMs: queued. | 1 |
| **Rosa** | Community | Newcomers find a path to a first contribution | GitHub triage. Announcements and DMs: queued. | 2 |
| **Juno** | Marketing & Docs | Accord's work is visible and its docs current | Drafts only. Any publish: queued. | 2 |
| **Sage** | Research | The TSC sees what matters in legal tech and agentic commerce | Web search; writes briefs | 2 |
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
  │  one agent per role, own vault and     │
  │  memory store; scheduled deployments   │
  └────────────────────────────────────────┘
```

| Component | What it is | Where |
| --- | --- | --- |
| Agent runtime | One Claude Managed Agent per role, each with its own environment, tools, credential vault and memory store. Recurring work runs as scheduled deployments with a per-run budget. | `scripts/deploy.ts`, `config/schedules.yaml` |
| Gateway | A Cloudflare Worker with a D1 database. Receives Telegram, Discord and Managed Agents webhooks, runs the agents' custom tools, holds the decision queue, executes approved actions and keeps an append-only audit log. | `gateway/src/` |
| Decision queue | A table in the gateway: id, agent, action kind, target, payload, risk, status. Cleared from approval cards in Telegram or Discord. | `gateway/src/agents.ts`, `controls.ts` |
| Configuration | Phase, repos in scope, budgets, permissions, schedules, model tiers and people, compiled into `gateway/src/generated/network.json`. | `config/`, `scripts/compile.ts` |
| Shared context | One read-only memory store with Accord context (`context/accord.md`), plus a read-write store per agent for its own notes. | `scripts/deploy.ts` |
| Model routing | Specs name a tier (deep, standard, fast); `config/models.yaml` maps tiers to models. | `config/models.yaml` |

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
threads, and a maintainer's approval unless the PR is low risk. The card lists them.

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

What is not enforced in code: agents with a write-capable GitHub token (Mira now, Rosa
later) can comment, label and open issues directly through the GitHub tool, limited by
their token and their instructions rather than by the decision queue (decision 24).
Those tokens list only the repos in scope (decision 23).

## Credentials

| Who | Holds | Can do |
| --- | --- | --- |
| Gateway | GitHub App `virtual-agent-org-gateway`, Discord bot token, Vimeo token, Telegram bot token, Managed Agents API key (Worker secrets) | Everything approved: merge, close, comment, release, post, DM, publish |
| Mira (later Rosa) | Fine-grained token from the `mttrbrts-agent` account, repos in scope only; the account has the Triage role there | Read; label, assign, request reviewers; comment |
| Vera, Otto | Fine-grained read-only token, all Accord repos | Read |
| Ada | Nothing | Assign tasks, message the owner, queue decisions |

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
  one spec change per agent as a pull request (`evaluation/rubric.md`).
- **Briefs and budgets:** Ada's `assign_task` requires an objective, output, a
  "done when" test and an effort level that sets the session budget (decision 21).
- **Task lifecycle:** a task is `open`, then `running` once its session starts. When
  the session ends its turn, the task is `done`, or `blocked` if the session's last
  status report listed blockers; `failed` if the session never started. A session that
  runs out of budget leaves its task `blocked`; one that ends in error leaves it
  `failed`, and the hourly tidy-up fails tasks whose session went stale (decision 53).
  Ada closes a stopped task that is finished in practice with `close_task`.
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
| 1 Core loop | Ada, Mira, Vera, Otto | Two weeks of on-time check-ins; at least 80% of merge proposals approved unedited; no public action without a decision id; spend within budget |
| 2 Community and voice | Rosa, Juno, Sage | Newcomer first-response median under 2 business days |
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
