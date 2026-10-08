# Test accounts

Connect a dedicated account when your gremlins need to exercise signed-in parts
of a preview, staging app, or disposable Docker fixture. Repository Discovery
does not need an account. Vercel deployment protection and your app's login are
separate: opening a protected preview does not sign in to the application.

## Connect and test

1. Connect the repository, choose its test environment, and start an agent service.
2. Open the project's **Environment → App sign-in** and choose **Connect a test
   account**. Setup uses the login recipe found in the source investigation. If
   that recipe is missing, choose **Find sign-in** first.
3. Enter the dedicated test account's **Email or username** and **Password**, then
   choose **Connect & test**. This saves private credential references and runs
   the browser check without sending you to Connections.
4. Review the result and masked screenshot. The check runs on the assigned
   available agent service, including an enrolled remote worker. An older remote
   worker must be updated before it can perform managed sign-in checks.

Use **Manage test account** to reconnect. Leave a saved field blank to retain its
value; stored passwords are never read back into the form. Create the identity
through your test app's normal account-management process first. ShipGremlins
does not create accounts, grant roles, or bypass an invitation or MFA policy.

The common case needs no secret-reference names or selectors. **Advanced sign-in
recipe** exposes the detected route, controls, signed-in confirmation and optional
protected page when inspection or a correction is needed. A saved recipe alone
does not prove that sign-in works.

## What the check proves

The runner opens a fresh browser, follows the saved login steps, and checks a
protected page. The signed-in confirmation must be absent in a separate signed-out
context and present after authentication. Optional principal and tenant assertions
check the expected account and workspace. A missing, ambiguous or public confirmation
does not produce a passing sign-in result.

Before model work begins, the runner verifies that the PM's actual browser connection
uses that same authenticated context. It repeats sign-in for every new run; an old
green setup result is not current session proof. If access expires, the job reports
a typed access failure instead of completing with an untested public-page visit.
Independent delivery QA signs in again in fresh contexts without asking the PM to
export cookies or session files.

An account is reserved while a run owns its browser. Another run using the same
identity waits until cleanup is confirmed. Cancellation and remote lease expiry
stop the private browser; uncertain cleanup keeps the identity reserved for
reconciliation. Existing configurations can contain up to eight accounts, checked
separately during setup. Ordinary managed jobs currently use the first configured
account; automatic account pools and role selection are not implemented.

Passing authentication does not establish role permissions, tenant isolation,
billing correctness or a completed product journey. Put those expectations in the
PM's brief. Automatic test-data reset is not included.

The private browser also redacts cookies and browser storage before returning
evidence. Ordinary application caches are supported, including large JSON values
with nested session fields. A cache that exceeds the bounded privacy budget stops
the check with a storage-specific explanation; it is not reported as an incorrect
password or a crashed browser.

## Supported login flows

Same-origin password forms, login modals, and email-then-password forms are supported
when their saved recipe describes the flow. Recipes permit at most twelve typed
steps: navigate, click, fill a private username/password, select an option, or wait
for a control. They cannot contain scripts. Each credential is filled once, with
a submit action after the password. Source discovery can propose these steps.
If a saved login control disappears, the runner can recognize one unambiguous
password form and try its username, password and sign-in controls once in a fresh
context. It must pass the original protected-page and identity checks. The receipt
records verified adjustments; the saved recipe is unchanged. Ambiguous forms,
rejected credentials, changed modal-opening steps and failed identity assertions
do not trigger additional attempts. This is bounded form detection, not general
AI discovery or support for new authentication methods.
Use **Find sign-in** again when a discovered step sequence has changed; the
inspector preserves that sequence while you update the account.

For advanced setup, the signed-in confirmation should identify one element your
app displays only after login, such as `[data-testid="account-menu"]`. A login path
and optional protected path must stay on the selected test app, without a query or
fragment. Principal assertions compare a visible value with the saved username;
tenant assertions compare with the explicitly configured workspace value. These
assertions are optional and make no identity claim when omitted.

Email OTP, magic links, TOTP, push approval, passkeys, and external SSO are not
general supported adapters yet. Do not put a one-time code in the password field.
Use an existing authorized password login if the test app offers one, or select
**Explore public pages for now** with the coverage limitation visible. External
sign-in redirects are blocked; that is an access limitation, not evidence of an
application defect.

## Public apps and synthetic fixtures

Public access is an explicit choice, not a guessed default. It permits testing
the app's reachable public and guest behavior without claiming a real account
login. A disposable fixture may expose synthetic signed-in UI without credentials;
gremlins may exercise that UI and must label the fixture boundary. This does not
verify production authentication, permissions, or external integrations.

## Credential handling and existing projects

New inline credentials are stored in permission-restricted, project-scoped files
under the controller's `.run/test-accounts/`; project configuration contains only
their generated references. This is private file storage, not encrypted storage.
Existing password recipes and Connections references remain usable.

For managed browser jobs, passwords, usernames, preview bypass values, cookies,
and browser storage remain inside a separate helper container. The model receives
a restricted browser gateway, not those values or the helper's filesystem. It can
perform ordinary UI actions and take masked screenshots; arbitrary evaluation,
session export, network/console inspection and filesystem tools are unavailable
through that gateway. Navigation and credential-bearing writes stay on the selected
app origin. Cross-origin static assets do not receive the preview bypass header.

Older `signIn.kind: "neon-auth-otp"` configurations remain a separate legacy path.
Their custom helper can seed a code in an isolated preview database, but the managed
password checker does not certify that OTP flow and Grumblins do not receive that
legacy database credential. Never treat retaining the recipe as a successful login
check or point its database reference at production. New OTP/SSO automation needs
an explicit supported adapter.
