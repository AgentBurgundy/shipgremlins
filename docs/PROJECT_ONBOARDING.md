# Find a test home for your gremlins

This guide prepares an application for browser testing, including an early
prototype. Starting without code? Use [idea onboarding](IDEA_TO_APP.md) to plan
the first milestone and create its PM crew. Return here when the foundation
is runnable. For a newly created idea, this page starts with **Approve & build
foundation**: a reviewed coding run that creates the first app and tests. It
does not ask for hosting or run a PM patrol against an empty repository.
[When to bring in ShipGremlins →](WHEN_TO_USE.md)

Start with `gremlins setup`, or `gremlins setup --lan` on a homelab server.
An existing repository opens **Investigate → Choose your crew → Adopt**. The
background setup investigation recommends one to five PMs with distinct product
areas, source evidence and editable briefs. It does not create a generic Product
Understanding PM. Choose **Adopt** on the suggestions you want, review the filled-in
brief, and confirm. Remaining suggestions stay available after the first adoption;
already adopted roles are identified so you do not create duplicates.

An existing project without PMs has the same **Find my gremlins** action. This
investigation reads bounded repository source and saved setup context; it does
not claim a browser walkthrough or successful sign-in. Source account access,
Claude and the setup runtime must be ready, but no PM, Linear project or hosting
connection is needed to discover a crew. Old setup reports without complete PM
briefs can be analyzed again. Manual adoption remains available.

