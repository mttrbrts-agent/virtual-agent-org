# Decisions

Settled design decisions for the agent network, in the order they were taken. Code
and config comments refer to them by number ("decision 20"). The owner (the TSC chair)
takes these decisions; a new one gets the next number and is added here in the same
pull request that implements it. [ARCHITECTURE.md](../ARCHITECTURE.md) describes the
result.

Statuses: **RESOLVED** (chosen), **DEFAULT** (the recommendation stands until someone
asks to revisit it), **OPEN**, **SUPERSEDED**.

**1. How the agents are paid for** · RESOLVED

- The agents run on a Claude Console API key and draw on API credits, never on anyone's
  chat or Claude Code limits. Budgets are in `config/network.yaml`.

**2. Where the agents run** · DEFAULT: Claude Managed Agents

- The hosted runtime provides scheduling, sandboxes, credential vaults, pause and audit,
  so only the gateway had to be built. Specs and `config/models.yaml` stay portable.
- Revisit if most work should move to non-Claude models.

**3. GitHub access for agents on the real Accord repos** · RESOLVED

- Each agent has its own fine-grained token. Decision 23 sets which repos each covers.

**4. Who merges** · DEFAULT: every merge goes through the owner's decision queue

- It keeps critical actions with the owner and builds the track record needed before
  any automatic merging is considered.
- Revisit if the queue exceeds about 15 merges a day.

**5. Telling the TSC and community that agents are acting** · RESOLVED

- The TSC was briefed on 31 October 2026. Agent-drafted public messages carry the
  agent's label, which the gateway adds to Discord posts.

**6. Six-month KPI targets** · RESOLVED

- Time to merge: mean 7 days, P90 21 days. Time to first response: 2 business days,
  P90 5 days. Contributor retention: 30%.

**7. Where the gateway runs** · DEFAULT: Cloudflare Worker with D1

- Always on, no server to patch, secrets in the platform's secret store, free at this
  volume. Revisit if the gateway needs long-running jobs.

**8. How LinkedIn posts get out** · DEFAULT: drafts go to the owner, who posts them

- LinkedIn's organisation posting API needs app review. Revisit if drafts become weekly.

**9. Where the code lives** · RESOLVED: the Accord Project organisation

- `accordproject/virtual-agent-org` and its sandbox, `accordproject/virtual-agent-org-sandbox`.

**10. Long-term funding** · OPEN

- Whether the project or a sponsor funds the API credits once the current arrangement
  ends. Vera's monthly spend figures inform it.

**11. Which repos the agents work on first** · RESOLVED

- Concerto, Template Engine and Template Playground, plus the sandbox for testing the
  network. `npm run repo:add` adds more.

**12. Whose name agents' direct GitHub actions appear under** · RESOLVED

- Agents' tokens belong to a dedicated account, `mttrbrts-agent`, with the Triage role
  on the repos in scope. Approved actions appear as the `virtual-agent-org-gateway` app.

**13. How Discord users reach the network** · RESOLVED

- Discord is a second front door alongside Telegram. The Discord bot handles slash
  commands, approvals and posts. `config/people.yaml` lists who may use it, with
  read-and-ask access only.

**14. Where the owner approves** · SUPERSEDED by 15

**15. What the owner can do from Discord** · RESOLVED

- Instruct Ada, and approve or reject low- and medium-risk decisions in DMs. High-risk
  decisions, paused tool calls, `/resume` and `/revoke` stay on Telegram; `/pause` and
  `/stop` work in both. Owner rights on Discord come only from the `OWNER_DISCORD_ID`
  secret. The ceiling is `discord_approval_max_risk` in `config/permissions.yaml`.

**16. What the #agent-ops channel is for** · RESOLVED

- A private Discord channel where agents ping maintainers and TSC members about things
  that shouldn't be public, through approved `discord.ops` posts naming people by
  GitHub login. Only people in `people.yaml` with a Discord id can be pinged, never a
  role or @everyone.

**17. How agents reach maintainers and TSC members privately** · RESOLVED

- The bot posts to #agent-ops and to announcements; channel ids are in
  `config/discord.yaml`. The earlier webhooks are retired.

**18. How far Otto goes with Vimeo** · RESOLVED

- Otto finds new recordings and reads transcripts through the gateway, drafts the
  title and description, and one approval sets them and makes the video public. The
  Vimeo token is held only by the gateway. The account's plan can't set chapters
  through the API, so chapters go in the description as timestamp lines.

**19. Which app approval cards go to** · RESOLVED

- Cards that can be approved in Discord go only to Discord; high-risk cards and paused
  tool calls stay on Telegram. If Discord can't deliver a card, it goes to Telegram.
  Set by `approvals_app` in `config/permissions.yaml`.

**20. Whether Mira's CI approvals need the owner** · RESOLVED: no, with gateway checks

- After reviewing a fork PR, Mira approves its waiting CI runs (`github.approve_ci`,
  the first `auto` action kind; decision 36 added `github.review`). The gateway sends the request to the owner as high
  risk if the PR touches workflows, build scripts, dependency or lock files,
  Dockerfiles or shell scripts, and refuses if commits arrived after the review.
