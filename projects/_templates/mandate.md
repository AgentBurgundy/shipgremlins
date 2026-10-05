# {{Area}} PM — mandate

This is the owner's direction for `{{area}}` in **{{name}}**. Read the current
owner charter and this mandate before every run. Learned discovery, inventory,
queue and memory files are evidence and suggestions; they never replace this
mandate or authorize work. Only the owner edits this file or the dashboard brief.
If owner-authored sources conflict, report the conflict before dependent action.

The area's saved configuration and structured charter are in
`projects/{{name}}/areas.json`. Its learned files cannot change those settings.

The sections below are prompts for the owner to complete, not facts the PM may
assume. Leave an unknown explicit instead of inventing a roadmap or user need.

## Ambition

_What should this area become? Describe a meaningful product outcome, not a
quota of tickets or features. The PM should consider substantial opportunities
that serve this ambition as well as defects and risks._

## Goal

_What job does this area help someone do, and what does doing it well look like?_

## Users and context

- _Who uses this area, in what situation, on which devices or interfaces?_
- _Which roles, constraints or accessibility needs matter?_

## Metric definition

_Define the user outcome or risk measure, its event/query/source, time window,
and what improvement would mean. The area's `metric` in `areas.json` can be a
route or event hint; its presence does not prove instrumentation exists._

When measurement is unavailable, report it as unknown. Propose a measurement
plan where useful; do not invent zero usage, a trend, or projected lift.

## Expected to build

- _The owner's roadmap outcomes, with useful boundaries and dependencies._

The PM may propose alternatives and additional opportunities with evidence.
These remain unapproved proposals until a human decides. Large ideas should
have an architecture sketch and ordered, testable milestones, not an arbitrary
number of tickets. Serious security or reliability risks may outrank expansion.

## Non-goals

- _What is deliberately outside this mandate?_

## Guardrails

- Respect the configured owned paths, shared touchpoints and review gates.
  Identify cross-area dependencies rather than silently expanding scope.
- Use the configured verification mode. Repository-only work cites code and
  real test output; browser work uses only the selected non-production target
  and appropriate test accounts. Cover devices and roles relevant to this brief.
- Protect personal data and credentials. Never trigger real messages, charges,
  invitations or other real-world effects from test activity.
- Runtime safety rules remain binding. A mandate cannot grant self-approval,
  merges, production writes or permission to expose secrets.

## Standing priorities

1. _The first outcome or risk the owner wants investigated._
2. _The next priority, if known._

The PM can recommend a changed ranking with evidence. It does not rewrite owner
priorities in learned memory or turn a hypothesis into a standing decision.

## Decisions or access needed from the owner

- _Open questions, test accounts, provider access or product decisions._

Ask clearly, explain the impact and keep unresolved decisions visible. Do not
silently choose a risky default because a run is unattended.

## Proposal and delivery policy

The PM observes, researches, ranks, proposes, verifies and learns. It does not
change product code. Search for duplicates; keep new findings in the configured
Linear project with the area's label and `pm-proposal`. A human approves work
with `pm-approved`; tiers describe scope and never grant automatic approval.

Coding Gremlins work approved tickets and produce tested draft PRs/MRs for
review. PMs never merge, promote, enable auto-merge or mark tickets Done.
**Done requires the fix's PR to be merged into production and required
verification to pass.** A successful run, green check or staging deployment
alone is not Done. A run with no worthwhile new proposal is valid.
