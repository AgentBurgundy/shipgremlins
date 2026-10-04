# ShipGremlins — original runtime guide

This guide describes the original PM Hub runtime. The current
[implementation status](IMPLEMENTATION_STATUS.md), [setup guide](SETUP.md),
[verification contract](VERIFICATION.md), and [Linear lifecycle](LINEAR_LIFECYCLE.md)
supersede its older setup and completion details. Prose-only verification comments
no longer authorize promotion. The [master plan](MASTER_PLAN.md)
defines the broader system, including both provider stacks, durable release gates,
the dashboard, and self-hosting. See the
[delivery roadmap](ROADMAP.md) for implementation order, and the
[launch plan](OPEN_SOURCE_LAUNCH.md) for branding and public distribution.

An AI **product manager** per product area of each project, running on a
schedule in GitHub Actions as headless Claude Code. Each PM owns an area
(`projects/<name>/areas.json`), keeps a mandate, a feature inventory, a ranked
queue and a memory (`projects/<name>/<area>/`), and runs **once per weekday** —
observe → tickets → test → promote → learn. It files evidence-backed Linear
tickets and it tests what shipped, in a real browser against the project's
**`pm-staging` preview** on Vercel. It never writes code, never merges.

PM work lands on its own integration branch in the target repo, **`pm-staging`**,
which Vercel builds like any other branch (a stable branch URL, a persistent
Neon branch). `staging` stays the owner's release candidate: verified PM
changes reach it only through a **promotion PR** (`pm-release/<area>/<YYYYMMDD>
→ staging`) that the PM opens and the owner merges. `staging → main` is the
owner's too. Current design: [master plan](MASTER_PLAN.md).

A deterministic program, the **dispatcher** (`src/dispatcher/`), turns approved
tickets into developer runs, merges the resulting PRs into `pm-staging` when
they are green — whatever they touch — and keeps `pm-staging` synced from
`staging`. The one thing it will not merge on its own is a diff touching the
hub's own workflows or prompts (`tiers.json` → `hubOwnerOnly`); that waits for
the owner. Everything else gets its one close look from the owner at
promotion, not per PR.

The hub holds nothing of the target's code and the target holds nothing of
the hub: one GitHub App ("PM Hub"), installed per repo, is the author of every
commit, PR and comment, so the owner's review is always a human one.

## Roles

| Role           | Runs as                                                           | Does                                                                                                                                                     | Never                                                       |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **PM**         | `pm-agent.yml`, one cron per (project, area), weekdays            | Observe → write/rank Linear tickets → test what merged into `pm-staging` on the preview → open the promotion PR to `staging` → learn                     | writes code, merges (incl. its promotion PR), reverts       |
| **Dispatcher** | `pm-dispatch.yml` hourly + after each PM run; no LLM              | Syncs `staging → pm-staging`; stops the line when `pm-staging` is red; heals and repairs developer runs; merges any green PR to `pm-staging`; dispatches | edits files, decides priority, merges a `hubOwnerOnly` diff |
| **Developer**  | `developer.yml` (`prompts/developer.md`), fired by the dispatcher | Builds one Linear ticket to a draft PR against `pm-staging` with tests and an `## Acceptance` section; resolves conflicts and red CI on request          | reprioritises, merges (the dispatcher does)                 |
| **Owner**      | a human, in Linear / GitHub / Slack                               | Edits mandates, approves epic proposals and hub-config tickets, comments on tickets and PRs, merges the promotion PRs (reading `## Look closely`)        | —                                                           |

