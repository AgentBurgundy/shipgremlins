import { createHash } from "node:crypto";
import { loadProject, type Project } from "../config.ts";
import { LABELS } from "../dispatcher/notes.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import { ProjectKnowledgeError } from "./index.ts";
import { acceptanceCriteria } from "../delivery/index.ts";
import { effectiveWorkflow } from "../projectCapabilities.ts";

const revision = (project: Project, ticket: LinearTicket) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        instanceId: project.config.instanceId,
        repo: project.config.repo,
        provider: project.config.provider,
        connection: project.config.linear,
        areas: project.areas.map((a) => ({
          key: a.key,
          instanceId: a.instanceId,
          label: a.label,
          linearProjectId: a.linearProjectId,
        })),
        ticket,
      }),
    )
    .digest("hex");
const inFlight = new Set<string>();
export function createProjectReview(options: {
  root: string;
  client: (project: Project) => Promise<LinearClient>;
}) {
  function mapped(project: Project, ticket: LinearTicket) {
    const matches = project.areas.filter(
      (a) =>
        a.linearProjectId === ticket.projectId &&
        ticket.labels.includes(a.label),
    );
    if (
      matches.length !== 1 ||
      (project.config.linear?.teamId &&
        project.config.linear.teamId !== ticket.teamId)
    )
      throw new ProjectKnowledgeError(
        "This ticket's team or owning PM changed. Repair the project's Linear mapping first.",
        409,
      );
    return matches[0]!;
  }
  function canApprove(project: Project, ticket: LinearTicket) {
    return (
      ticket.description.length <= 20000 &&
      (effectiveWorkflow(project.config).kind !== "promotion" ||
        acceptanceCriteria(ticket.description).length > 0) &&
      !["completed", "canceled"].includes(ticket.stateType) &&
      ![
        LABELS.approved,
        LABELS.needsHuman,
        LABELS.sync,
        LABELS.port,
        LABELS.ci,
      ].some((label) => ticket.labels.includes(label))
    );
  }
  async function list(name: string) {
    const project = loadProject(options.root, name),
      client = await options.client(project);
    const collected = new Map<string, LinearTicket>();
    for (const area of project.areas) {
      if (
        !area.linearProjectId ||
        /^(PASTE_|CHANGE_|<)/i.test(area.linearProjectId)
      )
        continue;
      for (const ticket of await client.listTickets(area.linearProjectId, [
        area.label,
      ])) {
        if (
          !["completed", "canceled"].includes(ticket.stateType) &&
          !ticket.labels.includes(LABELS.approved)
        )
          collected.set(ticket.id, ticket);
      }
    }
    return {
      project: name,
      items: [...collected.values()]
        .sort(
          (a, b) =>
            (a.priority || 5) - (b.priority || 5) ||
            a.createdAt.localeCompare(b.createdAt),
        )
        .slice(0, 100)
        .map((ticket) => {
          let area: string | undefined;
          try {
            area = mapped(project, ticket).key;
          } catch {
            /*Unmapped tickets remain visible but cannot be approved.*/
          }
          return {
            id: ticket.id,
            identifier: ticket.identifier,
            title: ticket.title,
            description: ticket.description.slice(0, 20000),
            truncated: ticket.description.length > 20000,
            url: ticket.url,
            area,
            revision: revision(project, ticket),
            canApprove: !!area && canApprove(project, ticket),
            reason: !area
              ? "Repair the Linear mapping before approval."
              : ticket.description.length > 20000
                ? "Only the first part of this proposal is shown. Review and approve the full ticket in Linear, or split it into a shorter bounded scope before approving here."
                : effectiveWorkflow(project.config).kind === "promotion" &&
                    acceptanceCriteria(ticket.description).length === 0
                  ? "Add a finite bullet list under ## Acceptance criteria in Linear so the owning PM can verify this fix before promotion."
                  : ticket.labels.includes(LABELS.proposal)
                    ? "Review this proposal's acceptance criteria. Split broad epics into testable milestones before approving coding."
                    : ticket.labels.includes(LABELS.needsHuman)
                      ? "Resolve the owner blocker in Linear first."
                      : "Review the scope and acceptance criteria before approving.",
            labels: ticket.labels,
          };
        }),
    };
  }
  async function approve(name: string, id: string, expected: unknown) {
    if (
      !/^[A-Za-z0-9-]{1,100}$/.test(id) ||
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new ProjectKnowledgeError(
        "Review the current ticket before approving.",
      );
    const key = `${options.root}:${name}:${id}`;
    if (inFlight.has(key))
      throw new ProjectKnowledgeError(
        "This approval is already being saved.",
        409,
      );
    inFlight.add(key);
    try {
      const project = loadProject(options.root, name),
        client = await options.client(project),
        ticket = await client.getTicket(id);
      if (!ticket || ticket.id !== id)
        throw new ProjectKnowledgeError("This ticket no longer exists.", 404);
      mapped(project, ticket);
      if (revision(project, ticket) !== expected)
        throw new ProjectKnowledgeError(
          "The ticket or project mapping changed. Refresh and review its current scope before approving.",
          409,
        );
      if (!canApprove(project, ticket))
        throw new ProjectKnowledgeError(
          "This ticket cannot be approved for coding here. Review its labels and milestones in Linear.",
          409,
        );
      // Revalidate local mapping immediately before the provider write. Linear lacks atomic CAS;
      // this narrows the external race and avoids implying a stronger guarantee.
      if (revision(loadProject(options.root, name), ticket) !== expected)
        throw new ProjectKnowledgeError(
          "Project settings changed. Review again.",
          409,
        );
      if (ticket.labels.includes(LABELS.proposal)) {
        // Remove the proposal hold first: an interrupted request remains unapproved.
        // Re-fetch before approval so a scope/mapping/label edit during the first
        // provider mutation cannot quietly authorize different work.
        const reviewedUpdatedAt = ticket.updatedAt;
        const withoutOwnMutation = (value: LinearTicket) => ({
          ...value,
          labels: value.labels
            .filter((label) => label !== LABELS.proposal)
            .sort(),
          updatedAt: reviewedUpdatedAt,
        });
        const reviewed = revision(project, withoutOwnMutation(ticket));
        await client.removeLabel(ticket.id, LABELS.proposal);
        const current = await client.getTicket(id);
        if (
          !current ||
          current.id !== id ||
          current.labels.includes(LABELS.proposal) ||
          revision(
            loadProject(options.root, name),
            withoutOwnMutation(current),
          ) !== reviewed
        )
          throw new ProjectKnowledgeError(
            "The proposal changed during review. It has not been approved; refresh and review its current scope.",
            409,
          );
      }
      await client.addLabel(ticket.id, LABELS.approved);
      return {
        ok: true,
        identifier: ticket.identifier,
        message:
          "Approved for coding. Enabled project automation picks it up; you can also start Coding Gremlins manually. This does not mark the ticket Done.",
      };
    } finally {
      inFlight.delete(key);
    }
  }
  return { list, approve };
}
