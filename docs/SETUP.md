# Set up ShipGremlins

Install the global CLI with Node.js **22.12+**, npm, and Git:

```sh
npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git
shipgremlins setup
```

This installs from the public GitHub repository; a registry package named `shipgremlins` is not published yet. Both `shipgremlins` and the shorter `hub` alias work globally. Everyday commands do not need a clone, `npm link`, or an `npm run` wrapper.

## Your local setup dashboard

`shipgremlins setup` opens a private dashboard in your browser with project enrollment, connection-token entry, and gremlins. `shipgremlins --help` introduces their ASCII cousin.

Enter your GitHub, Linear, Vercel, and optional Claude Code tokens, then add an app by its `owner/repository` and a short local ID such as `my-app`. Review its generated configuration, provider IDs, mandate, and isolated test accounts before enabling agents.

Supported connection keys are saved in the selected configuration directory's `.env`. Subsequent CLI commands load those keys; exported variables take precedence. Blank fields preserve saved values. API responses report only whether a connection is configured; existing tokens are never returned to the browser. Files use owner-only permissions where supported. The local file is not encrypted: keep the directory private and out of Git.

The dashboard listens only on `127.0.0.1` and authenticates with a random session credential in the launch URL fragment. The browser removes the fragment after connecting. Do not share that link. Restarting the dashboard creates a new session. This is a local setup tool, not a public multi-user service.

GitHub Actions executes agents. Local tokens are not automatically copied to Actions: configure the runner's CI secrets separately. GitLab/Railway adapters, dashboard agent logs, and runner administration remain planned.

## Where configuration lives

The CLI selects configuration in this order:

1. `--home PATH`, or `SHIPGREMLINS_HOME`.
2. The nearest `hub.json` in the current directory or its parents.
3. `~/.shipgremlins` outside a configured hub.

Code and templates stay in the global installation. Upgrades do not replace your projects, mandates, or connection files.

```sh
shipgremlins --home /path/to/my-hub setup
shipgremlins --home /path/to/my-hub setup status --json
```

Quote Windows paths containing spaces: `shipgremlins --home 'F:\My Projects\my-hub' setup`. `setup init --dir PATH` creates configuration relative to the current working directory; use `--home PATH` for subsequent commands there.

## Why there is an automation repository

The **app repository** contains the software PMs inspect. The **automation repository** stores ShipGremlins configuration and runs the supplied GitHub Actions workflows. The runtime needs its identity to dispatch developers.

You normally do not need `--hub-repo`: setup reuses `hub.json` or detects a GitHub `origin` for a fresh configuration in a Git checkout. The dashboard displays the chosen repository.

```sh
shipgremlins setup init --project my-app --repo your-org/my-app
```

For a fresh configuration outside any hub checkout, choose the automation repository once:

```sh
shipgremlins setup init --project my-app --repo your-org/my-app --hub-repo your-org/your-hub
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

```sh
shipgremlins setup status
shipgremlins setup --check --json
shipgremlins doctor my-app
```

`setup status` is read-only. `--check` exits 1 for missing requirements. An initial **needs setup** result is expected. Local checks report prerequisites and credential presence, not an online runner or valid token. `doctor` performs live provider checks and stamps the project verified only on success.

The dashboard manages `GITHUB_TOKEN`, `LINEAR_API_KEY`, `VERCEL_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`. Supply other project-specific variables, GitHub App credentials, and verification settings through your shell or an explicit environment file:

```sh
shipgremlins --env-file .env setup --check --project my-app
shipgremlins --env-file .env doctor my-app
```

The file path is relative to your current directory. Exported variables take precedence. Automatic loading only accepts supported connection keys; it never applies arbitrary `.env` entries such as `NODE_OPTIONS`. Keep credential values out of command arguments and committed files. Use the generated `projects/PROJECT/.env.example` for the full variable-name list and preserve existing `.env` values.

Promotion requires `SHIPGREMLINS_VERIFICATION_FILE` and the Ed25519 **public** PEM in `SHIPGREMLINS_ATTESTATION_PUBLIC_KEY` on the dispatcher. Keep the private `SHIPGREMLINS_ATTESTATION_KEY` only in a separate trusted signing job. See the [verification guide](VERIFICATION.md).

## First agent run

1. Configure project branches, Vercel IDs, Linear areas, test commands, and mandate.
2. Create isolated staging accounts/data and install the GitHub App on both repositories.
3. Configure CI secrets and register a runner. See [connections](README.md) and [runner operations](runners.md). The current workflow token must cover both repositories under the same GitHub owner.
4. Run `shipgremlins doctor my-app` with appropriate credentials.
5. Enable the reviewed area, run `shipgremlins crons write` in the operational hub checkout, and review/commit the schedule.
6. Start a manual PM run. Inspect screenshots, report, checks, and ticket transitions before relying on daily automation.

Self-hosted runners and GCE provisioning have workflow implementations; registration, cloud permissions, and an end-to-end run still need verification. Green local preflight is not a completed agent deployment.

## Server use

```sh
shipgremlins dashboard --no-open --port 4311
```

The terminal prints a session link. For a remote machine, keep loopback binding and use an SSH tunnel to the same local port. Do not expose the dashboard directly to the internet.

The older `shipgremlins serve` and Docker Compose `hub` service still serve the operator-help page on port 4310. Compose's CLI service can initialize its persistent volume:

```sh
docker compose run --rm cli setup init --hub-repo your-org/your-hub --project my-app --repo your-org/my-app
docker compose run --rm cli setup status --json
```

## Upgrade and troubleshoot

Repeat the global installation command to upgrade, then run `shipgremlins --version`. Stop a running dashboard before upgrading that installation. Configuration is stored separately and preserved.

| Result                            | Next action                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command not recognized            | Reopen the terminal after installing. Check `npm config get prefix`: its directory on Windows, or `bin` subdirectory on macOS/Linux, must be on `PATH`. |
| Install permission error          | Use a user-owned npm prefix or Node version manager. Daily commands do not need administrator access.                                                   |
| Windows `EPERM` on `esbuild.exe`  | Stop that installation's running dashboard/watch process with Ctrl+C and repeat the install. Other checkouts can keep running.                          |
| Runtime missing                   | Finish the global reinstall. Contributors can repair source dependencies with `npm ci`.                                                                 |
| No automation repository detected | Use the configured hub or choose `--hub-repo owner/name` once.                                                                                          |
| Configuration conflict            | Review existing settings or choose a fresh `--home PATH`.                                                                                               |
| Domain/capitals in project ID     | Use a local ID such as `example-com`.                                                                                                                   |
| Expired dashboard session         | Run `shipgremlins setup` and use the new browser link.                                                                                                  |
| Missing provider IDs/credentials  | Fill project settings and dashboard connections, then rerun checks.                                                                                     |
| Runner unavailable                | Check registration, labels, networking, and the runner guide.                                                                                           |

Source contributors can use `npm ci` and `node bin/shipgremlins.mjs`. The release check `npm run test:package` packs an allowlisted artifact, installs it to an isolated global prefix, and exercises real command shims outside the checkout on Windows and Linux CI.