- This assumes no in-scope repo uses `pull_request_target` or runners that aren't
  GitHub-hosted; `npm run repo:add` checks that for each new repo.

**21. Structured briefs and effort budgets** · RESOLVED

- Ada's `assign_task` requires an objective, output, a "done when" test and an effort
  level. Effort sets the session cap and a tool-call target: small $0.30 / ~10 calls,
  medium $1 / ~30, large $3 / ~80.

**22. How Mira reviews PRs** · RESOLVED

- Review is its own scheduled pass. Mira drafts findings after reading the repo's
  AGENTS.md and CONTRIBUTING.md; a fresh session verifies each finding, posts only
  confirmed ones, and alone may propose the merge (`review_check_required`). PRs over
  200 changed lines are checked on the deep tier. Repeated lessons become AGENTS.md
  update PRs (`github.docs_pr`, approval-gated).
- Decision 35 replaced the 200-line rule with the gateway's risk band, and decision 36
  moved posting to the gateway.

**23. Which repos the agents' tokens cover** · RESOLVED

- Read-only tokens (Vera, Otto) cover all Accord Project repos. Tokens that can write
  (Mira, later Rosa) list only the repos in scope, so direct writes stay within
  `github.repos` in `config/network.yaml`.
- Wrong if a read-only agent's token turns out to have write permissions.

**24. Whether agents' GitHub tool may write directly** · RESOLVED: yes

- The GitHub tool is `always_allow`; direct writes are limited by tokens and
  instructions, not by tool configuration, so the decision queue does not cover direct
  GitHub comments and new issues. Agents are to become more autonomous in a later phase.

**25. Personal data in the repo** · RESOLVED

- Discord and Telegram ids live in the git-ignored `config/people.ids.yaml`, keyed by
  name, and `npm run people:ids` loads them into the gateway's `PEOPLE_IDS` secret.
  `people.yaml` keeps names, roles and GitHub logins.

**26. The Tech WG joining link in the shared context** · RESOLVED

- It stays in `context/accord.md`; it is already public.

**27. How the repo went public** · RESOLVED

- The private history was replaced with one signed-off commit before the repo was made
  public, so earlier personal data was never published.

**28. Design documents** · RESOLVED

- The original private plan was split into [ARCHITECTURE.md](../ARCHITECTURE.md) and
  this log. The owner's working notes stay outside the repo.

**29. Licence** · RESOLVED: Apache-2.0 for everything

- Agent specs are instructions run by a model and are licensed like the code.

**30. Who reviews changes** · RESOLVED

- `.github/CODEOWNERS` makes the owner the reviewer for every file, matching the rule
  that agents only propose changes. Revisit when someone else maintains the gateway.

**31. How agents' reports of tool problems reach the owner** · RESOLVED: no new route yet

- Agents' tool complaints reach the owner only through status reports and Ada's
  check-in. Calls the gateway rejects (a missing or invalid field) are answered with
  an error but not flagged in the audit log.
- Revisit with the self-improvement loop, which will read status reports and the
  audit log for evidence.

**32. How Mira starts work** · RESOLVED: on a schedule

- Mira keeps her scheduled passes rather than reacting to GitHub webhooks. Each
  session has a fixed start-up cost, which a pass spreads across many items.
- Revisit if first responses to new contributors need to come within the hour.

**33. Mentioning Ada on GitHub** · RESOLVED: not supported

- Comments on GitHub don't reach Ada. Anyone can write a public comment, and owner
  rights come only from the Telegram and Discord ids (rule 5).

**34. Discord commands in DMs** · RESOLVED

- The slash commands are registered globally and work in the server and in DMs with
  the bot, so conversations with Ada can stay private. Who may do what is unchanged
  (decision 15).
- Plain messages without a command would need a permanent connection to Discord,
  and Telegram already covers them.

**35. What a merge needs** · RESOLVED: checks in the gateway; low risk needs no second review

- The gateway checks every `github.merge` itself, when it is proposed and again just
  before it runs. The PR must be open and not a draft. Its head must be the commit the
  review check reviewed, and a review with nothing blocking must have been posted at
  that head. CI must be green, with no runs waiting for approval, and GitHub must report
  the PR mergeable. Nobody may have requested changes, and no threads may be unresolved.
  Failed checks are returned to the agent rather than queued; the card lists the checks.
- The gateway rates each PR low, medium or high risk from its files and size
  (`config/review.yaml`). A medium- or high-risk PR also needs an approving review
  from a maintainer other than its author. For a low-risk PR (only docs or tests, and
  small), the owner's approval of the card is enough.
- High-risk PRs get the review check on the deep tier and a high-risk card. This
  replaces the 200-line rule in decision 22.
- On repos whose branch protection requires an approving review, GitHub still refuses
  a low-risk merge without one; the card says so.
- Typed findings and their outcomes live in the gateway's database, so the share of
  findings maintainers act on is computed, not estimated.

