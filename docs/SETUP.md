# Set up ShipGremlins

**Bring the app you already build.** Connect its codebase and give one product
area sustained attention. A public launch is not required. Start with a small,
supervised improvement. [Experimental idea builds →](IDEA_TO_APP.md)
[When to use ShipGremlins and what to try first →](WHEN_TO_USE.md)

Install the global CLI with Node.js **22.12+**, npm, and Git. Workers also need Docker Desktop or Docker Engine running **Linux containers**.

```sh
npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git
gremlins setup
```

This installs from the official GitHub repository; an npm registry package is not published yet. `gremlins` works from any directory on PowerShell, macOS, and Linux. `shipgremlins` and `hub` remain compatibility aliases.

**On a homelab server, use `gremlins setup --lan`.** Open a printed session link from your laptop or phone. Workers, configuration, and connections stay on the server. See [server use](#server-use).

## Your first adoption

The browser that opens is your private dashboard. Start with **Projects → Add
project**, then choose the path that fits your app:

1. **Give your gremlin a home.** Choose **Improve my app**, connect GitHub or
   GitLab, and select its repository. The secondary experimental idea path can
   create a new private-by-default repository and a reviewed foundation assignment.
2. **Choose its job.** On an existing project, choose **Adopt a PM Gremlin**. Explain
   who it helps, what should get better, and what it should leave alone. Review
   its proposed name and product brief with **Meet my gremlin** before adopting. One focused gremlin is
   a good start; you can grow the crew later.
3. **Give it a first assignment.** Choose **Explore the codebase** to run
   **Discovery**, or **Prepare first mission** if source access, Claude Code, or
   a ready worker is missing. Linear and a browser environment are not required. A new idea instead
   starts with the reviewed **foundation build**: a Coding Gremlin creates the
   initial app and tests. Review and merge that work before asking PMs to explore.

Adoption saves the PM and its brief. It does not start a job or turn on automation.
When ready, use **What should get better?** on the project home to start an
[improvement mission](IMPROVEMENT_MISSIONS.md). This explicitly starts investigation
and asks you to review a bounded proposal before coding begins.
Connect only what the next assignment needs. Linear is needed for proposals and
approved coding work; a browser environment is needed for a runnable app's browser
walkthroughs. Slack and product signals can wait.

[Build from an idea →](IDEA_TO_APP.md) · [Prepare a browser environment →](PROJECT_ONBOARDING.md)

## Your setup dashboard

The sidebar opens separate **Overview**, **Connections**, **Projects**, **Your gremlins**,
**Activity**, **Usage**, and **Settings** pages. Each page has its own address and supports
browser Back/Forward and reload. Moving between pages keeps unfinished forms in
memory; save them before closing or restarting the dashboard.

**Usage** shows workspace token totals, a trend, and project breakdowns. Filter
by period or project, and read reporting coverage alongside the totals: missing
reports are unknown, not zero. Counts update after runs and AI setup actions finish.
[Understand token usage →](TOKEN_USAGE.md)

Projects appear individually in the sidebar. **Your next change** leads with
ready drafts, blocked work, current progress, and an outcome for the next mission.
**Proposals** holds owner decisions; **Changes** collects coding results and links to advanced staged delivery; **Your
crew** keeps PMs, Grumblins, and shared knowledge; **Settings** includes environment
and run-limit setup. Existing direct links remain available. Open a PM for its
brief, Learning, Features, Queue, Memory, and run history.

Overview shows your projects, PM mandates, verified workers, and active jobs.
Connections has category tabs; mobile navigation opens from the menu button.
Your gremlins starts with the launch form, with worker management below. Settings
puts software updates first and keeps files and JSON under advanced configuration.

Projects and PMs have **Delete** controls in their workspace/settings. The preview
shows what is removed and preserved, and asks you to type the identifier. Active
work blocks deletion. Settings includes deleted resources with **Restore**;
restored PMs start paused and the project needs verification again. Connections
offers **Remove saved account** and **Clear saved token**. See
[resource removal and recovery](RESOURCE_LIFECYCLE.md) for the exact scope.

An update banner appears across the dashboard when a release is available. You
can install from that banner, see installation progress, and restart once the new
runtime is ready. Update details and rollback remain in Settings. A visible open
dashboard checks periodically for new releases; updates are never installed
automatically.

1. Open **Source control** and connect the official GitHub or GitLab app using the displayed device code. Choose the repositories available to your account; GitHub also requires installing the App on the selected repositories. Manual source tokens remain an advanced option. Connect Claude Code in Connections for repository analysis. Linear and hosting can come later. See [source-control setup](SOURCE_CONTROL.md).
2. In **Projects → Add project**, choose **Improve my app** to connect an existing repository. The secondary experimental idea path proposes a crew and creates a private-by-default repository. Its next action is the reviewed foundation build, before environment setup or repository analysis. Existing apps connect their repository and can adopt a PM immediately; adding the repository itself creates no PM. Source access and Claude Code may trigger a bounded Setup Gremlin analysis on import, but no PM or coding job starts and automation stays off. See [idea onboarding](IDEA_TO_APP.md) or [your first adoption](#your-first-adoption).
3. **When browser testing is useful**, open Environment. Choose **hosted staging** or a **disposable Docker app**, review proposed settings, then **Test environment**. Repository-only projects can skip this step. For a fresh idea, build and merge the foundation first. Keep test-account and app-input values in Connections. See [project onboarding](PROJECT_ONBOARDING.md).
4. Choose **Create local worker**. The machine is the CLI/dashboard server. The first image build can take time; Ready requires a real Chromium screenshot with verified evidence.
5. Adopt a PM with a focused **Product brief**. When application code exists, choose **Discovery** to build its context. New PMs start with automation paused; you do not need to edit JSON or configure hosting to try repository discovery.
6. Choose **Run now** for one investigation. The action explains missing prerequisites and can complete missing Linear setup and required connection verification using your selected accounts. It preserves existing mappings and repairs missing PM labels. Inspect Activity and its evidence. Choose **Automation** only when you want recurring patrols and automatic pickup of approved tickets. Manual Coding can find the next ready approved ticket without turning automation on.

Approval uses `pm-approved`; proposals use `pm-proposal`. Area labels remain `pm:core`, `pm:security`, and similar. Project Review lets you inspect a proposal and explicitly approve its bounded scope. The controller removes the proposal hold and re-checks the current scope before approving. After configured checks, the worker publishes its unique branch as a **draft** PR/MR. Repository-only projects leave merges to you. Explicit promotion projects target their integration branch and can advance eligible fixes for owning-PM verification; see [selective delivery](DELIVERY_WORKFLOW.md).

The dashboard provides pause/resume, browser verification, repair, idle-worker removal, and job logs/artifacts. Pausing lets the current job finish. Removing a busy worker is refused. Multiple PMs share capacity: each worker runs one job at a time. One click creates one worker; the local pool is capped at four.

Optional [project telemetry](TELEMETRY.md) lets PMs read scoped Sentry logs/errors, Datadog logs, and Mixpanel Insights reports. Provider accounts still require live validation.

Connect an optional [Slack channel](SLACK.md) once for PM patrol results, coding drafts ready for review, and blockers from every project. Choose Add to Slack in Connections, or save an incoming webhook when the OAuth broker is unavailable. Projects inherit that channel; leave optional project overrides empty unless a project needs a different channel. Slack is not required to run gremlins. Browser readiness checks do not post messages.

The local runtime prepares a PostgreSQL activity store before launching work. This adds a local Docker service and persistent volume; it is managed on the CLI/dashboard server. Visible tool activity, result summaries, checks, redacted logs, and bounded artifacts appear in the dashboard. Private model reasoning is not stored or displayed. Activity storage failures are separate from the recorded outcome of an already-running job; Docker output remains available.

Open a recent run or **Activity → View activity** for a focused run viewer with
**Summary**, **Activity**, **Output**, and **Artifacts** tabs. The selected tab and
reading position survive live refreshes. Live output and saved history load
independently, so a slow history service does not hide available worker events.
Artifacts become available after the job finishes and their contents are
sanitized. **Back to activity**, Escape, or leaving Activity closes the viewer and
stops detail polling without stopping the job. Run links can be bookmarked. A
finished PM run means its process completed; check the summary and evidence to
see which tests actually ran.

## Run now and automation are separate

A PM is a saved product mandate. A worker is the Docker capacity that executes
it. Creating one does not implicitly create or enable the other.

| Action             | Result                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discovery**      | Investigates the checkout and saves learned context. Requires source, Claude, and a ready worker; no Linear or hosting setup, ticket creation, or automation change. |
| **Run now**        | Queues one PM investigation using saved settings. A paused PM can run when its project and mapping are ready. Its automation state does not change.                  |
| **Run Coding**     | Queues work on one open ticket with `pm-approved`, the matching area label, and the PM's Linear project. Manual coding does not require automation to be enabled.    |
| **Automation on**  | Allows that PM's UTC patrol schedule and background pickup of its approved tickets while the controller runs.                                                        |
| **Automation off** | Stops new scheduled patrols and automatic approved-ticket pickup. It does not cancel an already-running job.                                                         |
| **Pause worker**   | Stops that execution slot accepting more work. It does not change any PM's automation settings.                                                                      |

Use the guided setup actions beside the selected project when something is
missing. Connect source control and Claude Code in Connections; repair the
project's Linear connection, team, or PM mappings in Edit settings; then verify
the project and create or resume a verified worker. Hosting setup is required
only for a selected browser environment. Slack and product signals are optional.
A saved credential, an enabled schedule, and a ready worker are different states.

**Run now** opens existing Activity when that PM already has a queued or running
job. Otherwise it queues one job after checking that PM's prerequisites. Discovery
uses its smaller source-only checklist; missing Linear or hosting setup in this
or another project does not block discovery. A remote worker must be online and
enrolled for the selected project. An eligible busy worker can queue the job.
Automation can be enabled before a worker is available, but execution still waits
for eligible capacity. Turning automation off remains possible when connections
need repair. Configured product-signal connections are checked during project
verification; remove an unwanted configuration rather than leaving it broken.

### Meet a PM before adopting it

Choose **Adopt a PM Gremlin** on your project. Describe what it should take care
of and choose **Meet my gremlin**, or **Write the brief myself**. AI combines that goal with a bounded view of the
repository's paths and existing PM ownership to suggest a name, mandate ID,
ownership paths, shared touchpoints, metric, UTC schedule, and WIP limit. It also
fills all eight **Product brief** fields: ambition, goal, measurement, users,
expected capabilities, non-goals, guardrails, and standing priorities. The area
label is derived from the final mandate ID. Review the rationale and warnings,
especially when the repository view was truncated or a business assumption needs
confirmation. Success metrics are proposals, not invented baselines or verified
telemetry. Shared project permission tiers are unchanged.

The flow introduces the gremlin before its detailed controls. Review the product
brief, with ownership and schedule available when you need them. Close
or Escape keeps the unfinished draft for your next visit during the same dashboard
session. Saving opens the new PM's workspace; automation starts off.

AI fill uses the saved Claude Code connection and source access, with a disposable
Docker container on your controller. The first request may need to build the
worker image. It reads repository paths, not source-file contents. The first PM
patrol follows the configuration you saved; it does not fill or rewrite ownership.

AI fills suggestions into blank fields and default controls in one
step, preserving the original mandate and values you already entered. Changes to
the selected project or form while generation is pending make the response stale;
your newer edits win. It does not save configuration, create Linear resources,
enable automation, or start work. Review the filled form and adopt the named
gremlin separately. The welcome screen offers **Explore the codebase** for
Discovery, or **Prepare first mission** when its setup is incomplete. Discovery
needs source access, Claude Code, and a ready worker; no Linear or browser
environment is required. Fresh ideas offer **Build the foundation** first. Provider selections, credentials, and optional Mixpanel report IDs
remain yours to configure; AI never invents them. You can always fill in the form
manually.

### Discover the codebase and keep a useful PM memory

**Discovery** is a separate worker run that reads actual source and tests. It
produces a codebase map, feature inventory, ranked opportunity queue, and memory
for subsequent patrols. It can run before Linear or hosting is configured, and
does not file tickets, publish changes, or change owner settings. Check the
result's run, branch, and commit before treating an observation as current.

Use the PM's **Product brief** for ambition, users, expected capabilities, a
measurable outcome, priorities, guardrails, and non-goals. Edit this owner direction
separately from the learned documents. Saving is revision guarded so another
browser's changes are not silently overwritten.

Learned documents are stored under `.run/pm-knowledge` in the configuration
directory. Back them up with your projects; updates preserve them. Missing,
failed, or incomplete new snapshots keep the last valid context. Repository
observations are not proof of a deployed behavior: browser evidence and actual
test results remain explicit. See [the full PM workflow](PM_WORKFLOW.md).

## Connections and configuration

Claude Code accepts the token from `claude setup-token`, including copied terminal
line wrapping or a quoted `CLAUDE_CODE_OAUTH_TOKEN` assignment. It never executes
the pasted text. A failed save reports whether the token format or credential
file caused the problem, without revealing the token. File permissions apply to
the account running the controller on your server, which may differ from your
interactive shell account. Existing credentials stay unchanged on failure.

Connections shows compact service cards with setup instructions when opened. The
Claude Code card explains how to run `claude setup-token` in a terminal with Claude
Code installed and a Claude subscription, then paste the resulting token. You can
generate it on your laptop and save it in your server's dashboard. Hosting cards
link directly to token creation; project-specific fields explain their purpose,
such as Vercel preview access. A saved credential is not proof of live access:
finish with **Verify connections** on the project.

Linear and Vercel support named connections for separate accounts or workspaces.
Add and authorize them in Connections, then select the right connection in each
project's settings. Choosing a card's account only changes which connection you
are managing. Each app keeps its own Linear team, PM mappings, hosting provider,
and environment. Existing projects keep the Default connection. See
[project account selection](PROJECTS.md#different-projects-different-accounts) and
[repairing Linear mappings](LINEAR_VERCEL.md#repair-an-incorrect-linear-setup).

Supported tokens are saved in the configuration directory's `.env`. Existing values are not returned to the browser. Blank fields preserve saved values; exported variables take precedence. Files use owner-only permissions where supported. The file is not encrypted: keep the directory private and out of Git.

Official GitHub/GitLab authorizations use encrypted state under `.run/source-control/` instead of `.env`. The local controller refreshes credentials directly with the provider and reserves them for active jobs so refresh cannot interrupt another worker. If refreshing must wait, new work remains queued. A saved OAuth connection takes precedence over a manual token for its provider/server; failed OAuth is not silently replaced with a PAT. See [credential storage and leases](SOURCE_CONTROL.md#jobs-keep-their-credentials-until-publication-finishes).

Linear and optional Vercel access have browser authorization buttons and encrypted local state under `.run/oauth/`. Add a PM from its app to create the corresponding Linear project; new PMs remain disabled. Railway uses manual tokens; Cloud Run uses service-account JSON or the controller's Application Default Credentials. Hosting credentials stay on the controller for discovery. Linear access tokens reach workers for proposal creation, while refresh tokens remain on the controller. See [setup and recovery](LINEAR_VERCEL.md) and [hosting choices](PROJECTS.md).

The controller supplies only the job's required credentials to its container. Credentials are not written into queue metadata or shell arguments. The worker redacts known credential values from persistent logs. Local mode does not copy tokens to GitHub Actions secrets or GitLab CI variables.

The configuration directory is selected in this order:

1. `--home PATH`, or `SHIPGREMLINS_HOME`.
2. The nearest `hub.json` in the current directory or its parents.
3. `~/.shipgremlins` outside an existing configuration directory.

```sh
gremlins --home /path/to/my-gremlins setup
gremlins --home /path/to/my-gremlins setup status --json
```

Quote Windows paths containing spaces: `gremlins --home 'F:\My Projects\my-gremlins' setup`. `setup init --dir PATH` creates configuration relative to the current directory; use `--home PATH` for later commands there.

The **Configuration** editor supports `hub.json` and each project's `project.json`, `areas.json`, and `tiers.json`. Saving validates JSON and schema before atomic replacement. A stale edit reports a conflict and preserves your draft; reload the latest file and reapply the intended changes. Use Connections for tokens; `.env` is not exposed in this editor. The local controller uses saved configuration without a commit or push.

**File locations** shows the installed runtime and configuration directory. Copy either path; local desktop sessions also offer Open folder through Explorer, Finder, or the Linux file manager. On a remote/headless server, paths refer to that server; a browser cannot open a server folder in your laptop's file manager.

Terminal initialization is also available:

```sh
gremlins setup init --project my-app --repo your-org/my-app
```

| Option       | Meaning                                                | Example                                 |
| ------------ | ------------------------------------------------------ | --------------------------------------- |
| `--project`  | Local lowercase folder/command ID                      | `example-com`                           |
| `--repo`     | App under test                                         | `your-org/app`                          |
| `--area`     | Starting PM mandate                                    | `security`                              |
| `--runner`   | Execution mode                                         | `local` (default), `self-hosted`, `gce` |
| `--hub-repo` | Advanced CI automation repository; unnecessary locally | `your-org/automation`                   |

Initialization preserves existing files and creates settings, templates, mandates, and memory. It does not activate PMs. Local configuration needs no `hubRepo` field. Existing installations retain their execution mode: disable old workflow schedules before changing `hub.json` → `runners.mode` to `local`.

## Checks and the first run

```sh
gremlins setup status
gremlins setup --check --json
gremlins doctor my-app
```

`setup status` is read-only. `--check` exits 1 while requirements are missing; an initial **needs setup** result is expected. `doctor` contacts providers and stamps the project verified only on success. Worker verification separately proves Chromium can produce a matching PNG. Neither check certifies your entire app: review the first PM run.

Use generated `projects/PROJECT/.env.example` names for project-specific secrets. Save their values privately in the configuration `.env`, or select a file explicitly with `gremlins --env-file .env doctor my-app`. Automatic connection loading accepts supported keys and does not apply arbitrary entries such as `NODE_OPTIONS`.

The controller reads automation-enabled areas' five-field schedules in **UTC** and considers their approved open tickets. Paused areas are excluded from automatic work; explicit manual runs do not enable them. Each scheduled slot/ticket attempt has an idempotency key. Job duration defaults to 45 minutes; project Run limits can lower it and cap concurrency, UTC daily runs, and runtime. Confirmed pre-execution failures have bounded retries with durable backoff. Ambiguous launches and failed agent work are not blindly replayed. Manual requests for an already queued/running PM or ticket are rejected.

An area's WIP limit includes approved tickets awaiting review: a completed worker job does not close its ticket or free that slot. Failed work also needs review and an explicit retry. Close or otherwise resolve reviewed tickets through the project's lifecycle before expecting later approved tickets to move forward. Never mark a ticket Done merely to free capacity before its production deliverables are merged.

Queue state lives under `.run/local-runners/` in the configuration directory. Restart recovery inspects the existing container before deciding what to do. Docker containers/output volumes retain logs and artifacts independently of the dashboard. Older completed metadata is archived. Back up configuration and Docker storage according to your server's retention policy.

## Server use

For a foreground dashboard on your trusted LAN:

```sh
gremlins setup --lan
```

LAN mode uses port **4311**, prints private IPv4/Tailscale session links, and skips opening a browser on the server. Include `#session=...` on the first visit; the browser removes it after connecting. Keep the link private. This is a private operator dashboard, not a public multi-user service.

Allow inbound TCP 4311 only from your trusted subnet if needed. The CLI does not change firewall rules. LAN mode uses HTTP; do not port-forward it to the internet. `--port 4312` selects another fixed port; `--port 0` selects an available one.

Keep the controller running after closing the terminal:

```sh
gremlins start --lan
gremlins status
gremlins stop
```

Omit `--lan` for loopback-only access. `status` prints the background dashboard link. `stop` stops scheduling and the dashboard; existing Docker jobs continue. Starting again reconciles them. Background start does not install an operating-system boot service.

For encrypted access without a LAN listener, run `gremlins dashboard --no-open --port 4311`. On your laptop, run `ssh -L 4311:127.0.0.1:4311 USER@SERVER_IP`, then open the server's printed loopback session link.

### Restart after a server reboot

On Linux, a systemd user service can supervise the foreground controller. Find the installed commands with `command -v gremlins` and `command -v node`. Use their actual absolute paths below; version-manager installations often live outside the service manager's default PATH.

Save `~/.config/systemd/user/gremlins.service`:

```ini
[Unit]
Description=ShipGremlins local controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=/home/YOUR_USER/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/YOUR_USER/.local/bin/gremlins --home /home/YOUR_USER/.shipgremlins dashboard --lan --port 4311
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Replace `YOUR_USER`, the CLI path, and PATH. Include the directory containing Node. Docker must start with the server and this user must be able to run it. Stop a manually started background dashboard before enabling a service on the same port.

```sh
systemctl --user daemon-reload
systemctl --user enable --now gremlins.service
journalctl --user -u gremlins.service -n 30
```

The private session link appears in this user's service log. For user services without an interactive login, enable lingering with `loginctl enable-linger YOUR_USER` using the host's required permissions. This is manual host configuration, not an automatically installed service. Windows/macOS boot-service installation remains a separate step. Docker jobs do not automatically restart: interrupted agents are reconciled as failed rather than silently replayed after a host reboot.

## Updates and recovery

Use the dashboard's **Updates** panel or the global CLI:

```sh
gremlins update --check
gremlins update
gremlins update --rollback
```

The updater pins an official commit with passing release CI, installs into a separate per-user runtime directory, and verifies startup/configuration compatibility before atomic selection. It does not reinitialize projects, replace credentials, change a Git checkout, or stop Docker jobs. Restart the dashboard to load new code; later CLI commands use the selected release. Original and previous runtimes are retained for rollback.

For an older installation without `update`, stop its dashboard once, repeat the global installation command, and reopen setup. Stop processes using the global installation before a manual reinstall on Windows to avoid locked binaries.

| Result                                         | Next action                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Command not recognized                         | Reopen the terminal. Check `npm config get prefix`: its directory on Windows, or `bin` subdirectory on macOS/Linux, must be on PATH.        |
| Windows `EPERM` on `esbuild.exe`               | Stop this installation's dashboard/watch process and repeat the install. Leave unrelated Node processes alone.                              |
| Runtime missing                                | Finish the global reinstall. Source contributors can repair dependencies with `npm ci`.                                                     |
| Missing Docker or wrong mode                   | Start Docker Desktop/Engine and select Linux containers. Workers are created on the dashboard host.                                         |
| Worker verification failed                     | Inspect its log/evidence, fix Docker/image access, then use Repair. Ready requires matching browser evidence.                               |
| Another runner operation is in progress        | Wait for the image build or queue operation to finish, then retry. Abandoned process locks are recovered without deleting jobs.             |
| Corrupt runner state                           | Keep `.run/local-runners/state.json` and Docker outputs for recovery. The controller refuses to erase/recreate corrupt state automatically. |
| Legacy setup asks for an automation repository | Choose local execution; advanced CI modes still need their operational repository.                                                          |
| Invalid project ID                             | Use a lowercase ID such as `example-com`, not a domain or URL.                                                                              |
| Expired dashboard session                      | Use `gremlins status` for the background link or reopen foreground setup.                                                                   |
| Missing provider settings                      | Complete Configuration and Connections, then rerun doctor before enabling the PM.                                                           |

## Advanced CI installations

Existing `self-hosted`/`gce` GitHub Actions workflows remain available. They still need an automation repository, CI secrets, provider registration, and reviewed schedules. Do not schedule the same project through both CI and the local controller. See [the advanced runner reference](runners.md#advanced-github-actions-and-gce-reference).

Promotion projects have a [Delivery page](DELIVERY_WORKFLOW.md): reviewed drafts can advance to integration, a ready integration deployment triggers owning-PM verification, and verified fixes become selective candidates. Configure a candidate deployment and trusted verification before expecting a staging PR. Keep private signing keys out of PM/developer containers. Production remains an owner merge; automatic reconciliation checks only complete scopes the owner explicitly confirmed. See [verification](VERIFICATION.md) and [Linear lifecycle](LINEAR_LIFECYCLE.md).

Source contributors can use `npm ci` and `node bin/shipgremlins.mjs`. Package-install and helper tests run on Windows, macOS, and Linux CI. These checks do not certify Docker Desktop on every host or a complete live GitHub/GitLab/Vercel/Linear application workflow.
