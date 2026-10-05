# Your project's control room

Choose a project in the sidebar. Its page keeps the repository and project name
visible while you work. Each PM has its own brief, discovery, feature inventory,
queue, memory and activity. Coding runs are separate from PM investigations.

## First useful run

1. Connect source control and Claude Code, select a repository, and create a worker.
2. Give a PM a mandate, then choose **Run discovery**. Discovery reads source and
   tests; it needs neither Linear nor a deployed web app.
3. Review its learned documents. When the source supports a definite setup recipe,
   **Suggested setup** shows commands, ownership and the supporting files. Apply
   commands or ownership explicitly. Suggestions never enable automation.
4. Connect the appropriate Linear account, team and PM project. Choose repository
   verification or a named test environment. Review the commands, then verify.
5. Run a patrol once, review the evidence, and enable its schedule when ready.

Suggested commands are code that will execute in an app checkout during future
jobs. Read them before applying. The worker must already contain the required
language/toolchain. An unknown stack produces a blocker, not invented test commands.
Changes to owner settings make older knowledge stale until discovery refreshes it.

## Review

The workspace inbox collects setup blockers, stale discovery and failed runs.
Project **Review** also fetches current Linear proposals on demand. Open a ticket
to read its scope and acceptance criteria, then approve coding explicitly.
Choose **Read proposal & evidence**, then **Approve coding**, and confirm the
ticket identifier. You do not need to create `pm-approved` yourself: the first
approval creates it in the ticket's Linear team when no matching team or shared
workspace label exists. Linear issue labels belong to teams or the workspace,
not individual projects, so it is normal not to see that label before the first
approval. The saved Linear connection needs permission to create and apply labels.

To approve directly in Linear, create or select the issue label `pm-approved`
under the ticket's team, apply it to the reviewed ticket, and remove
`pm-proposal`. Keep the owning PM's `pm:<id>` label and project mapping intact.
The dashboard handles both approval labels for you and checks the reviewed scope.

Approval re-fetches the ticket and checks its revision, selected workspace,
owning PM and project mapping. Changes require another review. Linear does not
offer atomic compare-and-set for labels, so a simultaneous remote edit remains a
provider limitation; jobs re-check current approval and scope before execution.

`pm-proposal` labels all new findings, including small fixes. Approval removes
that hold, re-fetches the ticket, and adds `pm-approved` only if the reviewed scope
still matches. An interrupted approval stays unapproved. Split broad epics into
testable milestones in Linear first. Owner-blocked tickets remain blocked.
Approval does not run a production
merge or set Done. Enabled automation picks up eligible approved work, or use
**Run Coding** for one run. The button finds the next ready approved ticket
across this project's mapped PMs, ordered by priority and then oldest first.
You do not need to paste an identifier. **Choose a specific ticket** remains
available in the coding form when you want an override or a reviewed retry.
Manual selection can use paused PMs and does not enable their schedules.

Automatic selection skips tickets that already have a coding attempt, including
failed or canceled work that needs review, and respects each PM's active-work
limit. If no ticket is ready, the dashboard links to Review and your PM crew.
Coding Gremlins implement approved work; PM patrols investigate the app and
propose new tickets. Selection checks approval again before queuing and the worker
rechecks it before execution.

Promotion tickets need a finite bullet list under `## Acceptance criteria`.
New PM prompts request this structure; the review page explains when an older
proposal needs that checklist before it can be approved for promotion work.

For Slack links back to this same review surface, set
`SHIPGREMLINS_DASHBOARD_URL` to your credential-free HTTPS dashboard URL in the
controller environment. Never use a `#session` URL. The button opens the project;
the owner must authenticate to the dashboard normally. Slack's incoming-webhook
connection does not grant in-Slack approval or automatically publish a homelab.

## Shared knowledge

Project **Knowledge** shows sibling PM summaries, their source revisions, and
overlapping ownership. Add concise owner decisions here rather than repeating
them in every PM mandate. Saved decisions survive updates and use revision checks
to prevent an older browser tab overwriting newer direction. PMs can read these
decisions but cannot write them.

Current sibling observations become bounded context in PM and coding prompts.
Owner decisions are included whole within the context budget. If older decisions
do not fit, the prompt states the omission and asks for consolidation before
implementation or release recommendations. Keep this list concise and current.
Stale or unreadable snapshots are excluded. Learned notes never grant approval,
broaden tools, or override runtime policy. Decisions are project-scoped and must
not contain credentials. Keep those in Connections.

## Run limits and recovery

Set optional project concurrency, UTC daily run count, UTC daily agent runtime and
per-job duration under **Run limits**. A blank daily limit preserves the existing
behavior. A worker handles one job at a time. Runtime is reserved before launch
so several jobs cannot spend the same remaining budget. Subscription access does
not provide a reliable dollar charge; the dashboard reports measured runs and
runtime instead of estimating a bill. This ledger measures the PM/coding job
containers. Post-run trusted browser replay has a separate ten-minute bound;
isolated promotion checks have their own bounded execution window and are not
included in the agent-runtime total. It is not a whole-machine compute budget.

Cancel queues a durable request and stops only that job's owned container. The UI
distinguishes cancellation requested from cancellation confirmed. Existing logs
and artifacts remain available. Pausing a worker drains it; pausing a PM stops
future automatic work, while manual runs remain possible.

Confirmed pre-execution infrastructure failures have bounded retries and backoff.
An uncertain launch or missing previously-started container is not blindly rerun.
Result reconciliation can retry recording evidence without repeating the agent.
After an actual agent failure, inspect its draft and evidence before retrying.

Back up `.run/project-knowledge`, `.run/pm-knowledge`, delivery state, queue state,
project configuration, connection storage and PostgreSQL together. Keep the
backup private. Updates preserve this configuration home.
