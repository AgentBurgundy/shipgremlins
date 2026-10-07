import { createHash } from "node:crypto";
import { loadProject, type Project } from "../config.ts";
import { LABELS } from "../dispatcher/notes.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import { ProjectKnowledgeError } from "./index.ts";
import { acceptanceCriteria } from "../delivery/index.ts";
import {
  approveEpic,
  epicApproved,
  epicApprovalContext,
  isEpic,
  usesEpicApproval,
} from "../epics.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";

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
          ...(usesEpicApproval(project)
            ? { approvalContext: epicApprovalContext(project, a) }
            : {}),
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
    const epic =
      usesEpicApproval(project) && isEpic(ticket) && !ticket.parentId;
    return (
      (!usesEpicApproval(project) || epic) &&
      ticket.description.length <= 20000 &&
      acceptanceCriteria(ticket.description).length > 0 &&
      !["completed", "canceled"].includes(ticket.stateType) &&
      ![
        ...(epic ? [] : [LABELS.approved]),
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
        let approvedEpic = false;
        if (usesEpicApproval(project) && isEpic(ticket)) {
          try {
            approvedEpic = epicApproved(
              options.root,
              project,
              mapped(project, ticket),
              ticket,
            );
          } catch {
            /* A changed mapping cannot retain approval. */
          }
        }
        if (
          !["completed", "canceled"].includes(ticket.stateType) &&
          (!ticket.labels.includes(LABELS.approved) ||
            (usesEpicApproval(project) && isEpic(ticket) && !approvedEpic)) &&
          (!usesEpicApproval(project) || isEpic(ticket))
        )
          collected.set(ticket.id, ticket);
      }
    }
    return {
      project: name,
      approvalPolicy: usesEpicApproval(project) ? "epic" : "ticket",
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
            priority: ticket.priority,
            acceptanceCriteria: acceptanceCriteria(ticket.description),
            description: ticket.description.slice(0, 20000),
            truncated: ticket.description.length > 20000,
            url: ticket.url,
            area,
            kind:
              usesEpicApproval(project) && isEpic(ticket) ? "epic" : "ticket",
            revision: revision(project, ticket),
            canApprove: !!area && canApprove(project, ticket),
            reason: !area
              ? "Repair the Linear mapping before approval."
              : ticket.description.length > 20000
                ? "Only the first part of this proposal is shown. Split it into a shorter bounded scope before approving here."
                : acceptanceCriteria(ticket.description).length === 0
                  ? "Add a finite, observable bullet list under ## Acceptance criteria in Linear before approving coding. Each item should state an outcome that can be verified."
                  : ticket.labels.includes(LABELS.proposal)
                    ? usesEpicApproval(project)
                      ? "Approve this epic's bounded outcome once. Its PM will create and self-approve testable child tickets within that scope."
                      : "Review this proposal's acceptance criteria. Split broad epics into testable milestones before approving coding."
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
      const reviewedTicket = structuredClone(ticket);
      if (!canApprove(project, ticket))
        throw new ProjectKnowledgeError(
          !acceptanceCriteria(ticket.description).length &&
            ticket.description.length <= 20000
            ? "Add a finite, observable bullet list under ## Acceptance criteria in Linear before approving coding."
            : "This ticket cannot be approved for coding here. Review its labels and milestones in Linear.",
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
      const epic = usesEpicApproval(project) && isEpic(ticket);
      if (epic) {
        const current = await client.getTicket(id);
        const latest = loadProject(options.root, name);
        if (
          !current ||
          current.id !== id ||
          ticketScopeHash(current) !== ticketScopeHash(reviewedTicket) ||
          revision(latest, reviewedTicket) !== expected
        ) {
          throw new ProjectKnowledgeError(
            "The epic changed while saving approval. No child work was authorized; review its current scope again.",
            409,
          );
        }
        approveEpic(options.root, latest, mapped(latest, current), current);
      }
      return {
        ok: true,
        identifier: ticket.identifier,
        message: epic
          ? "Epic approved. Its PM can now break this scope into testable child tickets and run them autonomously. Your next review is the PM's promotion batch."
          : "Approved for coding. Enabled project automation picks it up; you can also start Coding Gremlins manually. This does not mark the ticket Done.",
      };
    } finally {
      inFlight.delete(key);
    }
  }
  return { list, approve };
}
