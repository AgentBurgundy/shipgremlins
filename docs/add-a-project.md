# Adding a project

## Default local Docker setup

Open `gremlins setup` (or `gremlins setup --lan` on your server), save the source,
and Claude Code connections, and add your app repository. Linear can come later. Hosting is optional. A fork
or separate automation repository is not required. Terminal initialization is:

```sh
gremlins setup init --project my-app --repo your-org/my-app
```

The new project's **Environment** page starts a Setup Gremlin to inspect the source and recommend hosted staging or a disposable Docker app. Review and test the selected strategy, then create a PM. You can also keep repository-only verification. Review the PR base branch and test commands under **Edit settings**. See [project onboarding](PROJECT_ONBOARDING.md) for draft setup PRs, test accounts and Docker services.
Use Configuration to edit advanced JSON and File locations to find the mandate/memory
files. Create a Docker worker in the dashboard and wait for its browser screenshot
verification. Choose **Verify connections** or run `gremlins doctor my-app`, then enable reviewed areas. The local
controller reads their schedules in UTC; there is no `crons write` or commit/push
step for local scheduling. Inspect a supervised PM run before relying on it.

Developer jobs require an open `pm-approved` ticket in the area's Linear project
with its `pm:AREA` label. Approval is rechecked at launch; the worker publishes a draft
PR/MR to the configured base branch only after checks pass. Legacy promotion projects use their integration branch. The model does not publish
directly, and jobs cannot merge or mark the ticket Done.
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

If the target signs users in with emailed one-time codes on Neon Auth, give
the PM a test account instead of an inbox:

1. Add to `project.json`:
   `"signIn": { "kind": "neon-auth-otp", "email": "pm-agent@example.com", "path": "/sign-in", "databaseUrlSecret": "PM_DATABASE_URL_<NAME>" }`
2. Add the hub secret it names — the **preview** database URL (the Neon
   branch the integration branch's preview uses), never production:
   `gh secret set PM_DATABASE_URL_<NAME> -R <owner>/pm-hub`
3. Run the `pm-signin` workflow once for the project. It signs the test
   account in on the preview and prints its owner hash, for targets that gate
   test-mode features per owner.

Each PM run then calls `signin-code --project <name>`, which seeds a fresh
code in `neon_auth.verification` and prints `{email, code, path}`.
