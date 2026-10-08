# Sign-in testing setup audit

Date: 2026-10-08. Baseline: v0.23.2 / main `04f327c`.

Scope: live, read-only inspection of ForeverMods environment and credential screens; source review of new-project onboarding, detection, verification, runner credential handoff, and enterprise boundaries. No credentials changed, new projects created, or login/PM jobs run. The new-project path was traced in source, not exercised by creating a live project. Recommendations below are proposed capabilities, not existing features.

## Assessment

Setup exposes the underlying automation recipe instead of connecting a test identity. The ordinary password case crosses pages and save operations; the enterprise case cannot fit the existing recipe. A successful setup probe also does not establish a signed-in session for the next PM run.

Preserve the existing strengths: source-backed detection, explicit public-only selection, private credential substitution, separate browser contexts, scoped Vercel bypass headers, and useful controlled failure diagnoses. Simplification should sit above these protections.

## Findings, in delivery priority

1. **Make account setup one continuous operation.** Environment saves account metadata and login controls; Connections separately saves username and password in two expandable rows. Its “Continue setup” link returns to Overview rather than the originating project. The live ForeverMods screen confirms this detour. Collect credentials together, generate references internally, save through the private credential service, and continue automatically into verification. Sources: [environment form](../dashboard/project-onboarding.js#L2013), [credential rows](../dashboard/connections-view.js#L152).

2. **Bootstrap authentication on the actual runner before authenticated PM work.** The setup probe closes its browser context. A subsequent PM receives another isolated browser, a recipe, and private credential placeholders; the model must perform login. Setup success is not a session handoff. Run a bounded authentication preflight and reuse that run's verified account context. If access fails, return an actionable access problem before attempting signed-in journeys. Sources: [probe](../src/setup/environmentProbe.ts#L19), [browser configuration](../runner-local/browser-access.mjs#L108), [runtime instructions](../src/localRunners/jobs.ts#L247).

3. **Replace indefinite readiness with current evidence.** Changing settings or saved secrets invalidates the fingerprint, but elapsed time, server-side revocation, and a new deployment do not. The probe runs on controller-local Docker even when execution can use remote runners. Track the tested deployment, runner/network, identity, and time; revalidate at execution. A controller-side pass must not imply connectivity from a remote runner. Sources: [fingerprint/status](../src/setup/environmentAccess.ts#L91), [controller wiring](../src/commands/dashboard.ts#L442).

4. **Stop requiring users to invent selectors.** Source detection can propose a complete recipe, but missing evidence exposes the login path, success selector, and advanced CSS inputs. Detection also depends on report freshness or unrelated command confirmation. Discover from source plus a browser, preserve source-valid auth hints independently, and ask only the unresolved question. Sources: [detection availability](../dashboard/project-onboarding.js#L1870), [recipe proposal](../src/projectOnboarding/projectSetup.ts#L119).

5. **Support login as a sequence.** The current contract is public/password; the verifier opens a path, fills username and password, then submits. It cannot describe opening a modal, clicking Next, selecting an organization, or completing another factor. Add a bounded, validated sequence of allowed actions. Keep a developer inspector for unusual apps. Sources: [access schema](../src/testAccess.ts#L2), [probe sequence](../src/setup/environmentProbe.ts#L86).

6. **Verify identity and permissions separately from a visual success marker.** The probe checks that the marker is visible and the password field disappears. It does not verify the expected principal, tenant, or role. Manual recipes also accept generic selectors rejected by AI proposal validation. Add signed-out negative controls and an authenticated identity/protected-route assertion; permission tests need explicit allowed and denied outcomes. Sources: [probe assertions](../src/setup/environmentProbe.ts#L94), [manual parsing](../src/testAccess.ts#L73), [proposal validation](../src/projectOnboarding/projectSetup.ts#L265).

7. **Give new projects a coherent readiness path.** Creation says testing can wait, while browser PMs later need explicit app-access configuration. After connecting the repository, branch clearly into source-only investigation or browser investigation. Browser investigation should guide hosting → app identity → worker verification → crew activation, with resumable drafts. Sources: [wizard](../dashboard/project-wizard.js#L317), [adoption](../dashboard/gremlin-adoption.js#L277).

8. **Unify readiness and coverage language.** In the live project, “One thing needs your help / Project settings changed” appears beside three Passed rows. Show historical evidence as historical, name the changed requirement, and present one next action. Distinguish preview reachable, signed in, role verified, and journey tested. Finding controls is not a successful login; a successful login is not a completed product test.

## Proposed ordinary setup

1. **“We found your test app.”** Resolve the Vercel preview or Docker fixture. Ask for a choice only when ambiguous.
2. **“Connect a test account.”** Preselect the detected login method. For password login, collect email and password together. Explain that this is a dedicated identity in the test environment. Keep role/account management optional until multiple roles matter.
3. **“Save & test sign-in.”** Save credentials securely, discover/validate the login sequence, and run it from the assigned runner. Keep CSS and secret-reference names out of the default UI.
4. **Resolve one specific failure.** Wrong credentials: edit inline. Unknown route: ask for the sign-in address. Missing MFA/session: show the supported reconnection step. Do not restart the entire wizard.
5. **“Ready to test as Test user.”** Show the verified app, account, known role/tenant, timestamp, and redacted screenshot. Explicitly label anything not verified. Continue to crew activation.

During later runs, authenticate and confirm the intended identity before signed-in work. Repair bounded navigation/locator changes with fresh evidence; do not silently change identities, widen access, or suppress MFA. Expiry or lockout should produce one actionable state, not indefinite retries.

## Enterprise capabilities and boundaries

| Situation                      | Current boundary                                                              | Proposed support                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Password or multi-step form    | One same-origin username/password form                                        | Discovered, bounded login sequence; per-run identity verification                                            |
| Email code or magic link       | Legacy Neon code helper exists, but generic onboarding/probe support does not | Dedicated test inbox/provider adapter, run-scoped messages and timeouts                                      |
| SSO / separate auth domain     | Private browser access blocks external navigation and writes                  | Explicit IdP/origin policy; supported adapter or owner-mediated short-lived test session                     |
| MFA / passkeys / device policy | No generic recipe or session lifecycle                                        | Supported test-tenant method or supervised sign-in; clearly disclose when policy prevents unattended renewal |
| Multiple roles / organizations | Up to eight named accounts, one recipe; names do not establish roles          | Typed identities, expected tenant/role, explicit authorization assertions                                    |
| Concurrent mutating PMs        | Isolated browsers, but jobs receive the environment's accounts                | Account leases and test-data isolation; give each job only needed identities                                 |
| Private networks               | Setup checks controller-local connectivity                                    | Runner-specific DNS/VPN/network profile and supported CA/proxy configuration                                 |
| Expired or revoked access      | Configuration changes invalidate readiness; no age-based expiry               | Per-run validation, bounded renewal, revocation handling and a clear reconnect action                        |

Do not tell enterprise users to enable password login merely to satisfy ShipGremlins. Preserve their identity policy and report the unattended coverage that is actually achievable. A saved session can enable application testing without proving the login or MFA flow itself was tested.

Storage-state support is a useful building block, but session artifacts contain impersonation-capable credentials and require private storage, expiry, revocation, and environment scoping. Concurrent tests that mutate server-side state also need separate identities or equivalent isolation. See [Playwright authentication guidance](https://playwright.dev/docs/auth).

## Recommended implementation order and acceptance checks

**First: make the common case dependable.** One account form, one save-and-test action, automatic login discovery including modals/multi-step forms, project-specific resume, and actual-runner preflight. Test direct password login, modal login, email-then-password, rejected credentials, changed controls, expired sessions, and remote-runner reachability. A signed-in PM must either start with a verified identity or stop with a specific recoverable reason.

**Second: managed identity lifecycle.** Typed roles/tenants, private session storage, expiry/reconnect, account leases, and per-job credential minimization. Test concurrent state changes, revocation, wrong-tenant detection, and denied permissions. Preserve an explicit public-only/source-only path without presenting it as full coverage.

**Third: enterprise adapters.** Add selected IdP/test-inbox integrations and private-network support against real pilot applications. Test allowed redirects, rejected unexpected origins, absence of credential/bypass leakage, MFA/session expiry, and a policy that legitimately forbids unattended authentication. Never claim universal SSO support based only on a generic browser recipe.
