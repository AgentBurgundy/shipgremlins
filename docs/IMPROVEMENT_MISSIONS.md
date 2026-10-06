# Improvement missions

A mission keeps one product outcome attached to the work intended to improve it.
Use **What should get better?** on a project's home page. For example:

> Help a first-time user describe an addon, understand the preview, and download
> a usable result. Inspect the current journey before choosing a solution. Keep
> billing, pricing, and generation-model changes outside this mission.

The mission uses the existing PM and runner queue. It does not introduce a second
scheduler or grant a model permission to approve work.

For your first mission, finish the project introduction first: inspect the
existing source, confirm selected command suggestions, adopt a PM, and run
**Explore the codebase**. Read what it learned before choosing an outcome.
Sentry, Mixpanel, and Datadog are optional context for later investigations.
Save the project's Linear connection when ready for proposals; the PM prepares
missing mappings and labels rather than asking you to assemble them manually.
[First-run setup →](SETUP.md#your-first-adoption)

## From a goal to a reviewed change

1. **Investigate.** Select an owning PM and start the mission. If the project has
   no PM, setup can create a focused Product improvements PM with recurring work
   off. Required connections and environment readiness are checked before work
   starts. The PM receives the mission goal alongside the actual product brief.
2. **Review the proposal.** The mission shows current Linear proposals and their
   acceptance criteria. Open the ticket and evidence. Approval binds the mission
   revision and exact ticket revision; stale approvals are rejected.
3. **Approve and build.** The dashboard's first-change flow approves one bounded
   ticket. The underlying plan supports up to six selected tickets with explicit,
   ordered prerequisites. Each selected ticket goes through the same owner-review
   approval contract. No later, unselected ticket becomes approved automatically.
4. **Continue existing work.** The mission reuses its admitted jobs on repeat
   actions and after restart. A dependent step waits until its prerequisite's
   actual change is merged into the configured coding base. A successful process
   or open draft is insufficient. Paused missions block future steps; active jobs
   can be canceled separately through Activity.
5. **Review changes.** Project home puts coding drafts and their evidence ahead
   of another assignment. Read the actual PR/MR, checks, and limitations. A run
   without a confirmed PR link is not presented as a completed product change.
6. **Try the journey again.** Select the same saved Grumblin profile after the
   changed app is available. The followup retains its profile and observations.
   Compare environment and revision provenance before interpreting the result.

Ordinary pull-request projects retain owner review and merge. Promotion projects
use the [staged delivery flow](DELIVERY_WORKFLOW.md): integration admission,
exact-deployment PM review, independent browser replay, candidate verification,
and owner-controlled staging/production merges. A mission does not provision
candidate hosting or a trusted signer automatically.

## Coding that fits the product

Every new coding admission, in either delivery mode, needs a finite list under
`## Acceptance criteria` in its Linear ticket. An older ticket without a list
needs an edited proposal and another review. “Make it better” is not a testable
scope.

Coding gets the owning PM's structured product charter, ownership, mandate,
current shared context, and accepted checklist. A revision fingerprint binds the
owner context during preparation. The worker must write a bounded implementation
report describing the result against each criterion, UI evidence when applicable,
integration status, and limitations.

Draft PRs separate **worker-run configured checks** from **model-reported
acceptance evidence**. A mocked integration stays labelled as mocked. Missing
visual verification stays unverified. This report improves review quality; it
does not let an agent certify its own browser evidence or authorize a merge.

## Two independent automation controls

- **Scheduled PM patrols:** investigate the mandate on its configured schedule.
- **Automatic coding pickup:** select eligible, approved tickets on available
  runners without waiting for a PM patrol.

New PMs start with both off. Existing configuration that omits `codingEnabled`
keeps the prior behavior by inheriting `enabled`; saving the dashboard controls
makes both choices explicit. Manual single runs remain available. Current scope,
approval, dependency, duplicate-work, WIP, budget, and source protections still
apply to automated work.

Delivery verification is continuation of admitted promotion work, independent of
the recurring patrol toggle. Pause or cancel the relevant queued work in Activity
when you need to stop it.

## Retained product learning

PMs may emit `improvement-report.json` in addition to their four knowledge
documents. The controller validates and retains a separate observation snapshot
per run, bound to the project/PM incarnation, job, checked-out revision, owner
context revision, and selected Grumblin profile when applicable.

Opportunities record the problem, source/browser/telemetry evidence, alternatives,
assumptions, smallest experiment, success measure, and actual ticket identifiers.
Journeys record reported steps, outcome, friction, what worked, and available
screenshots. Bounded, immutable snapshots retain earlier observations when the
latest Markdown knowledge is replaced. These model reports never become trusted
merge evidence; a claimed click count is not independent telemetry.

Grumblins test a plausible perspective, not market demand. Security PMs can use
roles such as an administrator trying to revoke access or an operator diagnosing
a permission problem. Their core security conclusions still need reproducible
technical evidence. [Grumblins →](GRUMBLINS.md)

## Pilot an existing product

Use a narrow journey and keep an evidence ledger before making public claims:

| Record          | What to capture                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Baseline        | Exact commit/deployment, scenario, device, test account role, observed steps and actual blockers          |
| Proposed change | Evidence, alternatives considered, smallest useful scope, acceptance criteria, owner approval             |
| Implementation  | Ticket, run, PR/MR, exact code revision, checks, integration/UI limitations                               |
| Followup        | Same scenario/profile on the changed revision, comparable observations, regressions, unresolved questions |
| Effort          | Reported token usage and coverage, elapsed run time, owner interventions, review and rework               |

For ForeverMods, the first pilot is **describe → preview → download**. Protect
active development, use an isolated staging environment and synthetic data, and
keep billing/pricing outside scope. Select two useful changes from actual evidence;
do not predetermine a feature or invent a conversion lift. Publish a case study
only after the reviewed changes and followup evidence exist.

[Setup](SETUP.md) · [Project operations](PROJECT_OPERATIONS.md) ·
[Token usage](TOKEN_USAGE.md) · [Delivery](DELIVERY_WORKFLOW.md)
