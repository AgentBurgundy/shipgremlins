# Projects, environments, and connections

ShipGremlins can work on a repository without a hosted web app. Hosting is optional. Source control, Linear, and the AI runtime still need the access required by the job you request.

Run `gremlins setup`, or `gremlins setup --lan --port 4311` on a server. In **Projects**, choose your GitHub or GitLab repository, review its commands, and select how to verify work. Existing projects have an **Edit settings** button. Connections holds credentials; project settings hold resource IDs and credential variable names.

Choose a project's name in the sidebar to open its own workspace. Its PMs,
setup actions, launch controls, and settings stay scoped to that repository.
Open a PM to edit its owner brief and read the knowledge produced by its runs.

Use **Delete project** or a PM's **Delete PM** control to retire local
configuration. Confirm the reviewed identifier; queued/running work must finish
or be canceled first. Settings keeps a recovery copy, and restoring it pauses
automation until you verify the project and enable the PMs again. This does not
delete repositories or Linear resources. You can delete the last PM and leave a
project ready for a new crew. [Removal and recovery details](RESOURCE_LIFECYCLE.md).

## Get one PM ready, then automate

Start from the selected project's guided setup actions. Source control selects
the app repository; Connections supplies Claude Code and the chosen Linear
account; Edit settings holds commands, optional browser targets, and Linear
mappings. Verify the project, then create or resume a verified Docker worker.
Each action addresses a specific missing requirement instead of treating every
optional integration as mandatory.

Create a PM with a clear brief and ownership boundaries. **Fill with AI** proposes
a draft using that brief and repository paths. Review its rationale, scope, and
warnings, then **Apply suggestions** if useful. The original mandate remains
unchanged. Applying a draft only fills the form; **Create PM** is the separate
save/provisioning action, and the new PM starts with automation paused.

Expand **Product brief** to describe ambition, the outcome and metric, users,
expected capabilities, priorities, guardrails, and non-goals. These are owner
instructions, not learned memory. Existing PMs can edit the same brief with
conflict protection; saving it preserves their Linear mapping and automation state.

Use **Discovery** to investigate the actual checkout before a first patrol.
Discovery needs source access, Claude Code, and a ready worker, but does not need
Linear or a hosted app. It records a codebase map, feature inventory, ranked queue,
and memory with run and commit provenance. Later patrols consume that context.
It does not file issues or change your saved ownership or instructions. See the
[PM workflow](PM_WORKFLOW.md) for the distinction between discovery and AI form fill.

Use **Run once** to test a mapped PM after verification. Paused automation does
not prevent an explicit run. Inspect its Activity before selecting **Enable
automation**. That control enables both the PM's UTC patrol schedule and automatic
pickup of approved Coding tickets for its area. **Pause automation** stops new
automatic work and keeps the mandate, mapping, and history; existing work is not
canceled. Manual Coding runs remain available for open, properly approved tickets.

A worker's Pause/Resume controls capacity, separately from PM automation. A ready
worker does not enable a mandate, and an enabled mandate cannot bypass missing
connections, verification, or ticket approval.

## Different projects, different accounts

Connections is a directory of available access, not one mandatory account for every
project. In the Linear or Vercel card, **Add another account or workspace**, give it
a name, and authorize it. Adding a connection does not change existing projects.

Each project chooses its own Linear connection and team under **Edit settings →
Linear mappings**. Each Vercel environment chooses its own saved connection,
project, and team. Another project can use Railway, Cloud Run, a direct URL, or no
hosting at all. Railway targets can reference separate saved token variables.

The editor keeps the project name and repository visible while you work. Use its
section shortcuts for project setup, Linear mappings, and product signals.
Changing a Vercel connection clears the draft resource IDs so you can enter the
project and team accessible through that account before saving.

Existing projects continue using the **Default connection** unless you explicitly
select another one. A missing or revoked named connection never falls back to a
different account. Verify the project after changing its access or mappings.

## Start with repository checks

