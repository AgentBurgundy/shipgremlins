# Run ShipGremlins locally

ShipGremlins currently runs PM and developer jobs through GitHub Actions, with Vercel previews and Linear tracking. The local CLI creates configuration and checks prerequisites. The public source distribution serves a small local operator-help page. The full marketing site is maintained separately. It does not run a second scheduler or provide dashboard secret management.

GitLab CI and Railway adapters are planned. They are not selectable as working integrations yet. Self-hosted GitHub runners and GCE provisioning already have workflow implementations; a specific installation still needs its credentials, registration, and an end-to-end run verified.

Run commands from the cloned repository's directory, where `package.json` and `bin/` exist. `npm ci` installs this project's dependencies; it does **not** install a global `hub` command. Use `npm run hub -- ...` or `node bin/shipgremlins.mjs ...` in PowerShell, macOS, and Linux. No global install or `npm link` is necessary.

```sh
npm ci
npm run hub -- setup --help
npm run hub -- setup --check
```

An initial failed preflight is expected until you enroll a project and supply provider IDs and credentials. It prints a checklist and does not start an agent.

## Choose the three setup names

| Option       | Meaning                                                                                                             | Example                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `--project`  | Local project ID used in folders and commands. Lowercase letters, digits, and hyphens; not a website domain or URL. | `my-app` (`Example.com` could use `example-com`) |
| `--repo`     | Existing source repository of the application you want PMs to inspect.                                              | `your-org/my-app`                                |
| `--hub-repo` | Repository that contains your ShipGremlins configuration and runs its GitHub Actions workflows.                     | `your-org/your-hub`                              |

The application and automation hub are different roles. Cloning the public source does not create your operational hub repository or enroll an application.

If the clone contains a sample `hub.json`, review its `hubRepo` before initialization. Setup never replaces an existing hub identity automatically. To use a different repository in this checkout, edit **only the intended settings** in `hub.json` first, then pass the matching `--hub-repo`. A public example requires this flag explicitly so the source repository is not silently treated as your operational hub. To evaluate without editing the sample or existing configuration, use the isolated-directory example below.

When the operational hub identity has been chosen:

```sh
npm run hub -- setup init --project my-app --repo your-org/my-app --hub-repo your-org/your-hub
```

## Start the local site

From a checkout with Node.js 22.12 or newer:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4310>. The default listener is local to your machine. The application server is a static site, not an authenticated administrative dashboard.

Or, on a server with Docker Engine and Compose:

```sh
docker compose up --build -d hub
```

The Compose service binds `127.0.0.1:4310`, uses a non-root user, has a read-only root filesystem, and restarts after a host reboot. Its health check requests the home page. The image contains code and public templates, excluding the checkout's `hub.json`, private project directories, `.env` files, Git history, and run output. The named `shipgremlins-data` volume holds configuration created through the separate CLI service. The site mounts that volume read-only.

To inspect the container:

```sh
docker compose ps
docker compose logs hub
docker compose run --rm cli setup --json
```

The site container is not a browser runner. Agent execution still happens in the configured GitHub Actions runners. For remote access, place the site behind your own HTTPS reverse proxy, or use an SSH tunnel to the loopback port. No cloud deployment or public domain is created by setup.

## Inspect without changing anything

```sh
node bin/shipgremlins.mjs setup
node bin/shipgremlins.mjs setup --check --json
```

`setup` and `setup status` are read-only. They check the actual local Node version and bounded `--version` probes for Git, npm, Docker, and Claude. Node 22.12 or newer, Git, and npm are required for local setup. Docker and Claude on the control machine are optional; Claude must be available on the agent runner. GCE configuration also checks its project field and probes `gcloud`.

Preflight validates configuration, reports placeholder IDs, and lists credential **names and presence only**. It does not contact providers, read `.env` automatically, verify worker capacity, or prove that a token works. `--check` exits with status 1 if a required local check fails, while normal status returns 0 after producing the report. `ready: true` means ready for live checks; it does not certify the deployment.

