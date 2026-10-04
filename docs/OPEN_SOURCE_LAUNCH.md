# ShipGremlins open source launch plan

Updated October 4, 2026. Status: ShipGremlins is the selected project name. The public source and private landing site are being prepared separately. DNS, HTTPS, redirects, repository visibility, and deployment status must be verified during publication; this document is not a deployment receipt.

The public promise should be concrete: give your web app a team of AI PMs that explore it, bring back screenshots, turn approved findings into tested changes, and track the work through production. The launch should demonstrate that loop and its recovery behavior on a real reference application.

## Name and domain direction

**ShipGremlins** suggests a small, persistent crew finding problems and helping ship fixes. It provides room for original characters associated with security, onboarding, accessibility, and specific features. Keep the technical descriptor “self-hosted AI product teams” alongside the name so the joke does not obscure the product.

| Asset                   | Selected destination                          | Publication requirement                                                |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Primary domain          | `shipgremlins.com`                            | Serve the landing site over HTTPS with this canonical host             |
| Alternate domain        | `shipgremlins.ai`                             | Redirect to the corresponding path on the primary `.com` host          |
| Open-source repository  | `AgentBurgundy/shipgremlins`                  | Publish a sanitized source snapshot under Apache-2.0                   |
| Landing-site repository | `AgentBurgundy/shipgremlins-site`             | Keep private and deploy separately from the agent runtime              |
| CLI                     | `shipgremlins`, with the existing `hub` alias | Source-checkout launcher is included; npm publication is separate work |

The selected name does not establish trademark clearance or npm/social-handle availability. No availability or ownership claim is made by this document. Canonical URLs, social preview metadata, and repository links should use the selected destinations consistently once published.

Use an original mascot and illustration system. Avoid visual references to recognizable movie creatures or another agent project's branding. Keep commands usable without mascot knowledge; retain the existing `hub` alias for migration.

## Positioning and claims

Descriptor: **An open-source product team that tests your app while you build.** The root [Apache-2.0 license](../LICENSE) is included; public distribution still requires a sanitized repository publication.

Suggested hero headline: **Your app deserves a very nosy product team.**

Suggested supporting copy: “Give AI PMs a mandate. They explore your app in a real browser, document gaps with screenshots, and work with developers on approved tickets. Every promotion comes with test evidence.”

The important distinction is durable product ownership plus an evidence-backed delivery loop. Explain how a mandate differs from a one-off coding prompt, how approval works, and how a verified change moves through staging to production. Demonstrate rather than promise general superiority over other agent systems.

Current alpha claims must stay narrower than the overall vision:

- GitHub, GitHub Actions, Vercel, Linear, and Claude Code are implemented. GitLab/GitLab CI/Railway and other model providers remain planned.
- Setup scaffolding and a local preflight are implemented. They do not provision provider accounts, host a controller, or start agents as a local daemon.
- Self-hosted Linux runners and GCE tooling exist. A fresh cloud install still needs operator configuration and validation.
- Production completion has a read-only audit and explicit `--apply` reconciler with reviewed scope manifests. It is not yet a scheduled webhook service and conservatively flags complex historical mappings.
- Promotion gates and bounded recovery have automated scenario tests. A public real-environment demonstration should identify its exact revision, evidence, and remaining limits.
- The landing page is a marketing site. Connections management, agent administration, and a run-history dashboard are planned.

Make broader claims only after the corresponding certification:

- Real browser exploration and screenshot evidence.
- GitHub/Actions/Vercel and GitLab/CI/Railway support.
- Local/server installation and optional cloud execution.
- Configurable models, mandates, tools, and budgets.
- Bounded recovery and verifiable release gates.
- Done reflects production merge, with deployment health shown separately.

Do not claim zero bugs, guaranteed security, unlimited autonomous work, automatic support for every app, a specific acquisition outcome, or ten-times productivity without evidence. Publish measured owner time saved and accepted findings once available. Keep unsupported integrations visibly planned rather than presenting their logos as shipped compatibility.

## Landing page design brief

The site should feel like a polished product with a playful crew, rather than an abstract AI pitch. Suggested direction: warm off-white backgrounds, dark ink text, a deep charcoal run-console panel, restrained lime/amber accents, and small original inspector characters. Use a clear sans-serif typeface and monospace only for commands, revisions, and run metadata. Choose fonts/assets with appropriate redistribution permissions.