New projects default to repository verification and draft pull or merge requests against `main`. The repository picker suggests its default branch. Change that branch if your review process uses another one.

```json
{
  "workflow": { "kind": "pull-request", "baseBranch": "main" },
  "verification": { "mode": "repository" },
  "environments": {},
  "commands": {
    "install": "npm ci",
    "test": "npm test",
    "lint": null,
    "typecheck": null,
    "build": null
  }
}
```

This is an execution-settings excerpt, not a replacement for the full generated project file. Repository mode does not require a Vercel account, a preview URL, or three release branches. It produces repository findings and configured check results; it cannot claim browser screenshots of an app it did not visit.

Install and test commands must be explicit nonempty commands. Lint, typecheck, and build are optional. Node defaults are examples, not automatic stack detection. Use commands appropriate to your project and ensure the worker image contains their toolchain. For example, a Python project can create its own virtual environment during install and use that environment for tests. A configured command does not install Go, Rust, Java, or another language runtime by itself.

For the ShipGremlins repository itself, use `npm ci`, `npm test`, `npm run lint`,
and `npm run typecheck` in their corresponding fields. Leave Build blank; it runs
from TypeScript source. Its worker needs Node.js 22.12 or newer.

## Add a browser environment

Choose **Docker or another host**, **Vercel**, **Railway**, or **Google Cloud Run** in the project form. Give the target a name and a `preview` or `staging` role. Browser verification selects exactly one named environment:

```json
{
  "workflow": { "kind": "pull-request", "baseBranch": "main" },
  "verification": { "mode": "browser", "environment": "qa" },
  "environments": {
    "qa": {
      "role": "staging",
      "kind": "url",
      "url": "https://qa.example.com"
    }
  }
}
```

The browser target and PR base are separate choices. Provider-discovered Vercel or Railway targets can set `branch` to the deployed test branch; otherwise the configured work branch is used. Vercel requires a ready **preview** deployment, so `main` being a production deployment does not make it a valid preview. Configure an appropriate deployed branch such as `staging` when necessary.

Production environments may be recorded for context, but cannot be selected for browser verification. Use isolated accounts, synthetic data, and a mandate that explains allowed test actions. The URL must be HTTP(S), without embedded credentials, query parameters, or a fragment.

### Docker, a homelab, or another hosting provider

Use `kind: "url"` with an existing reachable preview. Discovery credentials are unnecessary. ShipGremlins does not start, deploy, or expose your application just because a URL is configured.

The URL must be reachable **from the worker container**. `localhost` points to that container, not the machine running your app. Use a reachable private-network address or `http://host.docker.internal:PORT` for a host service; the local worker configures the host gateway mapping. Bind the app to the appropriate interface and check its firewall. Services in another container need a published port or an intentionally shared network. This applies equally to your own server, Docker, a VPS, or a provider without a native connector.

### Vercel

```json
{
  "role": "preview",
  "kind": "vercel",
  "connectionId": "acme-vercel",
  "projectId": "prj_example",
  "teamId": "team_example",
  "branch": "staging",
  "bypassSecret": "PREVIEW_BYPASS_MY_APP"
}
```

Connect Vercel in **Connections**, or use its advanced manual token field. The target identifies a project and optional team; a connected integration's team can supply the team context. `bypassSecret` is optional and contains a variable name, never the secret value. Its input appears in Connections after saving the project. The controller discovers the deployment; account credentials stay out of agent payloads. See [Linear and Vercel setup](LINEAR_VERCEL.md).

### Railway

```json
{
  "role": "staging",
  "kind": "railway",
  "projectId": "your-project-id",
  "environmentId": "your-staging-environment-id",
  "serviceId": "your-web-service-id",
  "branch": "staging",
  "tokenSecret": "RAILWAY_TOKEN",
  "tokenType": "account"
}
```

