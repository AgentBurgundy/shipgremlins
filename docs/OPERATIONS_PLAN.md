# Easier autonomous delivery

Implementation plan, October 5, 2026. This document distinguishes acceptance
criteria from completed work; the release notes record what actually ships.

## The workflow we are building around

The owning PM is the verifier. A coding Gremlin implements an approved ticket
against the project's integration branch. After a reviewed change reaches
`pm-staging` and its test environment deploys, the next PM patrol checks the
ticket's acceptance criteria there. Passing changes become candidates for a
promotion branch created from `staging`, with selected commits cherry-picked in
dependency order. Unreviewed, failed, conflicting, and unrelated work stays out.
The assembled candidate must pass its own checks and deployment verification.
Production remains an owner decision. Linear Done means the entire approved
deliverable is proven merged into the configured production branch.

Repository-only projects retain a simpler draft-PR workflow. Hosting and source
control are independent choices. A Railway project must not need a Vercel
configuration, and a local worker must not need a fork or CI automation repo.

## Workstreams and acceptance criteria

| Priority | Work                                    | Completion criteria                                                                                                                                                                                                                                 |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | PM verification and selective promotion | Durable ticket/change/review records; exact repository, branch, commit and deployment binding; failed or missing evidence holds promotion; GitHub and GitLab identities; Railway environment selection; candidate checks; no whole-branch shortcut. |
| 2        | Recoverable execution                   | Bounded, classified pre-execution retries with persisted backoff; ambiguous publication requires reconciliation; cancel stops only the owned job; restart does not duplicate work.                                                                  |
| 3        | Discovery-led setup                     | Project page explains the next missing step; discovery works before Linear/hosting setup; learned observations suggest reviewable settings without silently enabling automation.                                                                    |
| 4        | One review inbox                        | Project-scoped blockers and decisions with links to the exact remedy; visible pending/success/error states; Slack links lead back to the same authoritative review surface.                                                                         |
| 5        | Production lifecycle                    | Local branch identities participate in production reconciliation; finite approved deliverables and actual merge evidence are required; no Done on draft creation, PM approval or staging merge.                                                     |
| 6        | Shared project knowledge                | Owner decisions are durable and revision-protected; PMs see current sibling summaries and ownership overlaps; stale knowledge is excluded from prompts; no cross-project mixing.                                                                    |
| 7        | Remote workers                          | Outbound enrollment, single-use credentials, revocation, heartbeats and capabilities; one fenced lease per execution; Linux Docker and native macOS capabilities are distinguished; no public controller token in worker commands.                  |
| 8        | Limits and outcomes                     | Project concurrency, daily runs/runtime and per-job limits are enforced; usage and holds are visible; unknown subscription costs remain unknown; no fabricated metrics.                                                                             |
| 9        | Reference benchmark                     | Disposable app with roles/tenants, uploads and seeded defects; deterministic failure/success cases exercise actual contracts; simulated provider/model tests are clearly distinguished from live certification.                                     |
| 10       | Dashboard and documentation             | Project-first navigation, clear setup actions, compact integrations, readable review/delivery/knowledge pages, stable activity, usable 390px mobile layout; README and hosted docs match shipped capabilities.                                      |

## Implementation boundaries

- Existing configurations, mandates, credentials and history survive upgrades.
- Learned repository content is data, below runtime policy and owner direction.
- PM statements alone cannot supply deployment identity or independent check receipts.
- Retry never means blindly repeating a possibly completed external action.
- Approval happens against a concrete scope/revision, not a mutable generic button.
- Secrets and model private reasoning never become public activity or shared memory.
- Live CrewOS is audited read-only. Tests use disposable fixtures; provider mocks
  do not count as certification of an actual Railway or GitLab account.

## Validation and rollout

Each workstream adds behavior-level tests and is reviewed against the workflow
above. The combined release runs unit/integration tests, type checking, lint,
format checks and global install/update/rollback checks. Browser validation
covers project setup, review, knowledge, delivery, cancellation and mobile.
The updater continues requiring successful CI on the exact official commit.
Private configuration is never copied into the public repository. Release notes
and the implementation status document identify remaining live-account gates.
