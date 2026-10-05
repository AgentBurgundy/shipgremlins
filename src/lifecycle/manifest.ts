import { createHash } from "node:crypto";
import type { LinearTicket } from "../services/types.ts";

/** An operator-reviewed finite scope, kept outside worker-controlled repositories.
 * This file is an authority boundary: never generate approvals from ticket/PR prose. */
export interface CompletionManifest {
  version: 1;
  repo: string;
  productionBranch: string;
  tickets: CompletionScope[];
}

export interface CompletionScope {
  ticketId: string;
  projectId: string;
  teamId: string;
  scopeHash: string;
  approvedBy: string;
  approvedAt: string;
  completedStateId: string;
  deliverables: {
    implementationPr: number;
    productionPr: number;
    implementationBranch?: string;
    implementationHeadSha?: string;
  }[];
}

/** State/labels are deliberately excluded: QA and reconciliation change them. */
export function ticketScopeHash(ticket: LinearTicket): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: ticket.id,
        identifier: ticket.identifier,
        projectId: ticket.projectId,
        teamId: ticket.teamId,
        title: ticket.title,
        description: ticket.description,
      }),
    )
    .digest("hex");
}

export function parseCompletionManifest(input: unknown): CompletionManifest {
  const fail = (reason: string): never => {
    throw new Error(`Invalid completion manifest: ${reason}`);
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail("expected an object");
    return value as Record<string, unknown>;
  };
  const required = (value: unknown, key: string): string => {
    if (typeof value !== "string" || !value.trim())
      return fail(`${key} is required`);
    return value;
  };
  const root = record(input);
  if (root.version !== 1 || !Array.isArray(root.tickets))
    return fail("version must be 1 and tickets must be an array");
  const seen = new Set<string>();
  const tickets = root.tickets.map((value): CompletionScope => {
    const t = record(value);
    const ticketId = required(t.ticketId, "ticketId");
    if (seen.has(ticketId)) return fail(`duplicate ticket ${ticketId}`);
    seen.add(ticketId);
    const scopeHash = required(t.scopeHash, "scopeHash");
    if (!/^[a-f0-9]{64}$/.test(scopeHash))
      return fail("scopeHash must be SHA-256");
    const approvedAt = required(t.approvedAt, "approvedAt");
    if (!Number.isFinite(Date.parse(approvedAt)))
      return fail("approvedAt must be a timestamp");
    if (!Array.isArray(t.deliverables) || !t.deliverables.length)
      return fail(`${ticketId} needs a nonempty deliverable set`);
    const pulls = new Set<number>();
    const deliverables = t.deliverables.map((d) => {
      const item = record(d);
      for (const key of ["implementationPr", "productionPr"] as const) {
        if (
          typeof item[key] !== "number" ||
          !Number.isSafeInteger(item[key]) ||
          item[key] < 1
        )
          return fail(`${key} must be a positive PR number`);
      }
      const implementationPr = item.implementationPr as number;
      if (
        (item.implementationBranch === undefined) !==
        (item.implementationHeadSha === undefined)
      )
        return fail(
          "local implementation identity requires both branch and head SHA",
        );
      if (
        item.implementationBranch !== undefined &&
        (typeof item.implementationBranch !== "string" ||
          !/^gremlins\/job-[a-z0-9-]{1,58}$/.test(item.implementationBranch) ||
          typeof item.implementationHeadSha !== "string" ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.implementationHeadSha))
      )
        return fail("local implementation branch or head SHA is invalid");
      if (pulls.has(implementationPr))
        return fail(`duplicate implementation PR #${implementationPr}`);
      pulls.add(implementationPr);
      return {
        implementationPr,
        productionPr: item.productionPr as number,
        ...(item.implementationBranch === undefined
          ? {}
          : {
              implementationBranch: item.implementationBranch as string,
              implementationHeadSha: item.implementationHeadSha as string,
            }),
      };
    });
    return {
      ticketId,
      scopeHash,
      approvedAt,
      projectId: required(t.projectId, "projectId"),
      teamId: required(t.teamId, "teamId"),
      approvedBy: required(t.approvedBy, "approvedBy"),
      completedStateId: required(t.completedStateId, "completedStateId"),
      deliverables,
    };
  });
  return {
    version: 1,
    repo: required(root.repo, "repo"),
    productionBranch: required(root.productionBranch, "productionBranch"),
    tickets,
  };
}
