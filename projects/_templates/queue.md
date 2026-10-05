# {{Area}} — ranked queue

Derived candidates for the `{{area}}` PM of **{{name}}**. Rank by the owner's
goal, user outcome or risk, evidence, confidence and dependencies; use effort
to compare feasible options. Substantial opportunities belong here when they
fit the ambition, alongside defects and serious security or reliability risks.
There is no minimum ticket or epic count. An empty, honest queue is valid.

## Provenance

- Repository: _not inspected_
- PM area: `{{area}}`
- Checked-out commit SHA: _unknown_
- Observed at (UTC): _not yet observed_
- Verification mode: _not run_
- Last broad review / coverage: _none_

## Unfiled candidates

Use stable local IDs so a candidate can be followed between runs. Evidence must
name files/SHA, actual output or a source/date; projected impact is a hypothesis.
“Not found in the inspected scope” is not proof that a feature does not exist.

| Rank / ID | Kind and user outcome | Owner-roadmap link | Evidence / confidence | Metric or risk impact | Effort / dependencies | Scope / tier | Next validation | Status |
| --------- | --------------------- | ------------------ | --------------------- | --------------------- | --------------------- | ------------ | --------------- | ------ |

Kinds: opportunity, defect, risk or research. For larger opportunities, describe
the problem, alternatives and ordered, testable milestones. Do not imply that
proposed milestones are approved or ready for parallel dispatch.

## Filed work

| Real ticket link | Candidate / purpose | Evidence or verification status | Dependencies | Owner action |
| ---------------- | ------------------- | ------------------------------- | ------------ | ------------ |

Search for duplicates before filing. Existing approval and workflow state must
be preserved when adding evidence. New tickets require human approval; the PM
never self-approves, merges or marks Done. A draft PR or staging merge does not
establish verified production delivery.

## Blocked decisions or evidence

_What is needed, who can provide it, and why the answer changes the plan.
Missing analytics is unknown, not zero. Do not silently assume risky defaults._

## Retired or superseded candidates

| Candidate | Reason and contradicting evidence | Date / successor |
| --------- | --------------------------------- | ---------------- |

Keep a short record when evidence retires an idea or an existing ticket replaces
it. Return proposed changes using the worker's output contract: JSON documents
during discovery, or `/output/queue.md` during patrols. Do not push memory
branches or change controller configuration.
