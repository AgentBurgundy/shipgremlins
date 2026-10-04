// Slack incoming webhooks: one POST, no retry (a repeated post is a duplicate
// message, not a recovered one).

import type { SlackClient } from "./types.ts";
import { validSlackWebhook } from "../slack/connection.ts";

export class SlackWebhook implements SlackClient {
  constructor(
    private readonly options: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}
  async post(
    webhookUrl: string,
    blocks: unknown[],
    text: string,
  ): Promise<void> {
    if (!validSlackWebhook(webhookUrl))
      throw new Error(
        "Configure a valid Slack incoming webhook before sending a report.",
      );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        (this.options.fetch ?? fetch)(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
          redirect: "error",
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error());
            },
            Math.min(5000, Math.max(1, this.options.timeoutMs ?? 5000)),
          );
        }),
      ]);
      void res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Error();
    } catch {
      throw new Error(
        "The Slack report could not be delivered. Check the webhook, channel permissions, and network.",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
