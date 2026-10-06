# Find or create a Vercel test environment

Open **Project → Environment**. With a connected Vercel account, ShipGremlins
finds the matching app, selects its current test preview, connects private
automation access, and opens the app in a real browser. One progress card follows
the whole setup, including after a refresh. You do not need to copy project IDs,
deployment URLs, or protection bypass secrets between forms.

Discovery uses the repository and source provider, not just an app name. It uses
the saved test branch, a configured nonproduction integration branch, or
`pm-staging` for a project without a separate integration branch. It never picks
an arbitrary pull-request preview or falls back to the production branch.

ShipGremlins asks for a choice when multiple Vercel apps match, for a connection
when an account cannot be accessed, or for an app test login when required. If
there is no ready test preview, it guides you through the deployment review below.
Existing Docker and direct-URL environments stay selected unless you choose to
replace them. An unfinished foundation stays on its build flow.

Vercel setup does not require Claude. The **Ask Setup Gremlin** conversation uses
your saved Claude connection and Docker to explain your setup and next steps.

## Use a test environment you already have

For an explicit choice, use the environment editor:

1. Choose the saved Vercel account. Its installation team is used automatically;
   a personal token may need the optional team ID.
2. Find projects and select the correct one. Repository matches are labeled,
   but multiple projects can deploy the same repository or different monorepo
   directories. ShipGremlins does not choose a project based on its name alone.
3. Choose a ready Preview deployment or an existing custom staging environment.
   The card shows the branch, environment, deployment state and commit. Production
   deployments are visible for context and cannot be selected as previews.
4. Save the environment. ShipGremlins connects preview access and tests the app
   automatically. Add app test accounts if needed. **Test again** reruns setup
   and browser verification. A successful Vercel build is not proof that a PM can
   reach the app or sign in.

The saved provider target contains the connection, team, project, branch and
optional custom environment ID. Later runs resolve the newest matching deployment.
If its latest build failed or is still building, an older successful build is
not silently substituted. URLs and screenshots remain evidence of the particular
deployment that was actually tested.

For a separate Vercel project dedicated to testing, choose that project. If it
deploys its test app as Vercel's **Production** target, create a Preview there or
use the explicit test-URL option after confirming that it is your nonproduction
app. A production label is never silently reinterpreted by the provider picker.

## Create a preview when there is none

Choose **Create a test preview**, review the branch (normally `pm-staging`), its
source branch and exact commit, and the selected Vercel project. If the branch
does not exist, the reviewed action can create it through your saved source
connection. Existing branches are not reset or overwritten.

Review the Preview environment in Vercel before creating the deployment. A
Preview build can still use a production database, storage bucket, payment key,
or email service. Supply test services and variables in Vercel and confirm that
the preview is safe for PM testing. ShipGremlins does not copy production secrets,
create databases, invent app accounts, or disable deployment protection.

The explicit **Create preview** action starts a Vercel deployment, which may
consume your Vercel build allowance. Creation requires deployment write access
and source write access if a branch must be created. A read-only integration can
discover existing deployments; creation explains when additional access is
needed. Existing installations may need to be reauthorized after permissions
change. A suitably scoped personal token remains available in Connections.

The controller records creation intent before contacting providers. Repeated
clicks and uncertain network responses are reconciled with the existing request;
an unconfirmed write is not blindly repeated. The dashboard can resume checking
a build after a controller restart. Changing project settings invalidates an
unexecuted plan and requires another review.

## Get help in the conversation

Ask questions such as “Which branch should the PM use?”, “My preview needs a
login”, or “How do I give this preview a test database?”. Answers use the observed
Vercel state and any saved repository analysis. The conversation can explain what
to do; provider writes and environment saves still happen through their explicit
reviewed actions. Do not paste secrets in chat. Save them in **Connections**.

## Connect protected preview access

Preview access is part of automatic setup. ShipGremlins checks the project using
its selected Vercel connection, creates or reuses a
dedicated **Protection Bypass for Automation** secret when needed, and saves it
privately in Connections. Project settings contain only a secret reference;
the credential is never sent to the dashboard or chat. Public previews need no
new secret. Opening an eligible, unverified Environment page starts this setup
once; a failed attempt does not loop on every refresh.

Vercel grants a bypass secret access across **all deployments of that Vercel
project** until revoked. ShipGremlins keeps deployment protection enabled and
uses the credential with the selected test environment. It does not replace or
revoke other tools' bypass secrets. Setup verifies the saved credential in a real
browser before displaying **Ready**.

Managed credentials are reconciled against Vercel: missing local values can be
restored and changed provider values refreshed. Browser jobs also reconcile their
managed access before starting. If a browser check still encounters protection,
setup attempts one repair and one more browser check, then shows the specific
remaining problem. Uncertain provider writes are reconciled rather than blindly
creating duplicate credentials. Manually supplied credentials are preserved;
a diagnosed repair can create a separate managed reference.

Workers apply the bypass privately to the exact selected deployment origin,
including redirect hops. Agents use clean URLs and saved test-account names;
the secret values are not included in prompts, browser output, or screenshots.
Cross-origin sign-in is not supported by the private password-login flow.

If Vercel denies permission, reconnect an account with permission to manage
deployment protection, or use **Advanced preview access** to reference a
manually created secret and save its value in **Connections → Project access**.
Vercel requires a team member role or a Project Administrator project role to
manage automation bypasses. Keep secret values out of chat and URLs.

The bypass is separate from logging into your application. Configure dedicated
app test accounts and verify both steps in the browser check. An email OTP,
magic link, or SSO login is not converted into a password login by connecting
preview access.

Conversation history is bounded and held in controller memory only. It resets
when the controller restarts or project configuration changes. Discovery and
deployment state persist under `.run/vercel-setup/`, scoped to the project's
identity so deleting and recreating a project does not reuse an old creation plan.

Existing custom environments can be selected when available in your Vercel
account. Creating a new custom environment, a new Vercel project, or external
test services is not part of this flow; standard Preview deployments are the
default provisioning path. Railway, Cloud Run, direct URLs, and disposable Docker
remain available through the [project onboarding flow](PROJECT_ONBOARDING.md).

Provider references: [Preview environments](https://vercel.com/docs/deployments/environments),
[deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
and [automation bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation),
including the [automation bypass API](https://vercel.com/docs/rest-api/projects/update-protection-bypass-for-automation).