| Section                | Content and behavior                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Header                 | Wordmark, Docs, How it works, GitHub, and Get started; mobile menu with keyboard support                                 |
| Hero                   | Headline, concise descriptor, copyable real install command when released, Watch demo and GitHub calls to action         |
| Product demo           | A real recorded browser run beside an action/evidence timeline; accessible static transcript and reduced-motion fallback |
| Meet the PMs           | Security, feature, onboarding, and accessibility examples, each with a concrete mandate and real finding                 |
| Workflow               | Observe → propose → approve → implement → verify → staging → production, with clear owner decisions                      |
| Evidence detail        | One actual issue, screenshot, acceptance assertions, code change, test result, and release record linked together        |
| Recovery demonstration | A failed check or lost runner, bounded repair, and re-verification; show failure states as part of the product           |
| Stack choices          | Certified combinations and runner options; expandable setup prerequisites and current limitations                        |
| Self-hosting           | Data ownership, provider credentials, budgets, a short setup walkthrough, export and backup links                        |
| Community              | Repository, starter mandates, contributor guide, roadmap, changelog, security reporting                                  |
| Footer                 | License, documentation, status/known issues, and optional privacy-respecting analytics disclosure                        |

The strongest visual is the app screenshot next to the verified outcome. Avoid invented customer logos, star counts, testimonials, live activity, or cost figures. Any interactive sample must be clearly marked as a recorded example. If a visitor changes the PM role, show the corresponding real sample scenario rather than simulated live execution.

Target small initial downloads, semantic HTML, readable tables/code, accessible contrast and focus, mobile layouts from narrow phones upward, and no essential animation. Verify install-command copying and keyboard navigation. Measure performance/accessibility during implementation rather than claiming scores in advance.

## Demonstration story

Use a sanitized sample SaaS application with seeded issues and synthetic tenants:

1. Create a security PM and a CSV-import PM from short mandates.
2. Security PM reproduces a cross-tenant access defect using two test accounts and records safe evidence.
3. Import PM generates a CSV, uploads it, and documents the actual validation failure with screenshots and expected rows.
4. The owner approves scoped tickets in Linear. Developers implement them on isolated branches.
5. A failing check triggers a bounded repair. The independent verifier reproduces the original failure and confirms the fix.
6. The complete candidate passes its promotion gate; the staging PR opens with evidence.
7. The owner merges through production. Linear moves to Done only after the production merge; deployment health appears separately.

Produce a short overview clip plus a longer uncut walkthrough and written reproduction. Disclose time compression, seeded defects, costs, and required setup. A public benchmark app makes the result repeatable without publishing private customer environments.

Potential X launch hook, **to use only after the demonstrated run exists**: “I gave my app a security PM and an import PM. They brought screenshots, found bugs, and handed me tested fixes. Neither scheduled a meeting.” A later ten-PM demo can support the ten-PM version of that joke. Draft posts and clips are launch assets; publishing is a separate authorized action.

## Open source packaging

Selected license: Apache-2.0. The root [LICENSE](../LICENSE) contains the complete [official license text](https://www.apache.org/licenses/LICENSE-2.0.txt). [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), and a credential-free [.env.example](../.env.example) are included. Dependencies retain their own licenses; the license does not imply ownership of third-party material.

Before the public alpha, complete:

- Publish a clean source snapshot, preserving the existing private hub and excluding private project configuration, credentials, evidence, run output, and original private Git history.
- Review generated schedules and workflow defaults so a public clone cannot trigger the owner's private projects.
- Replace private fixture identifiers and review historical design documents for internal context before including them in the public snapshot.
- Enable private vulnerability reporting and verify all public documentation and repository links.
- Validate the documented fresh-clone setup path and report provider/environment prerequisites honestly.
- Verify the landing site, mobile and keyboard behavior, canonical metadata, `.com` HTTPS, and `.ai` redirect. Keep its source in the private site repository.

For a later beta, also provide:

- A root README with the actual product state, demo, supported stacks, install path, limitations, and roadmap.
- An explicit license, attribution/notice handling, contribution guide, code of conduct, security reporting policy, and maintainership rules.
- A sanitized example project and a disposable reference app with test identities and documented reset scripts.
- Docker/Compose distribution, a compiled/versioned CLI package, tagged releases, changelog, checksums/signatures where supported, and an upgrade/rollback guide.
- Adapter and mandate contributor guides with conformance tests and a permissions declaration for plugins.
- Docs for environment cloning versus data isolation, provider setup, Linear state mappings, release gates, failure recovery, and cost controls.
- A review of tracked files and Git history for secrets/private material before making an existing private repository public. Preparing a clean release must preserve the owner's private configurations.

Keep core mandates, orchestration, evidence, providers, and self-hosting useful without a hosted account. Optional future commercial work could include managed hosting, runner capacity, support, and enterprise administration. Those are business options, not prerequisites for the initial open-source workflow.

## Launch readiness and feedback

The initial public alpha may expose the implemented GitHub/Vercel path while clearly marking other integrations as planned. A broader public beta requires both stack certifications, a tested fresh installation, restore/upgrade evidence, automated production-completion tracking, published known limitations, and a small external pilot. The first pilot should measure useful accepted findings, false positives, time to first result, owner intervention, cost per verified change, and successful deployment outcomes.

Prepare documentation and demo assets while reliability work proceeds, but let the launch promise follow the implemented product. Optimize early feedback for “I connected my app and it found something useful safely.” Stars and impressions are secondary indicators; they do not replace repeat usage or trustworthy releases.