**36. Who posts PR reviews** · RESOLVED: the gateway, as a second `auto` kind

- The review check submits its confirmed findings with `submit_review`, and the gateway
  posts them as one review that only comments: it never approves or requests changes.
  This is the `github.review` action kind, which runs without a card, like
  `github.approve_ci`.
- Before posting, the gateway checks each finding against the PR's files and the limits
  in `config/review.yaml`. It refuses text that @mentions anyone but the PR's author,
  which could ping people or trigger a bot, and text about how the review was made.
- Agents no longer post reviews through their own GitHub app.

**37. Jev for PR triage** · RESOLVED: not now; watch costs first

- A semantic classifier (TypeSafe's Jev) could answer the triage questions (a PR's
  kind, risk and spam) that run on Claude's fast tier today. It has an HTTP API and a
  TypeScript SDK, so the gateway could call it.
- One blind run on 50 historical concerto PRs is the only evidence, and it is thin. Jev
  matched 11 of 15 labels that a Claude model drew from maintainers' comments. Its
  confidence did not track accuracy, and nobody compared its cost with Claude's.
- Neither Jev nor Claude resists prompt injection, so the same rule applies to both:
  a model's output may raise risk or route a PR to the owner, but never loosen a
  check the gateway computes (decision 35).
- Triage stays on Claude's fast tier. The owner is watching its cost over the next few
  weeks; if that is high, a head-to-head trial of Jev and the fast tier on about 100
  labelled PRs, comparing accuracy and cost per PR, is the next step.

**38. PR labels** · RESOLVED: Mira labels the kind; the gateway labels risk and decision

- PRs carry the `ai/kind:*`, `ai/risk:*` and `ai/decision:*` labels that already exist
  on the repos in scope.
- Mira sets one `ai/kind:*` label in her triage pass, with `label_pr` (decision 41), on any
  open PR that has none yet: newest first, at most 15 a pass. The backlog clears over a
  few days without her tracking what she has done. First responses stay for new PRs.
- The gateway sets `ai/risk:*` (its risk band) and `ai/decision:*` (`needs-changes` when
  a review has blocking findings, otherwise `needs-review`) each time it posts a review,
  replacing its own earlier labels. A model never sets these, so they always match what
  the gateway enforces (decisions 35 and 37).
- A label GitHub refuses doesn't stop the review being posted; the result says so.

**39. Review queue order** · RESOLVED: age counts for two weeks at most

- The review queue ranks PRs by first-time contributor, age, green CI and size. Age now
  adds at most 14 points instead of 60, so a fresh first-time PR with green CI comes
  before the backlog instead of waiting behind it.
- The queue still reads only the 50 oldest open PRs in each repo. Newer PRs in a repo
  with more open PRs than that join the queue as older ones close.

**40. File tools for memory** · RESOLVED: every agent gets read, write, edit and glob

- Each agent's memory stores are mounted as files in its sandbox, but no agent had file
  tools, so none could read or write its notes and every session started from nothing.
- Every agent now has the built-in `read`, `write`, `edit` and `glob` tools. They touch
  only the agent's own sandbox and memory stores.
- Ada gets these four and nothing else. The config check still refuses her any other
  built-in tool and any MCP server, so she still has no side effects.
- Stores are mounted at `/mnt/memory/<store name>/`, confirmed by a test session. Each
  agent's prompt gives the full paths to its notes and to the shared context.

**41. How Mira labels PRs** · RESOLVED: through a gateway tool, one label at a time

- The GitHub MCP server can label only by replacing every label on an issue or PR. A
  call made just after the gateway labels a review could remove the gateway's labels.
- Mira labels PRs with `label_pr`, which adds and removes single labels with the
  gateway's GitHub App. It refuses `ai/risk:*` and `ai/decision:*`, kinds outside the
  agreed list, and labels the repo doesn't already have. Adding a kind removes the old
  one, so a PR has one kind at most. Each change is in the audit log.
- Issues still use her GitHub tools, since the gateway doesn't label issues.

**42. Approval cards show what will run** · DEFAULT: each action kind checks its own payload

- A card used to show the agent's summary and one text field, while the gateway acted
  on other fields: who a message goes to, a file's content, a release tag. The two
  could differ.
- Each action kind now has one spec that checks the payload when the agent asks,
  describes it for the card and runs it. Unknown fields are refused, and the card shows
  every field that will run. The payload is checked again just before it runs.
- A card too long to show in full in Discord goes to Telegram instead.

**43. Review checks are marked by kind** · RESOLVED: not by task title

- The gateway used to recognise a review check (decision 2A) by its task title, which
  any assigned task could copy.
- A task's kind and the PR and commit it checks are now stored with the task, and only
  the gateway's own review-check request sets them.

**44. Work a member sets going** · DEFAULT: marked, never automatic, and capped

- People in `people.yaml` may ask but not instruct (rule 5). Until now that was only an
  instruction in the agent's prompt.
- Each session records who started it, and sessions it starts in turn inherit that.
  A decision from work a member started says so at the top of its card.
