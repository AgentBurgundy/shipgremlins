# Your crew in Slack

PM Gremlins and Coding Gremlins post compact updates with their role, project, mandate or ticket, and run number. Coding updates link to the draft for review. **A draft is not Done: Done means merged into production.**

**Connect Slack once for the workspace. Every project uses that channel by
default.** You do not need a webhook per project, and Slack is optional: PMs and
coding jobs still run when no Slack connection is configured.

## Connect a channel

1. Open your dashboard with `gremlins setup`, or `gremlins setup --lan` on a homelab server.
2. Open the Slack connection and choose **Add to Slack**. Confirm the dashboard address, select your workspace and channel, and authorize the connection.
3. Return to your dashboard. It shows the connected workspace and channel; the webhook itself stays private.

If Add to Slack is unavailable, create a [Slack incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) and paste it into the dashboard's webhook field. The connection works for all projects unless a project has an explicit override.

Connecting does not send a test message. New PM and developer jobs produce these updates:

| Event                          | Message                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| A container starts             | 🔎 PM Gremlin or 🛠️ Coding Gremlin is on the job                                     |
| PM patrol completes            | A visible result summary and an explicit findings count when the result provides one |
| Coding work produces a draft   | Checks and a **Review draft** button; production remains the completion gate         |
| No code changes are needed     | A separate result without claiming a draft exists                                    |
| Preparation or execution fails | A blocker notification directing you to redacted logs and evidence                   |

Browser readiness checks stay out of Slack. Findings counts are never inferred from the length of logs. These messages describe visible work and results, not private model reasoning.

## Delivery and privacy

The controller records each notification attempt before sending it. Restarts do not repeat an attempted event. This is **at-most-once delivery**, not guaranteed delivery: a crash after recording the attempt, a timeout, a rejected webhook, or a rate limit can lose a message. Failed attempts remain visible in the job's logs and are not automatically retried. The dashboard's job state, logs, and artifacts are the source of truth.

Slack requests time out after five seconds. Delivery runs separately from the queue; a failed notification cannot fail or repeat an agent job. There are no channel-reading permissions, chat commands, or Slack-driven approvals in this integration. Incoming webhooks can post to the channel selected during authorization.

The local connection is saved under `<configuration>/.run/slack/connection.json`, with owner-only permissions where supported. It contains a credential and is not encrypted at rest. Keep the configuration directory private, out of Git, and in your protected backups. Runtime updates preserve it. Disconnect removes the local connection; revoke the webhook or app in Slack to invalidate the remote credential too.

Known saved credentials and common credential formats are redacted before local job notifications are sent. Text is escaped to prevent generated Slack mentions, lengths are bounded, and links require HTTPS without embedded credentials, query parameters, or fragments. Links and media do not unfurl automatically. Redaction is a best-effort safeguard; use staging accounts and avoid including sensitive customer data in job output.

## Optional per-project channels

A project's `slackWebhookSecret` names an environment variable, for example `SLACK_WEBHOOK_MY_APP`. Only set a value if this project should post to a different channel. The dashboard keeps these optional overrides in an expandable advanced section; an empty override inherits the workspace channel. Save its incoming webhook there, or export that variable on the controller. Do not put the URL directly in `project.json`.

Precedence is: exported project variable, saved project connection, then the instance-wide channel selected above. An invalid configured override fails that notification rather than silently posting to a different channel. Disconnecting the instance-wide connection does not remove a per-project override; clear that override separately if you want to stop its messages.

The older explicit `gremlins slack` PM report command remains available for advanced CI workflows. It uses the same branded report formatting and restricted webhook transport. Its manual invocations are separate from the local queue's notification-attempt ledger.

## Maintaining the OAuth broker

The local dashboard uses the official broker at `https://shipgremlins.ai`; it does not need a Slack client secret or a publicly reachable homelab callback. The broker implementation is in `slack-app/oauth.mjs`, with the deployment route in `slack-app/api/slack/[action].js` and a Slack app manifest alongside the broker.

The broker deployment needs `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_OAUTH_STATE_KEY` (32 random bytes encoded as base64url). Configure the Slack redirect URL as `https://shipgremlins.ai/api/slack/callback` and request only the `incoming-webhook` scope. Keep the client secret and state key in the deployment's secret store. Generating a state key:

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
```

The dashboard creates a short-lived pairing key and nonce and sends them to the broker over HTTPS. The user confirms the exact dashboard origin before authorization. The broker validates OAuth state with a short-lived browser cookie, then returns an encrypted result in a URL fragment. The dashboard checks its pending session, nonce, and expiry before saving the connection. Raw webhook credentials are not placed in callback query strings or retained by the broker. Hosting infrastructure can still retain request metadata such as IP addresses and encrypted URLs.

The connection UI checks broker availability and offers the webhook fallback. Automated tests use fake Slack responses; they do not send Slack messages or certify a workspace's live installation. Maintain the deployment and test the real authorization flow before announcing OAuth availability.
