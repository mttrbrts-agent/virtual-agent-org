# virtual-agent-org

A network of Claude agents that helps run the [Accord Project](https://accordproject.org):
triaging and reviewing pull requests, measuring community health, and turning Tech
Working Group recordings into summaries. The TSC chair instructs one agent, **Ada**,
the Chief of Staff, from Telegram or Discord. Ada delegates to specialist agents, and
every critical action (merging, publishing, posting, messaging someone) waits in a
decision queue for the chair's approval.

**Status:** Phase 1, an experiment. Five agents (Ada, Mira, Vera, Otto, Sage) work on
[Concerto](https://github.com/accordproject/concerto),
[Template Engine](https://github.com/accordproject/template-engine) and
[Template Playground](https://github.com/accordproject/template-playground).
Agent-drafted messages are labelled as such. A sixth agent, Mandla, builds
changes to this repo's own specs and tools that the chair has approved, as pull
requests he reviews.

## How it fits together

1. Each agent runs on [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents)
   with its job spec from `agents/`, its tools, and its own credentials vault and memory.
2. Agents call custom tools (`request_action`, `assign_task`, `report_status`, …).
   Managed Agents notifies the **gateway**, a Cloudflare Worker, which runs the tool.
3. `request_action` queues a decision and returns its id at once, so the agent keeps
   working. The chair approves or rejects it from a card in Telegram or Discord.
4. On approval the gateway carries out the action with its own credentials and logs it.

[ARCHITECTURE.md](ARCHITECTURE.md) explains the design, the safety rules and how the
network is governed; [docs/decisions.md](docs/decisions.md) records why.

## Layout

| Path | What it is |
| --- | --- |
| `ARCHITECTURE.md`, `docs/` | Design, decision log, and [setup guide](docs/setup.md) for running your own copy |
| `agents/` | One job spec per agent, plus `_protocol.md`, which every agent follows |
| `config/network.yaml` | Phase, agents per phase, repos in scope, budgets |
| `config/permissions.yaml` | Action kinds and their risk, and what each agent may use and request |
| `config/models.yaml` | Model tiers, and effort per agent and per task; specs name a tier, never a model |
| `config/schedules.yaml` | Recurring work: check-ins, triage, reviews, scorecards |
| `config/people.yaml` | People who can talk to the network, their roles and GitHub logins |
| `config/mcp_servers.yaml` | External tool servers and where each agent's token comes from |
| `context/accord.md` | Shared, read-only project context for every agent |
| `evaluation/` | Weekly evaluation rubric and scorecard schema |
| `gateway/` | The Cloudflare Worker: bots, decision queue, custom tools, audit log |
| `scripts/` | Config validation, deploys, and helpers such as `repo:add` |

## Talking to the network

Plain messages to the Telegram bot go to Ada. On Discord, use `/ada <text>` in the
server or in a DM with the bot. Commands: `/status`, `/queue`,
`/ask <agent> <text>`, `/pause <agent>`, `/resume <agent>`, `/stop <agent|all>`,
`/revoke <agent> confirm`. People listed in `config/people.yaml` can ask questions and
see status and the queue; only the chair can instruct, approve or stop agents.

## Development

Requires Node.js 22 or later.

```sh
npm ci && npm ci --prefix gateway
npm test                     # config validation, script tests, type-check, gateway tests
npm run compile              # regenerate gateway/src/generated/network.json after a config change
npm run deploy:agents:dry    # what an agent deploy would change
npm run repo:add owner/name  # check a repo is ready, then add it to the network
```

Deploying needs the project's Anthropic, Cloudflare and GitHub credentials, so it is
done by the maintainers: merging to `main` starts a deploy, which runs once the owner
approves it. To run your own network for another project, see
[docs/setup.md](docs/setup.md).

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Changes to agent
specs, permissions and models are proposed as pull requests and merged by the chair.
To report a security issue, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
