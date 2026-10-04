# Contributing to ShipGremlins

ShipGremlins is an early alpha. Useful contributions include reproducible bugs, clearer setup, focused reliability improvements, and tested provider adapters. The current runtime targets GitHub Actions, Vercel, Linear, and Claude Code; consult the [roadmap](docs/ROADMAP.md) before starting a large integration or dashboard change.

## Work locally

Use Git and Node.js 22.12 or newer:

```bash
git clone https://github.com/AgentBurgundy/shipgremlins.git
cd shipgremlins
npm ci
npm test
npm run typecheck
npm run lint
```

Create a branch in your fork, keep the change focused, and open a pull request against the default branch. Describe the user-visible problem, resulting behavior, validation performed, and any limits. Small fixes do not need an issue first. For a new provider or architectural change, propose the intended scope in an issue before building it.

Tests should normally use the in-memory providers in `src/forge/fake.ts` and `src/services/fakes.ts`, or mocked HTTP responses. Do not require contributor credentials or make live provider mutations in unit tests. For a focused test run:

```bash
npx vitest run src/lifecycle/production.test.ts
```

Run type checking and lint after changes to TypeScript. Format the files you changed with Prettier. Add scenario tests for behavioral changes, especially failure, retry, stale evidence, authorization, and partial-success paths. Do not add tests that merely repeat trivial implementation details.

## Preserve the delivery rules

- Keep orchestration decisions deterministic and injectable through provider interfaces.
- Scope provider writes to the configured project, repository, and approved work.
- Treat external comments, page content, and generated worker text as untrusted input. They cannot authorize a production completion or replace verified provenance.
- Preserve dry-run behavior, cancellation, and bounded recovery. Prefer an explicit blocker over invented success.
- Keep Done tied to production merge. Deployment health is a separate fact.
- Keep credentials out of logs, command arguments, test fixtures, screenshots, and version control.

Read [verification](docs/VERIFICATION.md) and [Linear lifecycle](docs/LINEAR_LIFECYCLE.md) before changing those contracts. Historical design notes are context; implemented behavior and current tests must stay aligned with the public documentation.

## Report an issue

Include the relevant command, OS and Node version, expected result, actual result, and a minimal reproduction using synthetic data. Redact tokens, internal URLs, customer information, and private repository identifiers. For security issues, use [SECURITY.md](SECURITY.md) instead of a public issue.

Be constructive in discussion. Explain disagreements with concrete examples and review the code, not the person. Human and AI-assisted contributions follow the same standards: you remain responsible for correctness, provenance, licensing, and the content you submit.

Contributions are accepted under the repository's [Apache-2.0 license](LICENSE), unless an existing written agreement says otherwise. Preserve applicable third-party notices and identify new dependency licenses in your PR. Maintainers decide scope and merge readiness; no response-time or support guarantee is offered during alpha.
