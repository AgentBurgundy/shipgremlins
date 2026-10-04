// The one Slack message per PM run. The PM writes the report as plain JSON
// (no mrkdwn, no links pre-built) so this file owns the whole layout; the
// `text` is the same message in plain lines for notifications and tests.

import type { SlackClient } from "./services/types.ts";

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

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (url: string | undefined, text: string): string =>
  url ? `<${esc(url)}|${esc(text)}>` : esc(text);

const header = (text: string) => ({
  type: "header",
  text: { type: "plain_text", text },
});
const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text },
});
const context = (text: string) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
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
  const shown = items.slice(0, ITEM_LIMIT);
  const more = items.length - shown.length;
  const moreLine = more > 0 ? [`…and ${more} more`] : [];
  return {
    lines: ["", title, ...shown.map(plain), ...moreLine],
    blocks: [
      section([`*${esc(title)}*`, ...shown.map(rich), ...moreLine].join("\n")),
    ],
  };
}

export function buildReport(r: RunReport): { text: string; blocks: unknown[] } {
  const title = `${r.project} · ${r.area} · ${r.date}${r.testedSha ? ` — tested ${r.testedSha.slice(0, 12)}` : ""}`;
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
      (n, i) => `${i + 1}. ${n.text}${n.url ? ` (${n.url})` : ""}`,
      (n, i) => `${i + 1}. ${link(n.url, n.text)}`,
    ),
  ];
  if (r.promotion) {
    const p = r.promotion;
    parts.push({
      lines: [
        "",
        `Ready for staging: PR #${p.pr} (${p.url})`,
        ...p.changes.map((c) => `- ${c}`),
      ],
      blocks: [
        section(
          [
            `*Ready for staging* — ${link(p.url, `PR #${p.pr}`)}`,
            ...p.changes.map((c) => `• ${esc(c)}`),
          ].join("\n"),
        ),
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
    text: [title, counts, ...parts.flatMap((p) => p.lines)].join("\n"),
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
