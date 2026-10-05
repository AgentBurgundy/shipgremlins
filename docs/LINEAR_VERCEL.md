# Connect Linear and Vercel

Run `gremlins setup`, or `gremlins setup --lan` on a homelab server. In Connections, choose **Connect Linear** and, if your browser environment uses Vercel, **Connect Vercel**. Approve the requested access and return to the same dashboard. Authorizations stay on the machine running ShipGremlins. Manual API keys remain available under advanced settings. Repository-only projects need no hosting connection; see [project and hosting choices](PROJECTS.md).

The provider cards support multiple named connections. Use **Add another account
or workspace**, name the connection, then authorize it. The dropdown in that card
selects the account you are managing; it does not reassign any project. Choose
connections explicitly in project settings. Different apps can use different
Linear workspaces or Vercel teams at the same time. Existing credentials remain
the **Default connection**; manual-token fallback belongs only to that default.

## One app team, one project per PM

When you add an app while Linear is connected, ShipGremlins creates a Linear team for that app and a Linear project for its initial PM mandate. Choose **Reuse an existing team** to keep your existing organization, or **Set up later** to save local configuration without creating anything in Linear.

Add another PM with a name, mandate, ownership paths, schedule, and WIP limit.
**Fill with AI** can suggest the form fields from your brief and repository paths;
review and **Apply suggestions** before the separate **Create PM** action. The
original mandate is never replaced, and generating or applying a draft creates
no Linear resources.

Creating the PM saves it with automation paused and creates its Linear project
under the app's team. Review its mapping and run **Verify connections**, then
**Run once** to inspect a supervised result. **Enable automation** opts into UTC
patrols and automatic approved-ticket pickup; **Pause automation** stops new
automatic work. Explicit PM and approved Coding runs remain available while
paused. Neither control approves a ticket or marks it Done.

Existing area `linearProjectId` values are preserved. For an older app, explicit Linear setup can infer a team when all mapped projects share exactly one team. Otherwise choose the shared team yourself. It will not move or delete existing Linear projects. An explicitly reused PM project must belong to the configured team.

The app's team is recorded in `projects/APP/project.json` under `linear`; each PM's project remains in `areas.json` under `linearProjectId`. Dashboard-authored instructions use the area's `mandate` field and are supplied alongside its existing `mandate.md` and memory files. These mappings are used for ticket lookup, proposals, and approval checks.

If setup stops halfway, your local app and PM remain saved. Use **Retry Linear setup**. The operation stores UUIDs before requesting remote creation, then looks up those same IDs on retry. A lost response or controller restart therefore does not create another team or project. The recovery journal is `.run/linear/provisioning/`; keep it in backups. Corrupt journals or a different connected workspace block new creation rather than replacing mappings. Fix access or restore the journal before retrying.

No bulk migration runs when you connect Linear, open the dashboard, or start the controller. Team/project provisioning follows an explicit app, PM, or retry action. The configuration-only `gremlins setup init` command remains offline; finish its Linear mapping from the dashboard.

Creating teams depends on your Linear workspace's permissions and limits. Choose reuse before creation if you need an existing team. Once a creation attempt has a reserved ID, retries keep that ID because the first request might already have succeeded. Use the explicit mapping repair below to select different existing resources. ShipGremlins does not request Linear's admin scope solely to bypass workspace restrictions. Linear's [GraphQL API](https://linear.app/developers/graphql) and [official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) define the supported mutations and caller-provided IDs.

## Repair an incorrect Linear setup

Open the app's **Edit settings → Linear mappings**. The header identifies the
local project and source repository. Choose its Linear connection, an existing
team, and an existing Linear project for each PM. The form shows names, marks
missing or wrong-team selections, and checks that the selected account can access
the resources. Selecting a different account requires choosing its team and PM
projects again.

**Save Linear mappings** updates the local app binding, PM mappings, and recovery
journal together. Concurrent edits are rejected. Unrelated project settings,
mandates, and credentials are preserved. This does not move, create, or delete
anything in Linear. Leaving a PM unmapped pauses it; saving a valid mapping does
not automatically enable a paused PM. An intentionally unmapped, paused PM does
not block verification of other configured PMs. It cannot run or be enabled until
its mapping is repaired. Verify connections after mapping changes, then use
**Run once** or explicitly resume automation. Explicit provisioning remains available for creating
missing resources.

## Vercel preview access

For a manual token, open the Vercel card in Connections and use its link to
[Vercel Tokens](https://vercel.com/account/tokens). Name the token ShipGremlins,
select the team or project you need, choose an expiration, and save it in the
card's personal-token form. Vercel's [token guide](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token)
explains the available scopes. You do not need to copy an environment-variable
assignment or edit a file.

Choose the Vercel account/team and projects available to the integration. In Edit settings, select Vercel, choose its saved connection, and enter its project ID and optional team ID. New targets are stored in named `environments`; legacy `vercel` settings remain supported. An OAuth installation's team is used when no team ID is configured. A team outside that installation requires another connection. Set the target's preview branch separately from the PR base when needed. Verify connections checks the selected project, and browser jobs look up its ready preview before launching.

Connecting Vercel does not create deployments or test accounts. The selected branch must already have a ready preview deployment; a production deployment is not a preview. Vercel is optional: repository verification requires no hosting, and browser targets also support Railway, Cloud Run, or a direct test URL. Provider discovery does not provision or deploy your app.

**Vercel preview access is a separate credential from the account token.** If your
preview uses Deployment Protection, generate a secret in that Vercel project's
**Settings → Deployment Protection → Protection Bypass for Automation**. In
ShipGremlins, select its secret name in the browser target settings, then save the
value in the project's Vercel preview access field in Connections. Public previews
need no bypass secret. See [Vercel's automation bypass guide](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

## Credentials and recovery

Linear uses OAuth with PKCE, and the controller exchanges and refreshes tokens locally. Vercel's confidential integration exchange runs through the ShipGremlins connection broker and returns an encrypted result to the requesting dashboard. The dashboard checks its session and the pending request before saving it. Browser return fragments are removed after processing.

Encrypted default provider state and its local key live together under `.run/oauth/linear/` and `.run/oauth/vercel/`. Named connections have separate state, keys, pending authorizations, and job reservations in each provider's `connections/CONNECTION_ID/` subdirectory. Back up each complete provider directory privately. Do not copy encrypted state without its key. Manual keys remain in the configuration `.env`; only the default connection supports that fallback. Saved OAuth takes precedence, and a broken OAuth connection does not silently fall back to an older manual key.

The controller uses Vercel tokens for deployment lookup; they are not included in the Docker job payload. Linear access tokens are supplied to workers so PMs can file proposals. Refresh tokens and provider client secrets stay out of worker payloads. Linear and source-control credentials have durable 50-minute job reservations for the 45-minute worker limit; new work waits when refreshing would invalidate a running job's credential. Reservations are released after completion or a failed preparation.

Disconnecting or reconnecting can require active jobs to finish first. Provider revocation can still interrupt a job; review its evidence before retrying. Neither a successful worker nor a draft PR marks a Linear ticket Done. Done remains tied to reviewed production delivery.

Automated connection and provisioning tests use fake provider responses. They cover restart/retry behavior, preserved legacy mappings, session and origin boundaries, and credential separation. Run doctor and supervise a real PM before relying on an account's schedules.
