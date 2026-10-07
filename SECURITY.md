# Security policy

ShipGremlins can run agents with access to source code, test environments, and provider credentials. Its current release is an early alpha; review the configured permissions and workflow behavior before connecting valuable environments.

## Supported code

Security fixes currently target the latest code on the default branch. There is no long-term support release or guaranteed response time yet.

## Report privately

Use GitHub's private vulnerability reporting for [AgentBurgundy/shipgremlins](https://github.com/AgentBurgundy/shipgremlins/security/advisories/new) when it is enabled. Include the affected revision, prerequisites, impact, and a minimal reproduction using synthetic accounts or a local fixture.

If private reporting is unavailable, open a public issue containing only a request for a private reporting channel. Do not put vulnerability details, exploit instructions, credentials, or customer data in that issue. Wait for a maintainer to provide a private channel before sharing the report.

Do not attach active tokens, raw browser sessions, unredacted logs, or private repository contents. If a credential was exposed, revoke it through its provider and describe the credential type without sending the value.

## Relevant trust boundaries

- The dashboard controls agents and provider credentials. Treat its password, private CLI launch link and remembered browser sessions as administrator access. Browser sessions can be revoked; changing the password revokes existing browser sessions.
- Use HTTPS for hosted dashboard access. Trusted-LAN HTTP requires explicit owner opt-in and does not encrypt passwords or cookies. Do not expose that mode to the internet. The configured HTTPS origin and local reverse-proxy boundary are explicit; forwarded headers are not an authentication mechanism.
- Run browser exploration against isolated test environments with synthetic data and restricted accounts.
- Keep provider credentials in CI secrets or your secret manager. `.env.example` contains names only; `.env` is local and is not loaded automatically.
- Keep completion manifests under operator control, outside repositories and paths that worker agents can edit. A manifest authorizes a finite deliverable scope.
- GitHub comments and Linear labels are not sufficient production provenance. Verification receipts also have a documented [trust boundary](docs/VERIFICATION.md).
- Give worker tokens only the access needed for their task. A worker holding a broad Linear token can bypass prompt-level instructions about status updates.
- Configure native Linear automations so they do not close tickets on integration or staging merges. The production reconciler performs guarded reads, but Linear status writes do not provide atomic compare-and-set protection against competing writers.

Report issues in these boundaries privately. Test only systems and accounts you are authorized to assess; a public issue tracker is not an invitation to probe someone else's deployment.
