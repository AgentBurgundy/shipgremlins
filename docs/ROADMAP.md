# ShipGremlins delivery roadmap

Current execution decision: local Docker workers are the default, with no fork,
automation repository, GitHub Actions, or GitLab CI requirement. The local queue,
background controller, browser verification, worker controls, and job logs/artifacts
are implemented foundations. The provider-CI and cloud items below are advanced
follow-up work. Local automatic staging promotion/production reconciliation,
automatic boot-service installation, and full live provider certification remain
open. See [implementation status](IMPLEMENTATION_STATUS.md) for the boundary.

Implemented in 0.6: repository-first projects, configurable PR base branches and
commands, and optional named URL/Vercel/Railway/Cloud Run environments. Shared
hosting credentials live in Connections. These adapters discover existing ready
targets; provisioning and exact-candidate promotion across providers remain open.
See [project configuration](PROJECTS.md).

Implemented telemetry foundation: project-scoped Sentry/Datadog reads and
per-area Mixpanel Insights reports. See [configuration and current limits](TELEMETRY.md).
Live account certification and broader telemetry queries remain follow-up work.

Updated October 4, 2026. This is an implementation backlog for the [master plan](MASTER_PLAN.md), not a claim that the items are already built or approved Linear tickets. No external tickets were created during planning.

Sequence work by exit criteria. Calendar estimates should follow the first provider and deployment spikes; avoid attaching a launch date to unmeasured browser and infrastructure work. Each completed phase should leave the current installation usable.

## Phase 0 Stabilize the existing loop

Goal: remove known release/recovery gaps and define honest ticket completion before adding more agents.

| ID    | Work                          | Acceptance criteria                                                                                                                                 |
| ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 | Integration health state      | Missing/pending/stale checks or deployment never count as healthy; fixtures cover unknown, canceled, and wrong-revision cases                       |
| P0-02 | Recovery lane                 | A deliberately broken integration branch can dispatch a repair and merge its independently verified result while ordinary changes remain paused     |
| P0-03 | Mandatory promotion checks    | Required build/test/type/lint checks are explicit; failed staging and absent verification block promotion creation; no optional bypass path         |
| P0-04 | Structured verification       | Define and validate the evidence schema; bind success to actor, candidate, base, deployment, criteria, and artifacts; reject spoofed/stale comments |
| P0-05 | Linear completion containment | Trace an early-Done issue, document actual cause, map intermediate states, and configure participating projects to prevent early completion         |
| P0-06 | Policy consistency            | Remove contradictory prompt instructions; enforce approved scope and protected-test changes in code; document actual promotion behavior             |

Dependencies: P0-01 precedes P0-02; P0-04 is required for the complete P0-03 gate. P0-05 and P0-06 can be independent workstreams. These dependencies describe sequencing, not a request to spawn agents.

Exit: scenario tests demonstrate fail-closed gates and a non-deadlocking repair; a dry-run produces explainable promotion eligibility; no claim of production certification yet. Retain the passing 271-test baseline, adding tests for meaningful new behaviors rather than text snapshots of implementation.

## Phase 1 Establish durable execution and release state

Goal: jobs, approvals, evidence, and releases survive restarts and provider failures.

| ID    | Work                            | Acceptance criteria                                                                                                                                        |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | Database and event/outbox model | Versioned migrations, transactional claims, replayable events, idempotent side effects, backup/restore test                                                |
| P1-02 | Provider contracts              | Extract source control, execution, hosting, tickets, runtime, and storage seams; retain current GitHub/Vercel behavior under tests                         |
| P1-03 | Scheduler and run leases        | Per-project/PM budgets and concurrency; heartbeat/queue deadlines; fencing; cancellation; no duplicate job after crash between dispatch and acknowledgment |
| P1-04 | Candidate promotion coordinator | Literal whole-branch mode freezes head, tests deployment before PR creation, protects required check, invalidates on head/base/environment drift           |
| P1-05 | Linear release reconciler       | Ticket → changes → release → production provenance; Done only for complete production inclusion; squash/port/partial-release/revert cases pass             |
| P1-06 | Project migration               | Import file config and legacy state; shadow comparison; one active scheduler; reversible cutover with no duplicate dispatch                                |

Dependencies: P1-01 underpins P1-03/04/05. Provider normalization in P1-02 and P0 evidence enable the promotion coordinator. P1-05 uses [the lifecycle contract](LINEAR_LIFECYCLE.md). Migration is last.

Exit: one GitHub/Vercel reference app completes approved ticket → implementation → deployed verification → staging → production merge → Done. Restart the controller mid-run, replay provider events, and demonstrate safe continuation. Record the actual evidence and remaining limitations.

## Phase 2 Certify both provider stacks

Goal: both required environments have equivalent behavior.

| ID    | Work                     | Acceptance criteria                                                                                                                                  |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01 | GitLab source adapter    | Hosted/custom base URL, subgroup paths, MR/pipeline/protection semantics, pagination, credentials, and webhook handling pass conformance tests       |
| P2-02 | GitLab execution adapter | Start/find/cancel jobs by correlation ID; collect evidence/artifacts; recover ambiguous dispatch and runner loss                                     |
| P2-03 | Railway hosting recipe   | Bind environment/services, duplicate configuration safely, seed isolated test data, deploy exact revision, confirm health and multi-service versions |
| P2-04 | Vercel recipe hardening  | Pre-PR candidate deployment, immutable URL and SHA mapping, private access, migrations/data isolation, stale-preview rejection                       |
| P2-05 | Two-stack certification  | Run the same successful, failing, recovery, and production-completion scenarios on both actual stacks                                                |

