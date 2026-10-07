import type { Project } from "../config.ts";
import { createHash } from "node:crypto";
import type { DeliveryRecord } from "./types.ts";

export const DEFAULT_PROMOTION_BATCH_SIZE = 10;
export const MAX_PROMOTION_BATCH_SIZE = 100;
export const validPromotionBatchSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= 1 &&
  Number(value) <= MAX_PROMOTION_BATCH_SIZE;

export function promotionBatchSize(project: Project, area: string): number {
  const configured = project.areas.find(
    (item) => item.key === area,
  )?.promotionBatchSize;
  if (configured !== undefined) return configured;
  return project.config.workflow?.kind === "promotion"
    ? (project.config.workflow.promotionBatchSize ??
        DEFAULT_PROMOTION_BATCH_SIZE)
    : DEFAULT_PROMOTION_BATCH_SIZE;
}

/** A new review, batch target, or staging baseline can unblock a held PM batch. */
export function automaticPromotionKey(
  project: Project,
  area: string,
  records: DeliveryRecord[],
  stagingSha?: string,
): string | undefined {
  const owner = project.areas.find((item) => item.key === area);
  if (!owner) return undefined;
  const verified = records
    .filter(
      (item) =>
        item.area === area &&
        item.areaInstanceId === owner.instanceId &&
        item.status === "verified" &&
        item.review &&
        !item.supersededBy,
    )
    .map((item) => ({ id: item.id, review: item.review!.manifestHash }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!verified.length) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        verified,
        // Another PM's newly verified work may need this area's below-target
        // prerequisite batch. Reconsider once per changed verified frontier.
        dependencies: records
          .filter(
            (item) =>
              item.area !== area &&
              item.status === "verified" &&
              item.review &&
              !item.supersededBy &&
              project.areas.some(
                (pm) =>
                  pm.key === item.area && pm.instanceId === item.areaInstanceId,
              ),
          )
          .map((item) => ({ id: item.id, review: item.review!.manifestHash }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        target: promotionBatchSize(project, area),
        stagingSha,
      }),
    )
    .digest("hex");
}
