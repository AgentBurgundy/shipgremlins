# Linear ticket lifecycle

Updated October 4, 2026. Status: the alpha includes a read-only production audit and an explicit opt-in completion reconciler. The broader lifecycle contract below remains the design target. This document does not change live Linear settings.

A developer finishing code, a successful test, or a merge into `pm-staging` must never complete a ticket. A ticket reaches **Done only when all changes required to deliver its approved scope are confirmed merged into the configured production branch**. The branch may be called `main`, `master`, or something else; resolve `branches.production` instead of assuming its name.

## Implemented in the alpha

`hub tickets audit` and `hub tickets reconcile` operate on tickets carrying a configured area's label inside that area's Linear project. They do not enroll every issue in the workspace. Audit is always read-only. Reconcile is also read-only unless the operator supplies `--apply`; combining `--apply` with `--dry-run` is rejected.

```bash
gremlins tickets audit --project my-app --json
gremlins tickets audit --project my-app --manifest /secure/release-scope.json --json
gremlins tickets reconcile --project my-app --manifest /secure/release-scope.json --dry-run
gremlins tickets reconcile --project my-app --manifest /secure/release-scope.json --apply
```

Use an absolute path appropriate to your OS for the manifest. The commands use the configured GitHub and Linear credentials. They do not change native Linear workflow rules, enable schedules, or deploy an application. Exact verification-receipt commands and the promotion gate are documented separately in [VERIFICATION.md](VERIFICATION.md).

The audit reports each ticket's UUID, project/team IDs, current state, scope hash, and the team's actual completed workflow state IDs. Without a reviewed deliverable manifest, it classifies the ticket as ambiguous. It does not infer a complete ticket scope from a release title, comment, label, or branch-name search.

### Reviewed manifest

Keep this file under operator control, outside the target repository and all paths worker agents can write. It is an authorization boundary, not a worker-generated completion claim. Review every required deliverable; do not omit unfinished PRs to obtain a successful result. The CLI validates structure and current provider evidence, but does not authenticate the person named in `approvedBy` or sign the file.

```json
{
  "version": 1,
  "repo": "your-org/my-app",
  "productionBranch": "main",
  "tickets": [
    {
      "ticketId": "uuid-from-audit",
      "projectId": "linear-project-uuid",
      "teamId": "linear-team-uuid",
      "scopeHash": "replace-with-the-64-character-sha256-from-audit",
      "approvedBy": "operator-name",
      "approvedAt": "2026-10-04T12:00:00Z",
      "completedStateId": "completed-state-uuid-from-audit",
      "deliverables": [
        { "implementationPr": 41, "productionPr": 58 },
        { "implementationPr": 45, "productionPr": 58 }
      ]
    }
  ]
}
```

Replace every placeholder, including the scope hash, before using the example. One manifest targets one configured repository and production branch. Each ticket must have a nonempty set of required implementation PRs. `productionPr` names the actual PR merged into production that contains that deliverable; multiple implementation PRs may map to one release. `completedStateId` must identify a completed state in that ticket's actual team, regardless of the state's display name.

`scopeHash` binds the ticket's ID, identifier, project, team, title, and description. Changes to those fields invalidate the reviewed scope. Labels and workflow status are excluded so normal QA transitions do not invalidate it. The manifest does not discover or approve requirements that are absent from the reviewed ticket description.

### Evidence checked before completion

For every listed deliverable, the reconciler verifies that:

1. The implementation is an actual merged PR authored by the configured bot, on the exact `pm/<lowercase-ticket-identifier>` branch, targeting one of this project's configured delivery branches.
2. The production PR is actually merged into `branches.production`, no earlier than the implementation merge. Its merge commit remains in the current production history.
3. The complete implementation changed-path set, including old paths in renames, retains the same Git file contents, modes, and types in the implementation head, implementation merge, production merge, and current production tree. Deletions must remain absent.
4. Either the implementation merge is an ancestor of the production merge, or the actual production PR's changed-path set includes every required path with the exact corresponding contents. This second route supports unchanged squash/cherry-pick delivery.
5. Every deliverable passes. Empty changes, incomplete provider results, and truncated file/tree responses cannot establish completion.

This is deliberately conservative: a legitimate later edit to a touched file, a port with changes, or an overlapping follow-up PR may leave a ticket ambiguous even when a human considers the feature delivered. Review those cases instead of weakening or fabricating the mapping. Exact-file preservation is not a new acceptance-test run; the separate verification and release gates are responsible for testing behavior.

