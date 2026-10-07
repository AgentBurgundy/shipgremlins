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

**On a homelab server, use `gremlins setup --lan`.** Open the private launch link once to set your dashboard password. After setup, bookmark the normal server URL and sign in there. Workers, configuration, and connections stay on the server. See [server use](#server-use).

## Your first adoption

The browser that opens is your private dashboard. Start with **Projects → Add
project**, then choose the path that fits your app:

1. **Give your gremlin a home.** Choose **Improve my app**, connect GitHub or
   GitLab, and select its repository. The secondary experimental idea path can
   create a new private-by-default repository and a reviewed foundation assignment.
2. **Inspect the existing app.** The project introduction offers **Inspect my
   app** and may already be analyzing when source access and Claude Code are
   ready. The Setup Gremlin reads bounded source at an exact commit and suggests
   checks and a first investigator. Review its evidence and open questions.
3. **Confirm the setup you reviewed.** Select the suggested install, test, lint,
   typecheck, or build commands you want to save, then choose **Confirm setup**.
   Unselected settings stay as they were. This does not execute commands or prove
   the app runs. If the source changed, inspect it again before confirming.
4. **Meet and adopt your gremlin.** Choose **Meet [name]**, review its job and
   brief, and adopt it. You can choose a different gremlin or write your own brief.
   Explain who it helps, what should get better, and what it should leave alone.
5. **Give the crew a place to work.** The welcome screen offers **Connect Linear**
   when the account is missing, or **Set up Linear** when it is already connected.
   Choose an existing team when there is more than one; ShipGremlins creates the
   missing PM projects and labels and keeps existing mappings. Authorization
   returns you to this project's setup.
6. **Connect a test environment.** For a runnable app, the next step opens
   Environment. **Connect Vercel** signs in and resumes preview discovery and
   testing automatically. Other hosting and Docker remain available. Once the
   test target is selected, you can add optional Sentry, Mixpanel or Datadog
   context. Read-only Discovery does not receive telemetry credentials.
7. **Give it a first assignment.** Choose **Explore the codebase** to run
   **Discovery**, or **Prepare first mission** if source access, Claude Code, or
   a ready worker is missing. Linear and a browser environment are not required. A new idea instead
   starts with the reviewed **foundation build**: a Coding Gremlin creates the
   initial app and tests. Review and merge that work before asking PMs to explore.

Adoption saves the PM and its brief. It does not start a job or turn on automation.
When ready, use **What should get better?** on the project home to start an
[improvement mission](IMPROVEMENT_MISSIONS.md). This explicitly starts investigation
and asks you to review a bounded proposal before coding begins.
Connect only what the next assignment needs. Save a Linear connection for
proposals and approved coding work; adoption or a later PM run prepares missing
team/project mappings and routing labels using the selected account. Existing
mappings are kept. Missing permissions are shown without losing the adopted PM.
A browser environment is needed for a runnable app's browser walkthroughs.
Slack and product signals can wait.

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
2. In **Projects → Add project**, choose **Improve my app**. Follow **Inspect your app → Review setup → Meet your gremlin**. Importing can start bounded source analysis, but creates no PM or coding job; confirming saves only the selected commands. Manual adoption remains available if you already know the setup. The experimental idea path creates a private-by-default repository and starts with the reviewed foundation build before source discovery. See [idea onboarding](IDEA_TO_APP.md) or [your first adoption](#your-first-adoption).
3. Adopt the suggested PM or choose another with a focused **Product brief**. Its welcome guides you through connecting Linear, creating missing PM projects and labels, and connecting a test environment. These steps also remain on the project home if you close the welcome. New PMs start with both automation controls off.
4. Choose **Create local worker**, then **Explore the codebase** for Discovery. The worker runs on the CLI/dashboard server; its first image build can take time. Worker readiness requires actual Chromium evidence, but the PM's source-only Discovery needs no app hosting or Linear mapping.
5. **Connect a test environment** for browser walkthroughs. Environment offers **Connect Vercel** even on a fresh installation, then resumes automatic preview setup after authorization. You can also choose another hosted target or a disposable Docker app. Code-only Discovery remains available while setup is incomplete. For a fresh idea, build and merge the foundation first. Keep test-account and app-input values in Connections. See [project onboarding](PROJECT_ONBOARDING.md).
6. After reviewing Discovery, use **What should get better?** for a mission tied to one outcome, or **Run now** for one normal patrol. Required Linear setup uses your saved connection and preserves existing mappings. Inspect the proposals and evidence before approving coding. Enable **Look for new improvements** and **Automatically build approved work** independently when ready. Manual Coding can find the next ready approved ticket without turning either on.

Approval uses `pm-approved`; proposals use `pm-proposal`. Area labels remain `pm:core`, `pm:security`, and similar. Project Review lets you inspect a proposal and explicitly approve its bounded scope. The controller removes the proposal hold and re-checks the current scope before approving. After configured checks, the worker publishes its unique branch as a **draft** PR/MR. Repository-only projects leave merges to you. Explicit promotion projects target their integration branch and can advance eligible fixes for owning-PM verification; see [selective delivery](DELIVERY_WORKFLOW.md).

The dashboard provides pause/resume, browser verification, repair, idle-worker removal, and job logs/artifacts. Pausing lets the current job finish. Removing a busy worker is refused. Multiple PMs share capacity: each worker runs one job at a time. One click creates one worker; the local pool is capped at four.

Optional [project telemetry](TELEMETRY.md) lets PMs read scoped Sentry logs/errors, Datadog logs, and Mixpanel Insights reports. Provider accounts still require live validation.

Before the first browser patrol, **App sign-in** asks whether your gremlin should
use a dedicated test account or test **public pages only**. Connecting Vercel
opens the preview; it does not sign into your app. An unanswered choice stays
visible as a setup step, including after adoption. Code-only Discovery can run
while you finish this step.

For signed-in work, create a dedicated identity in your test app and configure
[test accounts](TEST_ACCOUNTS.md). Password values go in Connections, never the
secret-reference fields. Saving credentials makes the setup available; use
**Test environment** to check that login actually works. Explicit public-only
patrols cannot verify account features. The current guided checker does not
complete email-code, magic-link, MFA, or external SSO flows.

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

| Action                                | Result                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discovery**                         | Investigates the checkout and saves learned context. Requires source, Claude, and a ready worker; no Linear or hosting setup, ticket creation, or automation change.            |
| **Run now**                           | Queues one PM investigation using saved settings. A paused PM can run when its project and mapping are ready. Its automation state does not change.                             |
| **Start coding**                      | Queues work on one open ticket with `pm-approved`, finite acceptance criteria, the matching area label, and the PM's Linear project. Manual coding does not require automation. |
| **Look for new improvements**         | Enables that PM's UTC patrol schedule. This is independent of approved-ticket pickup.                                                                                           |
| **Automatically build approved work** | Enables background pickup of eligible approved tickets while the controller runs. This is independent of patrols.                                                               |
| **Turn either control off**           | Stops new work for that automation. It does not cancel already-running jobs; use Activity to cancel a run.                                                                      |
| **Pause worker**                      | Stops that execution slot accepting more work. It does not change any PM's automation settings.                                                                                 |

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

An area's WIP limit includes approved tickets in delivery: a completed worker job does not close its ticket or free that slot. In the promotion workflow, reproducible PM QA failures return to coding automatically, with at most one automatic coding repair per original change. Failed runs, infrastructure blockers and exhausted repairs remain visible for review. Close or otherwise resolve tickets through the project's lifecycle before expecting later approved tickets to move forward. Never mark a ticket Done merely to free capacity before its production deliverables are merged.

Queue state lives under `.run/local-runners/` in the configuration directory. Restart recovery inspects the existing container before deciding what to do. Docker containers/output volumes retain logs and artifacts independently of the dashboard. Older completed metadata is archived. Back up configuration and Docker storage according to your server's retention policy.

### Put runner workspaces on a storage drive

On a Linux controller using its local Docker Engine, you can move **new job
workspaces** off the system disk. Repository checkouts, dependencies, and private
agent home directories then live on the dedicated mounted drive. Save
`runner-storage.json` in the configuration directory (normally `~/.shipgremlins/`):

```json
{
  "workspaceRoot": "/mnt/storage/shipgremlins/workspaces"
}
```

Mount the drive first, then create this dedicated directory with owner UID 1000
and permissions `0700`. The controller or enrolled worker process must also run
as UID 1000, matching the runner's container user. This requirement applies only
to opt-in external storage; default Docker storage is unchanged. For example:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /mnt/storage/shipgremlins/workspaces
```

Use an absolute directory without symbolic links. Configure the mount to be
available after reboot before starting the controller. Do not point this setting
at your home, configuration, or source repository directory. Windows, macOS,
Docker Desktop, and remote Docker endpoints use their existing Docker storage;
this opt-in setting requires a Linux controller and a local Docker Engine that
can read the exact host directory. Each enrolled remote worker reads its own
`runner-storage.json` from its worker home, normally
`~/.shipgremlins/worker/runner-storage.json`.

Each job receives its own directory mounted at `/work`; browser reviews use a
separate directory. ShipGremlins checks that the directory is private, writable
by the runner, visible to Docker, and has at least **5 GiB free** before starting
work. This is a starting-space check, not a quota or a guarantee that a large
build will fit. Storage admission failures show the required action and do not
retry automatically. Fix the mount, permissions, or free space, then start a new
run; the failed run stays in history.

This setting does not move existing containers or jobs, Docker images and build
cache, output/evidence volumes, or the activity database. Keep sufficient space
on Docker's own storage disk too. Removing the optional configuration restores
the default Docker workspace behavior for future jobs.

Job directories remain on the drive after success, failure, or cancellation;
there is **no automatic workspace purge**. They can contain unpublished code and
private agent files. Back them up and review completed jobs before removing
their directories as part of your own retention policy. Never remove a directory
used by an active job, and retain required logs, evidence, configuration, and
database backups separately. Cleaning unused Docker images does not clean these
workspaces or constitute a backup.

## Server use

For a foreground dashboard on your trusted LAN:

```sh
gremlins setup --lan
```

LAN mode uses port **4311** and skips opening a browser on the server. Open the private launch link once to prove you own the installation and set a dashboard password. The browser removes the launch credential from the address bar. Someone who only knows the server URL cannot claim an unconfigured dashboard.

After setup, open the normal URL, such as `http://192.168.1.3:4311`, and sign in with your password. Use at least 8 characters; a memorable passphrase works well. **Remember this device** keeps that browser signed in for up to 30 days across tabs and browser or controller restarts. Otherwise, the server session expires after eight hours and the browser uses a session cookie. You can revoke either kind of session sooner. Passwords and browser session tokens are not stored in browser local storage. This is one operator account for your installation, not a multi-user account system.

Use **Account access** to change the password, sign out, or revoke remembered devices. Changing the password revokes existing browser sessions. Sign-out does not stop your workers or queued jobs. Keep your private CLI launch link protected: it remains an owner credential for local administration.

Forgotten password? On the server, run `gremlins dashboard --reset-password`, then `gremlins status` and open the existing controller's private owner link to set a new password. The reset command exits without starting another dashboard. It revokes all browser sessions and clears the trusted-LAN HTTP choice; projects, provider connections and running jobs remain intact. If the controller is stopped, start it normally before opening its owner link.

### Choose the connection security

Password sign-in is available over HTTPS and loopback HTTP by default. A trusted private LAN can explicitly opt into HTTP during owner-authorized setup. This choice is off by default and is limited to private-network connections; public HTTP password sign-in is not supported.

HTTP does not encrypt passwords or session cookies. A password prevents unauthenticated dashboard access, but someone able to observe or alter LAN traffic could steal that access. Use HTTPS or an SSH tunnel on a shared or untrusted network. Enabling **Remember this device** does not change this transport limitation.

For HTTPS, terminate TLS with a reverse proxy on the same server and forward to the loopback dashboard. Start the controller with `SHIPGREMLINS_DASHBOARD_URL` set to its exact HTTPS origin, for example `https://gremlins.example.com`, and preserve the original Host header. Configuring this HTTPS origin disables password sign-in through the old plain-LAN HTTP address. ShipGremlins does not infer a trusted public origin from forwarded headers. Certificate issuance, DNS and proxy installation remain your hosting configuration.

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
| Expired dashboard session                      | Sign in again at the normal dashboard URL. The CLI launch link remains available for owner access.                                          |
| Missing provider settings                      | Complete Configuration and Connections, then rerun doctor before enabling the PM.                                                           |

## Advanced CI installations

Existing `self-hosted`/`gce` GitHub Actions workflows remain available. They still need an automation repository, CI secrets, provider registration, and reviewed schedules. Do not schedule the same project through both CI and the local controller. See [the advanced runner reference](runners.md#advanced-github-actions-and-gce-reference).

Promotion projects have a [Delivery page](DELIVERY_WORKFLOW.md): the controller checks and integrates coding drafts, a ready deployment triggers owning-PM QA, failed acceptance criteria return to coding, and verified fixes become a combined staging promotion PR after assembled checks. An explicitly configured candidate browser verifier adds another required gate. Keep private signing keys out of PM/developer containers. Production remains an owner merge; automatic reconciliation checks only complete scopes the owner explicitly confirmed. See [verification](VERIFICATION.md) and [Linear lifecycle](LINEAR_LIFECYCLE.md).

Source contributors can use `npm ci` and `node bin/shipgremlins.mjs`. Package-install and helper tests run on Windows, macOS, and Linux CI. These checks do not certify Docker Desktop on every host or a complete live GitHub/GitLab/Vercel/Linear application workflow.
