# Adding a project

## Default local Docker setup

Open `gremlins setup` (or `gremlins setup --lan` on your server), save the source,
and Claude Code connections, and add your app repository. Linear can come later. Hosting is optional. A fork
or separate automation repository is not required. Terminal initialization is:

```sh
gremlins setup init --project my-app --repo your-org/my-app
```

The new project starts with source inspection and suggested PM responsibilities.
Review commands and login hints, adopt the areas you want, connect Linear, and
prepare the integration deployment. Save dedicated test-account credentials when
needed and pass the real browser test. The setup checklist includes the AI
connection and a verified agent service; **Activate ready crew** enables daily
patrols and eligible coding only when all adopted PMs are ready. Source discovery
can start earlier. Explicit direct-PR projects can stay repository-only.
See [project onboarding](PROJECT_ONBOARDING.md) for test accounts and Docker services.
Use Configuration to edit advanced JSON and File locations to find the mandate/memory
files. Create a Docker worker in the dashboard and wait for its browser screenshot
verification. Choose **Verify connections** or run `gremlins doctor my-app`, then enable reviewed areas. The local
controller reads their schedules in UTC; there is no `crons write` or commit/push
step for local scheduling. Inspect a supervised PM run before relying on it.

Developer jobs require an open `pm-approved` ticket in the area's Linear project
with its `pm:AREA` label. New projects require a native parent epic whose exact
scope the owner approved in ShipGremlins. The PM may approve finite children in
that scope. The trusted worker publishes the coding draft after checks; the
controller handles its integration merge and the PM tests the exact deployment.
Only the owning PM's final promotion to staging needs human review. Direct-PR
projects retain owner review of individual coding drafts. Models never publish
directly or mark a ticket Done. [Workflow diagrams →](AUTONOMOUS_WORKFLOW.md)
See [the setup guide](SETUP.md) for background operation and current limits.

## Advanced legacy CI enrollment

The following checklist is for an existing GitHub Actions automation hub.
Its GitHub App, hub secrets, generated workflows and commit steps apply only to
that optional execution path. Do not enable both schedulers for one project.

One command seeds the config, one command checks it against the live APIs,
and the PM crons appear only once the check passes. Everything in between is
the owner's: installing the app, creating branches, creating Linear projects,
pasting ids, writing the mandate.

```bash
gremlins add-project <name> --repo owner/name [--area core]
```

`<name>` is the project's key in the hub (lowercase kebab-case; it names the
secrets as `<NAME>` and the memory branches as `pm/<name>/<area>`). The
command writes `projects/<name>/` from `projects/_templates/`, refuses to
overwrite an existing project, and prints this checklist.

## The checklist

1. **Install the PM Hub GitHub App on the repo.** Permissions: contents
   write, pull requests write, issues write, checks read, actions read,
   metadata read. Every commit, PR and comment on the target is authored by
   the app, so the owner's review is always a human one.
2. **Branches.** Create `staging` and `pm-staging` from `main` if they do not
   exist. Protect `pm-staging` so only the app and the owner push; the
   dispatcher merges into it with the installation token. (`project.json` →
   `branches` can rename all three; they must differ.)
3. **Vercel.** The project builds every branch (Settings → Git → preview
   deployments for all branches) with the Neon integration on, so
   `pm-staging` gets a stable branch URL and a persistent database branch, and
   every developer PR gets its own preview with a throwaway branch. Paste the
   Vercel project id (and the team id when the project is in a team) into
   `project.json` → `vercel`. Turn on deployment protection and create a
   **protection bypass for automation** secret; that value becomes the hub
   secret `VERCEL_BYPASS_<NAME>`.
4. **Linear.** One project per area. Paste each project id into
   `areas.json` → `linearProjectId`. Labels (`pm-tier-a` … `pm-needs-human`)
   are created on first use.
5. **Hub secrets** (the hub repo → Settings → Secrets and variables →
   Actions): `SLACK_WEBHOOK_<NAME>` (a Slack incoming webhook URL for the
   project's channel) and `VERCEL_BYPASS_<NAME>`. The hub-wide secrets
   `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY` and
   `VERCEL_TOKEN` are set once for every project. `project.json` holds only
   the NAMES; `gremlins validate` refuses a value where a name belongs.
6. **Write the mandate(s)** — `projects/<name>/<area>/mandate.md`. This is
   the steering wheel: ambition in the owner's words, what the PM is expected
   to build, the one metric it ranks by, the feature flags it may ship
   behind, quotas. A PM with a small mandate files small tickets.

## Check it

Optionally connect [Sentry, Datadog and Mixpanel](TELEMETRY.md) before running
doctor. Each project declares its own scope and credential names; areas can
select a saved Mixpanel Insights report. PMs use these signals during observation.

```bash
GITHUB_TOKEN=… LINEAR_API_KEY=… VERCEL_TOKEN=… \
SLACK_WEBHOOK_<NAME>=… VERCEL_BYPASS_<NAME>=… \
gremlins doctor <name>
```

`doctor` prints one PASS/FAIL line per step: no `PASTE_…` placeholder left,
the repo is readable with the token, the three branches exist, the Vercel
project answers and has a preview deployment for `pm-staging`, every area's
Linear project id resolves, and both secret names are set in the environment.
When every line passes it writes `"verified": "<today>"` into `project.json`.

Then generate the crons and commit:

```bash
gremlins crons write      # updates the block in .github/workflows/pm-agent.yml
gremlins validate
git add projects/<name> .github/workflows/pm-agent.yml && git commit -m "feat: add <name>"
```

Hub CI runs `crons --check` on every push, so a project whose `areas.json`
changed without a `crons write` fails the build instead of silently running
on the old schedule.

## Try it once by hand

- Actions → **pm-dispatch** → Run workflow: the dispatcher syncs `staging`
  into `pm-staging` and reports what it sees. Nothing is dispatched until a
  ticket carries `pm-approved`.
- Actions → **pm-agent** → Run workflow with `project` and `area`: the first
  PM run is a full sweep — it walks every surface, fills `features.md`, seeds
  `queue.md`, files tickets, and sends one Slack message. Read that message
  and tune the mandate until the tickets are ones you would approve; that
  tuning is the real work.

## Adding an area later

Add an entry to `areas.json` (key, `label: pm:<key>`, paths, Linear project,
cron), copy the four markdown seeds from `projects/_templates/` into
`projects/<name>/<key>/` (replace the `{{placeholders}}` by hand), then
`gremlins validate`, `gremlins doctor <name>` and `gremlins crons write`.

## When the app needs a sign-in

Use [test-account setup](TEST_ACCOUNTS.md) for the supported same-origin password
form. Configuration stores secret references; Connections stores their values.
Creating a recipe does not create an account or grant its role.

Older projects may retain `signIn.kind: "neon-auth-otp"`, with a dedicated test
email, sign-in path, and preview database secret reference. The legacy
`signin-code` helper seeds a temporary code in that test database. It does not
establish a browser session, exercise the app's email-delivery flow, or prove
the current UI can use the code. The guided environment checker does not run
this recipe, and Grumblins do not receive its database credential. Do not save
a one-time code as a password or treat this legacy path as verified end to end.
