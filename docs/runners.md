# Runners — self-hosted now, GCE one setting away

Every hub workflow (`pm-agent`, `pm-dispatch`, `developer`) is three jobs:
`launch` → `run` → `teardown`. `launch` runs
`npx tsx src/runners.ts resolve --run-label pm-<run id> [--project <name>]`
(`src/runners.ts`) and that decides everything:

| `hub.json` → `runners.mode` | `launch` / `teardown`                                                             | `run` targets                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `self-hosted` (v1 default)  | no-ops on `ubuntu-latest` (`echo skipped`)                                        | `["self-hosted", <hub.runners.label>]`, or `["self-hosted", <project.runnerLabel>]` when that is set |
| `gce`                       | creates / deletes an ephemeral VM carrying a JIT runner registration for this run | `["pm-<run id>"]` — the label only that VM carries                                                   |

`pm-agent.yml` fans out over a matrix of `(project, area)` pairs, so its
`plan` job resolves the runner per pair and carries the result in the
matrix (matrix jobs cannot share outputs); the other two use `launch`'s
outputs directly.

Developer and PM runs have `timeout-minutes: 300`; the dispatcher 20.

## Self-hosted (v1)

Register one runner (or several) to the **hub repo** — never to a target —
with the label from `hub.json` (`pm`):

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL -o runner.tgz https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz
tar -xzf runner.tgz
./config.sh --url https://github.com/<owner>/pm-hub --token <registration token from Settings → Actions → Runners → New self-hosted runner> \
  --labels pm --name <machine>-pm --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```

A project that needs a different box sets `"runnerLabel": "<label>"` in its
`project.json`; the runner registered with that label takes its jobs.

### Toolchain the runner needs

The `run` jobs install what they can (`npm ci`, the Claude Code CLI if
missing, the pinned Playwright MCP server and its Chromium); the machine
must provide the rest. The list below matches what `runner-image/packer.pkr.hcl`
bakes into the GCE image, so a self-hosted box and a GCE VM behave the same:

| Need                              | Why                                                                                                     | Install (Ubuntu 24.04)                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Node 22, npm                      | the hub (`tsx`), the targets' `commands.install/test`                                                   | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs`                    |
| git                               | both checkouts, the developer's branches, the PM's memory branch                                        | `sudo apt-get install -y git`                                                                                             |
| GitHub CLI (`gh`)                 | the prompts open PRs and comment with it; `launch` mints JIT configs with it                            | <https://github.com/cli/cli/blob/trunk/docs/install_linux.md>                                                             |
| curl, jq, build-essential, python | API calls in the prompts; native npm modules in targets                                                 | `sudo apt-get install -y curl jq build-essential python3`                                                                 |
| Playwright Chromium + OS deps     | the PM drives a real browser (`@playwright/mcp`); the OS libraries need root once, the browser does not | `sudo npx -y playwright@1.49.0 install-deps chromium` (deps, once); the job runs `npx playwright install chromium` itself |
| Claude Code CLI                   | `claude -p` is the agent                                                                                | `npm i -g @anthropic-ai/claude-code` (the job installs it when missing; a global install saves a minute per run)          |

The runner's user needs write access to its home (`~/.claude.json` is where
the jobs mark the workspaces trusted) and enough disk for two checkouts plus
the targets' `node_modules` (50 GB is comfortable).

Secrets never live on the runner: `CLAUDE_CODE_OAUTH_TOKEN`, `APP_ID`,
`APP_PRIVATE_KEY`, `LINEAR_API_KEY`, `VERCEL_TOKEN`, `SLACK_WEBHOOK_<NAME>`
and `VERCEL_BYPASS_<NAME>` are hub Actions secrets and arrive per job. Jobs
fail loudly when `CLAUDE_CODE_OAUTH_TOKEN` is empty or `ANTHROPIC_API_KEY`
is set anywhere in the environment (subscription billing, enforced).

### The GitHub App's permissions

The PM Hub app needs, on every **target**: contents write, pull requests
write, issues write, checks read, actions read, metadata read. On the
**hub repo** itself it additionally needs **actions: write** (the dispatcher
fires `developer.yml` with the same installation token) and, for GCE mode
only, **administration: write** (minting JIT runner registrations). The
`pm-agent` and `pm-dispatch` workflows mint ONE installation token covering
the hub and the targets, which requires the app to be installed on the hub
repo and on every target under the same GitHub owner.

## The GCE switch

Three `hub.json` fields turn ephemeral VMs on:

```json
{
  "runners": { "mode": "gce", "label": "pm" },
  "gce": {
    "project": "<gcp project id>",
    "zone": "us-central1-a",
    "image": "pm-runner",
    "machineType": "e2-standard-4",
    "spot": false
  }
}
```

