import { loadProject } from "../config.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { readConnections } from "../setup/connections.ts";
import { getSlackConnection, validSlackWebhook } from "./connection.ts";

export interface JobNotificationEvent {
  id: string;
  type: "started" | "succeeded" | "failed";
  job: LocalJob;
  workerName?: string;
  /** Credential-free owner dashboard origin; never a session link. */
  dashboardUrl?: string;
  result?: {
    summary?: string;
    findingsCount?: number;
    checks?: string[];
    prUrl?: string;
    noChanges?: boolean;
  };
}

export interface NotificationResult {
  status: "sent" | "skipped" | "failed";
  message?: string;
}

export interface NotificationOptions {
  fetch?: typeof fetch;
  getConnection?: typeof getSlackConnection;
  projectWebhook?: (root: string, project: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Slack interprets angle brackets as mentions and links, even in fallback text. */
export function escapeSlack(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function boundedText(value: string, limit: number): string {
  const clean = [...value]
    .filter(
      (char) =>
        char === "\n" ||
        char === "\t" ||
        (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join("");
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/** No credential-bearing, malformed, or Slack delimiter-bearing links. */
export function safeHttpsLink(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 1000 ||
    /[\s<>|\\]/.test(value)
  )
    return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.hash ||
      url.search
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

export function slackLink(value: unknown, label: string): string {
  const url = safeHttpsLink(value);
  const text = escapeSlack(boundedText(label, 200)).replace(/\|/g, "¦");
  return url ? `<${url}|${text}>` : text;
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return boundedText(
    value
      .replace(
        /https:\/\/hooks\.slack\.com\/services\/[^\s<>"']+/gi,
        "[REDACTED]",
      )
      .replace(
        /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+)/g,
        "[REDACTED]",
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
      .replace(
        /((?:password|token|api[_-]?key|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
        "$1[REDACTED]",
      ),
    limit,
  );
}

export function notificationResult(
  value: unknown,
): JobNotificationEvent["result"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  return {
    summary: clean(result.summary, 1200) || undefined,
    findingsCount:
      Number.isSafeInteger(result.findingsCount) &&
      Number(result.findingsCount) >= 0
        ? Number(result.findingsCount)
        : undefined,
    checks: Array.isArray(result.checks)
      ? result.checks
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 8)
          .map((entry) => clean(entry, 80))
      : undefined,
    prUrl: safeHttpsLink(result.prUrl),
    noChanges: result.noChanges === true,
  };
}

export function buildJobNotification(event: JobNotificationEvent): {
  text: string;
  blocks: unknown[];
  unfurl_links: false;
  unfurl_media: false;
} {
  const job = event.job;
  const coding = job.type === "developer";
  const role = coding ? "Coding Gremlin" : "PM Gremlin";
  const result = notificationResult(event.result);
  const prUrl = safeHttpsLink(result?.prUrl);
  const dashboard = safeHttpsLink(event.dashboardUrl);
  const state =
    event.type === "started"
      ? "On the job"
      : event.type === "failed"
        ? "Needs a human"
        : coding
          ? prUrl
            ? "Draft ready for review"
            : result?.noChanges
              ? "No code changes needed"
              : "Run complete · review results"
          : "Patrol finished";
  const title = `{g} ${coding ? "🛠️" : "🔎"} ${role} · ${state}`;
  const context = [
    clean(job.project, 80),
    coding ? clean(job.ticket, 100) : clean(job.area, 80),
    `Run #${job.runId}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const description =
    event.type === "started"
      ? coding
        ? "Picking up the approved ticket. Checks must pass before a draft is published."
        : "Exploring the app against this PM’s mandate and collecting evidence."
      : event.type === "failed"
        ? clean(job.message, 800) ||
          "The run hit a blocker. Open the dashboard for redacted logs and evidence before retrying."
        : coding
          ? prUrl
            ? "Configured checks passed. The draft is ready for human review; the ticket is not Done. Done means merged into production."
            : result?.noChanges
              ? "The run finished without code changes. Review its logs before changing ticket status."
              : "The worker completed this run. Review the dashboard artifacts; no draft link was reported."
          : result?.summary ||
            "The PM completed its patrol. Open the dashboard for findings, visible activity, and evidence.";
  const fields = [
    {
      type: "plain_text",
      text: `Project\n${clean(job.project, 80) || "Local workspace"}`,
    },
    {
      type: "plain_text",
      text: `${coding ? "Ticket" : "Mandate"}\n${clean(coding ? job.ticket : job.area, 100) || "—"}`,
    },
  ];
  if (
    result?.findingsCount !== undefined &&
    !coding &&
    event.type === "succeeded"
  )
    fields.push({
      type: "plain_text",
      text: `Reported findings\n${result.findingsCount}`,
    });
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: boundedText(title, 150), emoji: true },
    },
    { type: "section", fields },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedText(escapeSlack(boundedText(description, 1500)), 2900),
        verbatim: true,
      },
    },
  ];
  if (result?.checks?.length && event.type === "succeeded")
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: boundedText(`Checks: ${result.checks.join(" · ")}`, 1000),
        },
      ],
    });
  if (prUrl && event.type === "succeeded" && coding)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "open_gremlin_draft",
          text: { type: "plain_text", text: "Review draft", emoji: true },
          url: prUrl,
        },
      ],
    });
  if (dashboard) {
    const review = new URL(
      job.project ? `/projects/${encodeURIComponent(job.project)}` : "/inbox",
      dashboard,
    ).href;
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "open_gremlin_review",
          text: {
            type: "plain_text",
            text: "Open project review",
            emoji: true,
          },
          url: review,
        },
      ],
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "plain_text",
        text: boundedText(
          `ShipGremlins · Run #${job.runId}${event.workerName ? ` · ${clean(event.workerName, 80)}` : ""} · ${clean(job.finishedAt ?? job.startedAt ?? job.createdAt, 40)}`,
          500,
        ),
      },
    ],
  });
  return {
    text: boundedText(
      escapeSlack(
        [title, context, description, prUrl ? `Review draft: ${prUrl}` : ""]
          .filter(Boolean)
          .join("\n"),
      ),
      3500,
    ),
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

export function isSlackWebhook(value: string): boolean {
  return validSlackWebhook(value);
}

/** One bounded attempt. The engine claims delivery durably before calling this. */
export async function sendJobNotification(
  root: string,
  event: JobNotificationEvent,
  options: NotificationOptions = {},
): Promise<NotificationResult> {
  if (event.job.type === "verify") return { status: "skipped" };
  const env = options.env ?? process.env;
  let webhook: string | undefined;
  let secrets: string[] = [];
  try {
    if (event.job.project) {
      if (options.projectWebhook)
        webhook = options.projectWebhook(root, event.job.project);
      else {
        let secretName: string | undefined;
        try {
          secretName = loadProject(root, event.job.project).config
            .slackWebhookSecret;
        } catch {
          /* A global connection works before project setup is complete. */
        }
        if (secretName) {
          const saved = readConnections(root);
          secrets = Object.values(saved);
          webhook = env[secretName] || saved[secretName];
        }
      }
    }
    webhook ||= (await (options.getConnection ?? getSlackConnection)(root))
      ?.webhookUrl;
    if (!webhook) return { status: "skipped" };
    if (!isSlackWebhook(webhook))
      return {
        status: "failed",
        message:
          "Slack notification was not sent: configure a valid Slack incoming webhook.",
      };
    secrets.push(
      webhook,
      ...Object.entries(env)
        .filter(
          ([key, value]) =>
            /TOKEN|SECRET|PASSWORD|API_KEY/.test(key) && Boolean(value),
        )
        .map(([, value]) => value!),
    );
    let encoded = JSON.stringify({
      ...event,
      dashboardUrl: safeHttpsLink(env.SHIPGREMLINS_DASHBOARD_URL),
    });
    // Replace JSON-escaped credential bytes, preserving a valid JSON payload.
    for (const secret of secrets
      .filter((value) => value.length >= 4)
      .sort((a, b) => b.length - a.length))
      encoded = encoded
        .split(JSON.stringify(secret).slice(1, -1))
        .join("[REDACTED]");
    const body = JSON.stringify(
      buildJobNotification(JSON.parse(encoded) as JobNotificationEvent),
    );
    const controller = new AbortController();
    const timeoutMs = Math.min(10_000, Math.max(1, options.timeoutMs ?? 5000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        (options.fetch ?? fetch)(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
          redirect: "error",
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        }),
      ]);
      void response.body?.cancel().catch(() => undefined);
      return response.ok
        ? { status: "sent" }
        : {
            status: "failed",
            message:
              "Slack rejected the notification. Check its connection and channel permissions; this attempt will not repeat.",
          };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return {
      status: "failed",
      message:
        "Slack notification could not be delivered. Check the connection and network; this attempt will not repeat.",
    };
  }
}