- Such work never runs an `auto` kind: a CI approval goes to the owner. It cannot start
  a review check.
- Each member may send 20 messages a day across both apps (`budgets.member_daily_messages`
  in `network.yaml`). Members see a plain message when something fails; the detail goes
  to the audit log.

**45. Automatic CI approval checks the repo's workflows** · DEFAULT

- Approving a fork's CI runs the PR's code, so what limits the risk is how the repo's
  workflows run, not only which files changed.
- `github.approve_ci` runs automatically only if no workflow uses `pull_request_target`
  or a self-hosted runner, the workflows can be read, and the PR changes no build,
  dependency or CI files (a longer list than before). Otherwise it goes to the owner as
  high risk. `repo:add` warns about the same things.

**46. How long the gateway keeps records** · DEFAULT

- Event claims and stored tool answers are kept for 14 days and the audit log for 365
  days. Sessions idle for 7 days are marked stale and no longer swept, and each sweep
  handles at most 40 sessions.
- A tool call's answer is stored before it is sent, so a retry resends it instead of
  acting twice.

**47. Where Vera gets spend and audit data** · RESOLVED: a read-only gateway tool

- Vera's agent audit needs spend, tokens, models used, decision outcomes and tool
  denials. She had no way to read any of them.
- She calls `read_audit`, which returns the gateway's own records for a period of up to
  92 days. She holds no new credential.
- Not chosen: the Managed Agents API key in her vault, which could start sessions and
  edit agents (rule 2); and an Admin API key for Anthropic's usage and cost reports,
  which is an organisation-wide credential and cannot split cost by agent, since all
  sessions run under the gateway's key.
- Not now: checking the gateway's monthly totals against the cost report. The owner
  compares them with the Console by hand; revisit when decision 10 needs figures that
  can be audited.

**48. What the gateway records for the audit** · RESOLVED

