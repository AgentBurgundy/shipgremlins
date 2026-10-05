# Project logs and analytics

PMs can read their project's **Sentry logs and error events**, **Datadog logs**,
and **Mixpanel Insights reports** alongside browser evidence. Connections are
optional and configured per project. These adapters read telemetry your app
already sends to the providers; they do not install SDKs or ingest events.

## Connect a project

1. Open **Connections** and find Sentry, Datadog, or Mixpanel under product signals.
2. Choose your project and open its configuration from that card. Enable the
   provider and enter its project/service scope, environment, or region. The form
   supplies credential names and preserves any custom names already configured.
3. Save the project, then enter credentials in that provider's project access
   fields in Connections. Stored values are never returned to the browser.
4. For Mixpanel, open **Choose a saved report for each PM** in its card. Select the
   project, enter each PM's numeric saved Insights report ID, and save. New PMs
   can also set their report ID during creation. At least one report mapping is
   needed for Mixpanel verification.
5. Run **Verify connections** on the project before relying on scheduled work.

The same provider forms are available from **Projects → Edit settings**. Switching
pages preserves drafts. Concurrent configuration edits are rejected rather than
overwritten; reload the latest settings and reapply your changes. Disabling a
provider removes its project configuration but keeps saved credentials.

For advanced file-based setup, merge the providers you use into
`projects/my-app/project.json`. Keep its other settings. Omit unused providers, or
leave `telemetry` as `{}`. Existing projects need no changes to keep using Vercel
logs and analytics.

```json
{
  "telemetry": {
    "sentry": {
      "host": "sentry.io",
      "organization": "your-org",
      "project": "my-app",
      "environment": "production",
      "tokenSecret": "SENTRY_AUTH_TOKEN_MY_APP"
    },
    "datadog": {
      "site": "datadoghq.com",
      "service": "my-app",
      "environment": "production",
      "apiKeySecret": "DD_API_KEY_MY_APP",
      "appKeySecret": "DD_APP_KEY_MY_APP"
    },
    "mixpanel": {
      "region": "us",
      "projectId": "123456",
      "usernameSecret": "MIXPANEL_USERNAME_MY_APP",
      "passwordSecret": "MIXPANEL_PASSWORD_MY_APP"
    }
  }
}
```

All `*Secret` fields contain **environment-variable names**, never credentials.
Use the provider prefixes shown above and an uppercase project suffix. Scope
values cannot contain wildcards or query syntax; log connections require an
explicit environment.

After saving the project, its credential fields appear in that provider's
Connections card. Values stay in the local `.env` and are loaded
by the CLI; exported variables take precedence. Alternatively populate those
names in your local environment. Do not pass credentials on the command line.

For GitHub Actions, add the same named secrets to your private hub repository.
Saving a dashboard connection does not provision Actions secrets. `pm-agent.yml`
resolves only the current project's telemetry secrets for the PM step. Developer
jobs do not receive these new secrets.

Local Docker PM workers receive a controller-fetched snapshot at job preparation:
up to 10 recent rows per log/error source and the area's Mixpanel report. Provider
credentials stay outside the container. Start another PM run to refresh that
snapshot; the local worker cannot query new telemetry during its run. Large
Mixpanel reports need narrowing to fit the local snapshot's 25,000-character limit.

### Sentry

Use a token with `org:read` and access to the intended project. The reader uses
Sentry's [Explore table API](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/)
with separate `logs` and `errors` datasets and fixed project/environment filters.
Use the project's slug or positive numeric ID. Structured logs must already be
enabled and ingested in Sentry; error events and structured logs are separate
signals, so one may be available while the other is not.

Hosted domains: `sentry.io` (default), `us.sentry.io`, `de.sentry.io`.
Self-hosted Sentry endpoints are not supported by this adapter.

### Datadog

