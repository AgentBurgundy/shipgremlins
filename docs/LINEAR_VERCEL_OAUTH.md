# Linear and Vercel OAuth

Connect each service from **Connections** in `gremlins setup`. The browser returns to the same dashboard, including a dashboard on a private LAN address. The dashboard session must still be active. Access and refresh tokens never appear in dashboard responses.

## Linear

ShipGremlins requests `read,write` access with `actor=user`. This lets provisioning act with the authorizing user's workspace permissions. Workspace policy can still deny creating a team; use an existing team or an account allowed to create teams. The connection does not request the broader `admin` scope.

The local server generates the PKCE verifier. The hosted callback only relays the authorization code in an encrypted envelope. The local server exchanges that code directly with Linear. No Linear client secret is distributed or needed for this flow.

Linear's access tokens last 24 hours. Refresh happens locally under a cross-process lock. A running worker reserves its access token for 50 minutes; refresh and disconnect wait until its reservation ends. This covers the worker's 45-minute maximum runtime. An interrupted refresh can retry the same refresh token within Linear's documented grace period. Revoked access requires reconnecting.

These behaviors follow [Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication). Linear's [app actor documentation](https://linear.app/developers/agents) also explains that `actor=app` cannot request `admin` scope.

## Vercel

ShipGremlins uses a Vercel **community connectable integration**. In the
authorization flow, choose the account or team and the existing projects your
crew may access. The controller verifies the selected project before using that
connection.

The integration needs these permissions for the current setup features:

| Vercel permission         | Access     | Purpose                                                                                                                  |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| Integration Configuration | Read       | Installation access; its identity binds the saved OAuth connection and owned automation bypass.                          |
| Current User              | Read       | Verify a personal-account installation.                                                                                  |
| Teams                     | Read       | Verify a team installation.                                                                                              |
| Projects                  | Read       | Match the repository, inspect existing project settings and identify preview environments.                               |
| Deployments               | Read/Write | Find and verify deployments, and create a reviewed test Preview in the selected existing project.                        |
| Project Protection Bypass | Read/Write | Manage an integration-owned bypass where Vercel permits it; creation requires a native integration, not community OAuth. |

Project access and permission levels are separate: select only the projects the
crew needs. Vercel groups deployment writes into a broader permission; the
ShipGremlins setup implementation uses it to create nonproduction previews.
It does not create Vercel projects, edit general project settings, write environment
variables or domains, delete deployments, or promote production. Keep general
**Projects** access at **Read**. The separate protection-bypass permission does
not override Vercel's restriction on community integrations. See [Vercel's integration scope reference](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations)
and [automation bypass API](https://vercel.com/docs/rest-api/projects/update-protection-bypass-for-automation).

### Protected previews with community OAuth

Vercel's current API rejects a community integration's bypass creation with
`Only native integrations can create automation bypass.` This restriction was
confirmed with an authorized ShipGremlins installation, including approved
Project Protection Bypass Read/Write access. It is a credential-type restriction,
not a failed OAuth connection or a missing scope. The public endpoint reference
does not currently spell out that distinction.

Keep community OAuth for project discovery and deployment actions. For protected
previews, create one dedicated ShipGremlins secret in the Vercel project's
**Settings → Deployment Protection → Protection Bypass for Automation**, then
save its value in the field setup prepared for this project in **Connections →
Project access → Vercel preview access**. Setup has already saved the reference;
when configuring access manually, select that same reference in the environment
settings. Subsequent browser runs reuse it. Deployment Protection stays on; the
app's own login remains separate.
[User setup instructions →](LINEAR_VERCEL.md#vercel-preview-access)

Automatic creation requires an eligible native integration or a manual API
token whose owner can manage that project's protection. A manual token works
through the Default connection, and does not override a saved OAuth
authorization. Explicitly disconnect OAuth before selecting that alternative;
otherwise use the dedicated bypass without changing the account connection.
If a manually supplied bypass is revoked or rotated, update its saved value in
Connections. Do not promise that community OAuth can regenerate it.

A read-only installation supports discovery but needs deployment write access
to create test Previews. Existing installations must approve added permissions
before using them; reconnect if the saved grant lacks access. Additional scopes
do not remove the community bypass-creation restriction. Optional Vercel
analytics reads can still return unavailable and are not required for onboarding. If the hosted
connection broker is unavailable, the dashboard's advanced manual-token path
remains usable. See [Vercel environments](VERCEL_ENVIRONMENTS.md).

The integration secret stays on the hosted callback service. That service exchanges the one-use code, encrypts the installation token for the local server, and does not persist it. The local server stores the token and includes its installation team ID when making requests. Vercel integration tokens are long-lived; a removed or disabled installation must be reconnected. This flow follows [Vercel's integration API documentation](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).

### Connection-service operator and end user

The operator of the hosted ShipGremlins connection service registers the Vercel
integration once, configures these permissions and the callback
`https://shipgremlins.ai/api/vercel/callback`, and privately deploys its client ID,
client secret and OAuth state key. A working website alone does not register an
integration or supply those credentials. The registered integration slug must
match the broker's configuration. Operator details are in the
[connection broker README](../oauth-app/README.md).

People running ShipGremlins connect their own Vercel account through **Connect
Vercel**; they do not register an integration or enter the broker's client secret.
An unavailable broker or missing operator configuration needs an operator fix,
not repeated authorization attempts. After successful authorization, a connection
started from project setup resumes that project's environment setup. Connecting
the account alone does not create a deployment or bypass secret.

## Storage and recovery

Each connection lives under the configuration directory:

```text
.run/oauth/linear/connection.enc
.run/oauth/linear/key
.run/oauth/vercel/connection.enc
.run/oauth/vercel/key
.run/oauth/linear/connections/CONNECTION_ID/connection.enc
.run/oauth/linear/connections/CONNECTION_ID/key
.run/oauth/vercel/connections/CONNECTION_ID/connection.enc
.run/oauth/vercel/connections/CONNECTION_ID/key
```

The files use AES-256-GCM encryption and owner-only file permissions, including Windows ACLs. This is local file encryption, not a hardware key store. Back up both the encrypted connection and its separate key. Keep backups private. Do not commit this directory.

Each named profile has its own key, authorization handoff, refresh lock, and job reservations. Project Linear settings and Vercel targets reference the saved connection's stable ID. Selecting a profile for management in Connections does not change project bindings. Missing named profiles fail explicitly.

For the default connection, existing OAuth takes precedence over a manual `LINEAR_API_KEY` or `VERCEL_TOKEN`. A revoked OAuth connection fails explicitly; it never silently switches accounts through a manual token. Disconnect forgets only the selected profile's authorization. Only the default connection can resume using its separately configured manual token. It does not uninstall a provider integration that another machine may share.

`gremlins setup --check` reads saved connection metadata without contacting the hosted callback service. `gremlins doctor PROJECT` verifies live access using the same credential resolver as local jobs.

For Linear commands that do not already take a project, pass `--project NAME` to
use that project's account: `gremlins ticket ENG-123 --project client-app`,
`gremlins upload evidence.png --project client-app`, or
`gremlins linear-projects --project client-app`. Without a project, these commands
use the default account. Developer queue records pin the Linear account, workspace,
and issue identity; changing those bindings before launch requires fresh approval
checks instead of reusing an identically numbered ticket from another workspace.
