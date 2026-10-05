# Find a test home for your gremlins

This guide prepares an application for browser testing, including an early
prototype. Starting without code? Use [idea onboarding](IDEA_TO_APP.md) to plan
the first milestone and create its PM crew. Return here when the foundation
is runnable. For a newly created idea, this page starts with **Approve & build
foundation**: a reviewed coding run that creates the first app and tests. It
does not ask for hosting or run a PM patrol against an empty repository.
[When to bring in ShipGremlins →](WHEN_TO_USE.md)

Start with `gremlins setup`, or `gremlins setup --lan` on a homelab server. Connect source control and Claude Code, then add a repository. The dashboard opens that project's **Environment** page and starts a Setup Gremlin when its connections are ready. It reads bounded source files at an exact commit and recommends a test strategy. No Linear team, PM, or working deployment is required for this analysis.

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

## When the repository needs setup files

The Setup Gremlin may propose a Dockerfile, synthetic seed scripts, smoke helpers and instructions under `.gremlins/`. Review the actual file contents, then choose **Create draft setup PR**. GitHub gets a draft PR; GitLab gets a draft MR. The source branch must still match the analyzed commit, and existing files are not overwritten.

Merge reviewed setup changes yourself, reanalyze, and run the environment test against the resulting branch. The draft is not auto-merged, does not enable automation, and does not provision paid cloud resources. Retrying an interrupted publication checks for its existing branch and draft before creating another.

Some applications need changes outside the allowed setup files, proprietary services, additional containers, or a non-Linux toolchain. Analysis should name those gaps. This version supports one application container plus optional PostgreSQL and Redis; arbitrary Compose stacks, host mounts, custom service images, and cloud environment creation are not supported.

## Testing ShipGremlins itself

Use the [disposable dashboard fixture](../examples/dashboard-test/README.md) for PM browser patrols against ShipGremlins. It runs the real dashboard and HTTP handlers with a disposable workspace and explicitly simulated providers, workers and activity. It needs no hosting service, Docker socket or real integration credentials. Its Dockerfile is `examples/dashboard-test/Dockerfile`, build context `.`, port `3000`, health path `/fixture/health`, with public test access. Each managed run gets a fresh container.

The fixture can exercise dashboard flows and configuration validation. It does not verify real OAuth, Claude execution, worker containers or production RBAC. Those need separate integration tests. A controller's need to launch Docker workers is not a reason to require hosted staging for every UI patrol; the setup recommendation must distinguish the test surface from the complete production stack. For another application without an existing fixture, the Setup Gremlin can propose reviewed setup files and clearly explain the remaining limits.

## Test accounts

Under **Test accounts**, choose public access or a password login. Supply the login path, username/password fields, submit button and a selector visible after successful login. Give each account a friendly role name and dedicated username/password secret references. Save their actual values in Connections. Up to eight named accounts can be checked independently.

The check verifies sign-in, not RBAC correctness. PM mandates should explicitly cover roles, tenant boundaries, and allowed test actions. Existing legacy OTP configuration is retained; the new password checker does not claim it verified OTP. External SSO redirects need a dedicated test login or an application-specific recipe. Hosted test-account leasing and automatic data resets are not implemented; avoid sharing mutable accounts across simultaneous patrols.

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
