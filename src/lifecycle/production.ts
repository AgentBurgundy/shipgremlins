import { createHash } from "node:crypto";
import type { Ctx } from "../dispatcher/context.ts";
import { developerBranch } from "../dispatcher/notes.ts";
import type {
  PullChange,
  PullRequest,
  RevisionTreeEntry,
} from "../forge/types.ts";
import type { LinearTicket, LinearWorkflowState } from "../services/types.ts";
import {
  parseCompletionManifest,
  ticketScopeHash,
  type CompletionManifest,
  type CompletionScope,
} from "./manifest.ts";

export interface ProductionEvidence {
  implementationPr: number;
  implementationUrl: string;
  implementationMergeSha: string;
  productionPr: number;
  productionUrl: string;
  productionMergeSha: string;
  mergedAt: string;
  mapping: "ancestry-and-content" | "exact-content" | "verified-composition";
  promotionPr?: number;
  promotionSourceSha?: string;
  checkedPaths: string[];
}

export interface TicketAudit {
  ticketId: string;
  identifier: string;
  projectId?: string;
  teamId?: string;
  currentState: string;
  scopeHash: string;
  classification:
    "canceled" | "ambiguous" | "not-production" | "production-confirmed";
  reason: string;
  proposedStateId?: string;
  availableCompletedStates: LinearWorkflowState[];
  evidence: ProductionEvidence[];
  transitionKey?: string;
  applied?: boolean;
}

export interface ProductionAudit {
  repo: string;
  productionBranch: string;
  productionHead: string | null;
  checkedAt: string;
  dryRun: boolean;
  tickets: TicketAudit[];
}

const pathsOf = (changes: PullChange[]): string[] =>
  [
    ...new Set(
      changes.flatMap((c) =>
        c.previousPath ? [c.path, c.previousPath] : [c.path],
      ),
    ),
  ].sort();
const merged = (
  pr: PullRequest | null,
): pr is PullRequest & { mergeCommitSha: string; mergedAt: string } =>
  Boolean(pr?.state === "merged" && pr.mergeCommitSha && pr.mergedAt);
const entryIdentity = (entry: RevisionTreeEntry | undefined): string =>
  entry ? `${entry.type}:${entry.mode}:${entry.sha}` : "absent";

function scopeMatches(ticket: LinearTicket, scope: CompletionScope): boolean {
  return (
    ticket.id === scope.ticketId &&
    ticket.projectId === scope.projectId &&
    ticket.teamId === scope.teamId &&
    ticketScopeHash(ticket) === scope.scopeHash
  );
}

/** Reads only. Production records and Git trees, never comments, establish inclusion.
 * Exact-file matching intentionally leaves later edits and complex ports for review. */
