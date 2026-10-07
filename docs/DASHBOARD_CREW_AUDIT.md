# Crew dashboard audit · October 7, 2026

This pass replaces duplicated project/PM navigation with one breadcrumb, brings live work into the workspace overview, and makes the crew itself a first-class directory. It follows the historical [dashboard audit](DASHBOARD_DESIGN_AUDIT.md); its older test counts and screenshots do not describe this version.

## Design decisions

- The hierarchy is workspace → project → product manager → run. PM pages have one heading, a horizontal sibling switcher when needed, and no empty secondary sidebar or repeated back links.
- Overview shows current and queued work, recent outcomes, project summaries and compact setup guidance. Existing users do not have to scroll past the large introductory mascot or repeat a coding setup panel for each project.
- Your gremlins opens the searchable PM directory. Start a run and Runners are separate tabs. Project cards link directly to their PMs and show actual current work.
- `Ctrl/Cmd K` opens a keyboard-accessible jump menu for pages, projects and PMs. Search performs navigation only.
- White surfaces, compact spacing, consistent controls, restrained status colors and a shared type scale replace large nested panels. Advanced disclosures remain available as simple rows.
- Dialogs keep their heading and action footer visible with one scrolling content area. Close, Escape, backdrop dismissal and focus restoration preserve the existing draft and confirmation rules.
- Locally bundled Motion (the Framer Motion DOM engine) animates route/dialog entrances and real state changes. Reduced motion is respected immediately; polling does not replay entrances or animate edited form content. No CDN or relaxed content security policy is required.

## Coverage inventory

| Surface                          | Changes and verification                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell and navigation             | Global breadcrumb, quick jump, mobile drawer, project names, keyboard focus, no horizontal overflow. Quick jump into a PM retains heading focus after asynchronous refresh.                                                  |
| Overview                         | Live/queued jobs, recent outcomes, current-project instance isolation, compact metrics and project summaries. Empty and disconnected states have explicit copy.                                                              |
| Projects                         | Compact repository cards with PM links and current states. Fixed mobile flex basis creating 210px of blank space in each card.                                                                                               |
| Project overview and crew        | Current work, setup progress and next action are compact. Full setup remains on its own route. Empty crew leads to repository investigation and proposed PMs.                                                                |
| PM workspace                     | Brief, Learning, Features, Ranked queue, Memory and Activity reviewed. Current/latest run takes precedence over setup exposition. Live refresh preserves focused headings and controls.                                      |
| Project workflows                | Mission, proposal error state, changes/promotion status, knowledge and environment setup inspected. Existing approval, delivery and provenance rules are unchanged.                                                          |
| Connections                      | All-provider directory, search, category filters, status badges and provider dialogs. Unavailable/expired connections cannot appear green. Saved drafts survive dialog dismissal.                                            |
| Project settings                 | Environment/delivery/checks, Linear mappings and product signals use consistent fields and compact tabs. Mobile headers and close controls remain visible.                                                                   |
| Project creation and adoption    | One previous-step control plus a separate close action. Adoption is centered at short phone heights; its header/footer remain visible and its stage scrolls.                                                                 |
| Runners and activity             | Crew directory, manual start, machines, history filters, run summary/activity/output/evidence and return-to-project modal behavior. Tab navigation precedes every panel.                                                     |
| Usage and settings               | Empty usage state, account access, updates, deleted resources and configuration retain focused navigation. Settings tabs use a two-column layout on phones.                                                                  |
| Grumblins, deletion and recovery | Compact shared styles and empty/setup states. Deletion impact dialog retains typed confirmation, active-work blockers and Escape behavior. Populated simulations and recovery outcomes retain automated regression coverage. |
| Authentication                   | Compact sign-in/setup form, readable helper text and existing password/session protections. This audit did not set or change a real credential.                                                                              |

The real browser pass used the shipped dashboard against a disposable local server at desktop widths and 390px phone widths, including a 390×640 short dialog viewport. Browser screenshots and DOM overflow inspections complement the tests. Provider boundaries and job evidence are synthetic. No live OAuth, paid agent work, credential changes, production promotion or destructive action was performed by the visual audit.

Local visual evidence is saved under `.run/`: `crew-overview-final-desktop.png`, `crew-pm-final-desktop.png`, `crew-projects-mobile.png`, `crew-recommendations-desktop.png`, `crew-recommendations-mobile.png`, `crew-adoption-mobile.png`, `ui-connections-desktop.png`, `ui-provider-mobile.png`, `ui-adoption-mobile.png`, and `motion-quick-jump-proof.png`. These are working artifacts, not package dependencies.

The new-project fixture also covered investigation → three recommendations → prefilled adoption review → one paused PM. The two remaining recommendations survived navigation and reload. Old reports containing only a generic starter PM request a fresh investigation. Adopting a recommendation does not make another AI call, replace an edited draft without a choice, or activate schedules and coding.

## Finished process versus tested product

A PM worker can exit normally while its investigation remains incomplete. The interface now uses the neutral **Run finished** label and separately describes the recorded coverage. A navigation and screenshots with no recorded browser interaction produce **No browser interactions recorded**, not a successful product test. Unavailable/partial evidence and opaque browser scripts remain explicitly uncertain.

The checks display describes structured check events. Test counts written only in an agent's narrative do not populate that counter and do not authorize promotion. **None recorded** is different from a test failure or an assertion that no tests ran.

An existing source-only PM charter can still prohibit tickets or keep its investigation narrowly focused. Updated setup suggestions describe ongoing responsibilities, but this release does not silently rewrite an owner's saved mandate. Configured credentials likewise do not prove that a PM attempted sign-in. Neither the worker's successful exit nor the new visual treatment changes QA or promotion gates.

## Verification boundaries

Focused regression coverage includes project-instance isolation, job ordering, readiness labels, encoded navigation, zero-PM onboarding, recommendation adoption, live focus retention, dialog dismissal/drafts, navigation restoration, evidence uncertainty, reduced-motion changes and real bundled Motion execution through native browser animations.

The release must pass repository formatting and bundle freshness, TypeScript, ESLint, the complete Vitest suite, supplemental Node tests, configuration/cron validation and package installation smoke. Cross-platform release CI and installation verification are separate gates; local fixture screenshots do not prove either.
