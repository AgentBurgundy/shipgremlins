# Test logins

Set up a login only when a PM or Grumblin needs to use a signed-in part of your
test app. Repository Discovery needs no browser account. First choose a preview,
staging, or isolated Docker environment; use dedicated test identities and data.

The guided checker currently supports a **same-origin password form with the
username and password available before one submit**. It does not create the
account, assign a role, read an inbox, or establish an SSO session for you.

## Configure a password login

1. Create a dedicated account through your test app's normal account-management
   process. Give it the permissions needed for the journey you want to test.
2. In the project's **Environment → Test accounts**, choose **Password login ·
   dedicated test accounts** and describe the account and form.

| Field                      | What to enter                                                                           | Example                            |
| -------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| Account name / role        | A label that helps you and the PM identify this account; it does not grant permissions. | `Test member`                      |
| Username secret reference  | An uppercase storage name, not the email or username itself.                            | `APP_EXAMPLE_TEST_MEMBER_USERNAME` |
| Password secret reference  | A different uppercase storage name, not the actual password.                            | `APP_EXAMPLE_TEST_MEMBER_PASSWORD` |
| Login path                 | A path on the selected test app, without a query or fragment.                           | `/sign-in`                         |
| Signed-in success selector | An element visible only after login; use a selector from your own app.                  | `[data-testid="account-menu"]`     |

3. Open **Advanced login selectors** if your form differs from the defaults:
   `input[type="email"]`, `input[type="password"]`, and `button[type="submit"]`.
   Use selectors that identify the intended inputs and button on that page.
   If the page has another form, scope the submit selector to the sign-in dialog,
   for example `[role="dialog"] button[type="submit"]`. The environment test
   reports ambiguous selectors and takes you directly to the field to repair.
4. Choose **Save environment**, then open **Connections → Project access**.
   The saved references appear with the account's name. Enter the actual test
   username/email and password there. Values stay in the controller's private
   configuration `.env`; the environment recipe contains only their names.
5. Return to Environment and choose **Test environment**. Chromium opens a fresh
   session, fills both fields, submits, and waits for the signed-in selector.
   Review the result and screenshot. Saving a recipe alone does not verify it.

The examples are placeholders, not credentials or selectors ShipGremlins creates.
You can configure up to eight named accounts using the same login recipe; each
gets a separate browser session. A successful login does not prove role or tenant
isolation. Put those checks in the PM's brief. Account leasing and automatic data
resets are not implemented, so avoid concurrent runs that mutate the same account.

Docker PM and Grumblin browsers receive the saved test credentials through
Playwright's private secret configuration. Their prompts use plain secret names
such as `GREMLINS_TEST_PASSWORD_1` for form-filling tools, so actual
passwords need not appear in model tool arguments. Vercel preview access is
configured separately for the selected origin before browser navigation. Passing
deployment protection does not sign the test account into your application.
Browsers carrying private preview access or test credentials stay on the selected
app for navigation and writes, including redirect chains. External static assets
can load without the bypass header. External SSO or a separate-origin login API
requires a supported same-origin test login; a blocked external request is a
worker access limitation, not evidence that the app is broken.

## Email codes, magic links, and SSO

The password checker does not support multi-step forms, email OTP, magic links,
MFA, passkeys, or external SSO redirects. It blocks cross-origin sign-in navigation
and credential submission. Do not put a one-time code in the password reference:
that neither retrieves future codes nor handles the preceding email step.

For example, an app that shows an email field, sends a code, then reveals a second
form needs a different login flow even if its path is `/sign-in`. Knowing a valid
signed-in selector does not make the password checker compatible with that flow.
Use a supported dedicated password login if the test app already offers one;
otherwise signed-in verification remains unavailable until the integration is
implemented. Public access checks only the signed-out surface.

### Existing Neon OTP recipes

Some older configurations contain `signIn.kind: "neon-auth-otp"`, a test email,
a path, and a `databaseUrlSecret` reference. **Keep existing sign-in recipe**
retains this configuration. The legacy helper can seed a short-lived OTP in an
isolated preview database; it does not prove that browser login works. An app's
own code-request step may replace a previously seeded code.

The current environment checker does not exercise legacy OTP and reports
**No signed-in account was checked**. Grumblins receive no legacy preview database
credential, so this recipe cannot provide their authenticated session. Never
point that database reference at production or use an existing configuration as
evidence that an account signed in successfully.
