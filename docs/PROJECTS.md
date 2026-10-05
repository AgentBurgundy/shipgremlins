# Projects, environments, and connections

ShipGremlins can work on a repository without a hosted web app. Hosting is optional. Source control, Linear, and the AI runtime still need the access required by the job you request.

Run `gremlins setup`, or `gremlins setup --lan --port 4311` on a server. In **Projects**, choose your GitHub or GitLab repository, review its commands, and select how to verify work. Existing projects have an **Edit settings** button. Connections holds credentials; project settings hold resource IDs and credential variable names.

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

## Promotion remains an explicit advanced workflow

Legacy Vercel projects keep their staged promotion behavior. New projects use ordinary draft PRs/MRs. Selecting `workflow: {"kind":"promotion"}` requires distinct production, staging, and integration branches plus the separate deployment and evidence setup. The UI preserves these legacy settings and lets you review branch names.

Railway and Cloud Run discovery do not imply promotion support equivalent to the legacy Vercel path. The local queue does not auto-merge production or mark a ticket Done when a job succeeds. [Signed promotion gates](VERIFICATION.md) and [production completion](LINEAR_LIFECYCLE.md) remain separate reviewed operations.
