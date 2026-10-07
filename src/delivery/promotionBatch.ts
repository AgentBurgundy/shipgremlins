import type { Project } from "../config.ts";
import type { Forge, PullRequest } from "../forge/types.ts";
import type { DeliveryRecord } from "./types.ts";
import { promotionBatchSize } from "./batching.ts";

export interface PromotionBatch {
  url: string;
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  headSha: string;
  branch: string;
  baseBranch: string;
  draft: boolean;
  ticketCount: number;
  prerequisiteBatch?: boolean;
  rebuiltBatch?: boolean;
  checkedAt: string;
}

export interface PmPromotionBatch {
  area: string;
  name: string;
  target: number;
  verifiedTicketCount: number;
  batch: PromotionBatch | null;
}
export interface PromotionBatches {
  areas: PmPromotionBatch[];
  /** Existing combined promotions remain readable, never reassigned to a PM. */
  legacy: PromotionBatch[];
}

export async function readPromotionBatches(options: {
  project: Project;
  forge: Forge;
  records: DeliveryRecord[];
  now?: () => Date;
}): Promise<PromotionBatches> {
  const { project, forge, records } = options;
  const open = await forge.listOpenPulls(project.config.repo, {
    base: project.config.branches.staging,
  });
  const read = async (area: string, owned: DeliveryRecord[]) => {
    const prefix = `pm-release/${area}/`;
    const authors = new Set(
      owned.map((record) => record.implementation.author),
    );
    const matches = (pull: PullRequest) =>
      pull.baseRef === project.config.branches.staging &&
      pull.headRef.startsWith(prefix) &&
      authors.has(pull.author);
    const active = open.filter(matches);
    if (active.length > 1)
      throw new Error(
        `More than one promotion is open for ${area}. Existing PRs are preserved.`,
      );
    const known = [
      ...new Set(
        owned
          .filter((record) => record.promotion?.branch.startsWith(prefix))
          .map((record) => record.promotion!.number),
      ),
    ].sort((a, b) => b - a);
    for (const number of active.length ? [active[0]!.number] : known) {
      const pull = await forge.getPull(project.config.repo, number);
      if (!pull || !matches(pull)) continue;
      return {
        url: pull.htmlUrl,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        headSha: pull.headSha,
        branch: pull.headRef,
        baseBranch: pull.baseRef,
        draft: pull.draft,
        ...(pull.body.includes("## Prerequisite batch\n")
          ? { prerequisiteBatch: true }
          : {}),
        ...(pull.body.includes("## Rebuilt batch\n")
          ? { rebuiltBatch: true }
          : {}),
        ticketCount: new Set(
          owned
            .filter(
              (record) =>
                record.promotion?.number === pull.number &&
                record.promotion.headSha === pull.headSha,
            )
            .map((record) => record.ticket.id),
        ).size,
        checkedAt: (options.now?.() ?? new Date()).toISOString(),
      } satisfies PromotionBatch;
    }
    return null;
  };
  const areas = await Promise.all(
    project.areas.map(async (area) => {
      const owned = records.filter(
        (record) =>
          record.area === area.key && record.areaInstanceId === area.instanceId,
      );
      return {
        area: area.key,
        name: area.name,
        target: promotionBatchSize(project, area.key),
        verifiedTicketCount: new Set(
          owned
            .filter(
              (record) => record.status === "verified" && !record.supersededBy,
            )
            .map((record) => record.ticket.id),
        ).size,
        batch: await read(area.key, owned),
      };
    }),
  );
  const legacy = await read("combined", records);
  return { areas, legacy: legacy ? [legacy] : [] };
}

/** PR lifecycle comes from a fresh provider read; a retained promotion URL is not proof it is open. */
export async function readPromotionBatch(options: {
  project: Project;
  forge: Forge;
  records: DeliveryRecord[];
  now?: () => Date;
}): Promise<PromotionBatch | null> {
  const { project, forge, records } = options;
  const authors = new Set(
    records.map((record) => record.implementation.author),
  );
  const matches = (pull: PullRequest) =>
    pull.baseRef === project.config.branches.staging &&
    pull.headRef.startsWith("pm-release/combined/") &&
    authors.has(pull.author);
  const open = (
    await forge.listOpenPulls(project.config.repo, {
      base: project.config.branches.staging,
    })
  ).filter(matches);
  if (open.length > 1)
    throw new Error(
      "More than one combined promotion is open. Review the existing batches before continuing.",
    );
  const known = [
    ...new Set(
      records
        .filter((record) =>
          record.promotion?.branch.startsWith("pm-release/combined/"),
        )
        .map((record) => record.promotion!.number),
    ),
  ].sort((a, b) => b - a);
  for (const number of open.length ? [open[0]!.number] : known) {
    const pull = await forge.getPull(project.config.repo, number);
    if (!pull || !matches(pull)) continue;
    return {
      url: pull.htmlUrl,
      number: pull.number,
      title: pull.title,
      state: pull.state,
      headSha: pull.headSha,
      branch: pull.headRef,
      baseBranch: pull.baseRef,
      draft: pull.draft,
      ticketCount: new Set(
        records
          .filter(
            (record) =>
              record.promotion?.number === pull.number &&
              record.promotion.headSha === pull.headSha,
          )
          .map((record) => record.ticket.id),
      ).size,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  }
  return null;
}
