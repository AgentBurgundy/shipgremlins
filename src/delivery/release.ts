import type { Project } from "../config.ts";
import type { CheckSummary, Forge, PullRequest } from "../forge/types.ts";
import { effectiveWorkflow } from "../projectCapabilities.ts";

export class ReleasePreparationError extends Error {}

/** Prepare the owner's final review; this never merges or deploys production. */
export async function prepareProductionRelease(input: {
  project: Project;
  forge: Forge;
  resolveChecks: (sha: string) => Promise<CheckSummary>;
}): Promise<PullRequest> {
  const { project, forge } = input;
  const { repo, branches } = project.config;
  if (effectiveWorkflow(project.config).kind !== "promotion")
    throw new ReleasePreparationError(
      "Production releases require the staged promotion workflow.",
    );
  const existing = (
    await forge.listOpenPulls(repo, { base: branches.production })
  ).filter((pull) => pull.headRef === branches.staging);
  if (existing.length > 1)
    throw new ReleasePreparationError(
      "More than one staging release is open. Review the existing releases.",
    );
  if (existing[0]) return existing[0];
  const sha = await forge.getBranchSha(repo, branches.staging);
  if (!sha)
    throw new ReleasePreparationError(
      "Create and review the staging branch before preparing a release.",
    );
  const productionSha = await forge.getBranchSha(repo, branches.production);
  if (!productionSha)
    throw new ReleasePreparationError(
      "The configured production branch is missing.",
    );
  const comparison = await forge.compare(
    repo,
    branches.production,
    branches.staging,
  );
  if (!comparison.aheadBy)
    throw new ReleasePreparationError("Staging has no new commits to release.");
  if (comparison.behindBy)
    throw new ReleasePreparationError(
      "Bring production changes into staging and test them before releasing.",
    );
  const providerChecks = await forge.getChecks(repo, sha);
  const checks =
    providerChecks.status === "none"
      ? await input.resolveChecks(sha)
      : providerChecks;
  if (checks.status !== "success")
    throw new ReleasePreparationError(
      "Staging checks must pass before preparing a production release.",
    );
  if ((await forge.getBranchSha(repo, branches.staging)) !== sha)
    throw new ReleasePreparationError(
      "Staging changed during its checks. Retry with the new revision.",
    );
  if ((await forge.getBranchSha(repo, branches.production)) !== productionSha)
    throw new ReleasePreparationError(
      "Production changed during the release checks. Bring it into staging and retry.",
    );
  return forge.createPull(repo, {
    head: branches.staging,
    base: branches.production,
    title: `Release ${project.config.name}: ${branches.staging} → ${branches.production}`,
    body: `## Release review\n\nRelease the reviewed staging branch to production.\n\n- Checked staging revision: \`${sha}\`\n- Review the staging deployment and the included promotion PRs before merging.\n- Merging this PR follows the repository's production deployment rules.\n- Tickets are completed only after production inclusion is confirmed.\n`,
    draft: true,
  });
}
