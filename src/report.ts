// The one Slack message per PM run. The PM writes the report as plain JSON
// (no mrkdwn, no links pre-built) so this file owns the whole layout; the
// `text` is the same message in plain lines for notifications and tests.

import type { SlackClient } from "./services/types.ts";
import {
  boundedText,
  escapeSlack,
  safeHttpsLink,
  slackLink,
} from "./slack/messages.ts";

export interface RunReport {
  project: string;
  area: string;
  date: string;
  testedSha: string | null;
  runUrl: string;
  filed: {
    identifier: string;
    title: string;
    url: string;
    tier: "A" | "B" | "C";
  }[];
  verified: { pr: number; title: string; url: string; summary: string }[];
  failed: { pr: number; title: string; url: string; summary: string }[];
  needsYou: { text: string; url?: string }[];
  promotion: { pr: number; url: string; changes: string[] } | null;
  note: string | null;
}

const ITEM_LIMIT = 12;

const esc = (s: string): string => escapeSlack(boundedText(s, 400));
const link = slackLink;

const header = (text: string) => ({
  type: "header",
  text: { type: "plain_text", text: boundedText(text, 150) },
});
const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text, verbatim: true },
});
const context = (text: string) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: boundedText(text, 1900), verbatim: true }],
});

interface Rendered {
  lines: string[];
  blocks: unknown[];
}

/** one titled list in both renderings; `plain`/`rich` give the item's two forms */
function list<T>(
  title: string,
  items: T[],
  plain: (item: T, i: number) => string,
  rich: (item: T, i: number) => string,
): Rendered {
  if (items.length === 0) return { lines: [], blocks: [] };
  const shown: T[] = [];
  let length = esc(title).length + 64;
  for (const item of items.slice(0, ITEM_LIMIT)) {
    const line = rich(item, shown.length);
    if (length + line.length > 2900) break;
    shown.push(item);
    length += line.length + 1;
  }
  const more = items.length - shown.length;
  const moreLine = more > 0 ? [`…and ${more} more`] : [];
  return {
    lines: [
      "",
      title,
      ...shown.map((item, i) => boundedText(plain(item, i), 1000)),
      ...moreLine,
    ],
    blocks: [
      section([`*${esc(title)}*`, ...shown.map(rich), ...moreLine].join("\n")),
    ],
  };
}

export function buildReport(r: RunReport): { text: string; blocks: unknown[] } {
  const title = `{g} 🔎 PM Gremlin · ${boundedText(r.project, 40)} · ${boundedText(r.area, 40)} · ${boundedText(r.date, 20)}${r.testedSha ? ` — tested ${r.testedSha.slice(0, 12)}` : ""}`;
  const counts = `Filed ${r.filed.length} · Verified ${r.verified.length} · Failed ${r.failed.length} · Needs you ${r.needsYou.length}`;

  const parts: Rendered[] = [
    list(
      "Filed",
      r.filed,
      (f) => `- ${f.identifier} ${f.title} (tier ${f.tier})`,
      (f) => `• ${link(f.url, f.identifier)} ${esc(f.title)} · tier ${f.tier}`,
    ),
    list(
      "Verified",
      r.verified,
      (v) => `- #${v.pr} ${v.title} — ${v.summary}`,
      (v) => `• ${link(v.url, `#${v.pr}`)} ${esc(v.title)} — ${esc(v.summary)}`,
    ),
    list(
      "Failed",
      r.failed,
      (f) => `- #${f.pr} ${f.title} — ${f.summary}`,
      (f) => `• ${link(f.url, `#${f.pr}`)} ${esc(f.title)} — ${esc(f.summary)}`,
    ),
    list(
      "Needs you",
      r.needsYou,
      (n, i) =>
        `${i + 1}. ${n.text}${safeHttpsLink(n.url) ? ` (${safeHttpsLink(n.url)})` : ""}`,
      (n, i) => `${i + 1}. ${link(n.url, n.text)}`,
    ),
  ];
  if (r.promotion) {
    const p = r.promotion;
    const changes = list(
      "Changes",
      p.changes,
      (change) => `- ${change}`,
      (change) => `• ${esc(change)}`,
    );
    parts.push({
      lines: [
        "",
        `Ready for staging: PR #${p.pr}${safeHttpsLink(p.url) ? ` (${safeHttpsLink(p.url)})` : ""}`,
        ...changes.lines.slice(2),
      ],
      blocks: [
        section(
          [`*Ready for staging* — ${link(p.url, `PR #${p.pr}`)}`].join("\n"),
        ),
        ...changes.blocks,
      ],
    });
  }
  if (parts.every((p) => p.lines.length === 0)) {
    parts.push({
      lines: ["", "Nothing new this run."],
      blocks: [section("Nothing new this run.")],
    });
  }
  if (r.note)
    parts.push({ lines: ["", r.note], blocks: [context(esc(r.note))] });

  return {
    text: boundedText(
      escapeSlack([title, counts, ...parts.flatMap((p) => p.lines)].join("\n")),
      3500,
    ),
    blocks: [
      header(title),
      context(`${esc(counts)} · ${link(r.runUrl, "run log")}`),
      ...parts.flatMap((p) => p.blocks),
    ],
  };
}

export async function postReport(
  slack: SlackClient,
  webhookUrl: string,
  report: RunReport,
): Promise<void> {
  const { text, blocks } = buildReport(report);
  await slack.post(webhookUrl, blocks, text);
}
