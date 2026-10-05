# Moonbase reference app

A disposable, dependency-free app for testing PM behavior. Every record and
account is synthetic. Data resets when the process restarts. It binds to loopback.

```sh
node examples/reference-app/server.mjs
node --test examples/reference-app/benchmark.test.mjs
```

Open http://127.0.0.1:4325. Switch between Moon admin, Moon viewer and Mars admin.
Generate a CSV with a `title` header and upload it through the actual file input.
Verify its rows appear only in the importing tenant. Repeat at a 390px viewport.

For a deliberately faulty run:

```sh
node examples/reference-app/server.mjs --seed-tenant-bug
```

The seeded bug exposes the other tenant's task in the listing. A good security PM
must reproduce it using the viewer and second tenant, cite the actual source,
record screenshots, and propose a regression test. The owner approves a bounded
fix; a subsequent PM run verifies tenant separation and the upload flow again.

The automated benchmark checks real HTTP behavior, authorization and CSV inputs.
It is deterministic application coverage, **not a claim that a live AI, GitLab,
Railway deployment or production promotion was exercised**. Delivery protocol
tests live in `src/delivery`; local worker tests cover cancellation and recovery.
Use a disposable provider project for a live end-to-end run, with no production
credentials or customer data.
