# Setting up your own network

How to run a copy of this network for your own project. It takes about a day, most of
it creating accounts and apps. Read [ARCHITECTURE.md](../ARCHITECTURE.md) first.

You will need:

- Node.js 22 or later
- a Claude Console organisation with API access (Claude Managed Agents)
- a Cloudflare account (the gateway runs on the free tier)
- owner rights on the GitHub organisation whose repos the agents will work on
- a Telegram account; optionally a Discord server and a Vimeo account

Start in **Phase 0**: one sandbox repo, schedules off, and the gateway in dry-run mode,
so nothing real happens until you have seen an approval go through end to end.

## 1. Fork and adapt the config

Fork the repo, run `npm ci && npm ci --prefix gateway`, then make it yours:

| File | Change |
| --- | --- |
| `config/network.yaml` | `github.org`, `sandbox_repo`, `repos: []` for now, `current_phase: 0`, `schedules_enabled: false`, budgets, timezone |
| `config/people.yaml` | Yourself (`role: owner`) and anyone else who may ask the network questions |
| `config/people.ids.yaml` | Copy `config/people.ids.example.yaml`; add Discord and Telegram ids. Git-ignored. |
| `config/discord.yaml` | Your announcements and private ops channel ids, or leave empty |
| `context/accord.md` | Rename it for your project and rewrite it: mission, meetings, channels, KPI targets. Keep the `repos in scope` marker line; deploy fills it in. Update the path in `scripts/deploy.ts`. |
| `agents/*.md` | The specs name Accord Project repos, meetings and people. Rewrite those parts; keep the numbered steps and tool names. |
| `config/mcp_servers.yaml`, `scripts/repo-add.ts` | The agents' GitHub account name (`mttrbrts-agent` here) |
| `gateway/wrangler.toml` | Worker name and D1 database name and id (step 3) |
| `.github/CODEOWNERS`, `MAINTAINERS.md` | Your maintainers |

Run `npm test`; it tells you what's inconsistent.

## 2. Claude Console

1. Create two API keys in your Console organisation: one for the gateway, one for
   deploys. Set a monthly spend limit on the workspace.
2. Agents are created in step 7. Webhooks are added in step 5, once the gateway has a URL.

## 3. Cloudflare

```sh
cd gateway
npx wrangler login
npx wrangler d1 create <your-database-name>     # copy the id into wrangler.toml
# edit the database name in gateway/package.json's migrate script too
npm run migrate
```

Leave `DRY_RUN = "true"` in `wrangler.toml` until the Phase 0 gate passes.

## 4. GitHub

1. **Gateway app.** Create a GitHub App owned by your organisation, with repository
   permissions Contents, Pull requests, Issues and Actions (read and write) and
   Metadata (read). Leave its webhook off for now; step 5 turns it on once the
   gateway has a URL. Generate a private key, convert it to PKCS#8
   (`openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem`)
   and keep it **outside** the repo folder. Install the app on the sandbox repo and note
   the installation id.
2. **Agents' account.** Create a separate GitHub account for the agents and add it to
   the organisation. Give it the **Triage** role on the sandbox repo (later, each repo
   in scope) and nowhere else.
3. **Agents' tokens.** Signed in as that account, create one fine-grained token per
   agent, resource owner your organisation:
   - agents that triage (Mira): only the repos in scope, Issues and Pull requests read
     and write;
   - read-only agents (Vera, Otto): all repositories, read-only permissions.

## 5. Bots and webhooks

Deploy the gateway once to get its URL, then set its secrets:

```sh
npm run gateway:deploy           # prints https://<worker>.<subdomain>.workers.dev
cd gateway
npx wrangler secret put TELEGRAM_BOT_TOKEN
# …and each secret below
```