- `runners.mode` — `"gce"` makes `launch` create a VM and `run` target
  `pm-<run id>`.
- `gce.project` / `gce.zone` / `gce.image` / `gce.machineType` — where and
  from what the VM is created. `gce.image` is an image **family**;
  `make-runner-image.yml` publishes `<image>-<timestamp>` into it so the
  newest build is used automatically.
- `gce.spot` — `true` creates Spot VMs (`--provisioning-model=SPOT`,
  terminated → deleted). A preempted run shows up as a failed job and the
  dispatcher's heal re-fires it once.

### One-time GCP setup (Workload Identity Federation)

The hub authenticates to GCP with its OIDC token — no service-account key
in secrets. Replace `<gcp project>`, `<owner>` and `<project number>`:

```bash
gcloud config set project <gcp project>
gcloud services enable compute.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

# a service account that may create and delete runner VMs
gcloud iam service-accounts create pm-hub-runner --display-name "pm-hub runner launcher"
gcloud projects add-iam-policy-binding <gcp project> \
  --member "serviceAccount:pm-hub-runner@<gcp project>.iam.gserviceaccount.com" \
  --role roles/compute.instanceAdmin.v1
gcloud iam service-accounts add-iam-policy-binding \
  "$(gcloud iam service-accounts list --filter 'email ~ ^<gcp project>-compute@' --format 'value(email)')" \
  --member "serviceAccount:pm-hub-runner@<gcp project>.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountUser

# the pool + provider that trusts this hub repo's GitHub OIDC tokens
gcloud iam workload-identity-pools create github --location global --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc pm-hub \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository == '<owner>/pm-hub'"
gcloud iam service-accounts add-iam-policy-binding \
  pm-hub-runner@<gcp project>.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/github/attribute.repository/<owner>/pm-hub"
```

Then two **repository variables** on the hub (Settings → Secrets and
variables → Actions → Variables):

| Variable                         | Value                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project number>/locations/global/workloadIdentityPools/github/providers/pm-hub` |
| `GCP_SERVICE_ACCOUNT`            | `pm-hub-runner@<gcp project>.iam.gserviceaccount.com`                                      |

The three workflows' `launch`/`teardown` jobs already carry
`id-token: write` (job-level), which is what lets them present the OIDC
token; in self-hosted mode the auth step is skipped and no token is minted.

### Build the image

`make-runner-image.yml` (manual, `workflow_dispatch`) runs Packer against
`runner-image/packer.pkr.hcl`: Ubuntu 24.04 + the toolchain table above +
the Actions runner unpacked under `/opt/runner`, published into the
`gce.image` family. Needs `gce.project` set and the WIF variables above.
Re-run it to pick up a newer Node, Chromium, Claude Code or runner; the
next `launch` uses the newest image in the family.

Locally, the same build is:

```bash
cd runner-image && packer init packer.pkr.hcl && \
  packer build -var project=<gcp project> -var zone=us-central1-a -var image_name=pm-runner packer.pkr.hcl
```

### What a run does in GCE mode

1. `launch` (`ubuntu-latest`): authenticates with WIF, mints a JIT runner
   config for the hub repo
   (`POST /repos/<owner>/pm-hub/actions/runners/generate-jitconfig`, label
   `pm-<run id>`), and creates the VM from the image with the config and
   `self-destruct-minutes` (job timeout + 15) in metadata, and
   `runner-image/startup.sh` as the startup script.
2. The VM boots, `startup.sh` starts the runner with the JIT config (one job,
   then it de-registers), the `run` job lands on it.
3. `teardown` (`always()`) deletes the VM. If it never runs, the VM deletes
   itself at the deadline, or right after its one job — whichever comes first.

### Cost

| Runner                        | Hourly (us-central1, on-demand, Oct 2026) | A 5-hour developer run | Notes                                                       |
| ----------------------------- | ----------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| Self-hosted (your box)        | $0                                        | $0                     | electricity + a machine that is on; holds a slot for hours  |
| GCE `e2-standard-4` (4 vCPU)  | ≈ $0.13                                   | ≈ $0.67                | the spec's estimate; billed per second, deleted at teardown |
| GCE `e2-standard-4` Spot      | ≈ $0.04                                   | ≈ $0.20                | can be preempted; heal re-fires once                        |
| GCE `e2-standard-8`           | ≈ $0.27                                   | ≈ $1.34                | for targets whose test suite needs the cores                |
| GitHub-hosted `ubuntu-latest` | included (public) / $0.008 per minute     | ≈ $2.40 (private)      | `launch`/`teardown`/`plan` only — a few minutes per run     |

Plus ≈ $0.04 per GB-month for each image in the family (50 GB → ≈ $2/month
per image; delete old ones). v1 ships the switch, the docs and the
template; the live GCE path is milestone 4 and has not been exercised yet.
