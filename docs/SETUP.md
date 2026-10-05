# Set up ShipGremlins

Install the global CLI with Node.js **22.12+**, npm, and Git. Workers also need Docker Desktop or Docker Engine running **Linux containers**.

```sh
npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git
gremlins setup
```

This installs from the official GitHub repository; an npm registry package is not published yet. `gremlins` works from any directory on PowerShell, macOS, and Linux. `shipgremlins` and `hub` remain compatibility aliases.

**On a homelab server, use `gremlins setup --lan`.** Open a printed session link from your laptop or phone. Workers, configuration, and connections stay on the server. See [server use](#server-use).

## Your setup dashboard

The sidebar opens separate **Overview**, **Connections**, **Projects**, **Your gremlins**,
**Activity**, and **Settings** pages. Each page has its own address and supports
browser Back/Forward and reload. Moving between pages keeps unfinished forms in
memory; save them before closing or restarting the dashboard.

Overview shows your projects, PM mandates, verified workers, and active jobs.
Connections has category tabs; mobile navigation opens from the menu button.
Your gremlins starts with the launch form, with worker management below. Settings
puts software updates first and keeps files and JSON under advanced configuration.

An update banner appears across the dashboard when a release is available. You
can install from that banner, see installation progress, and restart once the new
runtime is ready. Update details and rollback remain in Settings. A visible open
dashboard checks periodically for new releases; updates are never installed
automatically.

1. Open **Source control** and connect the official GitHub or GitLab app using the displayed device code. Choose the repositories available to your account; GitHub also requires installing the App on the selected repositories. Manual source tokens remain an advanced option. Connect Linear and Claude Code in Connections. Hosting connections are optional. See [source-control setup](SOURCE_CONTROL.md).
2. Add the **app repository** and a short local ID such as `my-app`. When Linear is connected, setup creates an app team and a project for its first PM. Reuse an existing team or choose setup later when needed. [Linear and Vercel connections](LINEAR_VERCEL.md) explains mappings and retry recovery. Local Docker execution is the default. No fork, automation repository, GitHub Actions runner, or GitLab CI runner is required.
3. Review the PR base branch, install/test commands, and PM mandate. New projects default to repository-only verification. For browser work, add a named preview/staging target using a direct URL, Vercel, Railway, or Cloud Run. Keep credentials in Connections. Existing projects have **Edit settings**. See [project and hosting settings](PROJECTS.md).
4. Choose **Create local worker**. The machine is the CLI/dashboard server. The first image build can take time; Ready requires a real Chromium screenshot with verified evidence.
5. Follow the project's remaining setup steps and choose **Verify connections**, or run `gremlins doctor my-app`. Check the PM's Linear mapping and ownership. New PMs start with automation paused; you do not need to edit JSON to try one.
6. Choose **Run once** for a supervised PM investigation. Inspect Activity and its evidence. When ready, choose **Enable automation** for recurring patrols and automatic pickup of approved tickets. A manual Coding run requires an open, approved ticket in the matching Linear project; approval is checked again before launch, even when automation is paused.

Approval uses `pm-approved`; proposals use `pm-proposal`. Area labels remain `pm:core`, `pm:security`, and similar. After the agent's work passes configured checks, the worker publishes its unique branch and opens a **draft** PR or MR targeting the configured base branch. Legacy promotion projects target their integration branch. The agent does not publish directly. The local queue does not merge changes or mark tickets Done.

The dashboard provides pause/resume, browser verification, repair, idle-worker removal, and job logs/artifacts. Pausing lets the current job finish. Removing a busy worker is refused. Multiple PMs share capacity: each worker runs one job at a time. One click creates one worker; the local pool is capped at four.

Optional [project telemetry](TELEMETRY.md) lets PMs read scoped Sentry logs/errors, Datadog logs, and Mixpanel Insights reports. Provider accounts still require live validation.

Connect an optional [Slack channel](SLACK.md) once for PM patrol results, coding drafts ready for review, and blockers from every project. Choose Add to Slack in Connections, or save an incoming webhook when the OAuth broker is unavailable. Projects inherit that channel; leave optional project overrides empty unless a project needs a different channel. Slack is not required to run gremlins. Browser readiness checks do not post messages.

The local runtime prepares a PostgreSQL activity store before launching work. This adds a local Docker service and persistent volume; it is managed on the CLI/dashboard server. Visible tool activity, result summaries, checks, redacted logs, and bounded artifacts appear in the dashboard. Private model reasoning is not stored or displayed. Activity storage failures are separate from the recorded outcome of an already-running job; Docker output remains available.

## Run once and automation are separate

A PM is a saved product mandate. A worker is the Docker capacity that executes
it. Creating one does not implicitly create or enable the other.

| Action                | Result                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run once**          | Queues one PM investigation using saved settings. A paused PM can run when its project and mapping are ready. Its automation state does not change.               |
| **Run Coding**        | Queues work on one open ticket with `pm-approved`, the matching area label, and the PM's Linear project. Manual coding does not require automation to be enabled. |
| **Enable automation** | Allows that PM's UTC patrol schedule and background pickup of its approved tickets while the controller runs.                                                     |
| **Pause automation**  | Stops new scheduled patrols and automatic approved-ticket pickup. It does not cancel an already-running job.                                                      |
| **Pause worker**      | Stops that execution slot accepting more work. It does not change any PM's automation settings.                                                                   |

Use the guided setup actions beside the selected project when something is
missing. Connect source control and Claude Code in Connections; repair the
project's Linear connection, team, or PM mappings in Edit settings; then verify
the project and create or resume a verified worker. Hosting setup is required
only for a selected browser environment. Slack and product signals are optional.
A saved credential, an enabled schedule, and a ready worker are different states.

### Fill a PM draft with AI

Choose **Create PM**, select its project, and describe the investigation in your
own words. **Fill with AI** combines that brief with a bounded view of the
repository's paths to suggest a name, mandate ID, ownership paths, shared
touchpoints, metric, UTC schedule, and WIP limit. Review the rationale and any
warnings, especially when the repository view was truncated.

AI fill uses the saved Claude Code connection and source access, with a disposable
Docker container on your controller. The first request may need to build the
worker image. It reads repository paths, not source-file contents. The first PM
patrol follows the configuration you saved; it does not fill or rewrite ownership.

**Apply suggestions** copies the reviewed fields into the form and preserves your
original mandate. It does not save configuration, create Linear resources, enable
automation, or start work. Choose **Create PM** separately after reviewing the
form. Changes to the selected project or form while a suggestion is pending make
it stale; generate another draft instead of overwriting those edits. You can
always fill in the form manually.

## Connections and configuration

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

The controller reads automation-enabled areas' five-field schedules in **UTC** and considers their approved open tickets. Paused areas are excluded from automatic work; explicit manual runs do not enable them. Each scheduled slot/ticket attempt has an idempotency key. Jobs have a 45-minute execution limit. Failed agent jobs are not automatically replayed; a failure before container launch gets one infrastructure retry. Manual requests for an already queued/running PM or ticket are rejected.

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

Signed staging promotion and explicit production reconciliation remain separate tools. The local queue stops at draft integration PRs/MRs and does not provide automatic promotion or production lifecycle parity. Keep private signing keys out of PM/developer containers. See [verification](VERIFICATION.md) and [Linear lifecycle](LINEAR_LIFECYCLE.md).

Source contributors can use `npm ci` and `node bin/shipgremlins.mjs`. Package-install and helper tests run on Windows, macOS, and Linux CI. These checks do not certify Docker Desktop on every host or a complete live GitHub/GitLab/Vercel/Linear application workflow.
