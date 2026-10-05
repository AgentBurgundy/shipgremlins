# ShipGremlins alpha implementation status

Updated October 4, 2026. The master plan is a product roadmap, not a statement that
every capability is shipped. This page records the implemented foundation.

Project telemetry now includes optional read adapters for Sentry logs/error
events, Datadog logs, and Mixpanel saved Insights reports. Project configuration,
local dashboard credential fields, preflight/doctor checks and PM workflow secret
wiring are included. Scope, failure and redaction tests use mocked HTTP;
provider accounts still require live validation. See [setup and limits](TELEMETRY.md).

Official GitHub App and GitLab OAuth device connections now feed the dashboard's
repository picker, doctor checks, and local jobs. Credentials refresh on the
controller; durable job leases defer new work when rotation would invalidate a
running job's token. Existing PATs remain supported, with manual repository setup
for self-hosted GitLab. See [source control](SOURCE_CONTROL.md). Provider access
still needs verification for each user's repositories.

Linear and Vercel browser connections now feed local job preparation and provider
checks. Explicit dashboard app/PM setup provisions one Linear team per app and one
project per mandate, with persisted creation IDs and retry recovery. Existing
mappings are preserved. PMs remain disabled until reviewed; connection/provisioning
tests use fake provider responses. See [connections and mapping](LINEAR_VERCEL.md).

Version 0.6 adds repository-first projects with an explicit pull-request base and
editable install/test commands. Browser verification is optional and selects a
named preview/staging environment: a supplied URL, Vercel, Railway, or Cloud Run.
Connections holds shared and named credentials; hosting account credentials stay
on the controller. Existing Vercel promotion configurations remain supported.
See [project settings and hosting](PROJECTS.md).

Version 0.7 separates dashboard navigation into addressable pages, adds a shared
update banner with periodic release checks, and presents integrations as compact
cards with setup guidance. Sentry, Datadog and Mixpanel scopes can be edited in
project forms; saved Mixpanel report IDs can be assigned to individual PMs without
editing JSON. Project Slack overrides remain optional and inherit the workspace
connection when unset. Existing credentials and unrelated settings are preserved.

Version 0.8 adds independently encrypted, named Linear and Vercel connections,
selected per project and used by provisioning, verification, and local jobs.
Queued developer work pins its Linear account/workspace; changed bindings require
new approval checks. A missing named account never falls back to the default.
The project editor identifies the app and repository, and supports revision-guarded
repair of existing Linear teams and PM projects. The dashboard has category tabs,
a mobile navigation drawer, and operational overview counts. Provider integration
tests use fake accounts; live permissions still require Verify connections.

Version 0.9 makes PM automation controllable from each project card. Explicit
manual PM and Coding runs work while automation is paused; scheduled patrols and
background approved-ticket pickup still respect the pause. Readiness shows the
next missing connection, mapping, verification, or worker step. Fill with AI uses
the saved Claude Code connection and a bounded repository tree to suggest PM
defaults in an isolated Docker container. Suggestions require review and an
explicit apply/save; the first patrol does not rewrite ownership. Tests cover
draft validation and the real Docker isolation path with a synthetic model;
production model output remains dependent on the connected Claude account.

| Capability       | Current state                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled PMs    | Local controller schedules enabled, verified areas in UTC and queues approved Linear tickets; isolated Docker jobs use Claude Code and Playwright. Existing GitHub Actions workflows remain optional.                                                             |
| Recovery         | Durable local queue, idempotent schedule/ticket keys, cross-process lock, inspection of existing containers after restart, and one retry before launch. Failed agent jobs require review. Legacy dispatcher recovery remains separate.                            |
| Promotion        | Separate legacy Vercel release tools enforce checks and signed browser evidence for an assembled candidate. Local workers stop at draft PRs/MRs targeting the configured base branch; no automatic staging promotion.                                             |
| Linear Done      | Read-only audit and explicit, dry-run-first reconciliation using an operator-reviewed complete deliverable manifest; merged production PR and Git-tree proof required                                                                                             |
| Test fixtures    | CSV from JSON with quoting and Unicode; reproducible PNG test grids; size limits, SHA-256 manifests, no overwrite; PM instructions for real browser upload and cleanup                                                                                            |
| Setup            | Global `gremlins` command (`shipgremlins` / `hub` compatibility aliases), compact ASCII greeting, resumable initialization, LAN dashboard, validated config editor, file locations and connection tokens; PMs start disabled                                      |
| Updates          | CLI and dashboard checks/install/rollback; pinned official commit with successful CI, isolated runtime installation, startup/config validation, atomic selection and supervised dashboard restart                                                                 |
| Local hosting    | Foreground dashboard/controller or `gremlins start`, `stop`, and `status`; explicit LAN mode; manual service-manager setup for reboot persistence. Runtime upgrades preserve configuration and running Docker jobs.                                               |
| Runners          | Dashboard creates local Docker capacity, verifies Chromium screenshot evidence, pauses/drains, repairs and removes idle workers; logs/artifacts and archived job history persist. One job per worker, up to four slots. No provider CI registration is required.  |
| Activity history | Local Docker PostgreSQL store with idempotent run/event persistence, visible tool activity, summaries, checks, redacted logs, and bounded artifact retention. Queue control still uses private local files.                                                       |
| Slack            | Branded PM and developer lifecycle notifications, instance-wide incoming webhook/OAuth connection and per-project override. Attempts are durably claimed before sending; no repeat after restart, no guaranteed delivery. See [Slack setup and limits](SLACK.md). |
| Website          | Separate private landing repository, deployed to Vercel; original mascot and responsive static site with real setup guide and labeled example workflows                                                                                                           |

Version 0.9.2 separates live activity, logs, and artifact loading, keeps unchanged
timeline entries in place, and bounds slow dashboard reads. Newly created PM
projects in Linear receive gremlin branding and a mandate-based operating brief;
explicitly reused projects retain their existing content. Retry recovery fills
missing metadata only for projects with a saved controller creation record.

## What still needs implementation

The trusted verifier must be provisioned separately. The tools verify signed
receipts; this release does not automatically install a browser verifier, manage
its protected keys, or supply authenticated test accounts for arbitrary apps.
Existing PM/developer environments must never receive the private signing key.

Local jobs support GitHub and GitLab source connections, optional URL/Vercel/Railway/
Cloud Run browser targets, Linear, and Claude Code. Hosting adapters discover
existing ready environments; they do not provision infrastructure or deploy changes.
Railway and Cloud Run contracts are covered by mocked provider tests, not live
account certification. Exact-candidate promotion across all hosting providers,
other AI runtimes, semantic image generation, automatic fixture cleanup, automatic
OS service installation, cloud fleet management, and production lifecycle webhooks
remain roadmap work.
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

Flexible-project checks cover repository-only work, provider scope/readiness,
cross-project credential separation, configuration edits invalidating verification,
and concurrent edits during doctor checks. Real Docker smoke checks exercise
Chromium screenshots, host.docker.internal access and Python virtual environments.
Dashboard flows were checked at desktop and 320px widths with isolated provider
fixtures. These checks do not establish live Railway or Cloud Run authorization.

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