## Initialize an isolated configuration

Use an explicit destination while evaluating the software. Existing repository and project files are never overwritten:

```sh
node bin/shipgremlins.mjs setup init --dir .run/my-hub --hub-repo your-org/your-hub --project my-app --repo your-org/my-app
```

This creates:

```text
.run/my-hub/
  hub.json
  .env.example
  .gitignore
  projects/my-app/
    .env.example
    project.json
    areas.json
    tiers.json
    core/mandate.md
    core/features.md
    core/queue.md
    core/memory.md
```

Choose a starting PM with `--area security` or another lowercase name. Add `--runner gce` for the existing GCE workflow path, and `--runner-label pm` to choose the self-hosted runner label. GCE's project, image, zone, IAM, and identity federation must still be configured.

New PMs start disabled and projects remain unverified. Setup creates no remote branches, repositories, Linear projects, credentials, workers, schedules, or cloud resources. Its printed checklist tells you which fields to fill next.

Rerunning the same command preserves customized mandates and settings. A different hub repository, project repository, area, or explicitly requested runner setting conflicts with existing configuration and exits before writing. Invalid existing configuration also blocks initialization. Existing `.env` and `.env.example` files are preserved. Parent traversal, invalid portable names, and symbolic links in output paths are rejected. There is intentionally no `--force` flag.

`SHIPGREMLINS_HOME` chooses the configuration directory for CLI commands. For example, on macOS/Linux:

```sh
export SHIPGREMLINS_HOME="$PWD/.run/my-hub"
node bin/shipgremlins.mjs setup --check --project my-app
```

On PowerShell:

```powershell
$env:SHIPGREMLINS_HOME = (Resolve-Path .run/my-hub).Path
node bin/shipgremlins.mjs setup --check --project my-app
```

The code and templates still come from the installation directory. An isolated configuration is not a complete copy of the hub repository. Before enabling scheduled execution, review and place its `hub.json` and `projects/my-app/` into the hub repository that will run the supplied GitHub workflows. Do not replace an existing operator's configuration without reviewing it. Run schedule-writing commands from that actual hub checkout with `SHIPGREMLINS_HOME` unset, or pointing to the checkout. The workflows load committed configuration from their own checkout.

For Docker, initialize its named volume:

```sh
docker compose run --rm cli setup init --hub-repo your-org/your-hub --project my-app --repo your-org/my-app
docker compose run --rm cli setup --json
```

The configuration lives at `/data`. Export it for review with `docker compose cp hub:/data ./shipgremlins-config`. The named volume persists across `docker compose down`; `down --volumes` deletes it. The image and Compose service do not back up this volume automatically.

## Connect the first app

1. In `project.json`, set the actual Vercel project and optional team IDs; confirm production, staging, and integration branches. Set install, test, lint, and type-check commands for the application's own stack. Select the correct database recipe; the template's Neon integration is an example, not a requirement for every web app.
2. In `areas.json`, set the Linear project ID, ownership paths, schedule, and WIP limit. Review the mandate, forbidden actions, and test identities. Keep PMs disabled until the environment is ready.
3. Install the GitHub App on the hub and target repositories, configure isolated `pm-staging` previews and test data, and register a runner. See [connection setup](README.md) and [runner operations](runners.md). The current workflow token must cover both repositories under the same GitHub owner.
4. Add the environment variables listed in `projects/my-app/.env.example` to the appropriate local or CI secret store. This project-specific template includes its Slack webhook and Vercel bypass variable names even when the clone already contained a shared `.env.example`. Existing templates are preserved. App sign-in recipes may require a separate preview database variable.
5. Run local preflight, then `npm run hub -- doctor my-app` with exported credentials, or the explicit `.env` command below, for live branch, Vercel, Linear, and credential checks. Doctor stamps the project verified only after its checks pass. It does not complete the full first-agent acceptance test.
6. Explicitly enable the reviewed area in `areas.json`, run `npm run hub -- crons write` in the configured hub repository, and review/commit the generated workflow schedule. Start a manual PM run first and inspect its real screenshots, report, checks, and resulting ticket transitions before relying on daily automation.