| Secret | Where it comes from |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Create a bot with @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Any random string; used in `setWebhook` below |
| `OWNER_TELEGRAM_ID` | Your numeric Telegram id (message the bot, then `/whoami`) |
| `ANTHROPIC_API_KEY` | The gateway key from step 2 |
| `ANTHROPIC_WEBHOOK_SECRET` | The `whsec_…` secret of the Console webhook below |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | The gateway app from step 4 |
| `GITHUB_APP_PRIVATE_KEY` | The PKCS#8 key: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key-pkcs8.pem` |
| `GITHUB_WEBHOOK_SECRET` | Optional: any random string; the gateway app's webhook secret below. Without it the gateway hears nothing from GitHub |
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | Optional: a Discord application with a bot, invited to your server |
| `OWNER_DISCORD_ID` | Optional: your Discord user id |
| `VIMEO_ACCESS_TOKEN` | Optional: a Vimeo token with public, private and edit scopes |
| `PEOPLE_IDS` | Set by `npm run people:ids` from `config/people.ids.yaml` |

Then point each service at the gateway:

- **Telegram:**
  `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`
- **Claude Console:** add a webhook to `https://<worker>/anthropic` for session events
  and for `deployment_run.failed` and `deployment.paused`; its signing secret is
  `ANTHROPIC_WEBHOOK_SECRET`.
- **GitHub (optional, decision 62):** in the gateway app's settings, turn on the
  webhook with URL `https://<worker>/github` and secret `GITHUB_WEBHOOK_SECRET`, and
  subscribe to Pull request, Pull request review, Pull request review thread,
  Workflow run, Issues and Issue comment. The app sends events for the repos it is
  installed on; the gateway ignores any not in `github.repos`. Check the app's
  Advanced tab shows the ping answered `pong`.
- **Discord (optional):** in the Developer Portal set the Interactions Endpoint URL to
  `https://<worker>/discord`, then register the slash commands:
  `DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run discord:commands`. They work in your
  server and in DMs with the bot. If you registered them before decision 34, add
  `DISCORD_GUILD_ID=…` once to remove the old server-only copies.

Check `https://<worker>/health` answers `ok`, and that `/whoami` in Telegram knows you.

## 6. Load people's ids

```sh
npm run people:ids -- --dry-run   # who has which ids
npm run people:ids
```

Run this before every gateway deploy that changes `people.yaml`, or people lose access.

## 7. Deploy the agents

```sh
export ANTHROPIC_API_KEY=<deploy key>
export MIRA_GITHUB_TOKEN=… VERA_GITHUB_TOKEN=… OTTO_GITHUB_TOKEN=…
npm run deploy:agents:dry
npm run deploy:agents             # writes gateway/src/generated/deployed.json
npm run gateway:deploy            # the gateway bundles deployed.json
```

Commit `deployed.json`; it holds resource ids, not secrets.

### Deploying from GitHub Actions

After the first deploy, the `deploy` workflow does this on every push to `main`
(decision 49). It works out what changed since the last successful deploy and deploys
only that: people's ids
when `people.yaml` changed, D1 migrations, the gateway, then the agents. If the agents'
deploy creates resources, it deploys the gateway again and opens a
`chore(deploy): record deployed resource ids` PR. Merge it before the next agent
deploy; until then the workflow refuses to deploy agents, so nothing is created twice.
Running the workflow by hand deploys everything, as a dry run unless you untick it.

Set up its `production` environment once. Only runs from `main` may use it, each run
waits for your approval, and admins can't skip that:

```sh
REPO=<owner>/<repo>
ME=$(gh api user --jq .id)
gh api -X PUT repos/$REPO/environments/production --input - <<EOF
{ "reviewers": [{ "type": "User", "id": $ME }], "prevent_self_review": false,
  "can_admins_bypass": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
EOF
gh api -X POST repos/$REPO/environments/production/deployment-branch-policies -f name=main -f type=branch
```

Then give the environment its secrets. Keep them out of repository secrets, so only
approved runs from `main` can read them:

