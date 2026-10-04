import { describe, expect, it } from "vitest";
import {
  makeCtx,
  makeProject,
  TEST_REPO,
  type TestCtx,
} from "../services/fakes.ts";
import { FakeGit } from "../git.ts";
import { FAILED_PREFIX, VERIFIED_PREFIX, promotionTitle } from "./notes.ts";
import {
  promoteWithEvidence as runPromote,
  passingEvidence,
} from "./verification.test-support.ts";
import { formatBrowserEvidence } from "./verification.ts";

const DIR = "/work/target";
const STAGING = "origin/staging";

function twoAreas(): TestCtx {
  return makeCtx({
    project: makeProject({
      areas: [
        { key: "core", name: "Core", paths: ["app/", "lib/"] },
        { key: "billing", name: "Billing", paths: ["billing/"] },
      ],
    }),
  });
}

let shaNo = 1;
const mergeSha = (): string =>
  "a1b2c3d4e5f6" + (shaNo++).toString(16).padStart(28, "0");

/** a bot PR merged into pm-staging at `mergedAt`, with its files and 🧪 comments in order */
function seedMerged(
  ctx: TestCtx,
  opts: {
    number: number;
    title?: string;
    files: string[];
    mergedAt: string;
    verdicts?: string[];
    author?: string;
    headRef?: string;
  },
): string {
  const sha = mergeSha();
  ctx.forge.seedPull(
    TEST_REPO,
    {
      number: opts.number,
      title: opts.title ?? `Change ${opts.number}`,
      state: "merged",
      mergedAt: opts.mergedAt,
      mergeCommitSha: sha,
      author: opts.author,
      headRef: opts.headRef ?? `pm/game-${opts.number}`,
    },
    opts.files,
  );
  for (const v of opts.verdicts ?? [])
    ctx.forge.seedComment(
      TEST_REPO,
      opts.number,
      formatBrowserEvidence(
        passingEvidence(
          sha,
          v.startsWith(VERIFIED_PREFIX) ? "passed" : "failed",
        ),
      ),
    );
  return sha;
}

const verified = `${VERIFIED_PREFIX} — looked right`;
const failed = `${FAILED_PREFIX} — the button did nothing`;

function promotionPulls(ctx: TestCtx) {
  return ctx.forge
    .listOpenPulls(TEST_REPO, { base: "staging" })
    .then((ps) => ps.filter((p) => p.headRef.startsWith("pm-release/")));
}