- Each session now stores its model (the override, or the agent's default tier) and its
  cumulative token totals, alongside its list cost.
- A custom tool call the gateway refuses on permission grounds (a tool owned by another
  agent, an action kind the agent may not request, a stopped agent) is logged as a
  denial, as permission-policy denials already were.
- Scheduled runs are recorded with the agent's default model, since a session does not
  report which model it ran on.

**49. Deploying after a merge** · RESOLVED: automatic, after the owner approves the run

- Every push to `main` starts the `deploy` workflow, which deploys only what changed:
  people's ids, D1 migrations, the gateway, then the agents.
- The deploy secrets live in the `production` environment. It accepts runs from `main`
  only, each run waits for the owner's approval, and admins can't skip that. This
  follows the Accord Project's npm publishing setup.
- `main` is protected: changes arrive by pull request with the `ci` and DCO checks
  passing, so the approval is not the only gate.
- New Managed Agents resource ids come back as a PR. Agent deploys wait until it is
  merged, so a resource is never created twice. CI doesn't run on PRs the workflow
  opens, so the owner merges these past the `ci` check.
- People's platform ids are kept as a `production` environment secret, so a change to
  `people.yaml` loads them without a manual step.

**50. Following up blocked work** · DEFAULT: the gateway wakes Ada, within limits

- A task used to count as done whenever its session ended, even if its last status
  report listed blockers, and a failed approved decision was seen only if someone
  listed the queue.
- A task whose session ends with blockers in its last report is now `blocked`. It stays
  among the open tasks in `get_status` and `/status`.
- When a task ends blocked, or an approved decision fails to run, the gateway starts an
  Ada session naming it. She follows "Following up" in her spec: assign it, with full
  context, to an agent who can fix it, or put it to the owner as a decision. The
  check-in does the same for every blocked task, failed decision and task idle more
  than 4 days.
- Limits: never for Ada's own work or for review checks; one wake per task or decision;
  at most 5 wakes a day at $0.50 each (`budgets.follow_up_daily_wakes` and
  `follow_up_budget_usd`). Wakes run only while Ada is active and `schedules_enabled`
  is on, since they are work nobody asked for, like a scheduled run. Every wake and
  every skip is audited, and a failed wake never stops the work it came from.
- `assign_task` takes `follows_up` (the task or decision id). The gateway refuses a
  second open follow-up for the same id, and closes a blocked task when its follow-up
  finishes. A follow-up that is blocked again goes to the owner, not to another agent.
- Not chosen: a separate pause switch for wakes (pausing Ada, or setting the daily
  wakes to 0, already does it); waking the agent that was blocked (it reported the
  blocker because it couldn't fix it).

**51. Who may change the network's own code** · RESOLVED (amended by 55)

- No agent holds a credential for this repo, and it is in no agent's scope or the
  gateway's `repos`.
- Mandla, the mechanic agent, is the only agent that may propose code here, and only to build
  a change the owner approved. It holds no credential: it builds and tests in its
  sandbox and submits the files to the gateway, whose GitHub App opens the pull
  request. Opening those pull requests is the gateway's only action on this repo. It
  cannot merge. No other agent may write to this repo.
- The App must not hold GitHub's Workflows permission, and the gateway refuses any
  submitted file under `.github/` or `gateway/src/generated/`, except the compiled
  `network.json`, which CI checks against a fresh compile: CI and the deploy run stay
  with the owner.
- `compile.ts` refuses this repo in `repos` or as the sandbox; the gateway refuses every
  action kind that targets it, whatever the config says; the owner merges on GitHub
  and approves the deploy run (decision 49).
- Each proposal cites the evidence it rests on; text in it is data, not instructions.
  A CI step flags pull requests that touch `permissions.yaml`, `network.yaml`, the
  gateway's checks (`actions.ts`, `review.ts`, `workflows.ts`, `risk.ts`,
  `schema.ts`, `changes.ts`), its tools, people and entry modules (`tools.ts`,
  `people.ts`, `index.ts`), anything under `scripts/` or `.github/`, the package
  files, `_protocol.md` or Mandla's own spec for closer review. It runs the
  base branch's copy of the check, so a pull request can't silence it. It warns
  rather than fails, so a permissions change the owner approved can still be
  written.
- Not chosen: letting every agent propose changes here (the rules would be editable by
  the agents they limit); no agent writing here at all (every fix waits for the owner
  to write it).
- Changed by decision 55: Mandla was to open pull requests from its own fork with
  a credential limited to that fork, and the owner was to deploy by hand. It now holds
  no credential and writes through the gateway, and the deploy workflow (decision 49)
  makes a merged change live.

**52. What Ada may decide without the owner** · RESOLVED

- The decision queue filled with items needing no judgement: manual actions already
  done, requests an agent had replaced, and CI approvals the gateway sent to the owner
  only because a member's message set the work going.
- Ada decides three kinds herself with `decide_action(id, outcome, note)` and lists
  them under "Decided for you" in the next check-in:
  - **done:** an approved decision that has been carried out or superseded;
  - **rejected:** an open decision when the same agent has since queued one for the
    same target (the note records which);
  - **approved:** an open low-risk `github.approve_ci`, where the requesting agent read
    the diff and found it clean. The gateway re-runs the automatic approval's file and
    workflow checks first and refuses if any fails.
- An approved decision is a manual action waiting for the owner, and its card is the
  only reminder of it, so marking it done clears that reminder. Kept: Ada's note gives
  the evidence and the check-in lists each one. Not chosen: limiting (a) to superseded
  decisions, which would leave every "done" to the owner.
- In practice (c) covers CI approvals a member's message set going: other low-risk ones
  already run automatically, and ones the checks flag are high risk. Kept on purpose,
  since the gateway's checks are the same either way.
- The gateway refuses everything else, including paused tool calls, any other kind, and
  any call from a conversation a member started (rule 5). Spending, sending to people,
  deleting, merges and releases stay with the owner. Each decision is audited as
  `ada.decided` and her note is kept on the decision.

**53. Closing tasks that never finished** · RESOLVED

- A task closed only when its session ended its turn normally. A session that ran out
  of budget, ended in error or went stale left its task `running` for good, and nobody
  could close it, so Ada kept following up work that had stopped.
- The gateway now makes them `blocked`, with the reason in `blocked_reason`, so every
  unfinished task ends with a choice made by Ada or the owner, never silently:
  - out of budget, or ended in error or out of retries: blocked when the session
    stops, and Ada is woken within the usual limits (decision 50);
  - session stale, or no session after 7 days: blocked at the hourly tidy-up, which also
    clears the backlog. No wake; Ada's next check-in picks them up.
- Ada then retries, rewords, reassigns, puts it to the owner, or closes it. A task that
  ran out of budget is retried at a higher effort or split, never resent unchanged.
- Ada may close a task herself with `close_task(id, note)`, for one that is finished
  in practice or a duplicate, only once its session has stopped and never in a
  conversation a member started. It is audited as `ada.closed_task` and listed under
  "Decided for you".
- Not chosen: leaving them open; marking them `failed`, which drops them from Ada's
  list without anyone deciding; a close command for the owner only.

**54. Sage joins Phase 1 for WG news** · RESOLVED

- The Tech WG chair's weekly briefing offers up to three outside developments the WG
  could discuss. The chair decides what to raise; Otto never adds them to the agenda.
- Sage joins Phase 1 early, for this job only: a Monday brief on standards work for
  legal and contract data, legal context in agent protocols and agentic commerce, and
  related open source projects. Its wider brief waits for Phase 2.
- Sage is measured by the share of its items, sent to the chair, that the WG discusses.
  Otto records this from the transcript; Vera reports it.
- Otto reads Sage's memory store read-only (`reads_memory_of` in `permissions.yaml`),
  and Vera reads Otto's the same way. Agents can't write to the shared store.
- Otto processes recordings on Thursdays, the morning after the meeting, instead of
  the following Monday.
- The environment's network allowlist also limits web search and fetch, so Sage runs
  in its own environment with unrestricted outbound access (`networking: open` in
  `permissions.yaml`). Every other agent stays on the limited one; Ada can't be moved.
- Considered: giving Otto web search (overlaps Sage later), and folding Sage's remit
  into Otto (mixes two jobs).

**55. The self-improvement loop** · RESOLVED (on from 2026-11-03)

- The owner's rejection notes went back to the one agent rejected and then faded. Ada's
  weekly evaluation could propose a spec change, but nothing built it, recorded it or
  checked whether it helped.
- **Evidence:** Vera's weekly scorecard groups each agent's rejection notes, refused
  and denied tool calls with their ids, and lists the measured changes. She
  summarises; she does not propose.
- **Proposal:** in the weekly evaluation Ada may raise one `spec.change` per agent,
  herself and Mandla included. The payload names the change type, the problem,
  the change, 1 to 30 evidence ids and a measure from a fixed list. Only Ada may
  request it, and not from work a member started.
- **What the loop may change:** spec wording, model tiers and tools (`wording`, `tier`,
  `tool`). New integrations, permissions and major architecture changes stay the
  owner's decisions; proposals of those types are always high risk and say so on the
  card. A proposal about Mandla is high risk; `tool` changes medium; the rest
  low.
- **Approve before building:** the owner approves each proposal; approving it starts
  the build. There is no second card for the pull request: opening one merges
  nothing, and the owner's review is the gate. Building without approval would make
  `spec.change` an `auto` kind, which stays the owner's decision.
- **Start rule:** the gateway refuses proposals until the loop is switched on, and
  then until the agent has 10 decided decisions or the loop has run 14 days. It also
  refuses a second proposal for the same target within 7 days. Several changes may
  be in flight for one agent. (Decision 57 makes these limits settings.)
- **The gateway drives it:** approving records a change (`C-n`) and starts a task
  for Mandla, the mechanic, with a brief built from the payload. Mandla clones the
  repo, makes the change, runs the tests and calls `submit_change` once. The gateway opens the pull
  request, with the change, decision and evidence ids in its description. If the
  task ends without a pull request (including running out of budget), Ada may follow
  it up once with Mandla, on the same budget and tier; a second block closes
  the change and goes to the owner. If Ada closes the task with `close_task`
  (decision 53), the change closes with it. A change still building after 7 days is
  closed.
- **Budgets:** $1 a Mandla task for `wording` and `tier`, $5 and the deep tier for
  the other types (`budgets.mechanic_small_usd` and `mechanic_large_usd`).
- **Live:** after each deploy the workflow marks live the changes whose pull request
  is merged into the deployed history (by PR number, or a `Change: C-n` line), if it
  was still open or closed as stale (decision 60). The
  gateway never reads this repo. A pull request unmerged after 30 days is closed by
  the stale workflow, and the gateway closes its change.
- **Measured by the gateway, before and after:** 14 days after a change goes live, the
  gateway compares its measure over the 14 days before and after, and stores
  `better`, `same`, `worse` or `too_little_data` (fewer than 5 cases either side).
  Too little data is tried again weekly over the whole time since going live, up to
  42 days, then the change is closed. A result names other changes to the same agent,
  or to the network, that went live within its windows. No agent grades a change, so none grades its
  own.
- **Results:** Ada reports each in her next check-in, one line per change. A `worse`
  result leads her to propose reverting it through the same card; nothing is
  reverted automatically.
- **Name:** the mechanic is Mandla (agent id `mandla`), a Zulu, Xhosa and Ndebele name
  meaning strength, chosen so the team's names reach beyond Europe.
- **Commit author:** the gateway has one GitHub App, named after Mira, so
  Mandla's pull requests show that App as author. The owner kept it: each
  description names the change, decision and task. A neutral App name is worth it
  once others read this repo's history.
- Not chosen: replaying past cases against a proposed spec before it ships (the owner
  chose a before-and-after check); Ada tracking proposals in her notes (sessions start
  fresh, so proposals stall; her notes are only a reminder, and the gateway's change
  record is the source of truth); Mandla proposing and measuring its own changes.

**56. Mira reviewing pull requests on this repo** · RESOLVED (not built)

- Once the first outside contribution arrives, Mira will review pull requests here,
  on tighter terms than on the Accord repos.
- She may review, comment and label only. No `auto` kinds here: a CI approval goes to
  the owner. Every merge proposal is high risk. The repo stays out of her write
  scope.
- It does not change who writes here (decision 51).

**57. More proposals while the network settles** · RESOLVED

- The owner wants to run Mandla several times a week while the network settles. The
  loop allowed one proposal per agent a week, and none until an agent had 10 decided
  decisions or the loop had run 14 days.
- Those limits are now settings in `config/network.yaml`: `proposal_gap_days`,
  `min_decided` and `min_days`, with defaults 7, 10 and 14. While settling they are 0,
  10 and 0: Ada may propose for an agent as often as needed, from the start.
- Ada proposes in the weekly evaluation and whenever the owner asks. She still cites
  evidence, and the owner still approves each proposal before Mandla builds it.
- Changes to one agent close together share their before-and-after figures; each
  result names the others (decision 55). Once settled, the gap goes back to 7 days and
  the start rule to 14.

**58. Registering the Discord slash commands** · RESOLVED: automatic, in the deploy workflow

- The slash commands offer the deployed agents as fixed choices, each shown with its
  role ("Mira (Maintainer Desk)", from the spec's `title:`). Discord keeps the list it
  was last sent, so it went stale whenever an agent joined until someone re-ran
  `npm run discord:commands`. The workflow only warned when the script itself changed.
- The `deploy` workflow now re-registers them after the agents deploy, whenever
  `network.yaml`, an agent spec or the Discord command code changes. It uses
  `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN` from the `production` environment; a fork
  without them skips the step.
- The bot token already lets the gateway post as the bot, so holding it in the
  environment adds no new power. Runs still wait for the owner's approval (decision 49).

**59. A fresher `/status`** · RESOLVED

- `/status` read only the gateway's database, which is as fresh as the last webhook.
  The last report is what an agent said at the end of its last session, however old,
  so finished work could still show as in progress.
- Now `/status` first re-reads up to 10 live sessions from Managed Agents, as a
  webhook would; shows each agent's sessions at work and when the oldest started; and
  gives each report's age. On Discord it answers after Discord's 3-second deadline.
- Each `/status` costs up to 10 extra API calls. Ada's `get_status` still reads only
  the database: refreshing inside her own tool call could process her session
  mid-call.

**60. A `/status` that stays true** · RESOLVED

- A `/status` on 4 November was wrong in several ways at once:
  - It showed a merged change as `pr_open`. The squash merge kept only the PR title
    and sign-off, so the deploy found no `Change: C-n` line and never marked the change
    live.
  - It showed Ada blocked on file tools a deploy had since fixed. Ada's next check-in
    was two days away, so her old report stood until then.
  - Sage listed gaps in the news as blockers. A blocker leaves a task blocked and
    wakes Ada to follow it up, so gaps cost a wake and added noise to the
    self-improvement loop's evidence.
  - It counted Mira's open tasks without naming them, and her reports named neither
    the PR she meant nor who had to act.
- The deploy now finds changes by their PR number as well as the `Change:` line, and
  checks every pending change against the whole deployed history, so one an earlier
  deploy missed goes live at the next.
- `/status` lists each agent's open tasks (at most five, then a count) with why a
  blocked one stopped. It marks blockers reported before the latest deploy as possibly
  fixed.
- The protocol now says what each `report_status` field is for. Each item names its
  PR, issue, task or decision and gives the outcome, not the steps. `blocked` is only
  for work that needs someone else to act, with who and what. Gaps and caveats go in
  `notes`. An agent checks its tools before reporting one missing.

**61. Replying to an agent's message** · RESOLVED

- A plain reply in a Discord DM never reached the network: Discord tells a bot only
  about slash commands, buttons and forms, not ordinary messages, unless the bot holds
  a connection open, which the gateway (a Cloudflare Worker) can't. And `/ada` continues
  the most recent Discord conversation, which is often not the session that wrote the
  message being answered (a scheduled check-in, another agent, or a conversation that
  moved to a fresh session at its budget), so the agent had no record of it.
- Now the gateway records which session sent each message to a person. In Discord, each
  agent message carries a **Reply** button, and any bot message has **Reply to agent**
  in its Apps menu; both open a short form. In Telegram, the app's own reply does the
  same. The reply goes to the session that wrote the message, and that session's later
  answers come back to whoever replied.
- If that session has ended, is near or past its budget, or the message predates this,
  a fresh session for the agent named at the start of the message (Ada otherwise) gets
  the reply with the original quoted.
- Only the person a message was sent to can reply to it. A member's reply is marked as
  theirs and counts towards their daily allowance, as `/ada` does.

**62. Hearing about changes on GitHub** · RESOLVED (amends 32)

- Nothing listened to GitHub. Open decision cards went stale when a maintainer merged
  or closed a PR or new commits landed, and Mira found PRs ready for review or merge
  only at her next scheduled pass.
- The gateway's GitHub App sends events to the gateway (`POST /github`). The gateway
  updates its own records in plain code:
  - it marks an open decision `lapsed`, with the reason on the card, when a person
    merges or closes the PR or issue, or when a merge or CI approval's head gets new
    commits. Only open decisions lapse: approved ones are already running, and
    `lapsed` only closes a decision, so nothing is approved or run by an event;
  - it re-runs an open merge card's checks when CI finishes or a review or thread
    changes, and shows them on the card;
  - it records review outcomes for PRs people merge or close;
  - it shows each PR's recent activity in Mira's queue.
- Events wake Mira, within daily caps per trigger (`budgets.github_wakes`) and only
  while she is active and schedules are on: to review a PR when its CI goes green at a
  head not yet reviewed, to propose a merge when every merge check passes at a
  reviewed head (as a review check that skips the review), and to first-respond to a
  first-time contributor. Each wake re-reads the PR before starting and is dropped if
  it no longer applies. The review pass drops to once a day as a catch-up.
- Once a day, from 05:30 local time, the gateway re-reads the open PRs and issues the
  network tracks (open decisions, reviews with no outcome, pending wakes), since GitHub
  doesn't retry failed deliveries. It never lists whole repos.
- Events carry no rights (decision 33), the gateway stores no text from them, and it
  ignores the network's own repo and any repo not in scope.
- Not chosen: sessions subscribing to PRs and issues (sessions can only receive what
  the gateway sends them, and would spend tokens waiting); polling as the main route.
- Design: `docs/superpowers/specs/2026-11-11-github-events-design.md`.

**63. Fixing failed CI** · RESOLVED (not built)

- Felix joins Phase 1 for one job: fixing failed CI on PRs the network tracks (one
  Mira has reviewed, or with an open decision or a pending wake). His release work, and
  any watch on untracked PRs or the default branch, stay off.
- Mira diagnoses a tracked PR's failed CI from its logs. She asks for a re-run when it
  is flaky, comments to a person whose change broke it, and hands a bot's PR, or one
  failing because the base branch is broken, to Felix through the gateway.
- Felix builds and tests the fix in a sandbox with no write credentials, as Mandla
  does, and requests `github.fix_pr`; the gateway applies it only after the owner
  approves the card.
- Not chosen: giving Mira a shell. Building runs the repo's and its dependencies' code,
  and her sandbox holds a token that posts as the project.
- Design: section 4a of the design in decision 62.

**64. No advisor model** · RESOLVED

- Managed Agents lets an agent on a cheaper model consult a stronger one mid-turn
  (the "advisor"). Each consultation is billed at the stronger model's rates.
- Off for every agent. On a standard-tier agent it only adds cost. It could save
  money only by moving the deep-tier roles (Ada, Mira's review check) to a cheaper
  model, and Opus 5.5 costs only twice what Sonnet 5.5 does, so the saving would be
  small and fall on the roles where judgement matters most. The cheaper model also
  decides for itself when to ask, and the advice comes back encrypted, so the audit
  log can't show what it said.
- Revisit if spend by agent shows the deep-tier roles taking most of the monthly
  budget, after trying a lower effort level first.

**65. Spending less without lowering quality** · RESOLVED

- Per-task tiers now take effect. `models.yaml` already put Mira's triage on the fast
  tier and Vera's weekly analysis on the standard tier, but nothing used them: every
  scheduled run used the agent's default tier. A schedule now names a task (`task:`),
  and the run uses that task's tier and effort. The gateway's own sessions do the same:
  review wakes and review checks run as Mira's review task (the check task for a
  high-risk PR), first-response wakes as her triage task, and Mandla's large changes as
  his large_change task.
- Each agent and task sets an effort level: low for routine work (Vera's daily
  refresh), medium for drafting and chat, high for reviews and code changes. Before,
  every session ran at its model's default, which is high on Sonnet 5.5. Triage stays
  at medium because it reads fork diffs before approving CI.
- Ada stays on Opus 5.5 at low effort for check-ins, chat and follow-ups, with
  medium for the weekly evaluation. Not chosen yet: moving her to Sonnet 5.5. Her
  briefs shape every other agent's work; revisit if her scores hold for two weeks at
  low effort.
- Mira's triage runs once each morning, for nudges and closures. At 13:00 and 18:00 the
  gateway asks GitHub what was opened in the repos in scope since the pass before, and
  starts a triage pass only if something was (`budgets.triage_checks`).
- The evaluation rubric moves out of Ada's system prompt into the shared memory store,
  so only the weekly evaluation reads it, not every one of her sessions.
- Judge each step by Vera's cost per outcome and Ada's scores for the agent concerned.

**66. How Mira reviews: a published method as her baseline** · DEFAULT

- Mira's review steps said what to look at but not how to judge it. Her review method
  is now one skill file, `skills/pr-review/SKILL.md`, built on three published
  baselines: Google's engineering practices for code review (what to look for and
  when to approve), Addy Osmani's `code-review-and-quality` agent skill (MIT), and
  Anthropic's `claude-code-security-review` (MIT) for security findings and common
  false alarms. `NOTICE.md` beside it credits the sources and carries their licences.
- The method adds what the spec lacked: read the tests first; test every finding
  against callers, guards and tests before keeping it; leave defects that were
  already on the base branch out of the review; clear rules for high and medium
  confidence and for each severity; a list of false alarms not to report.
- Delivered through the shared memory store, like the evaluation rubric (decision 65):
  deploy writes it to `/reference/skills/pr-review.md`, and Mira reads it at the start
  of a review and of a review check. Triage sessions don't pay for it. The file is in
  Agent Skills format, so it can move to an attached skill later without rewriting.
- A new review area, `design` (fit, needless complexity, over-engineering,
  duplication), because all three baselines treat design as a first concern and none
  of the existing areas covered it.
- Mira's job spec still wins where the two differ: severities, limits, tone and what
  the gateway refuses stay as decisions 35 and 36 set them.
- Judge it by the share of posted findings maintainers act on (`review_findings`).
  Revisit if it drops, or if `design` findings are mostly dismissed.
