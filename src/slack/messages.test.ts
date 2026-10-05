import { describe, expect, it, vi } from "vitest";
import {
  buildJobNotification,
  sendJobNotification,
  safeHttpsLink,
  type JobNotificationEvent,
} from "./messages.ts";
import type { SlackConnection } from "./connection.ts";

const webhookUrl = "https://hooks.slack.com/services/TEAM/CHANNEL/secret";
const connection: SlackConnection = {
  webhookUrl,
  teamId: "TEAM",
  teamName: "Test",
  channelId: "CHANNEL",
  channelName: "gremlins",
  connectedAt: "2026-10-04T15:00:00Z",
};
const event: JobNotificationEvent = {
  id: "job-test:started",
  type: "started",
  workerName: "Gremlin 1",
  job: {
    id: "job-test",
    runId: 7,
    type: "pm",
    project: "my-app",
    area: "security",
    status: "running",
    createdAt: "2026-10-04T15:00:00Z",
  },
};
const options = () => ({
  getConnection: vi.fn(async () => connection),
  projectWebhook: vi.fn(() => undefined as string | undefined),
  env: {},
  fetch: vi.fn<typeof fetch>(async () => new Response("ok")),
});

describe("branded Slack job messages", () => {
  it("links to the project review without sharing session credentials", () => {
    const message = buildJobNotification({
      ...event,
      dashboardUrl: "https://gremlins.example.test/",
    });
    expect(JSON.stringify(message.blocks)).toContain(
      "https://gremlins.example.test/projects/my-app",
    );
    for (const dashboardUrl of [
      "https://gremlins.example.test/#session=private",
      "https://owner:private@gremlins.example.test/",
      "https://gremlins.example.test/?token=private",
    ]) {
      const rendered = JSON.stringify(
        buildJobNotification({ ...event, dashboardUrl }),
      );
      expect(rendered).not.toContain("private");
    }
  });

  it("explains PM starts with role, mandate, project, run and accessible fallback", () => {
    const message = buildJobNotification(event);
    expect(message.text).toContain("{g} 🔎 PM Gremlin · On the job");
    expect(message.text).toContain("my-app · security · Run #7");
    expect(JSON.stringify(message.blocks)).toContain("Gremlin 1");
    expect(message.unfurl_links).toBe(false);
  });

  it("reports explicit PM findings without inventing a clean bill of health", () => {
    const message = buildJobNotification({
      ...event,
      type: "succeeded",
      result: { summary: "Found a missing role check.", findingsCount: 2 },
    });
    expect(message.text).toContain("Patrol finished");
    expect(message.text).toContain("Found a missing role check.");
    expect(JSON.stringify(message.blocks)).toContain("Reported findings\\n2");
    expect(
      JSON.stringify(buildJobNotification({ ...event, type: "succeeded" })),
    ).not.toContain("Reported findings");
  });

  it("sends draft-ready coding language with a validated action and production Done meaning", () => {
    const message = buildJobNotification({
      ...event,
      type: "succeeded",
      job: { ...event.job, type: "developer", ticket: "APP-17" },
      result: {
        prUrl: "https://github.com/org/app/pull/17",
        checks: ["test", "typecheck"],
      },
    });
    expect(message.text).toContain(
      "{g} 🛠️ Coding Gremlin · Draft ready for review",
    );
    expect(message.text).toContain(
      "ticket is not Done. Done means merged into production",
    );
    expect(message.blocks).toContainEqual(
      expect.objectContaining({ type: "actions" }),
    );
  });

  it("handles no changes and failures without promising a draft", () => {
    const completed = buildJobNotification({
      ...event,
      type: "succeeded",
      job: { ...event.job, type: "developer" },
      result: { noChanges: true },
    });
    expect(completed.text).toContain("No code changes needed");
    expect(completed.blocks).not.toContainEqual(
      expect.objectContaining({ type: "actions" }),
    );
    expect(
      buildJobNotification({
        ...event,
        type: "failed",
        job: { ...event.job, message: "Check configuration before retrying." },
      }).text,
    ).toContain("Needs a human");
  });

  it("escapes mentions and bounds every section, including hostile expanded escapes", () => {
    const message = buildJobNotification({
      ...event,
      type: "succeeded",
      result: {
        summary: "<!here> <@U123> & ".repeat(1000),
        prUrl: "javascript:alert(1)",
      },
    });
    const encoded = JSON.stringify(message);
    expect(encoded).not.toContain("<!here>");
    expect(encoded).not.toContain("<@U123>");
    expect(encoded).not.toContain("javascript:");
    expect(encoded).toContain("&lt;!here&gt;");
    for (const block of message.blocks as {
      type: string;
      text?: { text: string };
    }[])
      if (block.type === "section" && block.text)
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
    expect(message.text.length).toBeLessThanOrEqual(4000);
  });

  it.each([
    "http://github.com/org/app/pull/1",
    "https://user:token@github.com/org/app/pull/1",
    "https://example.com/a|<!everyone>",
    "https://example.com/a?token=private",
    "https://example.com/#session=private",
    "file:///private",
    "https://example.com/\\evil",
    "not-a-url",
  ])("rejects unsafe link %s", (link) =>
    expect(safeHttpsLink(link)).toBeUndefined(),
  );
});

