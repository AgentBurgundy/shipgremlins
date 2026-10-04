// Slack incoming webhooks: one POST, no retry (a repeated post is a duplicate
// message, not a recovered one).

import type { SlackClient } from "./types.ts";

export class SlackWebhook implements SlackClient {
  async post(
    webhookUrl: string,
    blocks: unknown[],
    text: string,
  ): Promise<void> {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, blocks }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // the webhook URL is a secret — name the host only
      throw new Error(
        `Slack webhook (${new URL(webhookUrl).host}) → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
  }
}