Save `RAILWAY_TOKEN` in its Connections card. Use the narrowest account, workspace, or project access available. Account/workspace tokens use `tokenType: "account"`; a Railway project token requires `tokenType: "project"`. This is manual token setup, not Railway OAuth. A custom `tokenSecret` selects a different saved variable for this target.

The Railway card links to [Railway Tokens](https://railway.com/account/tokens).
Create a token named ShipGremlins and select the workspace containing your apps,
then paste it into the card and save. Choose **Account/workspace** in the project's
token type. For one environment, create a token in Railway's **Project Settings →
Tokens**, select that environment, and choose **Project** in ShipGremlins instead.
The field is named `RAILWAY_TOKEN` in ShipGremlins for either token type. See
[Railway's token guide](https://docs.railway.com/integrations/api#creating-a-token).

Discovery reads the selected service and deployment state. It does not provision environments or deploy code. A service without a usable URL needs a domain or a reachable direct URL target.

### Google Cloud Run

```json
{
  "role": "staging",
  "kind": "cloud-run",
  "projectId": "your-google-project",
  "region": "us-central1",
  "service": "your-preview-service",
  "credentialsSecret": "GCP_SERVICE_ACCOUNT_JSON"
}
```

In Connections, supply service-account JSON only if the controller needs a key. Alternatively, omit `credentialsSecret` and use the controller's Application Default Credentials, such as a machine identity. Give that identity only the read permissions needed for the selected Cloud Run service. Verify the project to check actual identity and resource access; the dashboard does not treat an empty key field as proof of working machine identity.

This connector reads service metadata and its URL. It does not create a service, deploy a revision, or configure IAM. The browser URL must be reachable; private-service browser authentication is not injected by this release. This is service-account or machine-identity access, not a Google OAuth button. Provider credentials remain on the controller.

## Edit without losing other settings

**Edit settings** loads the project's current file and revision. It updates verification, workflow, environment, and command settings while preserving unrelated configuration, Linear mappings, sign-in recipes, telemetry, and other environments. Execution-setting changes clear the previous verification stamp. Run **Verify connections** again before starting work.

Choose a saved preview/staging environment or add a new named target. Other targets are retained. Use **Open full configuration** for production targets, removal or renaming, custom sign-in, or other advanced JSON. A changed file produces a conflict instead of overwriting another process's edits. Your draft remains visible; copy the changes you need, reload, and reapply. Closing or reloading an edited settings form asks whether to discard the draft.

Repository-only mode can keep environment definitions for later. It does not access those hosts for repository verification. Switching modes does not migrate databases, reset mandates, or activate disabled PMs.

## Connections are separate from targets

The Connections section stores account credentials and shows configured state. Project forms select resources and refer to named credentials. Blank token inputs keep existing values. Saved does not mean verified; use each project's live **Verify connections** action.

Manual values live in the configuration directory's `.env`; OAuth connections use their encrypted local state and matching keys. Keep private backups of both. Never put token values or service-account JSON in `project.json`. Hosting discovery runs on the controller. Application preview bypass and test sign-in access, where configured, are distinct from the provider's account credential.

## Choose selective promotion when your app needs it

New projects use ordinary draft PRs/MRs. Selecting `workflow: {"kind":"promotion"}` requires distinct production, staging, and integration branches plus deployment and evidence setup. Project Delivery tracks approved drafts, owning-PM verification and selectively cherry-picked candidates. GitHub and GitLab source are independent of the hosting provider.

Vercel and Railway integration review require actual deployed branch/SHA metadata.
Select a named candidate target on the Delivery page using
`workflow.candidateEnvironment`. A Railway candidate must use a separate service
or environment so its deployment cannot overwrite the fixed `pm-staging` target.
Candidate deployment and trusted signing are still explicit setup steps; direct
URLs and Cloud Run discovery alone cannot authorize promotion. The controller
never auto-merges production or marks Done merely because a job succeeded.
Follow [the delivery setup](DELIVERY_WORKFLOW.md), [candidate gate](VERIFICATION.md),
and [production completion](LINEAR_LIFECYCLE.md).