describe("runPromote", () => {
  it("picks only verified merges, holds the rest with reasons, opens one PR to staging", async () => {
    const ctx = twoAreas();
    const ok = seedMerged(ctx, {
      number: 10,
      title: "Faster start",
      files: ["app/start.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [failed, verified],
    });
    seedMerged(ctx, {
      number: 11,
      title: "Broken thing",
      files: ["app/broken.ts"],
      mergedAt: "2026-10-01T11:00:00Z",
      verdicts: [verified, failed],
    });
    seedMerged(ctx, {
      number: 12,
      title: "Untested thing",
      files: ["lib/x.ts"],
      mergedAt: "2026-10-01T12:00:00Z",
    });
    const git = new FakeGit();

    const rows = await runPromote(ctx, { git, checkoutDir: DIR });

    const cmds = git.commands();
    expect(cmds[0]).toBe("fetch origin");
    expect(cmds).toContain(`checkout -B pm-release/core/20261002 ${STAGING}`);
    expect(cmds.filter((c) => c.startsWith("cherry-pick"))).toEqual([
      `cherry-pick -x ${ok}`,
    ]);
    expect(cmds).toContain(
      "push origin HEAD:refs/heads/pm-release/core/20261002",
    );
    expect(cmds.some((c) => c.includes("--force"))).toBe(false);
    expect(git.calls.every((c) => c.cwd === DIR)).toBe(true);

    const prs = await promotionPulls(ctx);
    expect(prs).toHaveLength(1);
    const pr = prs[0]!;
    expect(pr.title).toBe(promotionTitle("Core", "2026-10-02", 1));
    expect(pr.draft).toBe(false);
    expect(pr.body).toContain(
      "- [#10](https://github.com/owner/game/pull/10) Faster start",
    );
    expect(pr.body).toContain(
      "- [#11](https://github.com/owner/game/pull/11) Broken thing — failed its test on pm-staging",
    );
    expect(pr.body).toContain(
      "- [#12](https://github.com/owner/game/pull/12) Untested thing — not tested on pm-staging yet",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rule: "promote",
      ref: `#${pr.number}`,
      text: `Core: promotion #${pr.number} — 1 new, 1 total, 2 held`,
    });
    expect(rows[1]).toMatchObject({
      rule: "promote",
      text: "Billing: nothing verified to promote",
    });
  });

  it("cherry-picks in merge order, not PR-number order", async () => {
    const ctx = twoAreas();
    const later = seedMerged(ctx, {
      number: 20,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T15:00:00Z",
      verdicts: [verified],
    });
    const earlier = seedMerged(ctx, {
      number: 21,
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit();
    await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    expect(git.commands().filter((c) => c.startsWith("cherry-pick"))).toEqual([
      `cherry-pick -x ${earlier}`,
      `cherry-pick -x ${later}`,
    ]);
    const [pr] = await promotionPulls(ctx);
    expect(pr!.title).toBe(promotionTitle("Core", "2026-10-02", 2));
    expect(pr!.body.indexOf("#21")).toBeLessThan(pr!.body.indexOf("#20"));
  });

  it("uses -m 1 when the project merges with merge commits", async () => {
    const ctx = makeCtx({
      project: makeProject({ config: { mergeMethod: "merge" } }),
    });
    const sha = seedMerged(ctx, {
      number: 1,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit();
    await runPromote(ctx, { git, checkoutDir: DIR });
    expect(git.commands()).toContain(`cherry-pick -x -m 1 ${sha}`);
  });

  it("holds a merge that shares a file with another area's older unpromoted verified merge", async () => {
    const ctx = twoAreas();
    const billingSha = seedMerged(ctx, {
      number: 30,
      title: "Billing first",
      files: ["billing/a.ts", "billing/b.ts", "lib/shared.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    seedMerged(ctx, {
      number: 31,
      title: "Core after",
      files: ["lib/shared.ts", "app/c.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit();
    const rows = await runPromote(ctx, { git, checkoutDir: DIR });

    expect(git.commands().filter((c) => c.startsWith("cherry-pick"))).toEqual([
      `cherry-pick -x ${billingSha}`,
    ]);
    const prs = await promotionPulls(ctx);
    expect(prs.map((p) => p.headRef)).toEqual(["pm-release/billing/20261002"]);
    expect(rows.map((r) => r.text)).toEqual([
      "Core: nothing verified to promote (1 held)",
      `Billing: promotion #${prs[0]!.number} — 1 new, 1 total, 0 held`,
    ]);
    expect(ctx.lines.join("\n")).toContain(
      "#31 Core after — shares lib/shared.ts with Billing's #30, merged earlier and not on staging yet — that area promotes first",
    );
  });

  it("does not hold the older side of a cross-area overlap", async () => {
    const ctx = twoAreas();
    const coreSha = seedMerged(ctx, {
      number: 40,
      files: ["lib/shared.ts", "app/c.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const billingSha = seedMerged(ctx, {
      number: 41,
      files: ["billing/a.ts", "billing/b.ts", "lib/shared.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit();
    await runPromote(ctx, { git, checkoutDir: DIR });
    const picks = git.commands().filter((c) => c.startsWith("cherry-pick"));
    expect(picks).toEqual([`cherry-pick -x ${coreSha}`]);
    expect(picks).not.toContain(`cherry-pick -x ${billingSha}`);
  });

  it("sends a developer to port a merge whose cherry-pick fails, with the later merges on the same files", async () => {
    const ctx = twoAreas();
    const good = seedMerged(ctx, {
      number: 50,
      title: "Applies",
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const bad = seedMerged(ctx, {
      number: 51,
      title: "Conflicts",
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    const dependant = seedMerged(ctx, {
      number: 52,
      title: "Builds on 51",
      files: ["app/b.ts", "app/d.ts"],
      mergedAt: "2026-10-01T11:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit([
      {
        match: `cherry-pick -x ${bad}`,
        result: { code: 1, err: "error: could not apply — CONFLICT" },
      },
    ]);
    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });

    const cmds = git.commands();
    expect(cmds).toContain(`cherry-pick -x ${good}`);
    expect(cmds).toContain(`cherry-pick -x ${bad}`);
    expect(cmds[cmds.indexOf(`cherry-pick -x ${bad}`) + 1]).toBe(
      "cherry-pick --abort",
    );
    expect(cmds).not.toContain(`cherry-pick -x ${dependant}`);

    const [pr] = await promotionPulls(ctx);
    expect(pr!.title).toBe(promotionTitle("Core", "2026-10-02", 1));
    expect(pr!.body).toContain(
      "- [#51](https://github.com/owner/game/pull/51) Conflicts — does not apply on staging as written — a developer is porting it",
    );
    expect(pr!.body).toContain(
      "- [#52](https://github.com/owner/game/pull/52) Builds on 51 — goes with the port of earlier work on app/b.ts",
    );
    expect(rows[0]!.text).toBe(
      `Core: promotion #${pr!.number} — 1 new, 1 total, 2 held`,
    );

    // one developer, on the promotion branch, with both changes oldest first
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs).toMatchObject({
      kind: "port",
      branch: "pm-release/core/20261002",
    });
    const [ticket] = ctx.linear.created;
    expect(ticket!.labels).toEqual(["pm-port", "pm-dispatched", "pm:core"]);
    expect(ticket!.description.indexOf(bad)).toBeGreaterThan(-1);
    expect(ticket!.description.indexOf(dependant)).toBeGreaterThan(
      ticket!.description.indexOf(bad),
    );
    expect(ticket!.description).not.toContain(good);
    expect(rows[1]!.text).toContain("developer sent to port 2 changes");
    expect(ctx.linear.commentsOf(ticket!.id)[0]).toMatch(
      /^🚚 Port dispatched → run \d+/,
    );
  });

  it("does not send a second developer while the port run is still working, and gives up after two", async () => {
    const ctx = twoAreas();
    const bad = seedMerged(ctx, {
      number: 51,
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    const conflict = () =>
      new FakeGit([
        {
          match: `cherry-pick -x ${bad}`,
          result: { code: 1, err: "CONFLICT" },
        },
      ]);
    // the branch the first run pushed exists from then on, with nothing on it
    const pushed = () =>
      conflict().when(
        "ls-remote --heads origin pm-release/core/*",
        "abc\trefs/heads/pm-release/core/20261002\n",
      );
    const opts = { checkoutDir: DIR, area: "core" };

    await runPromote(ctx, { git: conflict(), ...opts });
    expect(ctx.forge.dispatched).toHaveLength(1);
    // no PR yet: nothing has been copied
    expect(await promotionPulls(ctx)).toHaveLength(0);

    const second = pushed();
    const again = await runPromote(ctx, { git: second, ...opts });
    expect(ctx.forge.dispatched).toHaveLength(1);
    // the same branch again, not pm-release/core/20261002-2
    expect(second.commands()).toContain(
      "checkout -B pm-release/core/20261002 origin/staging",
    );
    expect(again[0]!.text).toContain("a developer is porting 1 change");

    // the run ends without porting it: one more try, then the owner
    const finish = (n: number) =>
      ctx.forge.seedRun({
        id: ctx.forge.dispatched[n]!.runId,
        status: "completed",
        conclusion: "success",
      });
    finish(0);
    await runPromote(ctx, { git: pushed(), ...opts });
    expect(ctx.forge.dispatched).toHaveLength(2);
    finish(1);
    const last = await runPromote(ctx, { git: pushed(), ...opts });
    expect(ctx.forge.dispatched).toHaveLength(2);
    expect(last[0]).toMatchObject({ needsYou: true });
    expect(last[0]!.text).toContain("port them by hand");
  });

  it("adopts a promotion branch a developer ported onto and opens its PR", async () => {
    const ctx = twoAreas();
    const ported = seedMerged(ctx, {
      number: 51,
      title: "Was stuck",
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit([
      {
        match: "ls-remote --heads origin pm-release/core/*",
        result: "abc\trefs/heads/pm-release/core/20261001\n",
      },
      {
        match:
          "log --format=%B origin/staging..origin/pm-release/core/20261001",
        result: `Was stuck\n\n(cherry picked from commit ${ported})\n`,
      },
    ]);

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });

    const cmds = git.commands();
    expect(cmds).toContain(
      "checkout -B pm-release/core/20261001 origin/pm-release/core/20261001",
    );
    expect(cmds.some((c) => c.startsWith("cherry-pick"))).toBe(false);
    const [pr] = await promotionPulls(ctx);
    expect(pr!.headRef).toBe("pm-release/core/20261001");
    expect(pr!.body).toContain("Was stuck");
    expect(rows[0]!.text).toContain("0 new, 1 total, 0 held");
    expect(ctx.forge.dispatched).toHaveLength(0);
  });

  it("skips a cherry-pick that is already on staging instead of holding it", async () => {
    const ctx = twoAreas();
    const dup = seedMerged(ctx, {
      number: 55,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit([
      {
        match: `cherry-pick -x ${dup}`,
        result: { code: 1, err: "The previous cherry-pick is now empty" },
      },
    ]);
    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    expect(git.commands()).toContain("cherry-pick --skip");
    expect(git.commands()).not.toContain(
      "push origin HEAD:refs/heads/pm-release/core/20261002",
    );
    expect(await promotionPulls(ctx)).toHaveLength(0);
    expect(rows[0]!.text).toBe("Core: nothing verified to promote");
  });

  it("appends to this area's open promotion PR instead of opening another", async () => {
    const ctx = twoAreas();
    const already = seedMerged(ctx, {
      number: 60,
      title: "Shipped yesterday",
      files: ["app/a.ts"],
      mergedAt: "2026-09-30T09:00:00Z",
      verdicts: [verified],
    });
    const fresh = seedMerged(ctx, {
      number: 61,
      title: "New today",
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const open = ctx.forge.seedPull(TEST_REPO, {
      number: 70,
      headRef: "pm-release/core/20261001",
      baseRef: "staging",
      draft: false,
      title: promotionTitle("Core", "2026-10-01", 1),
    });
    const git = new FakeGit([
      {
        match:
          "log --format=%B origin/staging..origin/pm-release/core/20261001",
        result: `Shipped yesterday\n\n(cherry picked from commit ${already})\n`,
      },
    ]);
    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });

    const cmds = git.commands();
    expect(cmds).toContain(
      "checkout -B pm-release/core/20261001 origin/pm-release/core/20261001",
    );
    expect(cmds.filter((c) => c.startsWith("cherry-pick"))).toEqual([
      `cherry-pick -x ${fresh}`,
    ]);
    expect(cmds).toContain(
      "push origin HEAD:refs/heads/pm-release/core/20261001",
    );
    expect(cmds.some((c) => c.includes("--force") || c.includes("-f "))).toBe(
      false,
    );

    expect(await promotionPulls(ctx)).toHaveLength(1);
    const pr = ctx.forge.pull(TEST_REPO, open.number);
    expect(pr.title).toBe(promotionTitle("Core", "2026-10-02", 2));
    expect(pr.body).toContain(
      "- [#60](https://github.com/owner/game/pull/60) Shipped yesterday",
    );
    expect(pr.body).toContain(
      "- [#61](https://github.com/owner/game/pull/61) New today",
    );
    expect(rows[0]!.text).toBe("Core: promotion #70 — 1 new, 2 total, 0 held");
  });

  it("skips merges already on staging by trailer or ancestry and ignores sync and foreign PRs", async () => {
    const ctx = twoAreas();
    const onStaging = seedMerged(ctx, {
      number: 80,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const ancestor = seedMerged(ctx, {
      number: 81,
      files: ["app/b.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
      verdicts: [verified],
    });
    seedMerged(ctx, {
      number: 82,
      files: ["app/c.ts"],
      mergedAt: "2026-10-01T11:00:00Z",
      verdicts: [verified],
      headRef: "staging",
    });
    seedMerged(ctx, {
      number: 83,
      files: ["app/d.ts"],
      mergedAt: "2026-10-01T12:00:00Z",
      verdicts: [verified],
      author: "human",
    });
    const git = new FakeGit([
      {
        match: /^log --since=120\.days --format=%B origin\/staging$/,
        result: `x\n\n(cherry picked from commit ${onStaging})\n`,
      },
      {
        match: `branch -r --contains ${ancestor} --list origin/staging`,
        result: "  origin/staging\n",
      },
    ]);
    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    expect(git.commands().filter((c) => c.startsWith("cherry-pick"))).toEqual(
      [],
    );
    expect(git.commands().some((c) => c.startsWith("checkout"))).toBe(false);
    expect(await promotionPulls(ctx)).toHaveLength(0);
    expect(rows).toEqual([
      { rule: "promote", text: "Core: nothing verified to promote" },
    ]);
  });

  it("takes the next free branch name when today's already exists on the remote", async () => {
    const ctx = twoAreas();
    seedMerged(ctx, {
      number: 90,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit([
      {
        match: /^ls-remote --heads origin pm-release\/core\/20261002$/,
        result: "abc\trefs/heads/pm-release/core/20261002\n",
      },
    ]);
    await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    expect(git.commands()).toContain(
      `checkout -B pm-release/core/20261002-2 ${STAGING}`,
    );
    const [pr] = await promotionPulls(ctx);
    expect(pr!.headRef).toBe("pm-release/core/20261002-2");
  });

  it("renders the body sections exactly", async () => {
    const ctx = twoAreas();
    seedMerged(ctx, {
      number: 100,
      title: "Login hardening",
      files: ["app/api/auth/route.ts", "app/page.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    seedMerged(ctx, {
      number: 101,
      title: "Unverified",
      files: ["lib/z.ts"],
      mergedAt: "2026-10-01T10:00:00Z",
    });
    const git = new FakeGit([
      {
        match: "diff --name-only origin/staging...HEAD",
        result: "app/api/auth/route.ts\napp/page.ts\nbilling/fees.ts\n",
      },
      {
        match: "diff --name-status origin/staging...HEAD",
        result:
          "M\tapp/api/auth/route.ts\nM\ttests/guards/auth.test.ts\nD\ttests/old.test.ts\nR100\ttests/a.test.ts\ttests/b.test.ts\nM\ttests/kept.test.ts\n",
      },
    ]);
    await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    const [pr] = await promotionPulls(ctx);
    expect(pr!.body).toBe(
      [
        "## Look closely",
        "",
        "**app/api/auth**",
        "- `app/api/auth/route.ts`",
        "",
        "**\\*billing\\***",
        "- `billing/fees.ts`",
        "",
        "## Tests changed or removed",
        "",
        "- `tests/guards/auth.test.ts` — changed (guard test)",
        "- `tests/old.test.ts` — deleted",
        "- `tests/a.test.ts → tests/b.test.ts` — renamed",
        "",
        "## Ships",
        "",
        "Built from `staging` plus only the Core PM's verified changes, each copied from `pm-staging` with `git cherry-pick -x`.",
        "",
        "- [#100](https://github.com/owner/game/pull/100) Login hardening",
        "",
        "## Held back",
        "",
        "- [#101](https://github.com/owner/game/pull/101) Unverified — not tested on pm-staging yet",
        "",
      ].join("\n"),
    );
  });

  it("renders the empty body sections", async () => {
    const ctx = twoAreas();
    seedMerged(ctx, {
      number: 110,
      title: "Plain",
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit({
      "diff --name-only origin/staging...HEAD": "app/a.ts\n",
      "diff --name-status origin/staging...HEAD": "M\tapp/a.ts\n",
    });
    await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    const [pr] = await promotionPulls(ctx);
    expect(pr!.body).toBe(
      [
        "## Look closely",
        "",
        "Nothing in the stop-and-ask list.",
        "",
        "## Tests changed or removed",
        "",
        "None.",
        "",
        "## Ships",
        "",
        "Built from `staging` plus only the Core PM's verified changes, each copied from `pm-staging` with `git cherry-pick -x`.",
        "",
        "- [#110](https://github.com/owner/game/pull/110) Plain",
        "",
        "## Held back",
        "",
        "None.",
        "",
      ].join("\n"),
    );
  });

  it("dry run cherry-picks locally but neither pushes nor opens a PR", async () => {
    const ctx = makeCtx({ dryRun: true, project: twoAreas().project });
    const sha = seedMerged(ctx, {
      number: 120,
      files: ["app/a.ts"],
      mergedAt: "2026-10-01T09:00:00Z",
      verdicts: [verified],
    });
    const git = new FakeGit();
    const rows = await runPromote(ctx, { git, checkoutDir: DIR, area: "core" });
    expect(git.commands()).toContain(`cherry-pick -x ${sha}`);
    expect(git.commands().some((c) => c.startsWith("push"))).toBe(false);
    expect(await promotionPulls(ctx)).toHaveLength(0);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
    expect(rows[0]!.text).toBe(
      "Core: promotion (dry run) — 1 new, 1 total, 0 held",
    );
  });
});
