// Promotion: the project's verified work, and nothing else, as one PR into
// staging. A promotion is BUILT with cherry-picks, never pointed at the
// integration branch — git ships everything behind a commit, and pm-staging
// carries every area's work including merges that failed their test.
//
// Per area: the area's bot merges into pm-staging (newest 60), plus the owner's
// own PRs labeled pm-owner, whose latest 🧪
// comment is a pass are copied onto pm-release/<area>/<date> (or onto the
// area's open promotion branch) with `git cherry-pick -x`, oldest merge
// first. Held back, with the reason in the PR body: untested or failed
// merges, merges sharing a file with a held merge, merges sharing a file with
// another area's OLDER unpromoted verified merge (that area promotes first,
// so two areas can never deadlock), and merges that do not apply.

import type { AreaConfig, TiersConfig } from "../config.ts";
import { matchesPrefix } from "../config.ts";
import type { Git, GitResult } from "../git.ts";
import type { PullRequest } from "../forge/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import { dispatchPort } from "./port.ts";
import { integrationHealth } from "./stopTheLine.ts";
import {
  candidateEvidenceError,
  trustedVerdict,
  type CandidateVerification,
  type CandidateVerificationResult,
} from "./verification.ts";
import {
  FAILED_PREFIX,
  LABELS,
  promotionTitle,
  releaseBranch,
  SYNC_BRANCH_PREFIX,
  VERIFIED_PREFIX,
} from "./notes.ts";

export interface PromoteOpts {
  git: Git;
  /** a clone of the target with `origin` pointing at it */
  checkoutDir: string;
  /** promote only this area key (the CLI's --area); every area when absent */
  area?: string;
  /** Mandatory runtime gate: install, lint, typecheck, tests and application build.
   *  change can apply cleanly and still not build: it imports a file that a
   *  held change added. When given, a batch that fails is rebuilt one change
   *  at a time and the changes that break the build are held. */
  check?: (checkoutDir: string) => Promise<{ ok: boolean; output: string }>;
  /** Authenticated browser evidence for the exact assembled and deployed candidate. */
  verifyCandidate?: (
    candidate: CandidateVerification,
  ) => Promise<CandidateVerificationResult>;
  /** Controller ledger authority for local delivery; never inferred from worker comments. */
  candidateVerdict?: (
    pull: PullRequest,
  ) => Promise<{ area: string; verdict: Verdict } | null>;
  /** Local workers do not dispatch legacy CI port jobs. Conflicts remain held. */
  local?: boolean;
  /** Publish owning-PM-reviewed, build-checked changes without an external
   * signer. A supplied verifyCandidate always remains a required gate. */
  publishReviewedCandidate?: boolean;
  onCandidatePrepared?: (candidate: CandidateVerification) => Promise<void>;
  onPublished?: (
    candidate: CandidateVerification,
    pull: PullRequest,
  ) => Promise<void>;
}

const REMOTE = "origin";
const LOOKBACK_DAYS = 60;
const MAX_MERGES = 100;
const MAX_BRANCH_SUFFIX = 20;
const TRAILER_RE = /\(cherry picked from commit ([0-9a-f]{7,40})\)/g;

export type Verdict = "verified" | "failed" | "untested";

interface Candidate {
  pr: PullRequest;
  sha: string;
  files: string[];
  area: AreaConfig | null;
  verdict: Verdict;
  /** position in merge order, oldest = 0 */
  order: number;
}

interface Held {
  c: Candidate;
  reason: string;
}

export interface TestChange {
  path: string;
  status: "changed" | "deleted" | "renamed" | "added";
  guard: boolean;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Legacy display-only helper. Release authorization uses trustedVerdict instead. */
export function verdictOf(commentBodies: string[]): Verdict {
  const tests = commentBodies
    .map((b) => b.trim())
    .filter(
      (b) => b.startsWith(VERIFIED_PREFIX) || b.startsWith(FAILED_PREFIX),
    );
  const last = tests[tests.length - 1];
  if (!last) return "untested";
  return last.startsWith(VERIFIED_PREFIX) ? "verified" : "failed";
}

/** The area owning the most of these files; ties go to the earlier area; null when none match. */
export function areaOf(
  files: string[],
  areas: AreaConfig[],
): AreaConfig | null {
  let best: AreaConfig | null = null;
  let bestCount = 0;
  for (const area of areas) {
    const count = files.filter((f) => matchesPrefix(f, area.paths)).length;
    if (count > bestCount) {
      best = area;
      bestCount = count;
    }
  }
  return best;
}

/** Files under ownerOnlyPrefixes, grouped by the first prefix that matches. */
export function lookCloselyGroups(
  files: string[],
  prefixes: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const p = prefixes.find((x) => matchesPrefix(f, [x]));
    if (!p) continue;
    const list = groups.get(p) ?? [];
    list.push(f);
    groups.set(p, list);
  }
  return groups;
}