Review source-backed commands separately in project setup. Adoption does not
enable schedules or approved-ticket pickup. Connect the remaining services and
start a PM's first read-only Discovery when ready. See
[your first adoption](SETUP.md#your-first-adoption).

Open the project's **Environment** when browser testing is useful. A Setup
Gremlin can read bounded source at an exact commit and recommend a test strategy;
no Linear team, PM, or working deployment is required for that analysis.

### Vercel: let the gremlins handle setup

After adoption, the welcome and project home lead you through Linear setup and
then **Connect a test environment**. Environment shows **Connect Vercel** even
when no hosting account is saved. Sign in once; authorization returns to this
project and resumes setup. An interrupted status refresh can be retried without
repeating authorization. You can still choose another host or Docker, or start
with code-only Discovery.

With Vercel connected, opening Environment starts setup automatically for a clean,
unconfigured project or an unverified saved Vercel environment. ShipGremlins finds
the exact repository match, chooses the newest ready preview on the configured
test branch, saves the target, connects private preview access, and opens the app
in Chromium. Source-only projects use their nonproduction integration branch,
or `pm-staging` when no separate test branch was configured. You do not need to
copy a deployment URL, project ID, team ID, or bypass secret.

The page shows progress through finding the preview, saving it, connecting access,
and testing it. Returning to the page resumes showing the same operation. A failed
step stays visible; polling does not repeatedly create resources or restart tests.
**Test again** runs the complete check and tries one bounded access repair when
Vercel rejects the saved bypass.

ShipGremlins asks only when it cannot choose reliably: multiple matching apps in a
monorepo, an account that needs reconnecting, no ready preview on the intended
branch, or an application login that needs a dedicated test account. Preparing a
new deployment retains the existing test-data confirmation. It never substitutes
production or an unrelated feature branch for a missing test preview.

Managed automation credentials are reconciled before browser jobs start. Missing
local values and rotated tool-owned credentials recover from Vercel; a confirmed
removed managed bypass can be recreated once. Unconfirmed requests are reconciled
before another credential is created. Other tools' bypasses, manual credentials,
deployment protection, and production settings are preserved. A diagnosed failed
manual bypass can be replaced with a separate ShipGremlins reference while keeping
the original saved value.

Choose **I already know where to test** to skip analysis and enter an environment
yourself. The page shows one setup stage at a time. Hosted setup starts with a
test URL; **Find a preview with Vercel** opens the provider workflow when needed.
Advanced runtime settings, source evidence and proposed setup files have separate
review dialogs. Existing projects use the same Environment page; choosing a
setup path preserves their PMs, accounts, workflow, commands and other named environments.

Source selection follows manifests, executable entrypoints, relative imports, web assets and relevant test fixtures rather than taking the first files alphabetically. It can inspect up to 80 files and provide up to 512 KiB of selected source to Claude. Large files are explicitly marked as excerpts with line ranges. Open **Reviewed files** to see why each file was selected, listing limits and unread references. This remains a bounded investigation, not a complete repository audit or an agent freely browsing every file. Earlier saved reports retain their earlier coverage; choose **Analyze again** to use the improved investigation.

The analysis card shows saved connection status for this project's source provider and Claude. **Connect** appears for missing services, **Reconnect** for a source account that needs authorization again, and **Manage connections** for configured services. Analysis failures distinguish model limits, credential rejection, incomplete reports and runtime problems without displaying private model output. Use **Retry analysis** after addressing the reported cause; an older retained suggestion is labeled separately from the failed attempt.

## Two ways to test a web app

|             | Deployed staging                                                      | Disposable Docker app                                                                 |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Use when    | You already have a working test deployment or rely on hosted services | The app can run in a Linux container with test-only dependencies                      |
| Configure   | Existing URL, or a saved Railway/Vercel/Cloud Run target              | Existing image, or Dockerfile and build context from the repository                   |
| Data        | You supply isolated test accounts and test data                       | Optional fresh PostgreSQL and Redis; migration/seed commands run inside the app image |
| Each PM run | Visits the selected staging environment                               | Starts its own app and services on a private Docker network                           |
| Cleanup     | Keeps your hosted environment                                         | Removes the run's app, private network, disposable services, and managed build image  |

The Docker app is separate from the gremlin worker: one hosts your application; the other runs Claude and Playwright. The app receives only its named test inputs. The AI worker receives only the job's source/Linear/model access and configured browser test-account credentials. Neither gets the host Docker socket. Application commands run inside containers, not on your server.

## Detect → choose → test → ready

1. **Analyze the repository.** Read the recommendation, inspected files, missing inputs and limitations. Analysis is not proof that the app runs. Claude Code and Docker must be available on the controller for this step.
2. **Choose hosted staging or Docker.** For hosted staging, select an existing named environment or enter a test URL. For Docker, review the proposed image/Dockerfile, port, health path, services and commands. The app must listen on `0.0.0.0` inside its container.
3. **Save required Connections.** Environment configuration holds variable names, never secret values. Named inputs appear in Connections after saving. Add dedicated credentials for external test services if needed.
4. **Test environment.** ShipGremlins starts Chromium, opens the app, checks any configured password logins, and retains a private screenshot. Docker environments remain alive through the browser check, then are removed. Failed checks stay failed. Changing the selected environment invalidates the previous result.
5. **Return to your crew.** Choose **Open project** when PMs already exist, or adopt your first PM if the project has none. Review install/test commands and the worker toolchain before coding, and connect Linear for patrols. Repository discovery does not require browser setup. Automation remains paused until you enable it.

The setup browser test runs on the controller's Docker host. A remote worker must separately be able to reach a hosted URL and supply the required architecture/toolchain. A URL reachable only from the controller does not certify remote network access. Each Docker-backed job creates its app on the machine executing that job.

### When a check fails

The result panel keeps the checks that passed, identifies the failed step, and
offers the relevant repair. Later steps stay **Not yet tested**. **View test
details** shows each account's login controls and confirmation check; the timestamp
identifies the last attempt. Opening a repair keeps your unsaved settings.

| Result                                                             | Next action                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview credential missing, or Vercel protection stops the browser | Automatic setup reconciles preview access and retries once. If provider access is unavailable, the result names the connection or permission to repair. |
| App cannot be reached                                              | **Review environment** checks the selected address and Docker network path.                                                                             |
| Login selector matches zero or several elements                    | **Fix sign-in settings** opens the relevant selector. Scope it to one control inside the login form.                                                    |
| Test credentials missing or explicitly rejected                    | **Manage test credentials** opens Connections. Verify the account belongs to this test environment.                                                     |
| Signed-in confirmation not found                                   | Review the success selector and login result. A timeout alone does not prove the password is wrong.                                                     |

Saved Vercel credentials are labeled separately from verified browser access.
After a successful test, the page shows **Ready** without asking you to connect
again. Changing the environment or its credentials invalidates that result.

Local and enrolled Docker workers configure Playwright with the selected preview
origin and its saved automation access before the PM opens the browser. The PM
navigates to the ordinary URL; it does not need to put a secret in a URL or tool
call. Protection remains enabled. Successful `curl` requests alone never count
as a browser walkthrough or verify layout, interactions, or generation time.

## When the repository needs setup files

The Setup Gremlin may propose a Dockerfile, synthetic seed scripts, smoke helpers and instructions under `.gremlins/`. Review the actual file contents, then choose **Create draft setup PR**. GitHub gets a draft PR; GitLab gets a draft MR. The source branch must still match the analyzed commit, and existing files are not overwritten.

Merge reviewed setup changes yourself, reanalyze, and run the environment test against the resulting branch. The draft is not auto-merged, does not enable automation, and does not provision paid cloud resources. Retrying an interrupted publication checks for its existing branch and draft before creating another.

Some applications need changes outside the allowed setup files, proprietary services, additional containers, or a non-Linux toolchain. Analysis should name those gaps. This version supports one application container plus optional PostgreSQL and Redis; arbitrary Compose stacks, host mounts, custom service images, and cloud environment creation are not supported.

## Testing ShipGremlins itself

Use the [disposable dashboard fixture](../examples/dashboard-test/README.md) for PM browser patrols against ShipGremlins. It runs the real dashboard and HTTP handlers with a disposable workspace and explicitly simulated providers, workers and activity. It needs no hosting service, Docker socket or real integration credentials. Its Dockerfile is `examples/dashboard-test/Dockerfile`, build context `.`, port `3000`, health path `/fixture/health`, with public test access. Each managed run gets a fresh container.

The fixture can exercise dashboard flows and configuration validation. It does not verify real OAuth, Claude execution, worker containers or production RBAC. Those need separate integration tests. A controller's need to launch Docker workers is not a reason to require hosted staging for every UI patrol; the setup recommendation must distinguish the test surface from the complete production stack. For another application without an existing fixture, the Setup Gremlin can propose reviewed setup files and clearly explain the remaining limits.

## Test accounts

Under **Test accounts**, choose public access or a same-origin password login.
The login path and selectors describe the form; username/password **references**
name credentials that you save separately in Connections. This configuration
does not create accounts or grant roles. Up to eight accounts can be checked
independently. [Field-by-field test login setup →](TEST_ACCOUNTS.md)

The check verifies sign-in, not RBAC correctness. Email OTP, magic links, MFA,
multi-step forms, and external SSO are not supported by this guided checker.
Existing legacy Neon OTP settings are retained but are not an end-to-end login
verification. PM mandates should cover roles, tenant boundaries, and allowed
test actions. Account leasing and automatic data resets are not implemented;
avoid sharing mutable accounts across simultaneous patrols.

## Docker configuration example

This is an execution-settings excerpt for an existing project:

```json
{
  "verification": { "mode": "browser", "environment": "gremlins-test" },
  "environments": {
    "gremlins-test": {
      "kind": "docker",
      "role": "staging",
      "recipe": {
        "kind": "dockerfile",
        "dockerfile": ".gremlins/Dockerfile",
        "context": "."
      },
      "port": 3000,
      "healthPath": "/health",
      "services": [
        { "kind": "postgres", "name": "database", "env": "DATABASE_URL" }
      ],
      "migrate": ["npm", "run", "db:migrate"],
      "seed": ["npm", "run", "db:seed:test"],
      "env": { "APP_TEST_KEY": "MY_APP_TEST_KEY" },
      "access": { "kind": "public" }
    }
  }
}
```

Use scripts that actually exist in your image; these commands are examples. PostgreSQL/Redis connection values are generated for each run and injected into the app. Builds use a pinned source commit and a credential-free tracked build context. An existing image is pinned to its Docker image ID but is not proof that it contains any particular repository commit.

## Your Railway pm-staging flow

Keep the existing Railway `pm-staging` environment and select its saved target here. Preserve the project's promotion workflow, integration/staging/production branches, Railway resource IDs, and credentials. Environment onboarding does not change that delivery model.

A setup screenshot proves access only. A running baseline, including a disposable Docker baseline, cannot prove an unmerged code change. Selective promotion still requires supported provider metadata, owning-PM review of the exact candidate and independent signed verification. Direct URLs, Cloud Run, and Docker do not gain automatic promotion eligibility from passing onboarding. [Delivery workflow](DELIVERY_WORKFLOW.md) explains the evidence gate; production merges remain owner-controlled.
