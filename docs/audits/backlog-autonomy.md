# Completed autonomy backlog: 098–100

Implemented October 14, 2026. These changes run in the local controller and retain state in its private `.run` directory. They do not require a recurring desktop automation.

## 098: Bounded missed-schedule catch-up

The scheduler persists a cursor for each project incarnation, PM incarnation and UTC schedule. First connection starts at the current minute rather than replaying historical work. After downtime, it selects only the latest missed slot within seven days. It advances the admitted slot only after the engine saves the queued job; rejected/busy queue admission leaves the slot available. Stable keys reconcile a restart between saving the job and advancing its cursor.

Pausing or resuming resets only the PM whose investigation setting changed. Idempotent control requests and coding-only changes do not consume patrol slots. Project and PM replacements use independent cursors. Paused observations and clock rollback never move a cursor backward.

Evidence: `src/localRunners/scheduleCursor.ts` and tests; `jobs.ts`; the engine's saved admission callback; `setup/projectAutonomy.ts` and `pmReadiness.ts`.

## 099: Owner-selected automatic approval

Project home exposes a saved, default-off approval policy. The owner chooses bounded repository paths, a dedicated candidate label, daily approvals, open automatic tickets, files per ticket, and changed-line limits. Absolute ceilings are ten approvals per day, four open tickets, ten files, and 500 changed lines. Policy writes use the current configuration revision and normal mutation controls.

Eligible tickets require the exact configured Linear team, one owning PM and project, finite acceptance criteria and an exact finite `## Files` list. The controller permits Markdown/text documentation, static styles, and explicitly named JavaScript/TypeScript tests. Arbitrary executable files in documentation directories, MDX, agent instruction files, sensitive-system paths, protected prefixes/globs, configuration and dependency files are excluded. A candidate label or model-authored risk claim cannot grant approval.

The controller reserves approval durably before provider writes. Pending reservations consume open limits; a durable daily admission precedes the mutation that grants approval, including a pending reservation resumed on another day. Lost label responses reconcile the same reservation. The audit records ticket scope, file list, policy revision and timestamps. Removing the automatic label cannot erase the audit's authority. Reopened automatic tickets require fresh owner review.

Coding admission rechecks scope and saved policy. Delivery and legacy dispatcher merge paths require complete provider changed paths, including rename origins, exact-head file/line statistics and an unchanged ticket/policy. The policy is reread after provider waits. Missing or oversized diff evidence holds the draft for review. Configured epic approval, protected-file, independent-check, staging review and production release gates remain in effect; automatic approval never marks a ticket Done.

An audited ticket can be sent back to manual review from the policy panel. The controller stops its automatic authority, removes coding approval first and restores its proposal hold. The existing owner review flow then authorizes the exact reviewed scope; editing that scope again invalidates the manual exemption.

Evidence: `src/autonomy/policy.ts`, `approval.ts`, `approval.test.ts`, `approval.safety.test.ts`; authenticated approval-policy HTTP tests; the dashboard policy form; job preparation, delivery and dispatcher guards; GitHub/GitLab exact-head diff adapters; owner proposal review.

The legacy Actions dispatcher also checks current parent-epic approval before ordinary coding, retries and integration merge, including a final check after marking a draft ready. Blocked tickets retain no new launch reservation and do not consume another ticket's WIP slot. The controller-selected recovery lane remains limited to its exact unhealthy integration revision; editable ticket labels alone cannot grant this exception. `src/dispatcher/epicAuthorization.test.ts` covers missing/stale approval, changed PM context, revoked approval before merge, forged recovery labels, approved work following blocked work and genuine bounded CI repair.

## 100: Durable reasons and remedies

Setup and scheduling retain typed safe failure codes, occurrence times and a bounded next retry per project/PM. Messages and remedies come from fixed controller text, never raw exceptions or logs. Retry delays grow from five to thirty minutes and survive restart. Successful checks resolve the retained alert; replacement projects have separate state.

Automatic environment verification resolves its diagnostic only after reloading the same project incarnation and observing an actual verification stamp. A normal callback return without a stamp remains a verification failure. Shared readiness failures produce safe explanations for active loadable projects while malformed projects remain isolated.

Project home and the review inbox show direct Connections, environment, project-settings or approval-policy remedies with next retry times. Original run evidence remains available independently.

Evidence: `src/setup/automationDiagnostics.ts` and tests; `automaticPreparation.ts` and tests; scheduler integration in `localRunners/jobs.ts`; `projectKnowledge/operations.ts`; dashboard diagnostics rendering.

## Verification and limits

Focused tests exercise restart/catch-up, paused and sibling PMs, lost approval responses, delayed daily admissions, changed scope/policy, removed markers, reopened tickets, protected paths, bounded diff evidence, explicit owner reapproval, durable backoff and resolved alerts. Browser checks used the real dashboard/API against disposable synthetic providers and workers. Policy settings saved and reloaded, favorites/order persisted, keyboard search navigated correctly, and the mobile layout fit 390px without horizontal overflow.

Live Docker builds and real hosted staging/provider execution were not certified in this pass. Docker Desktop's Linux daemon was unavailable. Recovery of provider launches requires the evidence-enabled hub workflow; older workflow runs without authenticated inputs remain manual inspection cases.