Audit classifications are `production-confirmed`, `not-production`, `ambiguous`, and `canceled`. A production-confirmed result proposes the configured completed state. It records actual merge URLs, revisions, timestamps, checked paths, and the mapping method. Deployment health is separate and is not queried by this completion command.

### Write behavior and current limits

On `--apply`, the reconciler rereads the ticket and production head, preserves cancellation and existing completion, writes one deduplicated evidence comment, rereads state and scope again, and requests the completed state. The transition key binds the repository, branch, ticket scope, target state, and actual implementation/production merge revisions. If a state update fails after the comment succeeds, a retry can reuse the comment and attempt the state write again. The comment explicitly records evidence rather than claiming the transition already succeeded.

The Linear client checks actual project, team, state ID, cancellation, and `updatedAt` immediately before its status mutation. **Linear provides no atomic compare-and-set here.** A competing native automation or manual update can still race after that final read. Disable conflicting completion automations and run one reconciler writer per project. Comment deduplication is best-effort across simultaneous processes; no durable outbox or distributed execution lease is implemented yet.

The alpha does not automatically reopen uncertain historical Done tickets, even when audit cannot establish production provenance. It also does not automatically reopen reverted work, handle multi-repository ticket scope, import arbitrary human PRs, or maintain signed release manifests through edited ports. Those cases require review. The commands are not yet scheduled or connected to webhooks, and they do not manage intermediate Linear workflow states.

## Target lifecycle beyond the alpha

The following sections retain the larger design contract: durable change/release records, intermediate state transitions, owner-approved drift corrections, event processing, and eventual reconciliation. They describe intended behavior where the alpha section above identifies a current limitation.

## Current evidence and likely causes

The original Linear client managed tickets, labels, and comments without a production-merge completion path. The alpha now adds the explicitly invoked path above. `pm-verified` frees work from the developer WIP count, which is useful but is not a completion event. The developer prompt prohibits closing tickets; the dispatcher also skips completed tickets on initial dispatch.

Premature completion may therefore originate in native Linear PR/MR automations, another workflow, an agent using a direct API call, or a human action. The connected workspace settings and issue activity were not inspected during this planning task, so the exact live cause remains unverified. Implementation starts by tracing a representative prematurely completed issue's activity, actor, linked PR/MR, target branch, and timestamps.

