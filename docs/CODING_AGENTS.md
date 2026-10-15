# PMs and coding agents

PMs discover opportunities, propose finite work, prioritize their queues and verify
delivered changes. Coding agents implement approved tickets. Workers supply compute
for either role; a worker is not a coding agent.

Open **Projects → your project → Agents** to adopt PMs and create coding agents.
The global **Agents** page also shows the named agents across projects.

1. Adopt a PM and review its mandate, ownership and schedule.
2. Create a named coding agent. Assign one or more PM ticket queues.
3. Choose its provider and model from the available dropdowns, or inherit the
   project's coding default. Claude Code and Codex can remain connected together.
4. Set capacity from one to four concurrent runs. PM WIP limits and shared file
   ownership protections still apply, even when a coder has spare capacity.
5. Enable the agents you want to work automatically, or use their individual Run
   buttons for a single run.

Pausing a PM stops its recurring investigation. Its assigned coders can continue
approved work. Pausing a coder stops its automatic pickup without affecting PMs.
Project-wide pause suspends automatic launches and preserves every individual
setting; explicit single runs remain available. Active jobs keep their recorded
provider and are canceled separately in Runs.

Coding agents require approved finite tickets in their assigned current PM queues.
Assignment does not grant approval. Epic receipts, dependency checks, WIP limits,
delivery gates and production completion requirements continue to apply. A missing
selected provider blocks that route; another connected provider is never substituted.

Each queued run records its coder identity. Deleting and recreating a coder or PM
queue cannot transfer an old queued job to a replacement. Provider/model changes
are checked again before launch. Two coders cannot admit duplicate implementations
of the same ticket.

Existing projects migrate each PM-linked coding setting into a separate coder,
preserving its enabled state and effective model. New projects start without coders;
adopting another PM does not silently create one. Private, revision-guarded
`projects/<project>/coders.json` holds profiles and migration identities. The
dashboard is the supported editor. A restored project starts with project automation
paused until reviewed.

Named agents run through the local controller on local or remote Docker workers.
The legacy CI workflow cannot execute their saved identities or model routing and
refuses dispatch for projects with an explicit coding-agent document.
