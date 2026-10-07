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
    implementationMergeSha?: string;
    /** Worker-proven isolated source, freshly QAed after merging into integration. */
    promotionSource?: { sha: string; baseSha: string; paths: string[] };
  }[];
  /** Controller-recorded final composition of an implementation and its verified repair. */
  composition?: {
    promotionPr: number;
    branch: string;
    headSha: string;
    implementationPrs: number[];
  };
}

/** State/labels are deliberately excluded: QA and reconciliation change them. */
export function ticketScopeHash(ticket: LinearTicket): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: ticket.id,
        identifier: ticket.identifier,
        projectId: ticket.projectId,
        parentId: ticket.parentId,
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
      if (
        item.implementationMergeSha !== undefined &&
        (item.implementationHeadSha === undefined ||
          typeof item.implementationMergeSha !== "string" ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.implementationMergeSha))
      )
        return fail("registered implementation merge SHA is invalid");
      let promotionSource: CompletionScope["deliverables"][number]["promotionSource"];
      if (item.promotionSource !== undefined) {
        const source = record(item.promotionSource);
        const validSha = (value: unknown) =>
          typeof value === "string" &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
        if (
          !item.implementationBranch ||
          !item.implementationHeadSha ||
          !item.implementationMergeSha ||
          !validSha(source.sha) ||
          !validSha(source.baseSha) ||
          source.sha === source.baseSha ||
          !Array.isArray(source.paths) ||
          !source.paths.length ||
          source.paths.length > 1000 ||
          new Set(source.paths).size !== source.paths.length ||
          source.paths.some(
            (path) =>
              typeof path !== "string" ||
              !path ||
              path.length > 1000 ||
              path.startsWith("/") ||
              /^[a-z]:/i.test(path) ||
              path.includes("\\") ||
              [...path].some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127,
              ) ||
              path
                .split("/")
                .some(
                  (part) =>
                    !part ||
                    part === "." ||
                    part === ".." ||
                    part.toLowerCase() === ".git",
                ),
          )
        )
          return fail(
            "isolated promotion source requires exact implementation identities and finite safe paths",
          );
        promotionSource = {
          sha: source.sha as string,
          baseSha: source.baseSha as string,
          paths: source.paths as string[],
        };
      }
      return {
        implementationPr,
        productionPr: item.productionPr as number,
        ...(promotionSource ? { promotionSource } : {}),
        ...(item.implementationMergeSha === undefined
          ? {}
          : { implementationMergeSha: item.implementationMergeSha as string }),
        ...(item.implementationBranch === undefined
          ? {}
          : {
              implementationBranch: item.implementationBranch as string,
              implementationHeadSha: item.implementationHeadSha as string,
            }),
      };
    });
    let composition: CompletionScope["composition"];
    if (t.composition !== undefined) {
      const value = record(t.composition);
      if (
        typeof value.promotionPr !== "number" ||
        !Number.isSafeInteger(value.promotionPr) ||
        value.promotionPr < 1 ||
        typeof value.branch !== "string" ||
        !/^pm-release\/[a-z0-9][a-z0-9/_-]{0,190}$/.test(value.branch) ||
        typeof value.headSha !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headSha) ||
        !Array.isArray(value.implementationPrs) ||
        value.implementationPrs.length !== deliverables.length ||
        value.implementationPrs.length > 100 ||
        new Set(value.implementationPrs).size !== deliverables.length ||
        value.implementationPrs.some((id) => !pulls.has(id)) ||
        deliverables.some(
          (item) =>
            !item.implementationBranch ||
            !item.implementationHeadSha ||
            !item.implementationMergeSha,
        )
      )
        return fail(
          "composition must bind an exact promotion and every registered implementation identity",
        );
      composition = {
        promotionPr: value.promotionPr,
        branch: value.branch,
        headSha: value.headSha,
        implementationPrs: value.implementationPrs as number[],
      };
    }
    return {
      ticketId,
      scopeHash,
      approvedAt,
      projectId: required(t.projectId, "projectId"),
      teamId: required(t.teamId, "teamId"),
      approvedBy: required(t.approvedBy, "approvedBy"),
      completedStateId: required(t.completedStateId, "completedStateId"),
      deliverables,
      ...(composition ? { composition } : {}),
    };
  });
  return {
    version: 1,
    repo: required(root.repo, "repo"),
    productionBranch: required(root.productionBranch, "productionBranch"),
    tickets,
  };
}