/** Guard tests however they changed, plus any other test file that was deleted or renamed away. */
export function testChanges(
  nameStatusLines: string[],
  tiers: Pick<TiersConfig, "guardTests" | "testFileMarkers">,
): TestChange[] {
  const isTest = (p: string) =>
    tiers.testFileMarkers.some((m) => m && p.includes(m));
  const isGuard = (p: string) =>
    tiers.guardTests.some((g) => g && matchesPrefix(p, [g]));
  const out: TestChange[] = [];
  for (const raw of nameStatusLines) {
    const parts = raw.split("\t").filter(Boolean);
    const code = parts[0]?.[0];
    const oldPath = parts[1];
    const newPath = parts[parts.length - 1];
    if (!code || !oldPath || !newPath) continue;
    const status: TestChange["status"] =
      code === "D"
        ? "deleted"
        : code === "R"
          ? "renamed"
          : code === "A"
            ? "added"
            : "changed";
    const shown = code === "R" ? `${oldPath} → ${newPath}` : newPath;
    if (isGuard(oldPath) || isGuard(newPath))
      out.push({ path: shown, status, guard: true });
    else if ((code === "D" || code === "R") && isTest(oldPath))
      out.push({ path: code === "R" ? shown : oldPath, status, guard: false });
  }
  return out;
}

const bullet = (pr: PullRequest): string =>
  `- [#${pr.number}](${pr.htmlUrl}) ${pr.title}`;
const boldPrefix = (p: string): string => `**${p.replace(/\*/g, "\\*")}**`;

export function renderBody(input: {
  areaName: string;
  staging: string;
  integration: string;
  ships: PullRequest[];
  held: { pr: PullRequest; reason: string }[];
  lookClosely: Map<string, string[]>;
  tests: TestChange[];
  combined?: boolean;
}): string {
  const lines = ["## Look closely", ""];
  if (input.lookClosely.size === 0)
    lines.push("Nothing in the stop-and-ask list.", "");
  for (const [prefix, files] of input.lookClosely) {
    lines.push(boldPrefix(prefix));
    for (const f of files) lines.push(`- \`${f}\``);
    lines.push("");
  }
  lines.push("## Tests changed or removed", "");
  if (input.tests.length === 0) lines.push("None.");
  for (const t of input.tests)
    lines.push(
      `- \`${t.path}\` — ${t.status}${t.guard ? " (guard test)" : ""}`,
    );
  lines.push(
    "",
    "## Ships",
    "",
    `Built from \`${input.staging}\` plus only ${input.combined ? "verified changes reviewed by their owning PMs" : `the ${input.areaName} PM's verified changes`}, each copied from \`${input.integration}\` with \`git cherry-pick -x\`.`,
    "",
  );
  for (const pr of input.ships) lines.push(bullet(pr));
  lines.push("", "## Held back", "");
  if (input.held.length === 0) lines.push("None.");
  for (const h of input.held) lines.push(`${bullet(h.pr)} — ${h.reason}`);
  lines.push("");
  return lines.join("\n");
}

function trailersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TRAILER_RE)) out.add(m[1]!);
  return out;
}

const splitLines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

// ── git plumbing ─────────────────────────────────────────────────────────────

interface Repo {
  run(args: string[]): Promise<GitResult>;
  out(args: string[]): Promise<string>;
  must(args: string[]): Promise<void>;
}

function repoIn(git: Git, cwd: string): Repo {
  const run = (args: string[]) => git.run(args, cwd);
  return {
    run,
    out: async (args) => (await run(args)).out,
    must: async (args) => {
      const r = await run(args);
      if (r.code !== 0)
        throw new Error(
          `git ${args.join(" ")} failed (${r.code}): ${r.err.trim()}`,
        );
    },
  };
}

async function freeBranchName(repo: Repo, base: string): Promise<string> {
  for (let n = 1; n <= MAX_BRANCH_SUFFIX; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const taken = (
      await repo.out(["ls-remote", "--heads", REMOTE, name])
    ).trim();
    if (!taken) return name;
  }
  throw new Error(
    `no free promotion branch name after ${base}-${MAX_BRANCH_SUFFIX}`,
  );
}

