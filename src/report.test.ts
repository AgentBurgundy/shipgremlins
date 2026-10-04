import { describe, expect, it } from "vitest";
import { FakeSlack } from "./services/fakes.ts";
import { buildReport, postReport, type RunReport } from "./report.ts";

const base: RunReport = {
  project: "game",
  area: "Core",
  date: "2026-10-02",
  testedSha: "0123456789abcdef0123456789abcdef01234567",
  runUrl: "https://github.com/owner/pm-hub/actions/runs/77",
  filed: [],
  verified: [],
  failed: [],
  needsYou: [],
  promotion: null,
  note: null,
};

const full: RunReport = {
  ...base,
  filed: [
    {
      identifier: "GAME-12",
      title: "Start button does nothing on mobile",
      url: "https://linear.app/x/issue/GAME-12",
      tier: "A",
    },
    {
      identifier: "GAME-13",
      title: "Add a <share> link",
      url: "https://linear.app/x/issue/GAME-13",
      tier: "C",
    },
  ],
  verified: [
    {
      pr: 10,
      title: "Faster start",
      url: "https://github.com/owner/game/pull/10",
      summary: "loads in under a second",
    },
  ],
  failed: [
    {
      pr: 11,
      title: "Share sheet",
      url: "https://github.com/owner/game/pull/11",
      summary: "the sheet never opened",
    },
  ],
  needsYou: [
    {
      text: "Merge the sync PR — it conflicts with staging",
      url: "https://github.com/owner/game/pull/5",
    },
    { text: "Billing & tax prefix touched in #10" },
  ],
  promotion: {
    pr: 20,
    url: "https://github.com/owner/game/pull/20",
    changes: ["Faster start", "Clearer error page"],
  },
  note: "Quiet week; the metric is flat.",
};

type Block = {
  type: string;
  text?: { type: string; text: string };
  elements?: { text: string }[];
};

describe("buildReport", () => {
  it("renders header, counts, every section in order, the promotion last and the note at the end", () => {
    const { text, blocks } = buildReport(full);
    const lines = text.split("\n");
    expect(lines[0]).toBe("game · Core · 2026-10-02 — tested 0123456789ab");
    expect(lines[1]).toBe("Filed 2 · Verified 1 · Failed 1 · Needs you 2");
    expect(text).toBe(
      [
        "game · Core · 2026-10-02 — tested 0123456789ab",
        "Filed 2 · Verified 1 · Failed 1 · Needs you 2",
        "",
        "Filed",
        "- GAME-12 Start button does nothing on mobile (tier A)",
        "- GAME-13 Add a <share> link (tier C)",
        "",
        "Verified",
        "- #10 Faster start — loads in under a second",
        "",
        "Failed",
        "- #11 Share sheet — the sheet never opened",
        "",
        "Needs you",
        "1. Merge the sync PR — it conflicts with staging (https://github.com/owner/game/pull/5)",
        "2. Billing & tax prefix touched in #10",
        "",
        "Ready for staging: PR #20 (https://github.com/owner/game/pull/20)",
        "- Faster start",
        "- Clearer error page",
        "",
        "Quiet week; the metric is flat.",
      ].join("\n"),
    );

    const typed = blocks as Block[];
    expect(typed[0]).toEqual({
      type: "header",
      text: {
        type: "plain_text",
        text: "game · Core · 2026-10-02 — tested 0123456789ab",
      },
    });
    expect(typed[1]!.type).toBe("context");
    expect(typed[1]!.elements![0]!.text).toBe(
      "Filed 2 · Verified 1 · Failed 1 · Needs you 2 · <https://github.com/owner/pm-hub/actions/runs/77|run log>",
    );
    const sections = typed
      .filter((b) => b.type === "section")
      .map((b) => b.text!.text);
    expect(sections.map((s) => s.split("\n")[0])).toEqual([
      "*Filed*",
      "*Verified*",
      "*Failed*",
      "*Needs you*",
      "*Ready for staging* — <https://github.com/owner/game/pull/20|PR #20>",
    ]);
    expect(sections[0]).toContain(
      "<https://linear.app/x/issue/GAME-13|GAME-13> Add a &lt;share&gt; link · tier C",
    );
    expect(sections[3]).toContain("2. Billing &amp; tax prefix touched in #10");
    expect(sections[4]).toContain("• Faster start\n• Clearer error page");
    const last = typed[typed.length - 1]!;
    expect(last.type).toBe("context");
    expect(last.elements![0]!.text).toBe("Quiet week; the metric is flat.");
  });

  it("omits empty sections, the promotion and the note", () => {
    const { text, blocks } = buildReport({ ...base, filed: full.filed });
    expect(text).toBe(
      [
        "game · Core · 2026-10-02 — tested 0123456789ab",
        "Filed 2 · Verified 0 · Failed 0 · Needs you 0",
        "",
        "Filed",
        "- GAME-12 Start button does nothing on mobile (tier A)",
        "- GAME-13 Add a <share> link (tier C)",
      ].join("\n"),
    );
    const typed = blocks as Block[];
    expect(typed.map((b) => b.type)).toEqual(["header", "context", "section"]);
    expect(typed[2]!.text!.text.startsWith("*Filed*")).toBe(true);
  });

  it("says so when nothing happened and leaves out the tested sha when there is none", () => {
    const { text, blocks } = buildReport({ ...base, testedSha: null });
    expect(text).toBe(
      [
        "game · Core · 2026-10-02",
        "Filed 0 · Verified 0 · Failed 0 · Needs you 0",
        "",
        "Nothing new this run.",
      ].join("\n"),
    );
    const typed = blocks as Block[];
    expect(typed[0]!.text!.text).toBe("game · Core · 2026-10-02");
    expect(typed[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Nothing new this run." },
    });
  });

  it("caps long sections and says how many more", () => {
    const filed = Array.from({ length: 15 }, (_, i) => ({
      identifier: `GAME-${i}`,
      title: `Thing ${i}`,
      url: `https://linear.app/x/issue/GAME-${i}`,
      tier: "B" as const,
    }));
    const { text } = buildReport({ ...base, filed });
    expect(text).toContain("- GAME-11 Thing 11 (tier B)");
    expect(text).not.toContain("- GAME-12 Thing 12");
    expect(text).toContain("…and 3 more");
  });
});

describe("postReport", () => {
  it("posts the built message to the webhook", async () => {
    const slack = new FakeSlack();
    await postReport(slack, "https://hooks.slack.com/services/x", full);
    expect(slack.posts).toHaveLength(1);
    const post = slack.posts[0]!;
    expect(post.webhookUrl).toBe("https://hooks.slack.com/services/x");
    expect(post.text).toBe(buildReport(full).text);
    expect(post.blocks).toEqual(buildReport(full).blocks);
  });
});
