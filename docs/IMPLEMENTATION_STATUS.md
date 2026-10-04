# ShipGremlins alpha implementation status

Updated October 4, 2026. The master plan is a product roadmap, not a statement that
every capability is shipped. This page records the implemented foundation.

| Capability    | Current state                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduled PMs | Existing GitHub Actions / Claude Code jobs with per-area mandates, memory, Linear tickets and Playwright MCP                                                                                           |
| Recovery      | Unknown or stale integration health pauses ordinary work; current-revision CI repairs get a bounded recovery lane; one merge per pass awaits fresh health                                              |
| Promotion     | Local install/lint/typecheck/test/build gates; authenticated source evidence; Ed25519-signed browser evidence for the assembled candidate and base; missing evidence blocks staging PR creation/update |
| Linear Done   | Read-only audit and explicit, dry-run-first reconciliation using an operator-reviewed complete deliverable manifest; merged production PR and Git-tree proof required                                  |
| Test fixtures | CSV from JSON with quoting and Unicode; reproducible PNG test grids; size limits, SHA-256 manifests, no overwrite; PM instructions for real browser upload and cleanup                                 |
| Setup         | Resumable, non-overwriting CLI initialization and local preflight; PMs start disabled; credentials reported by name only                                                                               |
| Local hosting | Non-root Docker image and Compose with a read-only static operator-help site; CLI configuration stored separately                                                                                      |
| Runners       | Existing self-hosted GitHub runners and GCE launch tooling; no claim of live GCP certification in this release                                                                                         |
| Website       | Separate private landing repository, deployed to Vercel; original mascot and responsive static site with real setup guide and labeled example workflows                                                |

## What still needs implementation

The trusted verifier must be provisioned separately. The tools verify signed
receipts; this release does not automatically install a browser verifier, manage
its protected keys, or supply authenticated test accounts for arbitrary apps.
Existing PM/developer environments must never receive the private signing key.

The full control dashboard, provider/model connection management, durable database
leases/outbox, automatic ticket lifecycle webhooks, GitLab/Railway adapters,
additional AI runtimes, semantic image generation, and automatic fixture cleanup
remain roadmap work. Run logs are currently available through GitHub Actions.
There is no published npm package or complete one-command cloud control plane.

Promotions retain the existing per-area selective `pm-release/*` model. Whole-branch
`pm-staging` → staging releases are planned. CI adapters currently use aggregate
check state; named required-check publisher enforcement remains open. Provider
branch protections and human staging/production merge decisions remain necessary.

## Validation and practical limits

Automated tests cover recovery, merge/promotion gates, real Git candidate reuse,
signed evidence tampering and mismatches, lifecycle reconciliation, configuration,
fixture encoding, and static-file containment. Docker smoke checks cover non-root
execution, health, configuration initialization and private-file rejection. The
landing page was checked in a real browser at desktop and phone dimensions.

These checks do not constitute a complete live target-application certification.
Before enabling schedules for a real project, configure isolated test data and
accounts, verify runner/provider connections, provision the trusted verification
boundary, disable conflicting Linear completion automation, and perform one
supervised end-to-end release. See [setup](SETUP.md), [verification](VERIFICATION.md)
and [Linear lifecycle](LINEAR_LIFECYCLE.md) for the concrete contracts.