describe("bounded Slack delivery", () => {
  it("uses the global channel and never follows redirects or unfurls", async () => {
    const deps = options();
    expect(await sendJobNotification("unused", event, deps)).toEqual({
      status: "sent",
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      JSON.parse(deps.fetch.mock.calls[0]![1]!.body as string),
    ).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  it("prefers a configured per-project channel and skips unconnected or verify jobs", async () => {
    const deps = options();
    const override = "https://hooks.slack.com/services/OTHER/CHANNEL/key";
    deps.projectWebhook.mockReturnValue(override);
    await sendJobNotification("unused", event, deps);
    expect(deps.getConnection).not.toHaveBeenCalled();
    expect(deps.fetch.mock.calls[0]![0]).toBe(override);
    deps.fetch.mockClear();
    expect(
      await sendJobNotification(
        "unused",
        { ...event, job: { ...event.job, type: "verify" } },
        deps,
      ),
    ).toEqual({ status: "skipped" });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(
      await sendJobNotification("unused", event, {
        ...deps,
        projectWebhook: () => undefined,
        getConnection: async () => null,
      }),
    ).toEqual({ status: "skipped" });
  });

  it.each([
    "https://example.com/services/a/b/c",
    "http://hooks.slack.com/services/a/b/c",
    "https://hooks.slack.com.evil.example/services/a/b/c",
    "https://secret@hooks.slack.com/services/a/b/c",
    "https://hooks.slack.com/services/a/b/c?token=secret",
  ])("refuses a non-Slack webhook %s", async (url) => {
    const deps = options();
    deps.projectWebhook.mockReturnValue(url);
    expect((await sendJobNotification("unused", event, deps)).status).toBe(
      "failed",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("never returns Slack response bodies or thrown credential text", async () => {
    const deps = options();
    deps.fetch.mockResolvedValue(
      new Response(`private webhook ${webhookUrl}`, { status: 403 }),
    );
    expect(
      JSON.stringify(await sendJobNotification("unused", event, deps)),
    ).not.toContain(webhookUrl);
    deps.fetch.mockRejectedValue(new Error(`credential ${webhookUrl}`));
    const result = await sendJobNotification("unused", event, deps);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(webhookUrl);
  });

  it("redacts known credentials before Slack escaping and common token formats", async () => {
    const deps = options();
    await sendJobNotification(
      "unused",
      {
        ...event,
        type: "succeeded",
        result: {
          summary: "Oops opaque<&secret and ghp_PRIVATE123 were printed.",
        },
      },
      { ...deps, env: { GITHUB_TOKEN: "opaque<&secret" } },
    );
    const body = deps.fetch.mock.calls[0]![1]!.body as string;
    expect(body).not.toContain("opaque");
    expect(body).not.toContain("ghp_PRIVATE123");
    expect(body).toContain("[REDACTED]");
  });

  it("times out a stalled request even when the fetch adapter ignores abort", async () => {
    const deps = options();
    deps.fetch.mockImplementation(() => new Promise(() => {}));
    const result = await sendJobNotification("unused", event, {
      ...deps,
      timeoutMs: 5,
    });
    expect(result.status).toBe("failed");
    expect((deps.fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(
      true,
    );
  });
});