```sh
for s in ANTHROPIC_DEPLOY_KEY MIRA_GITHUB_TOKEN VERA_GITHUB_TOKEN OTTO_GITHUB_TOKEN \
         CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  gh secret set $s --env production --repo $REPO
done
gh secret set PEOPLE_IDS_YAML --env production --repo $REPO < config/people.ids.yaml
# Optional, with Discord: re-registers the slash commands when agents change.
for s in DISCORD_APP_ID DISCORD_BOT_TOKEN; do gh secret set $s --env production --repo $REPO; done
```

The Cloudflare token needs Workers Scripts: Edit and D1: Edit on the account. When
`people.ids.yaml` changes, set `PEOPLE_IDS_YAML` again. Without the Discord secrets the
workflow skips the slash commands; run `npm run discord:commands` by hand instead.

## 8. Pass the Phase 0 gate

In the sandbox repo, with `DRY_RUN` still `"true"`:

1. Message the bot: ask Ada to have Mira triage an open PR in the sandbox.
2. Approve the merge card she queues; the gateway logs what it would do.
3. Set `DRY_RUN = "false"`, deploy the gateway, and repeat: the gateway merges.
4. `/stop mira` halts her within seconds.

Then move to Phase 1: set `current_phase: 1` and `schedules_enabled: true`, add real
repos with `npm run repo:add owner/name` (it checks the GitHub side), and run
`npm run gateway:deploy` and `npm run deploy:agents`.

## 9. Switch on the self-improvement loop

The loop (decision 55) lets Ada propose changes to the network's own specs, tiers and
tools; once you approve one, Mandla builds it and the gateway's App opens a pull
request on your copy of this repo. It is off until you set a start date. Do this once
Phase 1 is running.

1. **Install the App on this repo.** In the gateway App's installation settings, add
   your copy of this repo to the repositories it can reach. Set
   `github.network_repo` in `config/network.yaml` to it. Don't add it to `repos`;
   `npm test` refuses that.
2. **Check the App lacks the Workflows permission.** In the App's settings, under
   Repository permissions, Workflows must be "No access". Then the App can't change
   CI or the deploy workflow, even by mistake.
3. **Set the commit author** to the App's bot identity, so its commits carry a DCO
   sign-off that matches the author. Find the bot's user id:

   ```sh
   gh api "users/<app-slug>%5Bbot%5D" --jq .id
   ```

   and set `self_improvement.commit_author` in `config/network.yaml` to
   `{ name: "<app-slug>[bot]", email: "<id>+<app-slug>[bot]@users.noreply.github.com" }`.
   `npm test` refuses the placeholder email once the loop is on.
4. **Switch it on.** Set `self_improvement.since` to the start date (e.g.
   `2026-11-10`). Ada can propose a change for an agent once it has `min_decided` (10)
   decided decisions, or `min_days` (14) after that date, and at most one per agent
   every `proposal_gap_days` (7). Lower them while the network settles. Keep `stale_days` equal to the days
   `.github/workflows/stale.yml` takes to close a PR (23 to mark it stale plus 7 to
   close it), and change that workflow's `repository_owner` check to your
   organisation.
5. Run `npm test`, then deploy the gateway and the agents.

To turn the loop off, set `self_improvement.since` back to `null` and deploy the
gateway. That stops new proposals, but proposal cards already in the queue stay
valid: approving one still starts Mandla. Reject them.

Mandla's budgets are `budgets.mechanic_small_usd` and `mechanic_large_usd`. The
`deploy` workflow records which changes each deploy made live; it already holds the
D1 credential it needs.

## 10. Repo settings worth turning on

- Secret scanning and push protection.
- Branch protection on `main`: pull requests, the `ci` check and the DCO check. The
  `deploy` workflow relies on it (decision 49). CI doesn't run on the resource-ids PRs
  it opens, so merge those past the `ci` check.
- Actions: require approval for workflows from fork pull requests.
- Actions → General → Workflow permissions: tick **Allow GitHub Actions to create and
  approve pull requests**. The `deploy` workflow needs it to open the resource-ids PR.
  Without it the ids wait on the `deploy/resource-ids` branch and agent deploys stop
  until you open and merge that PR by hand.