Dependencies: P1 contracts first. Railway and Vercel recipes require environment isolation checks. Do not advertise GitLab/Railway as supported based only on mocks.

Exit: recorded live evidence for both stacks, a compatibility matrix, and setup guides identifying provider-plan/network prerequisites. Other forge/host combinations remain experimental until tested.

## Phase 3 Make PM capabilities dynamic

Goal: new PMs and new test inputs come from configuration and approved tools.

| ID    | Work                                   | Acceptance criteria                                                                                                                              |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-01 | Versioned mandate schema and generator | Natural-language draft produces scope, scenarios, accounts, metrics, cadence, tools, quotas, and policy; activation stays within owner authority |
| P3-02 | Agent runtime adapters                 | Existing Claude workflow plus a second provider; capability discovery, structured results, cancellation, usage, and configured fallback tested   |
| P3-03 | Browser evidence runtime               | Real screenshots reach a vision-capable verifier; role/tenant contexts are isolated; screenshots/logs/trace manifests are retained and redacted  |
| P3-04 | Fixture toolkit                        | CSV/image generation, schema and binary validation, real UI uploads, output assertions, reproducible hashes/seeds, cleanup                       |
| P3-05 | Shared knowledge and deduplication     | Cross-PM findings consolidate; stale memory invalidates; dependencies and shared touchpoints avoid conflicting work                              |
| P3-06 | Application conformance fixtures       | Security/RBAC, file upload, asynchronous processing, responsive UI, and non-Next.js app scenarios pass                                           |

Exit: create a PM without editing shared prompts; it generates and uploads a CSV and an image, finds a seeded defect, gets approved work implemented, and verifies the fix with valid evidence. A missing capability is reported as blocked, never passed.

## Phase 4 Deliver the self-hosted product

Goal: users can install and operate PM Hub without maintaining custom workflow glue.

| ID    | Work                        | Acceptance criteria                                                                                                                      |
| ----- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| P4-01 | Packaged CLI and containers | Documented bootstrap command, pinned releases, persistent volumes, health checks, restart after host reboot                              |
| P4-02 | Resumable onboarding        | AI, source/CI, hosting, Linear, test identity/data, runner, and PM setup; preflight results; first real browser evidence                 |
| P4-03 | Dashboard                   | Overview, projects, PM editor, queues, run timeline, evidence, release gates, connections, runner health, cost, emergency stop           |
| P4-04 | Secrets and access          | Owner/operator/viewer permissions, project isolation, encrypted storage/key rotation, secret broker, audit trail, artifact authorization |
| P4-05 | Maintenance operations      | Backup/restore, upgrade rehearsal, export/import, retention, logs, and a diagnosable offline/provider-outage mode                        |

Design exploration can start earlier, but setup and dashboard behavior must reflect the actual control contracts. Do not build a second scheduler in the UI.

Exit: a new tester installs on a clean supported server, connects a prepared app, and obtains the first screenshot-backed finding within the proposed setup target. Verify the complete flow and an actual restore, not just a rendered dashboard.

## Phase 5 Prove cloud execution and scale

| ID    | Work                        | Acceptance criteria                                                                                                                 |
| ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P5-01 | Worker enrollment and pools | Scoped/revocable enrollment, heartbeat, clean workspaces, resource quotas, private-network access                                   |
| P5-02 | GCP ephemeral workers       | GitHub and GitLab federation paths, scoped launcher/worker identities, image lifecycle, cancellation and independent orphan cleanup |
| P5-03 | Chaos and concurrency runs  | Ten PM workload; kill workers/control service; inject duplicate events, outages, stale evidence, data contention, budget exhaustion |
| P5-04 | Reliability and cost report | Publish measured throughput, usage, queue/repair time, findings quality, intervention rate, and limitations                         |

Exit: ten configured PMs execute bounded workloads on both stacks across a proposed seven-day soak, including injected faults. Report actual parallelism; ten mandates need not mean ten simultaneously running browsers. No runaway resources, duplicate release actions, or premature Done transitions.

## Phase 6 Open source and launch

| ID    | Work                          | Acceptance criteria                                                                                                                          |
| ----- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-01 | Public repository preparation | License selected, history/examples reviewed, security and contribution docs, sanitized reference app, reproducible releases                  |
| P6-02 | Brand and domain              | Collision/availability checks completed, owner selects name, domain registered only with authorization                                       |
| P6-03 | Landing page and docs         | Responsive accessible site using the real demo; clear install instructions, supported stacks, evidence/recovery story, no fabricated metrics |
| P6-04 | Launch kit                    | Reproducible short demo, screenshots, architecture explanation, starter mandates, draft X posts, honest compatibility table                  |
| P6-05 | Maintainer operations         | Triage, release/version policy, security reporting, contribution tests, known issues, telemetry opt-in and data controls                     |

Exit: the public promise matches certified behavior. Follow [the launch brief](OPEN_SOURCE_LAUNCH.md); publishing and public announcements are separate execution steps.

## First implementation slice

Start with P0-01 and P0-02 together: model integration health correctly and demonstrate a repair that can unblock it. In the same stabilization milestone, perform the P0-05 Linear audit/configuration containment and build the P0-04 evidence contract used by P0-03. These establish the core promise before UI work.

Each implementation PR should state the behavior changed, its policy impact, migration impact, and evidence from relevant tests. A phase is complete only when its exit criteria are demonstrated; filing tickets or writing prompts does not complete it.