```
                ┌──────────────── Linear (one project per area) ────────────┐
  weekdays      │ pm-tier-a ─┐                                               │
  PM run ─────▶ │ pm-tier-b ─┴─ pm-approved (self) ──────────────┐           │
  (tickets)     │ pm-tier-c: epic or hub config ── pm-approved (owner) ┤      │
                └─────────────────────────────────────────────────────┼──────┘
                                                                      ▼
  hourly    ┌────────────┐  developer.yml     ┌──────────────┐  draft PR   ┌────────────┐
  + after ─▶│ dispatcher │  (project, ticket) │ developer    │ → pm-staging│ dispatcher │
  each PM   │ (TypeScript)│── fires ─────────▶│ (Claude Code)│  any green  │ MERGES     │
            └────────────┘                    └──────────────┘  PR →       └─────┬──────┘
                                                                hub config →      │
                                                                owner merges      │
  Vercel builds pm-staging → next PM run tests each acceptance criterion ◀────────┘
     pass → pm-verified · fail → pm-test-failed → dispatcher retries once → then pm-needs-human
                    │
  PROMOTE: hub promote builds pm-release/<area>/<date> FROM staging + only this area's
           verified merges (cherry-pick -x); `## Look closely` first → ONE PR → staging
  LEARN: one JSON report → hub slack → ONE Slack message (filed/verified/failed/promotion)
         → owner merges the PR → dispatcher syncs staging → pm-staging
```

## Files

| File                                 | What                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub.json`                           | Hub-wide settings: `hubRepo`, the runner mode switch (`runners.mode`: `self-hosted` or `gce`), GCE project/zone/image. See `runners.md`.                                                                  |
| `projects/<name>/project.json`       | The target: repo, the three branches, Vercel project id, the NAMES of its two hub secrets, merge method, the commands the developer runs, and `verified` (written by `hub doctor`).                       |
| `projects/<name>/areas.json`         | Ownership map — one entry per area: paths, shared touchpoints, Linear project, label `pm:<area>`, WIP limit, the one metric, the cron. Validated on every hub CI run (`hub validate`).                    |
| `projects/<name>/tiers.json`         | `ownerOnlyPrefixes` (listed under `## Look closely` on the promotion PR), `hubOwnerOnly` (never merged by the dispatcher), `alwaysFree`, `guardTests` (the developer may not edit one to get green).      |
| `projects/<name>/<area>/mandate.md`  | Ambition, goal, the metric, the roadmap the owner expects, guardrails, tiers, quotas. A human writes this; it is always read from `main`. **This is the steering wheel.**                                 |
| `projects/<name>/<area>/features.md` | Feature inventory. Seeded by `add-project`, maintained by the PM (refreshed on every full sweep).                                                                                                         |
| `projects/<name>/<area>/queue.md`    | Ranked backlog of ticket candidates the PM keeps between runs; its state decides whether a run is a light walk or a full sweep.                                                                           |
| `projects/<name>/<area>/memory.md`   | Decisions + run log. Maintained by the PM on the hub branch `pm/<project>/<area>` (see below).                                                                                                            |
| `projects/_templates/`               | Seeds for the seven files above; `hub add-project` fills their `{{placeholders}}`.                                                                                                                        |
| `prompts/pm.md`                      | The prompt every PM runs. Project-agnostic. The copy on `main` is what executes.                                                                                                                          |
| `prompts/developer.md`               | The developer. Builds one ticket, resolves a conflict (`kind: rc`) or fixes red CI (`kind: ci`).                                                                                                          |
| `src/cli.ts`                         | `npx tsx src/cli.ts <command>` — `dispatch`, `promote`, `slack`, `ticket`, `metric`, `crons`, `add-project`, `doctor`, `validate`. The only code that reads `process.env`.                                |
| `src/dispatcher/`                    | One module per rule (`sync`, `stopTheLine`, `heal`, `repair`, `merge`, `dispatch`, `promote`), each a pure function of `Ctx` with scenario tests against the fakes. `notes.ts` owns every comment string. |
| `src/forge/`, `src/services/`        | The GitHub forge and the Linear, Vercel and Slack clients — `fetch` only — plus in-memory fakes.                                                                                                          |
| `.github/workflows/pm-agent.yml`     | The PM job. One generated cron per (project, area) between the `# generated-crons-*` markers (`hub crons write`); the dispatcher runs as its last step.                                                   |
| `.github/workflows/pm-dispatch.yml`  | The dispatcher on its own hourly schedule, every project, no Claude.                                                                                                                                      |
| `.github/workflows/developer.yml`    | One ticket → one draft PR. Inputs `project`, `ticket`, `attempt`, `kind`, `branch`, `pr`, `marker`.                                                                                                       |
| `.github/workflows/hub-ci.yml`       | The hub's own gates: format, typecheck, tests, `hub validate`, `hub crons --check`.                                                                                                                       |