The launcher is available as `node bin/shipgremlins.mjs ...` or `npm run hub -- ...`; an npm-linked install also provides `hub` and `shipgremlins`. It uses the locally installed `tsx` runtime and never downloads another package implicitly.

For local credentials, create an ignored `.env` from the project's `.env.example`, fill in its values, and pass it explicitly. Preserve an existing `.env`; initialization does not read, replace, or populate it. On PowerShell, the following copy is safe to repeat:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath projects/my-app/.env.example -Destination .env }
```

For an isolated configuration, prefix the template path with that configuration directory (for example `.run/my-hub/projects/my-app/.env.example`). If `.env` already exists, add any missing variable names from the project template without replacing its existing values. Edit `.env` locally using your preferred editor, then:

```sh
node --env-file=.env bin/shipgremlins.mjs setup --check --project my-app
node --env-file=.env bin/shipgremlins.mjs doctor my-app
```

`--env-file` is a **Node option**, so it appears before `bin/shipgremlins.mjs`. `npm run hub -- setup --check` by itself reads only variables already exported into the process. Existing exported variables take precedence over `.env`; if an old exported token is being used, clear or correct that specific variable before retrying. Never paste credential values into chat, command arguments, or repository files other than your ignored local secret file.

For a container check, export the credentials in your shell and pass only their names:

```sh
docker compose run --rm -e GITHUB_TOKEN -e LINEAR_API_KEY -e VERCEL_TOKEN -e SLACK_WEBHOOK_MY_APP -e VERCEL_BYPASS_MY_APP cli setup --check --project my-app
```

Compose's ordinary `.env` interpolation file does not automatically inject all of its values into containers. Keep secret values out of command arguments and use your deployment secret manager for unattended operation.

Never pass credentials as setup flags. The CLI accepts provider identifiers and secret variable names in configuration, not credential values. The current workflow uses `CLAUDE_CODE_OAUTH_TOKEN`; other model providers and dashboard-managed AI connections remain roadmap work.

Promotion also requires signed verification evidence. Set `SHIPGREMLINS_VERIFICATION_FILE` and the Ed25519 **public** PEM in `SHIPGREMLINS_ATTESTATION_PUBLIC_KEY` on the dispatcher. The private PEM, `SHIPGREMLINS_ATTESTATION_KEY`, belongs only in a separate trusted signing job. Do not give it to PMs, developers, or application build jobs. Follow the [verification guide](VERIFICATION.md) to generate and validate evidence for the exact candidate revision.

## When setup stops

| Result                                     | Next action                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Existing configuration conflicts           | Use a fresh `--dir`, or deliberately edit the existing file after review. Setup will not replace it. |
| `hub` is not recognized                    | Run `npm run hub -- ...` from the cloned repository. `npm ci` does not install global commands.      |
| Project name contains a domain or capitals | Choose a lowercase local ID, such as `example-com`, and reuse that ID in later commands.             |
| Vercel/Linear placeholders                 | Fill `project.json` and `areas.json`, then rerun preflight.                                          |
| Missing environment variables              | Supply them to the process/CI secret store; an `.env` file is not auto-loaded.                       |
| Runner unavailable                         | Verify GitHub registration, labels, networking, and runner toolchain using the runner guide.         |
| GCE project missing                        | Fill `gce.project` and complete image/identity setup before selecting cloud execution.               |
| GitLab/Railway requested                   | The current adapter set cannot run this stack; follow the roadmap instead of labeling it connected.  |

Initialization and inspection are safe to repeat. Enabling CI jobs, merging changes, and provisioning runners remain explicit operational steps; the setup command does not perform them.