Linear documents target-branch automation for both GitHub and GitLab. Use that as an immediate configuration containment where appropriate, and add the release reconciler for reliable multi-stage provenance. Sources: [GitHub integration](https://linear.app/docs/github-integration), [GitLab integration](https://linear.app/docs/gitlab).

## States and responsible actors

Names are recommended defaults. Onboarding maps the semantic states below to each Linear team's actual workflow IDs; do not mutate or assume a team's existing state names automatically.

| Semantic state | Recommended Linear type        | Entry condition                                                                   | Authorized transition owner              |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------- |
| Proposed       | `backlog`                      | Finding or feature has reproduction/context, scope, and draft acceptance criteria | PM or owner                              |
| Approved       | `unstarted`                    | Owner approval or applicable standing policy covers the current scope revision    | Controller recording approval provenance |
| In Progress    | `started`                      | Developer has a valid execution lease                                             | Controller                               |
| In Review      | `started`                      | Implementation PR/MR exists; completion/check evidence is being evaluated         | Controller                               |
| In QA          | `started`                      | Change landed in `pm-staging`; deployed acceptance verification is queued/running | Controller                               |
| Verified       | `started`                      | Independent acceptance evidence passed for the current candidate context          | Controller                               |
| In Staging     | `started`                      | Verified promotion containing this work merged into staging                       | Release reconciler                       |
| Done           | `completed`                    | All required deliverables are included in confirmed production merge provenance   | Production reconciler                    |
| Blocked        | `started` plus reason metadata | Required dependency, access, decision, or repair budget is unavailable            | Controller or owner                      |
| Canceled       | `canceled`                     | Owner or existing cancellation policy abandons the work                           | Owner/policy controller                  |

Store the previous work state and blocker reason separately so unblocking resumes the correct step. Verification failure returns to In Progress/In Review when a repair is active, or Blocked when no safe repair remains. It does not create a new independent lifecycle or erase prior attempts.

“Verified” is provisional: changes to the tested code, criteria, relevant environment, fixtures, or policy invalidate it. If staging acceptance fails after merge, preserve the fact that staging contains the change while exposing the failed health state and remediation. One status cannot encode both branch location and every test outcome; the dashboard shows both.

## Completion predicate

For each ticket revision, persist a finite set of required deliverables. New scope or additional required PRs revise that set with approval; agents cannot shrink it to claim completion.

```text
canMarkDone(ticket) =
  ticket is tracked and is not canceled
  AND approved scope is represented by a nonempty deliverable set
  AND every required deliverable has trusted production inclusion evidence
  AND the evidence refers to this project's configured production branch
  AND no known revert removes an outstanding required deliverable
```

Production inclusion evidence includes the forge's merged PR/MR record, target branch, resulting production commit, merge timestamp, and a trusted mapping to the delivered changes. An open/closed-but-unmerged release PR, a PM comment, a label, a branch name, or a successful preview deployment cannot satisfy it. Direct production pushes require a separately authorized provenance/import path; do not infer completion from arbitrary commit text.

Validate the full ticket scope. If one ticket has three required PRs and only two reach production, it stays open. If a production release contains twelve tickets, update only the tickets whose required work is included. Approval must still be valid for any agent work dispatched after a ticket is edited or reopened.

## Release provenance

Model a change independently of any one commit SHA. A `Change` links a ticket revision to its implementation PR/MR, original revision, integration merge, and acceptance evidence. A `ReleaseManifest` records each included change and the actual source, target, candidate, and merge revisions for each promotion.

| Git operation   | Required provenance behavior                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Merge commit    | Record provider merge result and ancestry; carry the manifest into the next release                      |
| Squash          | Map the original changes to the squash result; original feature SHAs need not be ancestors of production |
| Rebase          | Record the final provider revisions and verified tree/change mapping                                     |
| Cherry-pick     | Retain origin mapping, verify the actual result, and carry the mapping to the release                    |
| Port with edits | Treat the port as a new candidate revision; require fresh tests before preserving completion eligibility |
| Partial release | Include only delivered changes; leave remaining deliverables pending                                     |
| Revert          | Mark removed change membership and reconcile affected tickets/recovery items                             |
| Hotfix          | Link to the original work or an explicit new ticket; do not double-count delivery                        |

Commit trailers and PR descriptions help humans and historical import, but they are not trusted authorization by themselves. The controller records manifests and validates them against forge events and diffs. If historical mapping is ambiguous, report it for review rather than falsely closing an issue.

Carry issue identifiers and ordinary related-work links into both the staging and production release descriptions. A release manifest must survive the fact that the original developer PR targeted `pm-staging`, while the production PR may have a generic release title. Code belongs to a release because of its actual contents and recorded mapping, not because its ticket ID appears in prose.

## One authority for status writes

The controller owns lifecycle transitions for tracked tickets. PMs propose outcomes; they do not have a general-purpose completion tool. Developers can claim work and report implementation status through scoped tools. Only the production reconciler may issue the Done transition.

When direct provider tokens cannot be restricted by operation, keep them in the controller and give workers narrow brokered tools. Otherwise an agent holding a broad Linear token can bypass a prompt-only restriction. Audit every status write with its actor, source event, expected current state, ticket revision, and reason.

In controller-managed mode, configure overlapping native merge automations to take no action for completion, or to perform only compatible non-completed transitions. The control service reconciles drift without fighting another writer indefinitely. A repeated automation conflict blocks setup and reports the offending rule for correction.

As interim containment before the controller is shipped, branch-specific native rules may map `pm-staging` merges to In QA and staging merges to In Staging. Production-only completion can be used only where linked-release behavior proves every ticket's required work is included. Native branch rules alone do not establish the full release provenance contract.

Avoid closing keywords on intermediate PR/MR descriptions; use the provider-supported related-work form. GitLab's Linear integration explicitly distinguishes contributing references from closing references. Verify equivalent GitHub behavior with a test issue instead of assuming identical semantics. [Linear GitLab linking documentation](https://linear.app/docs/gitlab) describes these distinctions.

## Events and reconciliation

Consume relevant PR/MR, push, deployment, and Linear issue events. Verify provider-specific webhook authentication, timestamp/replay controls, project binding, and delivery IDs before enqueueing work. Linear documents signed webhook payloads and delivery identifiers. [Linear webhooks](https://linear.app/developers/webhooks).

Persist each accepted event and acknowledge it promptly. Use an outbox for state writes and comments. A deduplication key such as project + ticket + production merge + transition ensures retries cannot duplicate completion or notifications.

Webhooks accelerate state updates; a periodic read-only reconciliation of branch history, releases, and tracked issues recovers missed events. Fetch authoritative provider state when event order is uncertain. A delayed intermediate merge event must never move a production-completed ticket backward. Read current state before changing it so owner cancellation and later scope edits are respected.

Proposed healthy-service target: reconcile a confirmed production merge within five minutes when polling is available. Show last successful reconciliation and backlog age. If Linear is unavailable, queue the transition and expose the pending update; never fabricate a successful write.

## Production merge and deployment health

The owner's requested Done threshold is **production merge**, so deployment success is tracked independently:

| Production event                        | Ticket behavior                                                        | Release/dashboard behavior                            |
| --------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| PR/MR opened                            | Remain In Staging                                                      | Awaiting production merge                             |
| PR/MR merged with all required changes  | Move to Done                                                           | Production merged; deployment pending                 |
| Deployment healthy for that revision    | Remain Done                                                            | Deployed, with URL/time and smoke evidence            |
| Deployment fails                        | Remain Done under merge-based policy                                   | Release failed; actionable incident and linked repair |
| Hosting rollback without code revert    | Preserve merge fact                                                    | Rolled back; affected features are not currently live |
| Production revert removes required work | Reopen affected scope or create an owner-approved linked recovery item | Record what was removed and why                       |
| Feature flag remains off                | Preserve merge fact                                                    | Show not enabled/customer-visible yet                 |

Never report “shipped successfully” solely because Linear says Done. The dashboard must distinguish merged, deployed, and enabled. A future project may explicitly choose the stricter Done-after-deployment policy, but that is not the default requirement recorded here.

## Capacity and cancellation

Execution capacity counts active developer/reviewer/repair leases, not every issue whose Linear type is `started`. QA, staging, and production queues have their own limits and age alerts. This prevents open tickets waiting for the owner's production release from exhausting all developer slots.

Reaching Verified releases the normal developer slot; a later repair acquires a new slot. Canceled tickets stop new work, revoke approval, cancel jobs when safe, and remain Canceled rather than being automatically marked Done after an unrelated release event. Already merged work needs an explicit keep/revert decision; cancellation does not silently remove code.

Human overrides remain possible but visible. A premature manual Done transition on a tracked ticket is recorded as a policy mismatch and restored to the evidence-supported state under the configured reconciliation policy. Never reinterpret a deliberately canceled ticket as a broken Done transition.

## Migration of current tickets

1. Snapshot existing team workflows, branch automation rules, tracked ticket states, and linked PR/MR data. Identify the actual source of premature closure from issue activity.
2. Map intermediate states to non-completed Linear types and disable conflicting early-Done automations. Keep changes scoped to participating teams/projects.
3. Run a dry-run audit over currently Done PM Hub tickets and in-flight tickets. Classify each as production-confirmed, staging-only, integration-only, not merged, canceled, or ambiguous.
4. Produce a reviewable reconciliation report with the proposed state, evidence links, and reason. Do not bulk reopen every Done issue without proof.
5. Apply confirmed corrections idempotently, preserving owners, descriptions, history, and cancellation choices. Add one explanatory comment per correction.
6. Import known release mappings. Leave ambiguous historical tickets flagged for review rather than inventing missing provenance.
7. Run the new reconciler in shadow mode, compare against expected transitions, then enable writes and verify on one real release per stack.

The audit and dry-run reconciliation commands are implemented with the reviewed-manifest requirement described above. Automatic historical import, intermediate state corrections, and bulk reopen remain planned; the alpha makes only individually proven production-completion transitions.

## Acceptance scenarios

- Developer PR merged into `pm-staging`: ticket enters In QA and cannot become Done.
- PM acceptance passes: ticket becomes Verified and frees the developer slot while staying open.
- Promotion merged into staging: ticket becomes In Staging.
- Production PR is opened or closed unmerged: no completion.
- Production PR merges with all required work: one Done transition with evidence links.
- Squash/cherry-pick/port changes SHAs: correct ticket mapping survives and altered candidates are retested.
- Partial production release: only fully delivered tickets become Done.
- One ticket spans multiple required PRs or repositories: wait for every required production inclusion record.
- Duplicate, delayed, missed, or out-of-order events: eventual correct state without duplicate comments or backward transitions.
- Production deployment fails: Done is retained under merge-based policy; release health is clearly failed.
- Production code is reverted: removed scope is reopened or linked to the approved recovery workflow.
- Native integration closes a ticket early: the mismatch is detected and corrected without a write loop.
- Owner cancels work or changes scope during execution: cancellation/approval revision is respected.
- Existing Done ticket lacks trustworthy provenance: audit flags uncertainty instead of assuming completion or reopening blindly.
