import { expect, it, vi } from "vitest";
import { makeProject, TEST_REPO } from "../services/fakes.ts";
import { FakeForge } from "../forge/fake.ts";
import { readPromotionBatch, readPromotionBatches } from "./promotionBatch.ts";
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
it("keeps each PM's batch, distinct ticket progress and overrides separate while retaining legacy history", async () => {
  const w = world();
  w.project = makeProject({
    areas: [
      { key: "core", name: "Core", paths: ["core/"] },
      {
        key: "billing",
        name: "Billing",
        paths: ["billing/"],
        promotionBatchSize: 3,
      },
      { key: "new", name: "New", paths: ["new/"], instanceId: "new-instance" },
    ],
  });
  w.project.config.workflow = { kind: "promotion", promotionBatchSize: 5 };
  w.forge.patchPull(TEST_REPO, 20, { state: "merged" });
  const billingHead = "b".repeat(40);
  w.forge.seedPull(TEST_REPO, {
    number: 21,
    headRef: "pm-release/billing/20261007",
    headSha: billingHead,
    baseRef: "staging",
    draft: false,
  });
  const verified = {
    ...w.records[0]!,
    id: "verified-core",
    status: "verified" as const,
    promotion: undefined,
  };
  w.records.push(
    verified,
    { ...verified, id: "verified-core-retry" },
    {
      ...verified,
      id: "superseded-core",
      ticket: { ...verified.ticket, id: "superseded" },
      supersededBy: "new-attempt",
    },
    { ...verified, id: "old-pm", area: "new", areaInstanceId: "old-instance" },
    {
      ...verified,
      id: "billing-one",
      area: "billing",
      status: "promoted",
      promotion: {
        number: 21,
        url: `https://github.com/${TEST_REPO}/pull/21`,
        headSha: billingHead,
        branch: "pm-release/billing/20261007",
      },
    },
  );
  const result = await readPromotionBatches(w);
  expect(result.areas).toMatchObject([
    { area: "core", target: 5, verifiedTicketCount: 1, batch: null },
    {
      area: "billing",
      target: 3,
      verifiedTicketCount: 0,
      batch: { number: 21, ticketCount: 1, state: "open" },
    },
    { area: "new", target: 5, verifiedTicketCount: 0, batch: null },
  ]);
  expect(result.legacy).toMatchObject([
    { number: 20, ticketCount: 12, state: "merged" },
  ]);
  w.project.config.workflow = { kind: "promotion" };
  expect((await readPromotionBatches(w)).areas[0]!.target).toBe(10);
  w.forge.patchPull(TEST_REPO, 21, { headSha: "c".repeat(40) });
  expect((await readPromotionBatches(w)).areas[1]!.batch!.ticketCount).toBe(0);
});
it("fails closed when one PM has more than one open promotion", async () => {
  const w = world();
  w.forge.seedPull(TEST_REPO, {
    number: 21,
    headRef: "pm-release/core/one",
    baseRef: "staging",
  });
  w.forge.seedPull(TEST_REPO, {
    number: 22,
    headRef: "pm-release/core/two",
    baseRef: "staging",
  });
  await expect(readPromotionBatches(w)).rejects.toThrow(
    "More than one promotion is open for core",
  );
});
