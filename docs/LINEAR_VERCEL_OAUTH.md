# Linear and Vercel OAuth

Connect each service from **Connections** in `gremlins setup`. The browser returns to the same dashboard, including a dashboard on a private LAN address. The dashboard session must still be active. Access and refresh tokens never appear in dashboard responses.

## Linear

ShipGremlins requests `read,write` access with `actor=user`. This lets provisioning act with the authorizing user's workspace permissions. Workspace policy can still deny creating a team; use an existing team or an account allowed to create teams. The connection does not request the broader `admin` scope.

The local server generates the PKCE verifier. The hosted callback only relays the authorization code in an encrypted envelope. The local server exchanges that code directly with Linear. No Linear client secret is distributed or needed for this flow.

Linear's access tokens last 24 hours. Refresh happens locally under a cross-process lock. A running worker reserves its access token for 50 minutes; refresh and disconnect wait until its reservation ends. This covers the worker's 45-minute maximum runtime. An interrupted refresh can retry the same refresh token within Linear's documented grace period. Revoked access requires reconnecting.

These behaviors follow [Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication). Linear's [app actor documentation](https://linear.app/developers/agents) also explains that `actor=app` cannot request `admin` scope.

## Vercel

ShipGremlins uses a Vercel **integration**, with read access to projects, deployments, the installation configuration, and team/user identity. Choose the Vercel projects the integration may read. The selected project is checked before credentials are used for preview discovery.

The integration secret stays on the hosted callback service. That service exchanges the one-use code, encrypts the installation token for the local server, and does not persist it. The local server stores the token and includes its installation team ID when making requests. Vercel integration tokens are long-lived; a removed or disabled installation must be reconnected. This flow follows [Vercel's integration API documentation](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).

## Storage and recovery

Each connection lives under the configuration directory:

```text
.run/oauth/linear/connection.enc
.run/oauth/linear/key
.run/oauth/vercel/connection.enc
.run/oauth/vercel/key
```

The files use AES-256-GCM encryption and owner-only file permissions, including Windows ACLs. This is local file encryption, not a hardware key store. Back up both the encrypted connection and its separate key. Keep backups private. Do not commit this directory.

An existing OAuth connection takes precedence over a manual `LINEAR_API_KEY` or `VERCEL_TOKEN`. A revoked OAuth connection fails explicitly; it never silently switches accounts through a manual token. Disconnect forgets this machine's connection and allows its configured manual token to be used again. It does not uninstall a provider integration that another machine may share.

`gremlins setup --check` reads saved connection metadata without contacting the hosted callback service. `gremlins doctor PROJECT` verifies live access using the same credential resolver as local jobs.