Use an API key and a scoped application key with `logs_read_data`. The
[log search API](https://docs.datadoghq.com/api/latest/logs/search-logs-post/)
uses both the configured `service` and `env` tags. Use a service name unique to
your app within that environment. Entries must have those tags to match.

Supported sites: `datadoghq.com` (default), `us3.datadoghq.com`,
`us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`,
`uk1.datadoghq.com`, `ddog-gov.com`, `us2.ddog-gov.com`.

### Mixpanel

Create a [service account](https://docs.mixpanel.com/reference/service-accounts)
with read access to the target project and report. Supply its username and
secret, not an ingestion token. Regions: `us` (default), `eu`, `in`.
Add `workspaceId` as a numeric string to `telemetry.mixpanel` when needed.

Create a saved Insights report for each PM's metric. Assign its bookmark ID using
the Mixpanel card's PM report form, or set it as a string in the existing area in
`areas.json`, for example:

```json
"mixpanelReportId": "987654"
```

The [saved-report API](https://docs.mixpanel.com/reference/insights-query)
uses the configured project, optional workspace and report IDs. Configure the
date window, events, environment filters, units and breakdowns in the saved
report. Prefer a rolling window for daily PM runs. At least one area must name a
report for the Mixpanel doctor check to pass.

Areas with `mixpanelReportId` use Mixpanel in `gremlins metric`; other areas
keep their existing Vercel metric. Unavailable Mixpanel reports never silently
fall back to Vercel. Output preserves `date_range`, `computed_at`, `headers`
and `series`, without inventing 7/28-day counts or summing unique users across
buckets. Use aggregate reports without customer identifiers in their labels.

## Inspect and verify

```bash
gremlins validate
gremlins setup --check --project my-app
gremlins doctor my-app
gremlins logs --project my-app
gremlins logs --project my-app --provider sentry --hours 1 --limit 50
gremlins logs --project my-app --provider datadog --hours 48 --limit 100
gremlins metric --project my-app --area core
```

Preflight checks credential presence locally. `doctor` performs live scoped
reads for configured log sources and each area's Mixpanel report, alongside
existing repository, deployment and ticket checks. An inaccessible configured
source fails verification; a successful empty log response passes.

`logs` returns JSON with independent status and scope for each source. It reads
the newest 25 rows per source from the past 24 hours by default. `--limit` accepts
1–100; `--hours` accepts 1–168. Sentry returns separate log and error samples.
`limited: true` means the sample may omit additional results. It does not follow
pagination or perform a full export.

| Status           | Meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ok`             | The query succeeded. Empty data is a valid sample, not proof of health.                                                        |
| `unavailable`    | Missing credentials, denied access, provider failure/rate limit, or an unsupported response. Never interpret as zero activity. |
| `not-configured` | This optional source was not connected.                                                                                        |

Optional failures leave other sources usable and do not terminate a PM run.
Invalid flags or configuration fail the command. Responses are bounded,
requests time out after 15 seconds, and redirects are refused.

## How PMs use the evidence

PMs inspect logs at the start of observation. Actions PMs can also refresh them
after reproducing a failure; local workers use their starting snapshot.
They correlate provider, event ID, time and environment with browser behavior,
then prioritize within their mandate. Production signals can guide a staging
investigation; they do not prove staging failures or authorize promotion.
Missing access is reported rather than hidden.

Readers select log fields and omit arbitrary request/user payloads. Known
connection credentials and common credential, email and IP patterns are
redacted, and long messages shortened. Redaction is best effort: keep
provider-side scrubbing enabled. Log messages and report labels are untrusted
data, never agent instructions. Tickets and memory should contain concise
sanitized findings, not raw dumps. PM output can appear in private run artifacts;
control access to those artifacts too.

Fixed CLI query scopes are not a sandbox for the agent's shell. Enforce access
limits with provider-side roles, project membership and log restrictions, and
use separate credentials per project. Automated tests use mocked HTTP; run
`doctor` against your provider accounts before enabling scheduled PMs.
