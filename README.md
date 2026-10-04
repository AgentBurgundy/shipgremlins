# ShipGremlins

**AI product managers that actually use your app.**

Give AI product managers a mandate. They explore your app in a real browser, collect screenshots, and turn findings into Linear tickets. Developer agents work on approved tickets while a deterministic dispatcher checks the work, retries bounded failures, and prepares changes for your review.

ShipGremlins is an **early alpha**. The working integration is **GitHub + GitHub Actions + Vercel + Linear + Claude Code**. Self-hosted Linux runners and GCE runner tooling are included. GitLab, Railway, additional model providers, and a dashboard for connections, agents, and run history are planned. The landing page is a product introduction, not an agent dashboard.

[Source](https://github.com/AgentBurgundy/shipgremlins) · [Roadmap](docs/ROADMAP.md) · [Setup guide](docs/SETUP.md) · [Contributing](CONTRIBUTING.md)

## What it does today

- PMs keep a mandate, feature inventory, queue, and memory for each product area. Scheduled Claude Code runs can use Playwright MCP to inspect the app and capture screenshots.
- The fixture CLI creates CSVs and reproducible PNG files for real browser uploads. See [upload fixtures](docs/FIXTURES.md).
- Developers receive approved Linear tickets, work on isolated branches, and open implementation PRs against `pm-staging`.
- The dispatcher monitors checks, repairs common failures with bounded retries, and leaves actionable blockers when recovery needs help.
- Promotion gates check verification receipts and the candidate revision before preparing a PR into staging. The owner controls staging and production merges. See [verification and its trust boundary](docs/VERIFICATION.md).
- A production audit and opt-in reconciler keep completion tied to **all approved deliverables merged into the configured production branch**. Verification and staging alone do not mean Done.

The automation still needs configured test environments, provider credentials, clear mandates, and owner review. It is not yet a general-purpose autonomous service or a one-command cloud deployment.

## Start locally

Install Git and Node.js 22.12 or newer, then clone the source:

```bash
git clone https://github.com/AgentBurgundy/shipgremlins.git
cd shipgremlins
npm ci
npm run hub -- setup --help
```

Create your own hub repository for project configuration and workflow execution. Replace the example owner and repository names below with yours. If your checkout includes a sample `hub.json`, first set its `hubRepo` to your hub repository; initialization preserves existing settings and rejects conflicting repository identities.

```bash
npm run hub -- setup init --project my-app --repo your-org/my-app --hub-repo your-org/your-hub
npm run hub -- setup --check --project my-app
```

Initialization creates missing configuration and preserves existing settings. New PMs start disabled. The initial preflight is expected to report unfilled provider IDs and missing credentials; use that output as the setup checklist.

Edit `projects/my-app/project.json`, `projects/my-app/areas.json`, and the area mandate. Configure isolated staging accounts and the connection variables listed in [.env.example](.env.example). The CLI does not automatically load `.env`; for local checks you can supply it explicitly:

```bash
node --env-file=.env bin/shipgremlins.mjs setup --check --project my-app
node --env-file=.env bin/shipgremlins.mjs doctor my-app
```

`setup --check` is local and read-only. `doctor` contacts providers and, on success, stamps the project's local verification date. Complete [setup](docs/SETUP.md) and [runner configuration](docs/runners.md), then explicitly enable the area and review the generated schedules. Agents execute through GitHub Actions; running the CLI or landing-page container does not start a background agent service.

The `hub` command remains supported. A `shipgremlins` launcher is included in `bin/`; there is no claim of a published npm package or global installer yet.

## Done means merged into production

Start with the read-only audit:

```bash
npm run hub -- tickets audit --project my-app --json
```

It reports tracked tickets, scope hashes, and actual team workflow IDs. Reconciliation requires an operator-reviewed manifest listing the complete deliverable set and corresponding production PRs:

```bash
npm run hub -- tickets reconcile --project my-app --manifest /secure/release-scope.json
npm run hub -- tickets reconcile --project my-app --manifest /secure/release-scope.json --apply
```

The first command performs a dry run. Only `--apply` enables status writes. The reconciler reads actual merged PRs and Git trees; a comment, label, or deployment alone cannot close a ticket. Canceled tickets remain canceled. Ambiguous history, edited ports, and later changes to the same files remain flagged for review.

Read the [manifest format and limitations](docs/LINEAR_LIFECYCLE.md) before enabling writes. This is an explicit command today, not an automatic webhook service. Disable conflicting native completion automations when using it as the lifecycle authority.

## Development

```bash
npm test
npm run typecheck
npm run lint
```

The test suite uses fake providers and mocked HTTP responses. Normal unit tests do not require provider credentials. See [CONTRIBUTING.md](CONTRIBUTING.md) for focused checks and conventions.

## Documentation

- [Setup](docs/SETUP.md) and [runner setup](docs/runners.md)
- [Verification receipts and promotion gates](docs/VERIFICATION.md)
- [Linear lifecycle and production completion](docs/LINEAR_LIFECYCLE.md)
- [Existing operating guide](docs/README.md) and [add a project](docs/add-a-project.md)
- [Master plan](docs/MASTER_PLAN.md), [roadmap](docs/ROADMAP.md), and [launch plan](docs/OPEN_SOURCE_LAUNCH.md)

Older operating documents use the original PM Hub name and describe the v1 workflow. The setup, verification, and lifecycle documents describe the current alpha changes; the master plan distinguishes the larger intended system.

## License and security

Copyright 2026 ShipGremlins contributors. Licensed under the [Apache License 2.0](LICENSE). Third-party dependencies retain their respective licenses.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md). Keep provider credentials, authentication sessions, customer data, and private project configuration out of public issues and commits.

## Public source defaults

This distribution contains generic configuration and no enrolled projects. Scheduled
PM and dispatcher workflows are gated by the repository variable
`SHIPGREMLINS_ENABLE_SCHEDULES=true`. Leave it unset until your private hub repository,
credentials, runner, test accounts, and enabled PM mandates have been reviewed.
Manual workflow dispatch remains available. Run `hub crons write` in your operational
hub after enabling areas; the public snapshot starts with an inert placeholder cron.

`npm start` and the Docker image serve a small local operator-help page. The full
public marketing site is maintained separately; neither page is an agent dashboard.