export async function auditProduction(
  ctx: Ctx,
  supplied?: CompletionManifest,
  options: { onlySuppliedTickets?: boolean } = {},
): Promise<ProductionAudit> {
  const { repo, branches } = ctx.project.config;
  const manifest = supplied ? parseCompletionManifest(supplied) : undefined;
  if (
    manifest &&
    (manifest.repo !== repo ||
      manifest.productionBranch !== branches.production)
  )
    throw new Error(
      "Completion manifest does not match this repository and production branch",
    );
  const scopes = new Map(manifest?.tickets.map((t) => [t.ticketId, t]) ?? []);
  const tracked = new Map<string, LinearTicket>();
  for (const area of ctx.project.areas) {
    for (const ticket of await ctx.linear.listTickets(area.linearProjectId, [
      area.label,
    ]))
      if (!options.onlySuppliedTickets || scopes.has(ticket.id))
        tracked.set(ticket.id, ticket);
  }
  // A manifest may not enroll arbitrary workspace tickets or other projects.
  for (const scope of scopes.values())
    if (!tracked.has(scope.ticketId))
      throw new Error(
        `Manifest ticket ${scope.ticketId} is outside the configured area projects/labels`,
      );
  const productionHead = await ctx.forge.getBranchSha(
    repo,
    branches.production,
  );
  const report: ProductionAudit = {
    repo,
    productionBranch: branches.production,
    productionHead,
    checkedAt: ctx.now().toISOString(),
    dryRun: true,
    tickets: [],
  };
  const treeCache = new Map<string, Promise<Map<string, RevisionTreeEntry>>>();
  const tree = (sha: string) => {
    if (!ctx.forge.getRevisionTree)
      throw new Error("Forge cannot read complete revision trees");
    let value = treeCache.get(sha);
    if (!value) {
      value = ctx.forge
        .getRevisionTree(repo, sha)
        .then((entries) => new Map(entries.map((e) => [e.path, e])));
      treeCache.set(sha, value);
    }
    return value;
  };
  const stateCache = new Map<string, LinearWorkflowState[]>();
  for (const ticket of tracked.values()) {
    const row: TicketAudit = {
      ticketId: ticket.id,
      identifier: ticket.identifier,
      projectId: ticket.projectId,
      teamId: ticket.teamId,
      currentState: ticket.stateType,
      scopeHash: ticketScopeHash(ticket),
      classification: "ambiguous",
      reason:
        "No reviewed finite deliverable manifest; production completion cannot be inferred from labels or comments",
      availableCompletedStates: [],
      evidence: [],
    };
    report.tickets.push(row);
    if (ticket.stateType === "canceled") {
      row.classification = "canceled";
      row.reason = "Owner cancellation is preserved";
      continue;
    }
    if (ticket.teamId && ctx.linear.listWorkflowStates) {
      if (!stateCache.has(ticket.teamId))
        stateCache.set(
          ticket.teamId,
          await ctx.linear.listWorkflowStates(ticket.teamId),
        );
      row.availableCompletedStates = stateCache
        .get(ticket.teamId)!
        .filter((s) => s.teamId === ticket.teamId && s.type === "completed");
    }
    const scope = scopes.get(ticket.id);
    if (!scope) continue;
    if (!scopeMatches(ticket, scope)) {
      row.reason = "Ticket scope, team, or project changed after approval";
      continue;
    }
    if (Date.parse(scope.approvedAt) > ctx.now().getTime()) {
      row.reason = "Scope approval is dated in the future";
      continue;
    }
    if (
      !ticket.stateId ||
      !row.availableCompletedStates.some((s) => s.id === scope.completedStateId)
    ) {
      row.reason =
        "Actual current state and completed workflow state IDs must resolve in this ticket's team";
      continue;
    }
    if (!productionHead) {
      row.reason = "Configured production branch does not exist";
      continue;
    }
    if (!ctx.forge.listPullChanges || !ctx.forge.getRevisionTree) {
      row.reason =
        "Forge does not support complete production provenance reads";
      continue;
    }
    try {
      const composition = scope.composition;
      const promotion = composition
        ? await ctx.forge.getPull(repo, composition.promotionPr)
        : null;
      if (
        composition &&
        (!merged(promotion) ||
          promotion.author !== ctx.botLogin ||
          promotion.baseRef !== branches.staging ||
          promotion.headRef !== composition.branch ||
          promotion.headSha !== composition.headSha)
      )
        throw new Error(
          "Recorded verified promotion identity changed or is not merged into staging",
        );
      const promotionPaths = composition
        ? new Set(
            pathsOf(await ctx.forge.listPullChanges(repo, promotion!.number)),
          )
        : null;
      const promotionHead = composition ? await tree(promotion!.headSha) : null;
      const promotionMerge = composition
        ? await tree(promotion!.mergeCommitSha!)
        : null;
      for (const required of scope.deliverables) {
        const [implementation, production] = await Promise.all([
          ctx.forge.getPull(repo, required.implementationPr),
          ctx.forge.getPull(repo, required.productionPr),
        ]);
        if (!merged(implementation))
          throw new Error(
            `Implementation PR #${required.implementationPr} is not confirmed merged`,
          );
        if (
          implementation.author !== ctx.botLogin ||
          implementation.headRef.toLowerCase() !==
            (required.implementationBranch ??
              developerBranch(ticket.identifier)) ||
          (required.implementationHeadSha !== undefined &&
            implementation.headSha !== required.implementationHeadSha) ||
          (required.implementationMergeSha !== undefined &&
            implementation.mergeCommitSha !==
              required.implementationMergeSha) ||
          ![
            branches.integration,
            branches.staging,
            branches.production,
          ].includes(implementation.baseRef)
        )
          throw new Error(
            `Implementation PR #${required.implementationPr} is not a tracked bot implementation for this ticket`,
          );
        if (!merged(production) || production.baseRef !== branches.production) {
          row.classification = "not-production";
          throw new Error(
            `PR #${required.productionPr} has not merged into ${branches.production}`,
          );
        }
        if (
          Date.parse(production.mergedAt) < Date.parse(implementation.mergedAt)
        )
          throw new Error("Production merge predates the implementation merge");
        if (
          composition &&
          (production.headRef !== branches.staging ||
            Date.parse(promotion!.mergedAt!) <
              Date.parse(implementation.mergedAt) ||
            Date.parse(production.mergedAt) < Date.parse(promotion!.mergedAt!))
        )
          throw new Error(
            "Production must follow the recorded verified promotion from staging",
          );
        const lineage = await ctx.forge.compare(
          repo,
          production.mergeCommitSha,
          productionHead,
        );
        if (lineage.behindBy !== 0)
          throw new Error(
            "Recorded production merge is absent from current production history",
          );
        let paths = pathsOf(
          await ctx.forge.listPullChanges(repo, implementation.number),
        );
        const [sourceTree, releaseTree, currentTree, sourceHeadTree] =
          await Promise.all([
            tree(implementation.mergeCommitSha),
            tree(production.mergeCommitSha),
            tree(productionHead),
            tree(implementation.headSha),
          ]);
        if (required.promotionSource) {
          const source = required.promotionSource;
          const [portTree, baseTree, portHistory, testedHistory] =
            await Promise.all([
              tree(source.sha),
              tree(source.baseSha),
              ctx.forge.compare(repo, source.baseSha, source.sha),
              ctx.forge.compare(repo, source.sha, implementation.headSha),
            ]);
          if (
            portHistory.aheadBy !== 1 ||
            portHistory.behindBy !== 0 ||
            testedHistory.behindBy !== 0
          )
            throw new Error(
              "Isolated promotion source is not the recorded one-commit staging port in the tested implementation head",
            );
          const allowed = new Set(source.paths);
          const portPaths = [
            ...new Set([...baseTree.keys(), ...portTree.keys()]),
          ]
            .filter(
              (path) =>
                entryIdentity(baseTree.get(path)) !==
                entryIdentity(portTree.get(path)),
            )
            .sort();
          if (
            !portPaths.length ||
            [...paths, ...portPaths].some((path) => !allowed.has(path))
          )
            throw new Error(
              "Isolated promotion source or integration draft escaped its recorded finite path scope",
            );
          for (const path of portPaths) {
            if (
              entryIdentity(portTree.get(path)) !==
                entryIdentity(sourceHeadTree.get(path)) ||
              entryIdentity(portTree.get(path)) !==
                entryIdentity(sourceTree.get(path))
            )
              throw new Error(
                `Tested integration does not preserve isolated promotion source at ${path}`,
              );
          }
          // Squashing the internal merge can erase the port's ancestry and leave
          // its PR with no file diff. The exact worker-registered source still
          // has to be present, with identical modes/content, in both QA revisions.
          paths = portPaths;
        }
        if (!paths.length)
          throw new Error(
            "Empty implementation change set cannot prove delivery",
          );
        for (const path of paths) {
          const originalIdentity = entryIdentity(sourceTree.get(path));
          if (originalIdentity !== entryIdentity(sourceHeadTree.get(path)))
            throw new Error(
              `Implementation merge changed ${path}; revised candidate needs review`,
            );
          if (composition && !promotionPaths!.has(path))
            throw new Error(
              `Verified promotion does not cover ${path} from the complete implementation and repair set`,
            );
          const identity = composition
            ? entryIdentity(promotionHead!.get(path))
            : originalIdentity;
          if (
            composition &&
            identity !== entryIdentity(promotionMerge!.get(path))
          )
            throw new Error(
              `Promotion merge changed ${path}; revised composition needs verification`,
            );
          if (identity !== entryIdentity(releaseTree.get(path)))
            throw new Error(
              `Production merge does not preserve ${path}; partial or edited port needs review`,
            );
          if (identity !== entryIdentity(currentTree.get(path)))
            throw new Error(
              `Current production differs at ${path}; possible revert or later edit needs review`,
            );
        }
        const sourceLineage = await ctx.forge.compare(
          repo,
          composition
            ? promotion!.mergeCommitSha!
            : implementation.mergeCommitSha,
          production.mergeCommitSha,
        );
        let mapping: ProductionEvidence["mapping"] = "ancestry-and-content";
        if (sourceLineage.behindBy !== 0) {
          // Squash/cherry-pick changes SHAs. Require the actual production PR
          // diff to deliver every original changed path and retain exact blobs.
          const releasePaths = new Set(
            pathsOf(await ctx.forge.listPullChanges(repo, production.number)),
          );
          if (paths.some((path) => !releasePaths.has(path)))
            throw new Error(
              "Changed SHAs lack a complete exact-content production PR mapping",
            );
          mapping = "exact-content";
        }
        row.evidence.push({
          implementationPr: implementation.number,
          implementationUrl: implementation.htmlUrl,
          implementationMergeSha: implementation.mergeCommitSha,
          productionPr: production.number,
          productionUrl: production.htmlUrl,
          productionMergeSha: production.mergeCommitSha,
          mergedAt: production.mergedAt,
          mapping: composition ? "verified-composition" : mapping,
          ...(composition ? { promotionPr: composition.promotionPr } : {}),
          ...(required.promotionSource
            ? { promotionSourceSha: required.promotionSource.sha }
            : {}),
          checkedPaths: paths,
        });
      }
      row.classification = "production-confirmed";
      row.proposedStateId = scope.completedStateId;
      row.reason =
        "Every approved deliverable is merged into configured production and its changed file contents remain present";
      row.transitionKey = createHash("sha256")
        .update(
          JSON.stringify({
            repo,
            production: branches.production,
            ticket: ticket.id,
            scope: scope.scopeHash,
            state: scope.completedStateId,
            deliverables: row.evidence
              .map((e) => [
                e.implementationPr,
                e.implementationMergeSha,
                e.productionPr,
                e.productionMergeSha,
                ...(e.promotionSourceSha ? [e.promotionSourceSha] : []),
              ])
              .sort((a, b) => String(a).localeCompare(String(b))),
          }),
        )
        .digest("hex");
    } catch (err) {
      row.reason = err instanceof Error ? err.message : String(err);
    }
  }
  return report;
}

