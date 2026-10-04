# Linear and Vercel connection broker

The official dashboard connects through `https://shipgremlins.ai/api/linear` and `/api/vercel`. Operators do not need to deploy this broker or register their own app. This directory publishes its source for review.

`createOAuthBroker(provider)` exports a Node HTTP handler for `/connect`, `/authorize`, `/callback`, and `/status`. The production website imports the same module from `lib/provider-oauth.mjs` in its two Vercel function routes. It also serves the shared `slack-connect.css` and a connection privacy page.

Server-only environment:

- `SG_LINEAR_CLIENT_ID`: public Linear application ID; the official application is `3bc32a19c5e977283d4945fac1107966`.
- `SG_LINEAR_OAUTH_STATE_KEY`: 32 random bytes encoded as base64url.
- `SG_VERCEL_CLIENT_ID` and `SG_VERCEL_CLIENT_SECRET`: Vercel integration credentials.
- `SG_VERCEL_OAUTH_STATE_KEY`: a separate 32-byte base64url key.
- `SG_VERCEL_INTEGRATION_SLUG`: defaults to `shipgremlins`.

Never put client secrets or state keys in the CLI distribution, source repository, browser bundle, or logs. Rotate a state key only when invalidating in-flight setup links is acceptable. Existing local connections are unaffected.

Linear uses `actor=user`, `read,write`, and S256 PKCE. The broker relays only the authorization code; the controller exchanges and refreshes credentials directly with Linear. Callback: `https://shipgremlins.ai/api/linear/callback`.

Vercel uses a connectable integration with read-only scopes for Integration Configuration, Deployments, Projects, Teams, and Current User. Callback: `https://shipgremlins.ai/api/vercel/callback`. Its confidential token exchange occurs in the broker, which immediately encrypts the token for the requesting instance without persisting it. Vercel tokens have no documented refresh flow; revoked or disabled installations must reconnect.

Pairing requests are ten-minute encrypted envelopes. Confirmation requires the canonical site Origin and creates an HttpOnly, Secure, SameSite=Lax browser cookie. Callback state verifies that cookie. Responses use provider-specific AES-GCM AAD and an instance-generated encryption key; credentials are returned only inside an encrypted fragment. Return destinations must be an HTTPS origin or a loopback/private IPv4 HTTP origin with root path and no credentials/query/fragment. The local dashboard additionally validates its session, pending nonce, and expiry before saving anything.

The hosted confirmation is essential: any public client can request a pairing URL, so the person authorizing must see which instance will receive the connection. Keep referrer policy `strict-origin`; `no-referrer` causes some browsers to send `Origin: null` on the confirmation POST. Do not log request bodies, raw callback URLs, tokens, or upstream responses. Infrastructure may retain request metadata and encrypted URL state as described on the privacy page.

Run `node --test oauth-app/oauth.test.mjs` to exercise both flows, browser binding, provider separation, invalid return addresses, denied consent, expired links, and failed exchanges. Application-side tests live in `src/oauthConnection/`.
