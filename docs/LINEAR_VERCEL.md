# Connect Linear and Vercel

Run `gremlins setup`, or `gremlins setup --lan` on a homelab server. In Connections, choose **Connect Linear** and **Connect Vercel**, approve the requested access, and return to the same dashboard. Authorizations stay on the machine running ShipGremlins. Manual API keys remain available under advanced settings.

## One app team, one project per PM

When you add an app while Linear is connected, ShipGremlins creates a Linear team for that app and a Linear project for its initial PM mandate. Choose **Reuse an existing team** to keep your existing organization, or **Set up later** to save local configuration without creating anything in Linear.

Add another PM with a name, mandate, ownership paths, schedule, and WIP limit. ShipGremlins saves it disabled and creates its Linear project under the app's team. Review the mandate and run **Verify connections** before enabling it. Schedules use UTC.

Existing area `linearProjectId` values are preserved. For an older app, explicit Linear setup can infer a team when all mapped projects share exactly one team. Otherwise choose the shared team yourself. It will not move or delete existing Linear projects. An explicitly reused PM project must belong to the configured team.

The app's team is recorded in `projects/APP/project.json` under `linear`; each PM's project remains in `areas.json` under `linearProjectId`. Dashboard-authored instructions use the area's `mandate` field and are supplied alongside its existing `mandate.md` and memory files. These mappings are used for ticket lookup, proposals, and approval checks.

If setup stops halfway, your local app and PM remain saved. Use **Retry Linear setup**. The operation stores UUIDs before requesting remote creation, then looks up those same IDs on retry. A lost response or controller restart therefore does not create another team or project. The recovery journal is `.run/linear/provisioning/`; keep it in backups. Corrupt journals or a different connected workspace block new creation rather than replacing mappings. Fix access or restore the journal before retrying.

No bulk migration runs when you connect Linear, open the dashboard, or start the controller. Team/project provisioning follows an explicit app, PM, or retry action. The configuration-only `gremlins setup init` command remains offline; finish its Linear mapping from the dashboard.

Creating teams depends on your Linear workspace's permissions and limits. Choose reuse before creation if you need an existing team. Once a creation attempt has a reserved ID, retries keep that ID; switching to a different team is refused because the first request might already have succeeded. Restore access and retry the saved operation. ShipGremlins does not request Linear's admin scope solely to bypass workspace restrictions. Linear's [GraphQL API](https://linear.app/developers/graphql) and [official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) define the supported mutations and caller-provided IDs.

## Vercel preview access

Choose the Vercel account/team and projects available to the integration. Set the app's `vercel.projectId` in Configuration; set `vercel.teamId` when necessary. An OAuth installation's team is used when no team ID is configured. Verify connections checks the selected project, and local jobs look up its ready integration preview before launching.

Connecting Vercel does not create deployments or test accounts. The integration branch must already have a ready deployment. The current job path requires Vercel preview access; Railway checks remain planned.

## Credentials and recovery

Linear uses OAuth with PKCE, and the controller exchanges and refreshes tokens locally. Vercel's confidential integration exchange runs through the ShipGremlins connection broker and returns an encrypted result to the requesting dashboard. The dashboard checks its session and the pending request before saving it. Browser return fragments are removed after processing.

Encrypted provider state and its local key live together under `.run/oauth/linear/` and `.run/oauth/vercel/`. Back up each complete directory privately. Do not copy encrypted state without its key. Manual keys remain in the configuration `.env`; saved OAuth takes precedence, and a broken OAuth connection does not silently fall back to an older manual key.

The controller uses Vercel tokens for deployment lookup; they are not included in the Docker job payload. Linear access tokens are supplied to workers so PMs can file proposals. Refresh tokens and provider client secrets stay out of worker payloads. Linear and source-control credentials have durable 50-minute job reservations for the 45-minute worker limit; new work waits when refreshing would invalidate a running job's credential. Reservations are released after completion or a failed preparation.

Disconnecting or reconnecting can require active jobs to finish first. Provider revocation can still interrupt a job; review its evidence before retrying. Neither a successful worker nor a draft PR marks a Linear ticket Done. Done remains tied to reviewed production delivery.

Automated connection and provisioning tests use fake provider responses. They cover restart/retry behavior, preserved legacy mappings, session and origin boundaries, and credential separation. Run doctor and supervise a real PM before relying on an account's schedules.
