import type { Project } from "../config.ts";
import type { Forge, PullRequest } from "../forge/types.ts";
import type { DeliveryRecord } from "./types.ts";

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
  checkedAt: string;
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
