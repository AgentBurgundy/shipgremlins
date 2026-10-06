# Connect Linear and Vercel

Run `gremlins setup`, or `gremlins setup --lan` on a homelab server. In Connections, choose **Connect Linear** and, if your browser environment uses Vercel, **Connect Vercel**. Approve the requested access and return to the same dashboard. Authorizations stay on the machine running ShipGremlins. Manual API keys remain available under advanced settings. Repository-only projects need no hosting connection; see [project and hosting choices](PROJECTS.md).

The provider cards support multiple named connections. Use **Add another account
or workspace**, name the connection, then authorize it. The dropdown in that card
selects the account you are managing; it does not reassign any project. Choose
connections explicitly in project settings. Different apps can use different
Linear workspaces or Vercel teams at the same time. Existing credentials remain
the **Default connection**; manual-token fallback belongs only to that default.

## One app team, one project per PM

Connect Linear when the chosen assignment needs proposals or coding. Adoption, a foundation build, or a PM run can prepare missing team and PM-project mappings using the app’s selected account. Choose an existing team in **Edit settings → Linear mappings** before starting if you want to keep your current organization. Connecting an account or importing a repository alone creates no Linear resources.

Choose **Adopt a PM Gremlin** and describe its job. **Meet my gremlin** proposes
a name and brief from that goal and repository paths. Use **Review full brief**
and **Advanced settings** to inspect direction, ownership, schedule, work limit,
and Linear choices before **Adopt [name]**. The original goal stays its mandate,
and generating the draft creates no Linear resources.

Adoption saves the PM with both automation controls paused. With a saved Linear
connection, ShipGremlins prepares the missing team and PM project using that
project's selected account, or reuses the project you chose. A connection or
permission problem leaves the PM adopted with a setup message; its read-only
Discovery can still run without Linear. **Run now** and outcome missions prepare
missing mappings when ticketed work is needed and verify required connections.
You do not need to create routine routing labels by hand.

**Look for new improvements** opts into UTC patrols; **Automatically build
approved work** opts into ticket pickup independently. Turning either off stops
its new automatic work. Explicit PM and approved Coding runs remain available
while paused. Neither control approves a ticket or marks it Done.

New Linear projects arrive with a 👾 icon, ShipGremlins green, and a readable PM
brief: the saved mandate, repository link, owned paths and shared touchpoints,
metric, UTC schedule, WIP limit, evidence expectations, and first-patrol checklist.
The brief explains how PM Gremlins propose findings, people approve them, and
Coding Gremlins produce tested draft PRs. It states the production rule clearly:
**Done means the fix is merged into production and required verification passed.**
The dashboard remains the source of truth for execution settings; later config
edits do not automatically rewrite your Linear document.

The initial brief also includes any structured ambition, users, expected
capabilities, metric definition, priorities, guardrails, and non-goals you saved.
Edit these in the PM's **Product brief** on its project page. Discovery can gather
codebase context before Linear is mapped; it does not receive Linear credentials
or create tickets. See [PM workflow](PM_WORKFLOW.md).

Existing area `linearProjectId` values are preserved. For an older app, explicit Linear setup can infer a team when all mapped projects share exactly one team. Otherwise choose the shared team yourself. It will not move or delete existing Linear projects. An explicitly reused PM project must belong to the configured team.

The app's team is recorded in `projects/APP/project.json` under `linear`; each PM's project remains in `areas.json` under `linearProjectId`. Dashboard-authored instructions use the area's `mandate` field and are supplied alongside its existing `mandate.md` and memory files. These mappings are used for ticket lookup, proposals, and approval checks.

If setup stops halfway, your local app and PM remain saved. Use **Retry Linear setup**. The operation stores UUIDs before requesting remote creation, then looks up those same IDs on retry. A lost response or controller restart therefore does not create another team or project. The recovery journal is `.run/linear/provisioning/`; keep it in backups. Corrupt journals or a different connected workspace block new creation rather than replacing mappings. Fix access or restore the journal before retrying.

For new projects whose journal proves ShipGremlins reserved and created them,
retry also fills missing brief or branding fields before completing setup.
Populated fields are preserved in case someone edited Linear during the
interruption. Reused projects and older mappings without that creation record
are never automatically rewritten. Explicit mapping repair removes that pending
metadata ownership, even when you select the same project again.

No bulk migration runs when you connect Linear, open the dashboard, or start the controller. Team/project provisioning follows an explicit app, PM, foundation-build, run, or retry action. Starting a PM with a missing mapping completes its resumable Linear setup using the app's selected connection; other paused PMs stay unmapped. The run also performs required connection verification after setup. Source, AI, Linear, and eligible worker access must be available first. Known mappings are preserved; missing access or an ambiguous team requires a clear remedy instead of silently switching resources. The configuration-only `gremlins setup init` command remains offline.

## Automatic label repair

Setup and PM runs check the area's routing label, such as `pm:foundation`, and
`pm-proposal`. ShipGremlins reuses an applicable team or workspace label by name,
case-insensitively, and creates missing labels in the mapped team. If another
PM creates the label at the same time or the response is lost, it looks up the
label again before reporting failure. Deleted labels are checked again on the
next run. Ordinary label creation does not require another owner approval.

Before launching a PM, the controller also repairs an open `pm-proposal` issue
that lacks an area label when its Linear project belongs to exactly one
configured PM. It checks the issue's current project and team, skips conflicting
area labels and closed issues, and adds only the missing label. Approval, state
and other labels are preserved. Shared project mappings need the PM to establish
which matching proposal it owns before repairing it. PM instructions apply the
same rules to new proposals and additional classification labels.

If the selected connection cannot read/create labels or update proposals, the
run explains the access needed; it does not silently continue with unroutable
tickets. Label repair never creates replacement teams/projects, changes mappings,
approves work or marks tickets Done.

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
not block verification of other configured PMs. Clicking **Run once** or
**Explore product ideas** on that PM deliberately prepares its missing mapping
and verifies connections. Code-only Discovery remains available when its source,
AI, and worker requirements are ready. To enable automation, verify connections
and explicitly resume it. Explicit provisioning also remains available for
creating missing resources.

## Vercel preview access

For a manual token, open the Vercel card in Connections and use its link to
[Vercel Tokens](https://vercel.com/account/tokens). Name the token ShipGremlins,
select the team or project you need, choose an expiration, and save it in the
card's personal-token form. Vercel's [token guide](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token)
explains the available scopes. You do not need to copy an environment-variable
assignment or edit a file.

Choose the Vercel account/team and projects available to the integration. Open **Project → Environment → Find my Vercel environment** to discover matching projects and existing Preview or custom staging deployments. Select the actual project and branch, then save the environment and test browser access. New targets are stored in named `environments`; legacy `vercel` settings remain supported. An OAuth installation's team is used when no team ID is configured. A team outside that installation requires another connection. Advanced resource IDs remain editable in project settings.

Connecting Vercel alone creates nothing. If there is no test deployment, **Create a test preview** prepares a reviewed branch and commit, then explicitly creates a Preview using a connection with deployment write access. Existing branches are preserved. Preview variables must already point to safe test services; ShipGremlins does not copy production secrets or create test accounts. Ask the Setup Gremlin for contextual guidance. [Vercel environment flow and limits →](VERCEL_ENVIRONMENTS.md)

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
