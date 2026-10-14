# Mission control design audit

Verified on 2026-10-14 for v0.28.0, with the gremlin-green palette restored in v0.28.1.

## Design implementation

All 36 existing dashboard stylesheets now use a shared dark forest and gremlin-green system. The new `dashboard/mission-control.css` supplies composition hooks for headings, toolbars, system metrics, panels, setup actions, technical disclosures, and empty states. Component colors, controls, spacing, radii, charts, dialogs, tabs, and responsive rules were updated in their owning stylesheets rather than covered by one generic theme override.

The foundation uses the bundled Manrope font, a system monospace stack, dark native controls, lime keyboard focus, and semantic success/warning/error colors. Provider marks remain visible on dark backgrounds. Primary actions use the logo's lime green with dark text. Run stages use softer green for passed checks and lime for the current recorded phase; unavailable, queued, failed, and stale states retain their actual meanings.

The overview has a compact heading, one row of workspace metrics, live execution cards, project actions, and collapsed connection diagnostics. PM workspaces have one contextual back link, a full-width status/automation band, role switches, and disclosed testing/scheduling references. Mobile process rails use three columns so stage labels remain intact at 320 pixels. Expanded history does not stretch adjacent cards. Large setup illustrations were removed from the first-investigation and repository-introduction layouts.

## Actual browser coverage

Browser verification used the real local dashboard HTTP API with disposable synthetic fixtures at ports 4335 (populated workspace) and 4336 (empty workspace). External provider, model, and worker execution was denied. No user configuration or credentials were changed.

| Page or component | Observed coverage                                                                                                          | Screenshot evidence under `.run/mission-control-qa/`                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sign-in           | Password setup presentation, private fields, launch-session continuation                                                   | `auth-desktop.jpg`                                                                                                       |
| Mission control   | Populated workspace, current phases, queued run, inline rails, expanded process, metrics, project actions; empty workspace | `overview-desktop.jpg`, `run-timeline-desktop.jpg`, `empty-overview-desktop.jpg`                                         |
| Approvals         | Populated review list, filters, status/category hierarchy                                                                  | `approvals-desktop.jpg`                                                                                                  |
| Projects          | Repository cards, PM links, primary actions                                                                                | `projects-desktop.jpg`                                                                                                   |
| Agents            | Three PM cards, current work, search/filter; Workers tab and offline/empty remote-worker states                            | `agents-desktop.jpg`, `workers-desktop.jpg`                                                                              |
| Runs              | Live board and historical jobs; run Summary and Output dialogs                                                             | `runs-desktop.jpg`, `run-summary-desktop.jpg`, `run-output-desktop.jpg`                                                  |
| Usage             | Unknown totals, missing-report notice, empty trend, project table, reporting disclosures                                   | `usage-desktop.jpg`, `usage-820.jpg`                                                                                     |
| Connections       | Full service directory; connected AI provider/model form; unconnected AI/source dialogs                                    | `connections-desktop.jpg`, `ai-model-dialog-desktop.jpg`, `ai-unconnected-desktop.jpg`, `source-unconnected-desktop.jpg` |
| Settings          | Account access and configuration editor                                                                                    | `settings-desktop.jpg`, `configuration-desktop.jpg`                                                                      |
| Project workspace | Overview, autonomous state, blocked recovery, first investigation, crew; project settings dialog                           | `project-overview-desktop.jpg`, `project-settings-dialog-desktop.jpg`, `project-390.jpg`                                 |
| PM workspace      | Product brief, Learning, Features, Opportunities, Memory, Runs; automation switches and testing disclosure                 | `pm-brief-desktop.jpg`, `pm-390.jpg`                                                                                     |
| Command menu      | Project, PM, recent-run and workspace destinations, search input, keyboard instructions                                    | `command-menu-desktop.jpg`                                                                                               |
| Repository wizard | Start → repository picker → editable review → Add my app → persisted project after reload                                  | `wizard-review-desktop.jpg`                                                                                              |

Responsive checks used the documented browser viewport capability at 320×720, 390×844, and 820×1180, then restored the normal viewport. Mission control and its process rails were checked at 320 and 390; project and PM controls and the AI model dialog at 390; an unconnected AI dialog at 320; Usage at 820. The inspected pages had no document-level horizontal overflow. The 320-pixel dialog measured 300 pixels wide with matching internal client/scroll widths. The mobile navigation drawer opened, selected a route, and closed. Proof: `overview-320.jpg`, `overview-390.jpg`, `pm-390.jpg`, `ai-model-dialog-390.jpg`, `ai-unconnected-320.jpg`, `usage-820.jpg`.

The wizard saved only the disposable `ui-polish-test` project pointing at `fixture/dashboard-demo`. The project name and repository survived a page reload. Repository analysis correctly showed a safe failure because external execution was blocked; this does not certify model or source-provider execution.

## Checks and limits

- All 37 stylesheets parsed with the esbuild CSS parser; no undefined CSS custom-property references remained.
- Prettier and `git diff --check` passed for the final styles.
- Focused dashboard interface, project workspace, and run-flow DOM suites: 3 files / 93 tests passed.
- The parent integration run reported 234 files / 4016 tests passing, plus type, lint, bundle, configuration, native, and package checks. CSS refinements were subsequently parsed and checked as above.
- Reduced-motion rules were inspected in source: global animation/transition suppression and run-flow-specific rules are retained. An operating-system reduced-motion toggle and screen-reader walkthrough were not exercised.
- Deletion, real OAuth/device sign-in, real worker execution, populated billing/usage data, and every possible provider-error state were not executed. Their component styles share the same semantic system; this audit does not claim end-to-end certification of those services.
- Screenshots are local QA artifacts in the ignored `.run` directory, not shipped product assets. Early route screenshots can contain fixture data and the navigation copy present at capture time; the final overview and PM screenshots were refreshed after integration.

The v0.28.1 palette correction was checked on the populated dashboard in the
browser. The original `#c3f66b` logo green now drives actions, selection, focus and
the animated live-stage glow; surfaces use dark forest tones. All 37 stylesheets
parsed successfully, and the five inspected text/background pairs exceeded 4.5:1
contrast (primary button text: 13.01:1). Proof is saved in
`.run/green-brand-qa/mission-control-green.jpg`. Layout and behavior were unchanged.
