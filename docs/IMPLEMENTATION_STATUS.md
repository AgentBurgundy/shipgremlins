# ShipGremlins alpha implementation status

Updated October 4, 2026. The master plan is a product roadmap, not a statement that
every capability is shipped. This page records the implemented foundation.

Project telemetry now includes optional read adapters for Sentry logs/error
events, Datadog logs, and Mixpanel saved Insights reports. Project configuration,
local dashboard credential fields, preflight/doctor checks and PM workflow secret
wiring are included. Scope, failure and redaction tests use mocked HTTP;
provider accounts still require live validation. See [setup and limits](TELEMETRY.md).

| Capability       | Current state                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled PMs    | Local controller schedules enabled, verified areas in UTC and queues approved Linear tickets; isolated Docker jobs use Claude Code and Playwright. Existing GitHub Actions workflows remain optional.                                                             |
| Recovery         | Durable local queue, idempotent schedule/ticket keys, cross-process lock, inspection of existing containers after restart, and one retry before launch. Failed agent jobs require review. Legacy dispatcher recovery remains separate.                            |
| Promotion        | Separate legacy release tools enforce install/lint/typecheck/test/build and signed browser evidence for an assembled candidate. Local worker jobs currently stop at draft integration PRs/MRs; no automatic staging promotion.                                    |
| Linear Done      | Read-only audit and explicit, dry-run-first reconciliation using an operator-reviewed complete deliverable manifest; merged production PR and Git-tree proof required                                                                                             |
| Test fixtures    | CSV from JSON with quoting and Unicode; reproducible PNG test grids; size limits, SHA-256 manifests, no overwrite; PM instructions for real browser upload and cleanup                                                                                            |
| Setup            | Global `gremlins` command (`shipgremlins` / `hub` compatibility aliases), compact ASCII greeting, resumable initialization, LAN dashboard, validated config editor, file locations and connection tokens; PMs start disabled                                      |
| Updates          | CLI and dashboard checks/install/rollback; pinned official commit with successful CI, isolated runtime installation, startup/config validation, atomic selection and supervised dashboard restart                                                                 |
| Local hosting    | Foreground dashboard/controller or `gremlins start`, `stop`, and `status`; explicit LAN mode; manual service-manager setup for reboot persistence. Runtime upgrades preserve configuration and running Docker jobs.                                               |
| Runners          | Dashboard creates local Docker capacity, verifies Chromium screenshot evidence, pauses/drains, repairs and removes idle workers; logs/artifacts and archived job history persist. One job per worker, up to four slots. No provider CI registration is required.  |
| Activity history | Local Docker PostgreSQL store with idempotent run/event persistence, visible tool activity, summaries, checks, redacted logs, and bounded artifact retention. Queue control still uses private local files.                                                       |
| Slack            | Branded PM and developer lifecycle notifications, instance-wide incoming webhook/OAuth connection and per-project override. Attempts are durably claimed before sending; no repeat after restart, no guaranteed delivery. See [Slack setup and limits](SLACK.md). |
| Website          | Separate private landing repository, deployed to Vercel; original mascot and responsive static site with real setup guide and labeled example workflows                                                                                                           |

## What still needs implementation

The trusted verifier must be provisioned separately. The tools verify signed
receipts; this release does not automatically install a browser verifier, manage
its protected keys, or supply authenticated test accounts for arbitrary apps.
Existing PM/developer environments must never receive the private signing key.

Local jobs support GitHub and GitLab source connections with Vercel previews,
Linear, and Claude Code. This does not establish complete live certification of
both stacks. Railway deployment verification, other AI runtimes, semantic image
generation, automatic fixture cleanup, automatic OS service installation, cloud
fleet management, and production lifecycle webhooks remain roadmap work.
The local controller stores queue metadata in owner-private files and keeps job
containers/output volumes. PostgreSQL stores activity history and retained evidence;
distributed database leases and a guaranteed-delivery outbox are not implemented.
The CLI installs globally from GitHub; no npm registry package is published.
Local credentials are supplied to local jobs, not copied into provider CI stores.

The separate promotion tools retain the per-area selective `pm-release/*` model. Whole-branch
`pm-staging` → staging releases are planned. CI adapters currently use aggregate
check state; named required-check publisher enforcement remains open. Provider
branch protections and human staging/production merge decisions remain necessary.

## Validation and practical limits

Automated tests cover local queue restart recovery, duplicate suppression, worker
capacity, browser-proof rejection, archived history, credential separation, and
stopping the controller without removing jobs. Existing tests also cover recovery, merge/promotion gates, real Git candidate reuse,
signed evidence tampering and mismatches, lifecycle reconciliation, configuration,
fixture encoding, and static-file containment. Docker smoke checks cover non-root
execution, health, configuration initialization and private-file rejection. The
landing page was checked in a real browser at desktop and phone dimensions.

Slack tests use fake HTTP responses and cover formatting bounds, mention escaping,
restricted webhook URLs, timeouts, durable attempt markers, and restart behavior.
They do not send real Slack messages or certify a live workspace authorization.

These checks do not constitute a complete live target-application certification.
Before enabling schedules for a real project, configure isolated test data and
accounts, run doctor and worker verification, and supervise one complete PM/developer
flow. For the separate release tools, provision the trusted verification boundary,
disable conflicting Linear completion automation, and perform a reviewed release.
The local controller does not supply that full release automation yet. See [setup](SETUP.md), [verification](VERIFICATION.md)
and [Linear lifecycle](LINEAR_LIFECYCLE.md) for the concrete contracts.