## The daily run

`prompts/pm.md` is the contract; in short:

1. **Observe** — the code diff since the last run, the mandate's metric in
   Vercel Analytics (`hub metric`), the project's Vercel runtime logs, owner
   comments on Linear, the area's open tickets and PRs, each external provider
   the mandate names (`WebFetch`), and a walk of the `pm-staging` preview in
   the browser (sending the project's protection-bypass header). The walk is
   **light** by default (surfaces touched by what merged + one rotating
   inventory surface) and becomes a **full sweep** (every surface, phone +
   desktop, inventory refresh) when `queue.md` holds fewer than 5 unfiled
   candidates or the last full sweep is 7+ days old.
2. **Tickets** — re-rank `queue.md` by impact on the metric; file at most 8
   Linear tickets from the top, dedup first, every one with evidence,
   acceptance criteria a browser can check, where in the code, the flag
   (`none` or a feature-flag name the mandate defines), and a `Tier: A|B|C`
   line. The PM self-approves (`pm-approved`) everything except an epic
   proposal (`pm-tier-c` + `pm-proposal`) or a ticket whose "Where in the
   code" names the hub's `.github/` or `prompts/` (also `pm-tier-c`) — those
   two wait for the owner. Epics carry numbered milestones.
3. **Test** — every PR merged into `pm-staging` since the last run that
   touches the area's paths and has no `🧪` verdict yet: wait for the merge
   sha's Vercel deployment to be READY, exercise each acceptance criterion at
   390×844, comment the pass/fail table on the PR and the ticket. Pass →
   `🧪 Verified on pm-staging` + `pm-verified`. Fail → `🧪 Failed on
pm-staging` + `pm-test-failed` with evidence; the dispatcher re-dispatches
   once; a second failure → `pm-needs-human`. The PM never reverts.
4. **Promote** — the PM runs `npx tsx src/cli.ts promote --project <p> --area
<a>`. It builds `pm-release/<area>/<YYYYMMDD>` **from `staging`** and
   cherry-picks (`-x`) only this area's `pm-staging` merges whose latest `🧪`
   comment is verified, then opens or updates ONE PR to `staging` titled
   `PM promotion: <area> — <date> (<n> changes)`. Its body opens with
   `## Look closely` — every changed file under `tiers.json` →
   `ownerOnlyPrefixes`, grouped by prefix, or `Nothing in the stop-and-ask
list.`; then **Tests changed or removed** (every `guardTests` file the
   batch touched and every test file it deleted — a test edited to pass is a
   rule change); then what ships and what was held back and why (failed,
   untested, touches a file that another area's earlier, still-unpromoted
   merge also touched — that area promotes first — or doesn't apply on
   `staging`). It appends to an open promotion rather than rebuilding it
   (never force-pushes). Nobody but the owner merges it.
5. **Learn** — memory entry, `queue.md` (and `features.md` after a sweep)
   committed to `pm/<project>/<area>` on the hub; then one Slack message,
   built by writing a JSON report and running `npx tsx src/cli.ts slack
<report.json>`: filed tickets, verified/failed PRs, owner actions needed
   and — only when PROMOTE opened or updated the PR this run — the promotion
   in plain language. A run with nothing filed and nothing tested still sends
   the report, saying so in a note.

Quota is set per area in its mandate: every full sweep files at least three
epic proposals and keeps at least five in `queue.md`, ranked by impact on the
metric; polish and copy are capped at three tickets a run and never outrank
an epic; a light run still files at least one ticket.

### Tiers

A ticket's tier says only where the diff lands, not who approves it. The PM
self-approves every ticket it files except an epic proposal and a ticket that
edits the hub's own workflows or prompts.

| Tier  | Where the diff lands                                                                     | Approval | Merge on `pm-staging`    |
| ----- | ---------------------------------------------------------------------------------------- | -------- | ------------------------ |
| **A** | inside the area's `paths` + tests + docs                                                 | self     | dispatcher, any green PR |
| **B** | reaches `sharedTouchpoints` / another area / an `ownerOnlyPrefixes` path                 | self     | dispatcher, any green PR |
| **C** | an epic proposal, or the diff touches the hub's `.github/` / `prompts/` (`hubOwnerOnly`) | owner    | owner, by hand           |

The owner's review of sensitive code (auth, migrations, billing — whatever
`ownerOnlyPrefixes` names) happens once, in the promotion PR's `## Look
closely` section, not per ticket or per merge.

## The dispatcher

`npx tsx src/cli.ts dispatch [--project <name>] [--dry-run]` — reads every
`projects/*`, needs `GITHUB_TOKEN` (the app installation token), `LINEAR_API_KEY`
and `VERCEL_TOKEN`; `BOT_LOGIN` names the app's bot login (default
`pm-hub[bot]`). Per project, in this order; every rule is one module under
`src/dispatcher/` with scenario tests, and a rule that throws becomes one
`Needs you` row while the others still run:

- **sync** — `staging` ahead of `pm-staging` → open `sync: staging →
pm-staging` (if none is open) and merge it as a merge commit as soon as
  GitHub reports it mergeable. The dispatcher merges it itself; it does not
  rely on the repository's auto-merge setting. A **conflicting** sync heals
  itself: the dispatcher files a `pm-sync` Linear ticket and sends a
  developer (`kind: sync`) to merge `staging` into a `pm-sync/<staging sha>`
  branch off `pm-staging`, resolve, run the tests and open a PR; the merge
  rule lands that PR as a merge commit, which settles the sync PR too. Two
  developer runs that end without a PR → `🚫 needs owner: sync conflict`,
  once. A sync ticket never takes a WIP slot.
- **stop the line** — `pm-staging`'s latest checks or Vercel deployment
  failed → nothing merges for that project (`⛔ Line stopped` — a status, not
  a request: the repair is automatic). Retry the checks once; then ONE
  `Fix red pm-staging (<sha>)` Linear ticket (label `pm-ci`, pre-approved) to
  the developer with the failing logs and the PRs merged in the last 24 h. Two
  such fixes in 24 h with the branch still red → a `Needs you` line and no
  more dispatches.
- **heal** — a developer run that was fired for a ticket and ended with no
  PR is re-fired once (judged by its run id, not the clock); a second empty
  run → `🚫 needs owner: two runs ended` + `pm-needs-human`. A run still
  queued or running is left alone however long it waits.
- **repair** — per open developer PR: a **conflict** with `pm-staging` goes
  back to the developer on the SAME branch and PR (`kind: rc`, comment
  `🔀 Conflict resolution dispatched → run <id> (at <sha>, pm-staging at
<sha>)`). An attempt has FAILED only when the PR still conflicts against the
  same `pm-staging` commit it was dispatched against; two of those →
  `🚫 needs owner: conflict with pm-staging — …` + `pm-needs-human`. A
  resolution that landed and was then re-conflicted by a newer merge is NOT a
  failure; those re-dispatch freely, capped at four. **Red checks** are re-run
  once (`🔁 Retried failed jobs`), then a `kind: ci` fix goes to the developer
  with each failed job's log tail (`🔁 CI fix dispatched → run <id>`), two
  attempts, then `🚫 needs owner: CI still red after two fixes`.
- **merge** — per open draft PR by the app targeting `pm-staging`, OLDEST
  FIRST (so a repaired PR merges before the newer one that would re-conflict
  it): needs `🔧 PR opened`, all checks success, GitHub's `mergeable_state`
  clean, and no `@claude` comment from a human newer than the bot's last
  reply. Mark ready, merge with the project's `mergeMethod` at the PR's head
  sha, delete the branch, comment `🚢 Merged by the dispatcher`. A diff
  touching `hubOwnerOnly` is held with `🚫 needs owner: hub config — <files>`.
  A refused merge gets `🚫 needs owner: merge failed at <sha> — <reason>`,
  which holds only that commit: a new push retries.
- **dispatch** — per area with `enabled: true`: tickets labeled `pm-approved`
  and not `pm-dispatched` (or `pm-test-failed` not yet retried), oldest
  first, up to `wipLimit` minus what is in flight (`pm-dispatched`, not done,
  not verified, not needs-human). Fires `developer.yml`, labels the ticket,
  comments `Dispatched → run <id>`. A first dispatch skips tickets Linear
  shows Done or Canceled; a retry does not. A ticket whose last dispatch is
  still running is left alone. Skipped entirely while the line is stopped.
- **promote** — as in step 4 above, for every area, when the job has the
  target checked out in `target/`.

It writes nothing to the target's working tree, never force-pushes, and
every decision is one line in the job log. Digest rows land in
`.run/dispatch.json`; the ones that need the owner carry `needsYou`.

## Where state lives

Config and mandates are read from the hub's `main`. A PM's `features.md`,
`queue.md` and `memory.md` change every run; merging them into `main` would
produce PRs nobody reviews, so the PM commits them to the hub branch
`pm/<project>/<area>` (fast-forward only, never force) and overlays that
branch's copies at the start of each run — the versions on `main` are seeds.
The mandate is deliberately NOT on that list: it comes from `main` every run,
so an owner edit lands on the next run, and a mandate change that contradicts
a remembered decision wins.

Secrets live only in the hub repo's Actions secrets; config names them
(`SLACK_WEBHOOK_<NAME>`, `VERCEL_BYPASS_<NAME>`) and `hub validate` refuses a
value where a name belongs.

## Steering a PM

If a PM's output is too small, the fix is the mandate, not the prompt: state
the ambition in the owner's words, list what it is _expected_ to build, name
the one metric it ranks by, set quotas, and rank by impact. Give it an "owner
actions you may ask for" list so blockers become requests instead of reasons
to stop. **Redirect** a PM by commenting on its ticket; the PM reads owner
comments every run and treats them as product direction. **Approve** a tier C
ticket by adding `pm-approved` in Linear. **Stop** a PM by setting its area's
`enabled` to `false` (no dispatches for that area; open PRs still merge).
**Ask for a change on a developer PR** with ONE comment starting `@claude`;
while it is unanswered the dispatcher will not merge that PR.

## When something looks stuck (owner runbook)

Almost everything heals itself within an hour. The run's Slack message's
**Needs you** list is the only thing that asks for you. Start there.

| You see                                              | What already happens                                                  | What you do, only if it's in Needs you                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A run claimed a ticket but produced no PR            | Re-fired once; a second empty run labels the ticket `pm-needs-human`. | In Linear, remove `pm-dispatched` and `pm-needs-human`. The next hourly run builds it again.              |
| An urgent ticket waiting because the area is full    | Nothing — the WIP limit holds it.                                     | Raise `wipLimit` or close a less important in-flight ticket.                                              |
| `pm-staging` red                                     | Retried, then a fix is dispatched; merges pause until green.          | After two failed fixes: open the red run, read the failing test, fix or ask Claude to.                    |
| A PR noted `🚫 needs owner: hub config`              | Held on purpose — it edits the hub's workflows or prompts.            | Review and merge it yourself.                                                                             |
| A PR noted `🚫 needs owner: merge failed at <sha>`   | Held at that commit only.                                             | Read the reason (usually branch protection); a new push retries by itself.                                |
| "The dispatcher could not run" / a red `pm-dispatch` | Nothing was dispatched or merged.                                     | The job log names the cause — a rejected `GITHUB_TOKEN`, `LINEAR_API_KEY` or `VERCEL_TOKEN`.              |
| Nothing happening at all                             | —                                                                     | Actions → pm-dispatch → Run workflow. Still nothing: `hub doctor <name>` and check the area is `enabled`. |

## See also

- `MASTER_PLAN.md` — the design and the
  decisions behind it
- `runners.md` — self-hosted runner setup and the GCE switch
- `add-a-project.md` — the onboarding runbook `hub add-project` prints