/** Explicit opt-in writes; the default is a read-only audit. No bulk reopen. */
export async function reconcileProduction(
  ctx: Ctx,
  manifest: CompletionManifest,
  options: {
    apply?: boolean;
    authorizeTicket?: (ticketId: string) => Promise<boolean>;
    onlySuppliedTickets?: boolean;
    /** Managed batches isolate a provider error to its ticket and retry it later. */
    continueOnTicketError?: boolean;
  } = {},
): Promise<ProductionAudit> {
  const report = await auditProduction(ctx, manifest, options);
  if (!options.apply || ctx.dryRun) return report;
  if (!ctx.linear.updateWorkflowState)
    throw new Error(
      "Linear client cannot perform guarded production transitions",
    );
  report.dryRun = false;
  for (const row of report.tickets) {
    if (
      row.classification !== "production-confirmed" ||
      !row.proposedStateId ||
      !row.transitionKey ||
      row.currentState === "completed"
    )
      continue;
    try {
      const scope = manifest.tickets.find((t) => t.ticketId === row.ticketId)!;
      if (
        options.authorizeTicket &&
        !(await options.authorizeTicket(row.ticketId))
      ) {
        row.reason =
          "Current managed scope or owner approval changed; no transition applied";
        continue;
      }
      const before = await ctx.linear.getTicket(row.ticketId);
      if (
        !before ||
        before.stateType === "canceled" ||
        before.stateType === "completed" ||
        !scopeMatches(before, scope)
      ) {
        row.reason = "Ticket changed after audit; no transition applied";
        continue;
      }
      const expectedStateId = before.stateId;
      if (
        (await ctx.forge.getBranchSha(report.repo, report.productionBranch)) !==
        report.productionHead
      ) {
        row.reason =
          "Production advanced after audit; rerun to validate the new tree";
        continue;
      }
      const marker = `<!-- shipgremlins:production:${row.transitionKey} -->`;
      if (
        !(await ctx.linear.listComments(row.ticketId)).some((c) =>
          c.body.includes(marker),
        )
      ) {
        await ctx.linear.addComment(
          row.ticketId,
          `${marker}\nProduction completion evidence for ${report.repo}@${report.productionBranch}. All ${row.evidence.length} approved deliverables verified at ${report.productionHead}.\n${row.evidence.map((e) => `- ${e.implementationUrl} → ${e.productionUrl} (${e.productionMergeSha}, merged ${e.mergedAt}, ${e.mapping})`).join("\n")}\nScope: ${scope.scopeHash}; approved by ${scope.approvedBy} at ${scope.approvedAt}. This records production merge, not deployment health. Status transition is attempted separately and may be retried.`,
        );
      }
      // Comments are not evidence or authorization. Re-fetch after our comment,
      // since it may change updatedAt; preserve owner cancellation and scope edits.
      const current = await ctx.linear.getTicket(row.ticketId);
      if (
        !current ||
        !current.stateId ||
        current.stateType === "canceled" ||
        current.stateType === "completed" ||
        current.stateId !== expectedStateId ||
        !scopeMatches(current, scope)
      ) {
        row.reason = "Ticket changed before transition; no transition applied";
        continue;
      }
      if (
        (await ctx.forge.getBranchSha(report.repo, report.productionBranch)) !==
        report.productionHead
      ) {
        row.reason =
          "Production changed before transition; no transition applied";
        continue;
      }
      if (
        options.authorizeTicket &&
        !(await options.authorizeTicket(row.ticketId))
      ) {
        row.reason =
          "Current managed scope or owner approval changed before transition";
        continue;
      }
      await ctx.linear.updateWorkflowState(current.id, row.proposedStateId, {
        projectId: scope.projectId,
        teamId: scope.teamId,
        stateId: current.stateId,
        updatedAt: current.updatedAt,
      });
      row.applied = true;
    } catch (error) {
      if (!options.continueOnTicketError) throw error;
      row.reason =
        "The provider could not confirm this ticket's completion update. Saved evidence is preserved; the controller will retry without blocking other tickets.";
    }
  }
  return report;
}
