# Set up ShipGremlins

Install the global CLI with Node.js **22.12+**, npm, and Git:

```sh
npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git
gremlins setup
```

This installs from the public GitHub repository; a registry package named `shipgremlins` is not published yet. The command is `gremlins`; `shipgremlins` and `hub` remain compatibility aliases. Everyday commands do not need a clone, `npm link`, or an `npm run` wrapper.

## Your local setup dashboard

`gremlins setup` opens a private dashboard in your browser with project enrollment, connection-token entry, and gremlins. `gremlins --help` introduces their ASCII cousin.

Enter your GitHub, Linear, Vercel, and optional Claude Code tokens, then add an app by its `owner/repository` and a short local ID such as `my-app`. Review its generated configuration, provider IDs, mandate, and isolated test accounts before enabling agents.

Supported connection keys are saved in the selected configuration directory's `.env`. Subsequent CLI commands load those keys; exported variables take precedence. Blank fields preserve saved values. API responses report only whether a connection is configured; existing tokens are never returned to the browser. Files use owner-only permissions where supported. The local file is not encrypted: keep the directory private and out of Git.

The dashboard defaults to `127.0.0.1` and authenticates with a random session credential in the launch URL fragment. The browser removes the fragment after connecting. Do not share that link. A fresh CLI launch creates a new session; the dashboard's update restart preserves its URL and session. Use the explicit LAN mode below for a homelab; this is a self-hosted setup tool, not a public multi-user service.

GitHub Actions executes agents. Local tokens are not automatically copied to Actions: configure the runner's CI secrets separately. GitLab/Railway adapters, dashboard agent logs, and runner administration remain planned.

## Where configuration lives

The CLI selects configuration in this order:

1. `--home PATH`, or `SHIPGREMLINS_HOME`.
2. The nearest `hub.json` in the current directory or its parents.
3. `~/.shipgremlins` outside a configured hub.

Code and templates stay in the global installation or a staged runtime selected by the updater. Upgrades do not replace your projects, mandates, or connection files.

```sh
gremlins --home /path/to/my-hub setup
gremlins --home /path/to/my-hub setup status --json
```

Quote Windows paths containing spaces: `gremlins --home 'F:\My Projects\my-hub' setup`. `setup init --dir PATH` creates configuration relative to the current working directory; use `--home PATH` for subsequent commands there.

## Why there is an automation repository

The **app repository** contains the software PMs inspect. The **automation repository** stores ShipGremlins configuration and runs the supplied GitHub Actions workflows. The runtime needs its identity to dispatch developers.

You normally do not need `--hub-repo`: setup reuses `hub.json` or detects a GitHub `origin` for a fresh configuration in a Git checkout. The dashboard displays the chosen repository.

```sh
gremlins setup init --project my-app --repo your-org/my-app
```

For a fresh configuration outside any hub checkout, choose the automation repository once:

```sh
gremlins setup init --project my-app --repo your-org/my-app --hub-repo your-org/your-hub
```

Setup does not create the GitHub repository or install workflows remotely. Use your operational fork/checkout and commit reviewed configuration before enabling Actions. When forking a public example, set `hubRepo` in its sample `hub.json` to your fork. Setup rejects a mismatch between a marked sample and Git origin; existing configured hub identities are never silently replaced.

| Option       | Meaning                                                     | Example                |
| ------------ | ----------------------------------------------------------- | ---------------------- |
| `--project`  | Local folder/command ID: lowercase letters, digits, hyphens | `example-com`          |
| `--repo`     | App under test                                              | `your-org/app`         |
| `--hub-repo` | Optional explicit automation repository                     | `your-org/your-hub`    |
| `--area`     | Starting PM mandate                                         | `security`             |
| `--runner`   | Runner mode                                                 | `self-hosted` or `gce` |

Initialization creates `hub.json`, `.gitignore`, empty `.env.example` templates, and `projects/PROJECT/` with settings, areas, tiers, mandate, features, queue, and memory. PMs start disabled and unverified. Repeating initialization preserves existing files; identity conflicts stop before writing. It creates no cloud resources, provider projects, workers, credentials, or schedules.

## Terminal checks and credentials

The dashboard's **Configuration** section edits `hub.json` and each project's `project.json`, `areas.json`, and `tiers.json`. Choose a file, edit its JSON, then save. The server validates settings before replacing the file; invalid JSON or configuration leaves the original intact. If another tab or process changed a file, saving reports a conflict instead of overwriting the newer version. Keep your draft, reload the latest file, and apply the intended changes again.

The editor does not expose `.env`; use Connections for tokens. Changes are saved to this server's configuration, not committed or pushed to GitHub. Review and commit operational configuration before expecting GitHub Actions to use it.

**File locations** shows both the installation directory (the global npm package or source checkout) and configuration directory. Each path can be copied. Local desktop sessions also offer **Open folder**, using Explorer, Finder, or the Linux file manager. Homelab/LAN and headless sessions show server paths with copy controls and the in-browser editor; the browser cannot open a remote server's folder on your laptop.

```sh
gremlins setup status
gremlins setup --check --json
gremlins doctor my-app
```

`setup status` is read-only. `--check` exits 1 for missing requirements. An initial **needs setup** result is expected. Local checks report prerequisites and credential presence, not an online runner or valid token. `doctor` performs live provider checks and stamps the project verified only on success.

The dashboard manages `GITHUB_TOKEN`, `LINEAR_API_KEY`, `VERCEL_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`. Supply other project-specific variables, GitHub App credentials, and verification settings through your shell or an explicit environment file:

```sh
gremlins --env-file .env setup --check --project my-app
gremlins --env-file .env doctor my-app
```

