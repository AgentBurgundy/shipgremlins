import { expect, it } from "vitest";
import { makeProject } from "../services/fakes.ts";
import { automaticPromotionKey, promotionBatchSize } from "./batching.ts";
import { deliveryConfiguration } from "./index.ts";
import type { DeliveryRecord } from "./types.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";

it("keeps the default and PM override independent of accepted delivery evidence", () => {
  const project = makeProject({ config: { workflow: { kind: "promotion" } } });
  const evidence = deliveryConfiguration(project, "core");
  const discovery = knowledgeRevision(project, project.areas[0]!);
  expect(promotionBatchSize(project, "core")).toBe(10);
  project.config.workflow = { kind: "promotion", promotionBatchSize: 20 };
  expect(promotionBatchSize(project, "core")).toBe(20);
  project.areas[0]!.promotionBatchSize = 3;
  expect(promotionBatchSize(project, "core")).toBe(3);
  expect(deliveryConfiguration(project, "core")).toBe(evidence);
  expect(knowledgeRevision(project, project.areas[0]!)).toBe(discovery);
});

it("reconsiders a PM batch when its reviews, current PM dependencies, target or staging baseline change", () => {
  const project = makeProject({ config: { workflow: { kind: "promotion" } } });
  const record = {
    id: "one",
    area: "core",
    status: "verified",
    review: { manifestHash: "review-one" },
  } as DeliveryRecord;
  const key = automaticPromotionKey(project, "core", [record], "staging-one");
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(
    automaticPromotionKey(project, "core", [{ ...record }], "staging-one"),
  ).toBe(key);
  expect(
    automaticPromotionKey(
      project,
      "core",
      [record, { ...record, area: "billing", id: "other" }],
      "staging-one",
    ),
  ).toBe(key);
  project.areas.push({ ...project.areas[0]!, key: "billing", name: "Billing" });
  expect(
    automaticPromotionKey(
      project,
      "core",
      [record, { ...record, area: "billing", id: "other" }],
      "staging-one",
    ),
  ).not.toBe(key);
  expect(
    automaticPromotionKey(project, "core", [record], "staging-two"),
  ).not.toBe(key);
  project.areas[0]!.promotionBatchSize = 1;
  expect(
    automaticPromotionKey(project, "core", [record], "staging-one"),
  ).not.toBe(key);
  expect(
    automaticPromotionKey(
      project,
      "core",
      [{ ...record, supersededBy: "two" }],
      "staging-one",
    ),
  ).toBeUndefined();
  project.areas[0]!.instanceId = "new-pm";
  expect(
    automaticPromotionKey(project, "core", [record], "staging-one"),
  ).toBeUndefined();
});
