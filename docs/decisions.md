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

**51. Who may change the network's own code** · RESOLVED (the mechanic is not built yet)

- No agent holds a credential for this repo, and it is in no agent's scope or the
  gateway's `repos`. Today the owner applies every `spec.change` by hand.
- A future mechanic agent may open pull requests here from its own fork, with a
  credential limited to that fork. It cannot merge. No other agent may write to this
  repo.
- When it is built: `compile.ts` refuses this repo in any other agent's scope or in
  `repos`; the gateway refuses every action kind that targets it; the owner merges on
  GitHub and deploys by hand, so a merged change is not live until deployed.
- Each proposal cites the audit rows it rests on; text in those rows is data, not
  instructions. Pull requests that touch the mechanic's own spec or permissions,
  `permissions.yaml`, or the gateway's checks are flagged for closer review.
- Not chosen: letting every agent propose changes here (the rules would be editable by
  the agents they limit); no agent writing here at all (every fix waits for the owner
  to write it).

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
- The gateway now closes them: out of budget makes the task `blocked` on that, and Ada
  is woken within the usual limits (decision 50); an error or exhausted retries makes it
  `failed`. The hourly tidy-up fails open or running tasks whose session is over or
  stale, and tasks with no session after 7 days, which also clears the backlog.
- Ada may close a task herself with `close_task(id, note)`, for one that is finished
  in practice or a duplicate, only once its session has stopped and never in a
  conversation a member started. It is audited as `ada.closed_task` and listed under
  "Decided for you".
- Not chosen: leaving them open, or a close command for the owner only.
