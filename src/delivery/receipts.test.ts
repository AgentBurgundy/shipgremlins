import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReviewReceipts,
  validateReviewPlan,
} from "../../runner-local/review-receipts.mjs";
import type { PmReviewPlan } from "./types.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const SHA = "a".repeat(40),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-review-")));
  roots.push(root);
  const plan: PmReviewPlan = {
    schema: 1,
    id: "plan",
    jobId: "job-review",
    project: "app",
    area: "core",
    configuration: "config",
    createdAt: "2026-10-05",
    deployment: {
      id: "dep",
      url: "https://preview.example",
      sha: SHA,
      branch: "pm-staging",
      provider: "railway",
      state: "READY",
    },
    deliveries: [
      {
        id: "job-code",
        ticket: {
          id: "ticket",
          identifier: "T-1",
          title: "Fix name",
          description: "scope",
        },
        implementationPr: 1,
        mergeSha: SHA,
        scopeHash: "scope",
        criteria: ["The saved name is visible."],
      },
    ],
  };
  const request = {
    schema: 1,
    planId: plan.id,
    deliveries: [
      {
        id: "job-code",
        checks: [
          {
            criterion: plan.deliveries[0]!.criteria[0],
            path: "/settings",
            kind: "text-visible",
            text: "Ronald",
          },
        ],
      },
    ],
  };
  const locator = {
    count: async () => 1,
    isVisible: async () => true,
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
  };
  const page = {
    setDefaultTimeout: () => {},
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => "https://preview.example/settings",
    getByText: () => locator,
    locator: () => locator,
    screenshot: vi.fn(async () => png),
  };
  const context = {
    route: vi.fn(async () => {}),
    newPage: async () => page,
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async (_options?: unknown) => context),
    close: vi.fn(async () => {}),
  };
  const chromium = { launch: async () => browser };
  const run = () => {
    writeFileSync(
      join(root, "pm-review-request.json"),
      JSON.stringify(request),
    );
    return runReviewReceipts({
      plan,
      commitSha: SHA,
      outputDirectory: root,
      sessionDirectory: join(root, "private"),
      chromium,
    });
  };
  return { root, plan, request, locator, page, browser, run };
}
describe("trusted worker browser receipts", () => {
  it("executes real browser API checks and binds screenshots to trusted proof digest", async () => {
    const w = world();
    const result = await w.run();
    const bytes = readFileSync(join(w.root, result.reviewProof.file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      result.reviewProof.sha256,
    );
    const proof = JSON.parse(bytes.toString());
    expect(proof.manifest.deliveries[0].status).toBe("passed");
    expect(w.page.goto).toHaveBeenCalledWith(
      "https://preview.example/settings",
      expect.anything(),
    );
    expect(w.page.screenshot).toHaveBeenCalledOnce();
    expect(existsSync(join(w.root, "pm-review-request.json"))).toBe(false);
  });
  it("ignores invented pass flags when the browser assertion fails", async () => {
    const w = world();
    w.locator.isVisible = async () => false;
    const result = await w.run();
    const proof = JSON.parse(
      readFileSync(join(w.root, result.reviewProof.file), "utf8"),
    );
    expect(proof.manifest.deliveries[0].status).toBe("failed");
  });
  it("blocks cross-origin paths before opening a page", async () => {
    const w = world();
    w.request.deliveries[0]!.checks[0]!.path = "//evil.example";
    const result = await w.run();
    expect(w.page.goto).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("blocked");
  });
  it("replays bounded interactions with a private same-origin role session, then removes secrets", async () => {
    const w = world();
    mkdirSync(join(w.root, "private"));
    writeFileSync(
      join(w.root, "private", "member.json"),
      JSON.stringify({
        cookies: [
          {
            domain: "preview.example",
            name: "session",
            value: "private-cookie",
            path: "/",
          },
        ],
        origins: [],
      }),
    );
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      session: "member",
      steps: [
        { action: "fill", selector: "#name", value: "private-input" },
        { action: "click", selector: "button.save" },
      ],
    });
    const result = await w.run();
    expect(w.locator.fill).toHaveBeenCalledWith("private-input");
    expect(w.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: expect.anything() }),
    );
    expect(existsSync(join(w.root, "private", "member.json"))).toBe(false);
    const proof = readFileSync(join(w.root, result.reviewProof.file), "utf8");
    expect(proof).not.toContain("private-cookie");
    expect(proof).not.toContain("private-input");
  });
  it("rejects another origin's session instead of replaying it", async () => {
    const w = world();
    mkdirSync(join(w.root, "private"));
    writeFileSync(
      join(w.root, "private", "member.json"),
      JSON.stringify({
        cookies: [{ domain: "evil.example", name: "session", value: "secret" }],
        origins: [],
      }),
    );
    Object.assign(w.request.deliveries[0]!.checks[0]!, { session: "member" });
    const result = await w.run();
    expect(w.page.goto).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("blocked");
  });
  it("rejects moved checkouts and empty acceptance plans", async () => {
    const w = world();
    await expect(
      runReviewReceipts({
        plan: w.plan,
        commitSha: "b".repeat(40),
        outputDirectory: w.root,
        chromium: {},
      }),
    ).rejects.toThrow("differs");
    w.plan.deliveries[0]!.criteria = [];
    expect(() => validateReviewPlan(w.plan)).toThrow(
      "finite approved criteria",
    );
  });
});
