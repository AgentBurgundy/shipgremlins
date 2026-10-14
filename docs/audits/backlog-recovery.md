# Completed recovery backlog: 049 and 050

Completed on 2026-10-14. This document records the implementation and regression evidence for the two recovery items from the original 100-item audit.

## 049 — Associate an uncertain dispatch with its existing provider run

**Implemented.** `src/setup/recoveryActions.ts` exports:

- `listRecoveryReservations(ctx, { includeBound?: boolean })` for controller-scoped support views. The default returns unresolved reservations; the internal POST lookup can include resolved records for idempotent replay.
- `bindRecoveryRun(ctx, { reservationId, runId })` to verify an existing provider run and repair its receipt. Its result is `reconciled` or `already-reconciled`.
- `RecoveryActionError` with a safe explanatory message and HTTP status.

The controller saves a UUID reservation, exact dispatch inputs, project incarnation, repository and Linear ticket mapping, kind, attempt, integration revision, and PR/head scope before requesting execution. The inputs include a digest of that scope and the reservation marker. Successful dispatches and operator repairs record the association beside their existing receipt format.

The browser supplies only a reservation ID and numeric run ID. Expected inputs come from the saved controller reservation. GitHub evidence comes from authenticated provider reads: the workflow run's repository, event, branch and immutable commit; a successful pre-agent input-recording step in the `launch` job; and the workflow/project configuration at that same immutable commit. The adapter verifies the canonical recording step and pinned checkouts before accepting its server-recorded step metadata. GitHub documents workflow run metadata separately from job steps; a run's title or recent creation time alone does not establish its inputs. See [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs).

Binding validates exact inputs, scope digest, current approval, ticket mapping, project incarnation, bot PR identity, exact PR head, and integration revision. A newer execution receipt or reservation blocks repair of an older record. Duplicate requests are serialized inside the controller, and a lost receipt response can be replayed without adding another receipt. Repairing a receipt preserves ticket workflow state and uses no agent launch, CI rerun, merge, or publication API.

Proof: `src/setup/recoveryActions.test.ts` covers build/conflict/CI association, replay after a lost receipt acknowledgment, concurrent duplicate requests, browser-supplied proof rejection, missing provider runs, every dispatch input mismatch, repository/workflow/ref/incarnation/event mismatch, stale timestamps, changed approval/mapping/PR head/base, and newer execution evidence. `src/forge/recovery.test.ts` verifies the provider metadata chain and rejects older, unpinned, or mismatched workflow evidence. `src/commands/dashboard.recovery.test.ts` exercises authenticated HTTP reads/writes, origin and field validation, replayed acknowledgments, mismatched provider scope, and one unavailable project alongside a healthy project.

Older workflow revisions that never recorded authenticated inputs cannot safely prove an unknown run's scope. They remain available for manual provider inspection; the controller refuses to infer their inputs. The evidence-enabled workflow must be present in the actual hub repository for new recovery associations. The controller needs credentials that can read both target repository state and the hub's Actions/workflow metadata.

## 050 — Make failed-CI-job reruns durable and exact to the revision

**Implemented.** `repairChecks()` now uses `src/dispatcher/rerunRecovery.ts` instead of issuing an unrecorded rerun and writing its marker afterward.

The controller records a complete exact-revision rerun plan before processing provider targets. Each target gets a durable admission before its provider request and a separate acknowledgment afterward. A provider request with an uncertain outcome is reconciled through provider evidence; the controller never reissues an admitted target merely because its receipt is missing. A completed plan records the full head SHA beside the existing retry prefix.

GitHub targets identify their repository, exact commit, workflow run and original `run_attempt`. A later attempt proves acknowledgment. GitLab targets identify the exact pipeline and failed jobs; replacement job IDs for the same jobs prove acknowledgment. GitHub documents the retry endpoint and run attempt metadata in [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs). GitLab documents [pipeline retries](https://docs.gitlab.com/api/pipelines/#retry-jobs-in-a-pipeline) and [latest pipeline jobs](https://docs.gitlab.com/api/jobs/#list-pipeline-jobs).

Mixed pending checks defer admission. An acknowledged but pending retry also defers developer repair. Exact PR head/branch/base checks run before admission, before the provider request and before final acknowledgment. A changed head preserves old-revision evidence and does not cause an old request to be replayed. Corrupt durable plans fail closed. Unconfirmed acknowledgments remain visible and become attention items after the bounded observation interval.

GitHub dispatch and CI rerun POSTs now disable generic HTTP retries, preventing a transport-level retry from duplicating a request after the provider committed it. Dispatch run lookup also requires the exact marker rather than selecting a recent unrelated run.

Proof: `src/dispatcher/rerunRecovery.test.ts` injects lost provider responses, failed acknowledgment comments, failed final receipts, unconfirmed admissions, pending checks, changed heads and corrupt plans. `src/forge/recovery.test.ts` verifies GitHub advanced attempts and GitLab replacement jobs after lost responses, with exactly one POST. Existing dispatcher conflict, CI, stop-line and healing regression tests remain green.

## Additional integration support

`Forge.getPullDiffStats()` is implemented for GitHub and GitLab for item 099. GitHub uses exact-head authoritative file/line totals. GitLab validates complete unified diff hunks, exact file totals, bounded pagination and a stable head; truncated, collapsed or unavailable evidence fails closed. The developer dispatch boundary checks the durable automatic-approval audit even if its marker label was removed.

## Validation

- Focused dispatcher, forge, recovery-action, HTTP and workflow contract suite: **21 files, 301 tests passed**.
- TypeScript checking and linting of the affected dispatcher, forge and recovery-action files passed.
- Tests use provider contract fixtures and injected failures. No external workflow was launched, no PR was published, and no live account/staging validation is claimed by these checks.
