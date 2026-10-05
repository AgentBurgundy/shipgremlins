# First adoption audit

Reviewed October 5, 2026 for the unreleased 0.19.0 dashboard.

## Journey and design

The landing page's adoption promise now leads to an installation guide for a self-hosted workspace. The dashboard then asks for the next missing prerequisite: source control, Claude Code, a project, a PM Gremlin, and a first mission. Empty metrics and unrelated setup controls do not dominate this first visit.

For an existing app, adding its repository opens adoption. The owner chooses a useful responsibility, asks AI to draft a brief or writes it manually, then meets and names the gremlin. Its creature portrait, job, and project appear together. Full brief, technical settings, and AI assumptions have separate focused views. Adoption saves a real PM mandate with automation off; the welcome offers an explicit first assignment or the setup needed for it.

For a new idea, the reviewed crew and foundation plan remain the starting point. PM analysis and browser environment setup wait for application code. Adoption does not bypass that foundation gate.

## Repaired findings

- Landing copy, installation instructions, and the dashboard used different terms and offered different starting points. The adoption CTA now has a concrete self-hosted handoff and consistent instructions.
- A fresh workspace showed empty metrics and many setup concerns together. It now highlights one next action and retains a small progress path.
- Connection settings had no obvious return to onboarding. The first-run connection dialog includes a continuation link.
- Existing-app creation sent users into environment setup before defining their first gremlin. It now opens adoption and defers environment details until a task needs them.
- PM creation exposed implementation fields before the owner's goal. It now starts with the job and progressively reveals the brief and technical controls.
- The website's mobile docs navigation consumed several screens before the introduction. It now offers a native topic selector while retaining the desktop sidebar.
- Project and crew views now carry the adopted gremlin's portrait and name beyond the creation dialog.

## Scope and limits

The browser pass covered landing-to-guide navigation, responsive topic selection, connected/unconnected first-run guidance, existing-app creation, AI-assisted and manual adoption, retained drafts, failed planning, advanced-field validation, and first-mission setup. It used desktop, 390px, and 320px layouts. Two actual PM configurations were saved in the disposable workspace with automation disabled and zero jobs queued. Focused tests also cover accepted saves followed by failed refreshes, changed-project drafts, regeneration that preserves human edits, foundation gating, and active-run reuse.

Browser verification uses a disposable dashboard, real configuration/API handlers, and synthetic source, planner, and runner boundaries. Provider calls are blocked. This establishes the onboarding interactions and persistence described in the main dashboard audit, not a live model, OAuth, or worker outcome.

Creature portraits currently use the shipped product/security artwork; they are presentation derived from the mandate, not claims of a newly generated personality or unique artwork.

An empty repository imported through **I have an app** is not automatically converted into an idea foundation. The wizard explicitly directs new/empty starts to **I have an idea**, which creates a new repository. Supporting foundation builds in an arbitrary existing empty repository remains a separate product capability.

Publication is pending review and CI. The website instructions target this unreleased dashboard and must ship with or after it.
