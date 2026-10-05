# Disposable ShipGremlins dashboard

This is a repeatable **UI test application**, built from the real dashboard and HTTP handlers. It needs no Docker socket, provider credentials, real projects, PostgreSQL, or paid hosting. Do not use it as your controller or enter real credentials.

Choose this fixture when a PM needs to inspect ShipGremlins onboarding, projects, PM controls, editing, or run presentation. Testing the complete worker stack is a separate integration test and requires a real controller plus Docker.

## Run with a managed Docker environment

Use the configuration in [`recipe.json`](./recipe.json): repository build, Dockerfile `examples/dashboard-test/Dockerfile`, context `.`, app port `3000`, health path `/fixture/health`, public access. The managed environment builds the admitted repository commit and creates a fresh fixture directory per container. No app secrets or service containers are required. Merge this fixture into the repository branch before asking an existing installation to build it.

```json
{
  "kind": "docker",
  "role": "preview",
  "recipe": {
    "kind": "dockerfile",
    "dockerfile": "examples/dashboard-test/Dockerfile",
    "context": "."
  },
  "port": 3000,
  "healthPath": "/fixture/health",
  "access": { "kind": "public" }
}
```

For manual inspection from a checkout:

```sh
docker build -f examples/dashboard-test/Dockerfile -t shipgremlins-dashboard-fixture .
docker run --rm --name shipgremlins-dashboard-fixture -p 127.0.0.1:3000:3000 shipgremlins-dashboard-fixture
```

Open `http://127.0.0.1:3000/`. The server binds `0.0.0.0` inside the container and honors `PORT`; the example publishes only to local loopback. Never mount your real configuration, home directory, repository, or Docker socket into it. Restarting the container resets the synthetic workspace.

Local development after `npm ci`: set `SHIPGREMLINS_DASHBOARD_FIXTURE=1` and run `node --import tsx examples/dashboard-test/server.mjs`. The explicit flag prevents accidentally starting this test app as the ordinary dashboard.

## What is real, what is simulated

| Boundary          | Behavior                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard         | Real HTML, CSS, JavaScript, routing, dialogs and authenticated HTTP handlers                                                                    |
| Configuration     | Real revision checks and writes, confined to a fresh temporary fixture directory                                                                |
| PM edits          | Real brief/configuration validation and enable/pause handlers                                                                                   |
| Projects          | Two synthetic projects, three PMs, named synthetic test roles                                                                                   |
| Runs              | Seeded repository, browser-event, discovery, failed, queued and running scenarios; additional Run once requests create simulated queued entries |
| Evidence          | Explicitly synthetic events, summary files and a sample fixture screenshot; none prove real AI execution or application correctness             |
| Connections       | Simulated source/Linear metadata; no real tokens, OAuth flow or Slack messages                                                                  |
| Providers/workers | External fetches and provider/machine mutations are blocked; no Docker daemon, Claude or PostgreSQL runs inside this app                        |

A persistent banner identifies this boundary on every dashboard page. Recorded Playwright tool names and screenshot files are presentation fixtures, not successful browser-verification assertions. A new simulated run stays queued until canceled; the fixture never silently performs AI work or publishes tickets/PRs. Config and brief changes are backed by disposable files; simulated run changes are saved in `fixture-state.json` in the same private temporary directory.

**Run coding** automatically selects a seeded, approved synthetic ticket belonging to that project's PMs; no ticket identifier is required. Each PM has one sample approved ticket (`FIX-101` through `FIX-103`). `FIX-199` is an unapproved proposal and cannot start coding. Automatic selection skips previous attempts, including canceled ones. These records are local test data, not real Linear issues.

Useful scenarios: inspect Activity and open each run; compare repository-only versus screenshot evidence; edit a PM brief, save it, and reopen; enable/pause automation; queue and cancel a run; open project settings and save a change; cancel seeded queued/running scenarios before exercising deletion/recovery. Saving meaningful configuration changes can correctly clear project verification. Real connection verification, updates, remote enrollment and provider authorization are intentionally unavailable here.

The root URL grants a fresh **synthetic-only** session automatically. It is not a production authentication model. The real dashboard still requires that session on its APIs, and the fixture gateway rejects cross-origin mutations. Use the managed private container network or the loopback-only publishing example.

## Optional synthetic login probe

The fixture also exposes `/fixture/login` for testing a configured password-login recipe. The public test values are `fixture-member` / `fixture-password`; they are fake by design. Selectors: username `#fixture-username`, password `#fixture-password`, submit `#fixture-submit`, success `#fixture-signed-in`. Save these as dedicated test inputs only if choosing the optional password access mode. This checks the fixture's simple login form, not GitHub/Linear OAuth, your actual dashboard authentication, or RBAC.

Run focused checks with `node --test examples/dashboard-test/fixture.test.mjs`. Docker/Chromium smoke checks must report which fixture pages and mutations were actually exercised, separately from seeded run evidence.
