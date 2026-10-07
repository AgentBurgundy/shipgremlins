import { expect, it, vi } from "vitest";
import { makeProject, TEST_REPO } from "../services/fakes.ts";
import { FakeForge } from "../forge/fake.ts";
import { readPromotionBatch } from "./promotionBatch.ts";
import type { DeliveryRecord } from "./types.ts";
const head = "a".repeat(40),
  branch = "pm-release/combined/20261006";
function world() {
  const project = makeProject(),
    forge = new FakeForge();
  const records: DeliveryRecord[] = Array.from({ length: 12 }, (_, i) => ({
    id: `job-${i}`,
    jobId: `job-${i}`,
    project: "game",
    area: "core",
    repository: TEST_REPO,
    configuration: "config",
    ticket: {
      id: `ticket-${i}`,
      identifier: `GAME-${i}`,
      title: "Ticket",
      description: "Scope",
      projectId: "linear",
      teamId: "team",
    },
    scopeHash: "scope",
    approvedBy: "owner",
    approvedAt: "2026-10-06T12:00:00Z",
    status: "promoted",
    message: "ready",
    createdAt: "2026-10-06T12:00:00Z",
    updatedAt: "2026-10-06T12:00:00Z",
    implementation: {
      number: i + 1,
      url: `https://github.com/${TEST_REPO}/pull/${i + 1}`,
      branch: `gremlins/job-${i}`,
      headSha: head,
      author: forge.botLogin,
    },
    promotion: {
      number: 20,
      url: `https://github.com/${TEST_REPO}/pull/20`,
      headSha: head,
      branch,
    },
  }));
  forge.seedPull(TEST_REPO, {
    number: 20,
    headRef: branch,
    headSha: head,
    baseRef: "staging",
    draft: false,
    title: "Twelve PM-tested improvements",
  });
  const options = {
    project,
    forge,
    records,
    now: () => new Date("2026-10-06T13:00:00Z"),
  };
  return { ...options, read: () => readPromotionBatch(options) };
}
it("reports an accumulating batch with twelve independently tracked tickets", async () => {
  const w = world();
  expect(await w.read()).toMatchObject({
    number: 20,
    state: "open",
    draft: false,
    headSha: head,
    ticketCount: 12,
  });
  w.records.push({ ...w.records[0]!, id: "job-repair", jobId: "job-repair" });
  expect((await w.read())?.ticketCount).toBe(12);
});
it.each(["merged", "closed"] as const)(
  "refreshes historical ledger URLs to actual %s provider state",
  async (state) => {
    const w = world();
    w.forge.patchPull(TEST_REPO, 20, { state });
    expect(await w.read()).toMatchObject({ number: 20, state });
  },
);
it("freshly reads the selected PR after listing it, including a concurrent owner merge", async () => {
  const w = world(),
    original = w.forge.listOpenPulls.bind(w.forge);
  vi.spyOn(w.forge, "listOpenPulls").mockImplementation(async (...args) => {
    const listed = structuredClone(await original(...args));
    w.forge.patchPull(TEST_REPO, 20, { state: "merged" });
    return listed;
  });
  expect((await w.read())?.state).toBe("merged");
});
it("prefers the current combined PR and never reports stale head receipts as current ticket counts", async () => {
  const w = world();
  w.forge.patchPull(TEST_REPO, 20, { state: "closed" });
  w.forge.seedPull(TEST_REPO, {
    number: 21,
    headRef: "pm-release/combined/20261007",
    headSha: "b".repeat(40),
    baseRef: "staging",
    draft: false,
  });
  expect(await w.read()).toMatchObject({
    number: 21,
    state: "open",
    ticketCount: 0,
  });
});
it("does not adopt similarly named foreign-author or production-target PRs", async () => {
  const w = world();
  w.forge.patchPull(TEST_REPO, 20, { author: "someone-else" });
  expect(await w.read()).toBeNull();
  w.forge.patchPull(TEST_REPO, 20, {
    author: w.forge.botLogin,
    baseRef: "main",
  });
  expect(await w.read()).toBeNull();
});
it("does not guess between two open combined promotions", async () => {
  const w = world();
  w.forge.seedPull(TEST_REPO, {
    number: 21,
    headRef: "pm-release/combined/20261007",
    baseRef: "staging",
  });
  await expect(w.read()).rejects.toThrow("More than one combined promotion");
});