The file path is relative to your current directory. Exported variables take precedence. Automatic loading only accepts supported connection keys; it never applies arbitrary `.env` entries such as `NODE_OPTIONS`. Keep credential values out of command arguments and committed files. Use the generated `projects/PROJECT/.env.example` for the full variable-name list and preserve existing `.env` values.

Promotion requires `SHIPGREMLINS_VERIFICATION_FILE` and the Ed25519 **public** PEM in `SHIPGREMLINS_ATTESTATION_PUBLIC_KEY` on the dispatcher. Keep the private `SHIPGREMLINS_ATTESTATION_KEY` only in a separate trusted signing job. See the [verification guide](VERIFICATION.md).

## First agent run

1. Configure project branches, Vercel IDs, Linear areas, test commands, and mandate.
2. Create isolated staging accounts/data and install the GitHub App on both repositories.
3. Configure CI secrets and register a runner. See [connections](README.md) and [runner operations](runners.md). The current workflow token must cover both repositories under the same GitHub owner.
4. Run `gremlins doctor my-app` with appropriate credentials.
5. Enable the reviewed area, run `gremlins crons write` in the operational hub checkout, and review/commit the schedule.
6. Start a manual PM run. Inspect screenshots, report, checks, and ticket transitions before relying on daily automation.

Self-hosted runners and GCE provisioning have workflow implementations; registration, cloud permissions, and an end-to-end run still need verification. Green local preflight is not a completed agent deployment.

## Server use

To open the dashboard from another device on your homelab network:

```sh
gremlins setup --lan
```

LAN mode uses port **4311**, prints your server's private IPv4 addresses with authenticated session links, and does not try to open a browser on the server. Open a printed link from your laptop or phone. Keep the `#session=...` part for the first visit. The credentials and configuration stay on the server.

Allow inbound TCP 4311 through the server's firewall for your trusted local subnet if needed. The CLI does not change firewall rules. LAN mode uses HTTP: keep it inside a trusted network and do not port-forward it to the internet. `--port 4312` selects another fixed port; `--port 0` chooses an available port. IPv4 private LAN and Tailscale interfaces are discovered automatically.

For encrypted access without exposing a LAN listener, start loopback mode on a fixed port:

```sh
gremlins dashboard --no-open --port 4311
```

On your laptop, run `ssh -L 4311:127.0.0.1:4311 USER@SERVER_IP`, then open the loopback session link printed by the server. Keep the CLI running in the server terminal while using either mode. This command does not install a background service.

The older `gremlins serve` and Docker Compose `hub` service still serve the operator-help page on port 4310. Compose's CLI service can initialize its persistent volume:

```sh
docker compose run --rm cli setup init --hub-repo your-org/your-hub --project my-app --repo your-org/my-app
docker compose run --rm cli setup status --json
```

## Upgrade and troubleshoot

Use **Updates** in the dashboard to check the available version, install it, and restart the dashboard on the same URL. The page stays usable during installation. Unsaved form changes are checked before a restart. You can also use the global CLI:

```sh
gremlins update --check
gremlins update
gremlins --version
```

The updater requires successful CI for the selected official commit, then installs it into a separate, per-user runtime directory under `~/.shipgremlins/runtime`. It checks that the candidate starts and can read your existing configuration before atomically selecting it for future commands. It does not run setup again, reseed PMs, change credentials, pull/reset your operational Git checkout, or stop running GitHub Actions jobs. Failed installation or validation leaves the selected runtime unchanged. The dashboard needs a restart to load the new code; other commands use it on their next launch.

The previous runtime is retained. Use **Roll back** in the dashboard or `gremlins update --rollback` to switch back after a compatibility check. Updates apply to this machine and user; they do not update workflows or code committed in a separate automation repository. Review those changes in your operational fork normally.

For older installations without the update command, stop their dashboard once, repeat the global installation command at the top of this guide, then run `gremlins setup` (or `gremlins setup --lan` on a homelab). Subsequent updates use the staged updater. A manually repeated global npm install replaces the bootstrap installation, so stop its running processes first on Windows.

| Result                            | Next action                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command not recognized            | Reopen the terminal after installing. Check `npm config get prefix`: its directory on Windows, or `bin` subdirectory on macOS/Linux, must be on `PATH`. |
| Install permission error          | Use a user-owned npm prefix or Node version manager. Daily commands do not need administrator access.                                                   |
| Windows `EPERM` on `esbuild.exe`  | Stop that installation's running dashboard/watch process with Ctrl+C and repeat the install. Other checkouts can keep running.                          |
| Runtime missing                   | Finish the global reinstall. Contributors can repair source dependencies with `npm ci`.                                                                 |
| No automation repository detected | Use the configured hub or choose `--hub-repo owner/name` once.                                                                                          |
| Configuration conflict            | Review existing settings or choose a fresh `--home PATH`.                                                                                               |
| Domain/capitals in project ID     | Use a local ID such as `example-com`.                                                                                                                   |
| Expired dashboard session         | Run `gremlins setup` and use the new browser link.                                                                                                      |
| Missing provider IDs/credentials  | Fill project settings and dashboard connections, then rerun checks.                                                                                     |
| Runner unavailable                | Check registration, labels, networking, and the runner guide.                                                                                           |

Source contributors can use `npm ci` and `node bin/shipgremlins.mjs`. The release check `npm run test:package` packs an allowlisted artifact, installs it to an isolated global prefix, and exercises real command shims outside the checkout on Windows, macOS, and Linux CI. Dashboard, updater, credential store, configuration editor, and folder helpers also run on all three CI platforms.