// ── the rule ─────────────────────────────────────────────────────────────────

async function collectCandidates(
  ctx: Ctx,
  opts: PromoteOpts,
): Promise<Candidate[]> {
  const repo = repoOf(ctx);
  const { staging, integration } = branchesOf(ctx);
  const since = new Date(
    ctx.now().getTime() - LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  const merged = (await ctx.forge.listMergedPulls(repo, integration, since))
    .filter(
      (p) =>
        (p.author === ctx.botLogin || p.labels.includes(LABELS.owner)) &&
        p.headRef !== staging &&
        // a sync resolution is staging's own content arriving on the
        // integration branch: there is nothing in it to promote, and it
        // must not hold the changes that share its files
        !p.headRef.startsWith(SYNC_BRANCH_PREFIX) &&
        p.mergeCommitSha,
    )
    .slice(0, MAX_MERGES)
    .reverse();
  const out: Candidate[] = [];
  for (const pr of merged) {
    const files = await ctx.forge.listPullFiles(repo, pr.number);
    const tracked = opts.candidateVerdict
      ? await opts.candidateVerdict(pr)
      : null;
    const area = tracked
      ? (ctx.project.areas.find((a) => a.key === tracked.area) ?? null)
      : areaOf(files, ctx.project.areas);
    if (!area) continue;
    const comments = opts.candidateVerdict
      ? []
      : await ctx.forge.listPullComments(repo, pr.number);
    out.push({
      pr,
      sha: pr.mergeCommitSha!,
      files,
      area,
      verdict: opts.candidateVerdict
        ? (tracked?.verdict ?? "untested")
        : trustedVerdict(comments, ctx.botLogin, pr.mergeCommitSha!),
      order: out.length,
    });
  }
  return out;
}

/** merge shas already on staging: by the cherry-pick trailer, or by ancestry */
async function promotedOnStaging(
  repo: Repo,
  staging: string,
  candidates: Candidate[],
): Promise<Set<string>> {
  const promoted = trailersIn(
    await repo.out([
      "log",
      "--since=120.days",
      "--format=%B",
      `${REMOTE}/${staging}`,
    ]),
  );
  for (const c of candidates) {
    if (promoted.has(c.sha)) continue;
    const contains = await repo.out([
      "branch",
      "-r",
      "--contains",
      c.sha,
      "--list",
      `${REMOTE}/${staging}`,
    ]);
    if (contains.trim()) promoted.add(c.sha);
  }
  return promoted;
}

export async function runPromote(
  ctx: Ctx,
  opts: PromoteOpts,
): Promise<DigestRow[]> {
  if (!opts.check)
    return [
      {
        rule: "promote",
        needsYou: true,
        text: "Promotion blocked — a local install/lint/typecheck/test/build check is required",
      },
    ];
  const health = await integrationHealth(ctx);
  if (health.state !== "healthy")
    return [
      {
        rule: "promote",
        pending: true,
        text: `Promotion blocked — ${health.reason}`,
      },
    ];
  const repo = repoIn(opts.git, opts.checkoutDir);
  const { staging } = branchesOf(ctx);
  await repo.must(["fetch", REMOTE]);
  const candidates = await collectCandidates(ctx, opts);
  const onStaging = await promotedOnStaging(repo, staging, candidates);
  const rows: DigestRow[] = [];
  // Automatic promotion batches all owning PMs into a single project PR.
  // --area remains an explicit compatibility escape hatch for manual operation.
  const areas = opts.area
    ? ctx.project.areas.filter((area) => area.key === opts.area)
    : opts.local
      ? [
          {
            ...ctx.project.areas[0]!,
            key: "combined",
            name: ctx.project.config.name,
          },
        ]
      : ctx.project.areas;
  for (const area of areas) {
    const check = () => opts.check!(opts.checkoutDir);
    rows.push(
      ...(await promoteArea(
        ctx,
        repo,
        area,
        candidates,
        onStaging,
        check,
        opts,
      )),
    );
  }
  return rows;
}

async function promoteArea(
  ctx: Ctx,
  repo: Repo,
  area: AreaConfig,
  candidates: Candidate[],
  onStaging: Set<string>,
  check: () => Promise<{ ok: boolean; output: string }>,
  opts: PromoteOpts,
): Promise<DigestRow[]> {
  const forgeRepo = repoOf(ctx);
  const { staging, integration } = branchesOf(ctx);
  const combined = !!opts.local && !opts.area;
  const say = (m: string) => ctx.log(`promote (${area.name}): ${m}`);
  const isoDate = ctx.now().toISOString().slice(0, 10);
  const nothing = (held: Held[]): DigestRow[] => [
    {
      rule: "promote",
      text: `${area.name}: nothing verified to promote${held.length ? ` (${held.length} held)` : ""}`,
    },
  ];

  const openPromotions = (
    await ctx.forge.listOpenPulls(forgeRepo, { base: staging })
  ).filter(
    (p) => p.author === ctx.botLogin && p.headRef.startsWith("pm-release/"),
  );
  if (
    combined &&
    openPromotions.some(
      (p) => !p.headRef.startsWith(releaseBranch("combined", "")),
    )
  )
    return [
      {
        rule: "promote",
        needsYou: true,
        text: "Finish or close existing per-PM promotion PRs before starting the combined promotion. Their branches and reviews were preserved.",
      },
    ];
  const matching = openPromotions.filter((p) =>
    p.headRef.startsWith(releaseBranch(area.key, "")),
  );
  if (matching.length > 1)
    return [
      {
        rule: "promote",
        needsYou: true,
        text: "More than one promotion is open for this batch. Review the existing PRs before adding work.",
      },
    ];
  const openPr = structuredClone(
    matching.find(
      (p) =>
        p.author === ctx.botLogin &&
        p.headRef.startsWith(releaseBranch(area.key, "")),
    ) ?? null,
  );
  // The promotion branch in progress: the open PR's, or — when a developer
  // ported changes onto a branch that has no PR yet — the newest release
  // branch that carries work staging does not have.
  let existingBranch: string | null = openPr?.headRef ?? null;
  // A release branch with nothing on it yet (it was created for a porting
  // developer, or its PR was merged): its name is reused from staging's tip
  // rather than piling up `-2`, `-3` beside a port in progress.
  let emptyBranch: string | null = null;
  if (!existingBranch) {
    const heads = splitLines(
      await repo.out([
        "ls-remote",
        "--heads",
        REMOTE,
        `${releaseBranch(area.key, "")}*`,
      ]),
    )
      .map((l) => l.split("refs/heads/")[1] ?? "")
      .filter(Boolean)
      .sort()
      .reverse();
    for (const head of heads) {
      const carries = trailersIn(
        await repo.out([
          "log",
          "--format=%B",
          `${REMOTE}/${staging}..${REMOTE}/${head}`,
        ]),
      );
      if ([...carries].some((sha) => !onStaging.has(sha))) {
        existingBranch = head;
        break;
      }
      const ahead = Number(
        (
          await repo.out([
            "rev-list",
            "--count",
            `${REMOTE}/${staging}..${REMOTE}/${head}`,
          ])
        ).trim() || "0",
      );
      if (ahead === 0) emptyBranch ??= head;
    }
  }
  const onRelease = existingBranch
    ? trailersIn(
        await repo.out([
          "log",
          "--format=%B",
          `${REMOTE}/${staging}..${REMOTE}/${existingBranch}`,
        ]),
      )
    : new Set<string>();
  const promoted = new Set([...onStaging, ...onRelease]);

  // file → the OLDEST other-area verified merge not on staging that touched it
  const foreign = new Map<string, Candidate>();
  for (const c of candidates) {
    if (
      !c.area ||
      combined ||
      c.area.key === area.key ||
      c.verdict !== "verified" ||
      onStaging.has(c.sha)
    )
      continue;
    for (const f of c.files) if (!foreign.has(f)) foreign.set(f, c);
  }

  const mine = candidates.filter(
    (c) => c.area && (combined || c.area.key === area.key),
  );
  // The candidate query is bounded. An older/evicted source must not silently
  // remain in an accumulating PR while disappearing from its review manifest.
  if (
    [...onRelease].some(
      (sha) =>
        !onStaging.has(sha) && !mine.some((candidate) => candidate.sha === sha),
    )
  )
    return [
      {
        rule: "promote",
        needsYou: true,
        text: `${area.name}: the existing promotion includes source revisions outside the current reviewed candidate set. Its PR and branch are preserved. Review and finish or replace that batch before adding more work.`,
      },
    ];
  let carried = mine.filter((c) => onRelease.has(c.sha));
  if (carried.some((c) => c.verdict !== "verified"))
    return [
      {
        rule: "promote",
        needsYou: true,
        text: `${area.name}: promotion blocked — carried changes no longer have trusted passing evidence`,
      },
    ];
  const held: Held[] = [];
  // file → merge order of the OLDEST held change that touched it. Only an
  // OLDER held change can strand a later one; a change merged before the
  // held one was written without it and stands without it.
  const heldFiles = new Map<string, number>();
  const hold = (c: Candidate, reason: string) => {
    held.push({ c, reason });
    for (const f of c.files)
      heldFiles.set(f, Math.min(heldFiles.get(f) ?? Infinity, c.order));
    say(`held #${c.pr.number} ${c.pr.title} — ${reason}`);
  };
  const sharesHeld = (c: Candidate): string | undefined =>
    c.files.find((f) => (heldFiles.get(f) ?? Infinity) < c.order);

  const toPick: Candidate[] = [];
  for (const c of mine) {
    if (promoted.has(c.sha)) continue;
    if (c.verdict !== "verified") {
      hold(
        c,
        c.verdict === "failed"
          ? `failed its test on ${integration}`
          : `not tested on ${integration} yet`,
      );
      continue;
    }
    const sharedWithHeld = sharesHeld(c);
    if (sharedWithHeld) {
      hold(c, `builds on held work (shares ${sharedWithHeld})`);
      continue;
    }
    const older = c.files
      .map((f) => ({ f, o: foreign.get(f) }))
      .find(({ o }) => o && o.order < c.order);
    if (older?.o) {
      hold(
        c,
        `shares ${older.f} with ${older.o.area!.name}'s #${older.o.pr.number}, merged earlier and not on ${staging} yet — that area promotes first`,
      );
      continue;
    }
    toPick.push(c);
  }
  if (toPick.length === 0 && !existingBranch) {
    say("nothing verified to promote");
    return nothing(held);
  }

  let branch: string;
  let updatedBase = false;
  if (existingBranch) {
    branch = existingBranch;
    await repo.must(["checkout", "-B", branch, `${REMOTE}/${branch}`]);
    // An old candidate may predate today's staging. Verify the actual merge
    // result, never a branch whose eventual staging merge has untested content.
    if (
      (
        await repo.run([
          "merge-base",
          "--is-ancestor",
          `${REMOTE}/${staging}`,
          "HEAD",
        ])
      ).code !== 0
    ) {
      const rebased = await repo.run([
        "merge",
        "--no-edit",
        `${REMOTE}/${staging}`,
      ]);
      if (rebased.code !== 0) {
        await repo.run(["merge", "--abort"]);
        return [
          {
            rule: "promote",
            needsYou: true,
            text: `${area.name}: promotion blocked — candidate conflicts with current ${staging}; resolve and reverify`,
          },
        ];
      }
      updatedBase = true;
    }
  } else {
    branch =
      emptyBranch ??
      (await freeBranchName(
        repo,
        releaseBranch(area.key, isoDate.replace(/-/g, "")),
      ));
    await repo.must(["checkout", "-B", branch, `${REMOTE}/${staging}`]);
  }

  const pickArgs =
    ctx.project.config.mergeMethod === "merge" ? ["-m", "1"] : [];
  // A verified change that does not apply on staging as written is not held
  // for good: staging moved under it, and a developer ports it (port.ts).
  // Later changes on the same files wait for that port and go with it.
  const toPort: Candidate[] = [];
  const portFiles = new Map<string, number>();
  const port = (c: Candidate, reason: string) => {
    toPort.push(c);
    held.push({ c, reason });
    for (const f of c.files)
      portFiles.set(f, Math.min(portFiles.get(f) ?? Infinity, c.order));
    say(`porting #${c.pr.number} ${c.pr.title} — ${reason}`);
  };
  let picked: Candidate[] = [];
  for (const c of toPick) {
    const sharedWithHeld = sharesHeld(c);
    if (sharedWithHeld) {
      hold(c, `builds on held work (shares ${sharedWithHeld})`);
      continue;
    }
    const behind = c.files.find(
      (f) => (portFiles.get(f) ?? Infinity) < c.order,
    );
    if (behind) {
      port(c, `goes with the port of earlier work on ${behind}`);
      continue;
    }
    const r = await repo.run(["cherry-pick", "-x", ...pickArgs, c.sha]);
    if (r.code === 0) {
      picked.push(c);
      continue;
    }
    if (/now empty|nothing to commit/i.test(r.err + r.out)) {
      await repo.run(["cherry-pick", "--skip"]);
      say(`#${c.pr.number} is already on ${staging} — nothing to copy`);
      continue;
    }
    await repo.run(["cherry-pick", "--abort"]);
    port(
      c,
      `does not apply on ${staging} as written — a developer is porting it`,
    );
  }

  // Applying cleanly is not building. If the batch does not build, find out
  // which changes cannot stand on staging without work that is not promoted,
  // and hold exactly those — an open promotion PR must never be red because
  // of how it was assembled.
  let rebuilt = false;
  if (picked.length > 0 || carried.length > 0) {
    const whole = await check();
    if (!whole.ok) {
      // A carried change may have been PORTED: the commit on the branch, not
      // the original, is the one that applies on staging. Rebuild from those.
      const ported = new Map<string, string>();
      if (existingBranch)
        for (const c of carried) {
          const onBranch = (
            await repo.out([
              "log",
              "--format=%H",
              "-1",
              `--grep=${c.sha}`,
              `${REMOTE}/${staging}..${REMOTE}/${existingBranch}`,
            ])
          ).trim();
          if (onBranch) ported.set(c.sha, onBranch);
        }
      await repo.must(["reset", "--hard", `${REMOTE}/${staging}`]);
      if (!(await check()).ok) {
        // staging itself is red: nothing here can be blamed on a change
        say(`${staging} itself does not build — promotion blocked`);
        return [
          {
            rule: "promote",
            needsYou: true,
            text: `${area.name}: promotion blocked — ${staging} itself does not build; repair the baseline before release`,
          },
        ];
      } else {
        say(
          `the batch does not build on ${staging} — rebuilding it one change at a time`,
        );
        const wasPicked = new Set(picked.map((c) => c.sha));
        const kept: Candidate[] = [];
        // Only what THIS rebuild drops can strand a later change: everything
        // here already passed the held-file rules, and heldFiles by now also
        // names files of merges NEWER than these.
        const dropped = new Set<string>();
        const drop = (c: Candidate, reason: string) => {
          for (const f of c.files) dropped.add(f);
          hold(c, reason);
        };
        for (const c of [...carried, ...picked].sort(
          (a, b) => a.order - b.order,
        )) {
          const sharedWithDropped = c.files.find((f) => dropped.has(f));
          if (sharedWithDropped) {
            drop(c, `builds on held work (shares ${sharedWithDropped})`);
            continue;
          }
          const source = ported.get(c.sha);
          const r = await repo.run(
            source
              ? ["cherry-pick", source]
              : ["cherry-pick", "-x", ...pickArgs, c.sha],
          );
          if (r.code !== 0) {
            await repo.run(["cherry-pick", "--abort"]);
            drop(
              c,
              `does not apply cleanly on ${staging} — it depends on work not promoted yet`,
            );
            continue;
          }
          if ((await check()).ok) {
            kept.push(c);
            continue;
          }
          await repo.must(["reset", "--hard", "HEAD~1"]);
          drop(
            c,
            `does not build on ${staging} by itself — it needs work that is not promoted yet`,
          );
        }
        carried = kept.filter((c) => !wasPicked.has(c.sha));
        picked = kept.filter((c) => wasPicked.has(c.sha));
        rebuilt = true;
      }
    }
  }
  const portChanges = toPort.map((c) => ({
    sha: c.sha,
    number: c.pr.number,
    title: c.pr.title,
  }));
  if (
    picked.length === 0 &&
    carried.length === 0 &&
    !openPr &&
    toPort.length === 0
  ) {
    say("nothing verified to promote");
    return nothing(held);
  }

  const range = `${REMOTE}/${staging}...HEAD`;
  const files = splitLines(await repo.out(["diff", "--name-only", range]));
  const nameStatus = splitLines(
    await repo.out(["diff", "--name-status", range]),
  );
  const ships = [...carried, ...picked]
    .sort((a, b) => a.order - b.order)
    .map((c) => c.pr);
  if (openPr && ships.length === 0)
    return [
      {
        rule: "promote",
        needsYou: true,
        text: `${area.name}: promotion blocked — existing PR has no verified source changes in the current manifest`,
      },
    ];
  let body = renderBody({
    areaName: area.name,
    staging,
    integration,
    ships,
    held: held.map((h) => ({ pr: h.c.pr, reason: h.reason })),
    lookClosely: lookCloselyGroups(files, ctx.project.tiers.ownerOnlyPrefixes),
    tests: testChanges(nameStatus, ctx.project.tiers),
    combined,
  });
  const title = promotionTitle(area.name, isoDate, ships.length);
  const summary = `${picked.length} new, ${ships.length} total, ${held.length} held`;
  const publishReviewed =
    opts.local === true &&
    opts.publishReviewedCandidate === true &&
    !opts.verifyCandidate &&
    !!opts.candidateVerdict;
  let publishedCandidate: CandidateVerification | undefined;
  if (publishReviewed)
    body += `\n## Verification\n\nEach included change passed its owning PM's browser review on \`${integration}\`. The assembled candidate passed the configured build and checks. These are source-change browser receipts and assembled-code checks; no separate browser review of this assembled candidate is claimed. This PR is ready for staging review. ShipGremlins does not merge it or release production automatically.\n`;

  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] would prepare ${branch}; ${openPr ? `update PR #${openPr.number}` : "open a PR"} after ${publishReviewed ? "owning-PM review and combined checks" : "exact-candidate browser verification"}: ${title}`,
    );
    const dry: DigestRow[] = [
      {
        rule: "promote",
        text: `${area.name}: promotion (dry run) — ${summary}`,
      },
    ];
    if (toPort.length > 0 && !opts.local)
      dry.push(await dispatchPort(ctx, area, branch, portChanges));
    return dry;
  }
  if (ships.length > 0 || openPr) {
    // A branch may deploy before there is a PR. Never append unverified content
    // to an existing PR: stage it on a separate immutable candidate branch.
    if (openPr) {
      // Reuse an earlier pending candidate with this exact tree/base rather
      // than changing its SHA merely because cherry-pick used a new timestamp.
      const tree = (await repo.out(["rev-parse", "HEAD^{tree}"])).trim();
      const previous = splitLines(
        await repo.out([
          "ls-remote",
          "--heads",
          REMOTE,
          `pm-candidate/${area.key}/*`,
        ]),
      )
        .map((line) => line.split("refs/heads/")[1])
        .filter((head): head is string => Boolean(head))
        .sort();
      for (const head of previous) {
        const ref = `${REMOTE}/${head}`;
        if (
          tree &&
          (await repo.out(["rev-parse", `${ref}^{tree}`])).trim() === tree &&
          (
            await repo.run([
              "merge-base",
              "--is-ancestor",
              `${REMOTE}/${staging}`,
              ref,
            ])
          ).code === 0
        ) {
          await repo.must(["reset", "--hard", ref]);
          break;
        }
      }
    }
    const sha = (await repo.out(["rev-parse", "HEAD"])).trim();
    const baseSha = (
      await repo.out(["rev-parse", `${REMOTE}/${staging}`])
    ).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !/^[0-9a-f]{40,64}$/.test(baseSha))
      return [
        {
          rule: "promote",
          needsYou: true,
          text: `${area.name}: promotion blocked — cannot resolve candidate and staging revisions`,
        },
      ];
    const candidateBranch = openPr ? `pm-candidate/${area.key}/${sha}` : branch;
    if (openPr || picked.length > 0 || rebuilt || updatedBase)
      await repo.must([
        "push",
        ...(rebuilt && !openPr ? ["--force-with-lease"] : []),
        REMOTE,
        `HEAD:refs/heads/${candidateBranch}`,
      ]);
    const candidate: CandidateVerification = {
      branch: candidateBranch,
      releaseBranch: branch,
      sha,
      baseSha,
      checkoutDir: opts.checkoutDir,
      changes: ships.map((pr) => pr.number),
    };
    // Stable, machine-readable handoff for an independent verifier. These are
    // preparation coordinates, not authorization or a claim of browser success.
    ctx.log(
      `Candidate verification: ${JSON.stringify({
        project: ctx.project.config.name,
        repo: forgeRepo,
        author: ctx.botLogin,
        branch: candidate.branch,
        releaseBranch: candidate.releaseBranch,
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        changes: candidate.changes,
      })}`,
    );
    publishedCandidate = candidate;
    await opts.onCandidatePrepared?.(candidate);
    const result = opts.verifyCandidate
      ? await opts.verifyCandidate(candidate)
      : {
          ok: false as const,
          reason: "no authenticated candidate browser evidence supplied",
        };
    const error = candidateEvidenceError(result, candidate, ctx.botLogin);
    if (error && !publishReviewed)
      return [
        {
          rule: "promote",
          pending: true,
          text: `${area.name}: candidate ${candidateBranch} at ${sha} (base ${baseSha}; release ${branch}; PRs ${candidate.changes.map((n) => `#${n}`).join(", ")}) waits — ${error}. Verify this deployed revision, then rerun promote with signed evidence.`,
        },
      ];
    if ((await repo.out(["rev-parse", "HEAD"])).trim() !== sha)
      return [
        {
          rule: "promote",
          pending: true,
          text: `${area.name}: promotion blocked — local candidate changed during verification`,
        },
      ];
    const baseNow = await ctx.forge.getBranchSha(forgeRepo, staging);
    if (baseNow !== baseSha)
      return [
        {
          rule: "promote",
          pending: true,
          text: `${area.name}: promotion blocked — staging moved during verification; rebuild and verify again`,
        },
      ];
    const healthNow = await integrationHealth(ctx);
    if (healthNow.state !== "healthy")
      return [
        {
          rule: "promote",
          pending: true,
          text: `${area.name}: promotion blocked — ${healthNow.reason}`,
        },
      ];
    const candidateHead = (
      await repo.out(["ls-remote", "--heads", REMOTE, candidateBranch])
    )
      .trim()
      .split(/\s+/)[0];
    if (candidateHead !== sha)
      return [
        {
          rule: "promote",
          pending: true,
          text: `${area.name}: promotion blocked — candidate branch changed during verification`,
        },
      ];
    // Building can take minutes; an owner may revoke approval during that time.
    if (opts.candidateVerdict) {
      for (const ship of ships) {
        const fresh = await ctx.forge.getPull(forgeRepo, ship.number);
        if (
          !fresh ||
          (await opts.candidateVerdict(fresh))?.verdict !== "verified"
        )
          return [
            {
              rule: "promote",
              pending: true,
              text: `Promotion held: #${ship.number} changed or lost approval during preparation.`,
            },
          ];
      }
    }
  }
  if (openPr) {
    const current = await ctx.forge.getPull(forgeRepo, openPr.number);
    if (
      !current ||
      current.state !== "open" ||
      current.author !== openPr.author ||
      current.headRef !== openPr.headRef ||
      current.headSha !== openPr.headSha ||
      current.baseRef !== staging
    )
      return [
        {
          rule: "promote",
          pending: true,
          text: "Promotion changed while preparing the next batch. Refresh before adding verified work.",
        },
      ];
    if (
      publishReviewed &&
      !rebuilt &&
      (await repo.run(["merge-base", "--is-ancestor", openPr.headSha, "HEAD"]))
        .code !== 0
    )
      return [
        {
          rule: "promote",
          pending: true,
          text: "Promotion history changed. Rebuild the batch before extending the existing PR.",
        },
      ];
  }
  if (rebuilt && existingBranch)
    await repo.must([
      "push",
      openPr
        ? `--force-with-lease=refs/heads/${branch}:${openPr.headSha}`
        : "--force-with-lease",
      REMOTE,
      `HEAD:refs/heads/${branch}`,
    ]);
  else if (
    picked.length > 0 ||
    updatedBase ||
    (toPort.length > 0 && !existingBranch)
  )
    // with nothing picked this only creates the branch at staging's tip, so
    // the porting developer has somewhere to work
    await repo.must([
      "push",
      ...(openPr && publishReviewed
        ? [`--force-with-lease=refs/heads/${branch}:${openPr.headSha}`]
        : []),
      REMOTE,
      `HEAD:refs/heads/${branch}`,
    ]);
  const rows: DigestRow[] = [];
  if (ships.length > 0 || openPr) {
    let pr = openPr;
    if (pr) await ctx.forge.updatePull(forgeRepo, pr.number, { title, body });
    else
      pr = await ctx.forge.createPull(forgeRepo, {
        title,
        head: branch,
        base: staging,
        body,
        draft: false,
      });
    if (pr.draft && publishReviewed) {
      await ctx.forge.markReady(forgeRepo, pr.number);
    }
    // The release branch may have just moved. Register the provider's new head,
    // not the pre-build PR snapshot used to guard the update.
    pr = (await ctx.forge.getPull(forgeRepo, pr.number)) ?? pr;
    if (publishedCandidate) await opts.onPublished?.(publishedCandidate, pr);
    say(`${pr.htmlUrl} — ${summary}`);
    rows.push({
      rule: "promote",
      text: `${area.name}: promotion #${pr.number} — ${summary}`,
      ref: `#${pr.number}`,
    });
  }
  if (toPort.length > 0) {
    if (opts.local)
      rows.push({
        rule: "promote",
        needsYou: true,
        text: `${area.name}: ${toPort.length} changes need a reviewed port onto ${staging}; they remain excluded from the promotion.`,
      });
    else rows.push(await dispatchPort(ctx, area, branch, portChanges));
  }
  return rows;
}
