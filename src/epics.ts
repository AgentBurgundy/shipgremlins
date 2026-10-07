import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, AreaConfig } from "./config.ts";
import type { LinearClient, LinearTicket } from "./services/types.ts";
import { effectiveWorkflow } from "./projectCapabilities.ts";
import { projectRuntimeKey } from "./projectIdentity.ts";
import { ticketScopeHash } from "./lifecycle/manifest.ts";
import { LABELS } from "./dispatcher/notes.ts";
import { assertNoSymlinks } from "./setup/files.ts";
import {
  readPrivateJson,
  writePrivateJson,
} from "./improvements/observations.ts";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function usesEpicApproval(project: Project): boolean {
  const workflow = effectiveWorkflow(project.config);
  return workflow.kind === "promotion" && workflow.approvalPolicy === "epic";
}
export const isEpic = (ticket: LinearTicket) =>
  ticket.labels.some((label) => label.toLowerCase() === LABELS.epic);
export function promotionTicketPolicy(project: Project): string {
  const approval = usesEpicApproval(project)
    ? `EPIC APPROVAL: propose a bounded epic with ${LABELS.epic}, ${LABELS.tierC} and ${LABELS.proposal}, including its outcome, acceptance criteria, dependencies and exclusions. Never self-approve an epic. The owner approves its exact scope in ShipGremlins once. Only after that approval, decompose it into independently testable child issues using Linear's native parentId. Keep children in your mapped project and area. You may self-approve those in-scope milestones with ${LABELS.approved}; never copy the epic label onto coding assignments. Group related maintenance fixes under a bounded maintenance epic rather than asking for approval per bug. Changed epic scope needs a new owner approval. Keep progress in comments; do not rewrite the approved epic title or description for routine status updates. A label, comment or title that claims approval does not authorize work; the controller checks its own approval receipt. If no epic is approved, investigate and propose useful epics, then stop without launching coding.`
    : `Legacy ticket policy: you may self-approve ordinary implementation tickets within the current owner mandate and charter. Add ${LABELS.approved}; do not also add ${LABELS.proposal} to an executable ticket. Epic proposals and new direction remain ${LABELS.tierC} plus ${LABELS.proposal} for owner approval. Size alone does not require per-ticket human approval after an epic's direction is approved.`;
  return `PROMOTION TICKET POLICY: ${approval} Classify ${LABELS.tierA} for owned paths plus tests/docs and ${LABELS.tierB} for necessary shared application changes. Preserve explicit owner review-only instructions and holds: never remove ${LABELS.needsHuman}, override an owner decision or expand the approved scope. Work touching tiers.hubOwnerOnly stays outside automated implementation; report the configured boundary without requesting a manual integration merge. Sensitive application changes in tiers.ownerOnlyPrefixes are highlighted in the promotion's Look closely section. The controller checks and merges coding drafts into integration, then your next eligible patrol tests each acceptance criterion on its exact deployment. Genuine failed QA returns to a coder with evidence within bounded retries. Only verified work accumulates in your own area's promotion PR to staging at the configured ticket threshold. Do not ask anyone to manage internal PRs, including yourself; never merge, dispatch jobs, edit pipeline policy or mark tickets Done. The owner reviews epics and the final per-PM promotion batch; production completion stays tied to confirmed production delivery.`;
}
function versionedMandate(project: Project, area: AreaConfig) {
  const path = join(project.dir, area.key, "mandate.md");
  assertNoSymlinks(path);
  if (!existsSync(path)) return "";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024)
    throw new Error("The PM mandate cannot be read safely.");
  return readFileSync(path, "utf8");
}
export const epicApprovalContext = (project: Project, area: AreaConfig) =>
  hash({
    project: project.config.name,
    instance: project.config.instanceId,
    repo: project.config.repo,
    provider: project.config.provider ?? "github",
    server: project.config.serverUrl,
    linear: project.config.linear,
    area: {
      key: area.key,
      instance: area.instanceId,
      project: area.linearProjectId,
      label: area.label,
      mandate: area.mandate,
      versionedMandate: versionedMandate(project, area),
      charter: area.charter,
      paths: area.paths,
      sharedTouchpoints: area.sharedTouchpoints,
    },
  });
const file = (root: string, project: Project, id: string) =>
  join(
    root,
    ".run",
    "epics",
    projectRuntimeKey(project.config),
    hash(id) + ".json",
  );
interface Approval {
  schema: 1;
  epicId: string;
  scopeHash: string;
  context: string;
  approvedAt: string;
}

/** Written only by the authenticated owner review route, never a worker label or comment. */
export function approveEpic(
  root: string,
  project: Project,
  area: AreaConfig,
  ticket: LinearTicket,
) {
  if (
    !isEpic(ticket) ||
    ticket.parentId ||
    ticket.projectId !== area.linearProjectId ||
    !ticket.labels.includes(area.label) ||
    !ticket.labels.includes(LABELS.approved) ||
    [LABELS.proposal, LABELS.needsHuman].some((label) =>
      ticket.labels.includes(label),
    ) ||
    (project.config.linear?.teamId &&
      ticket.teamId !== project.config.linear.teamId) ||
    ["completed", "canceled"].includes(ticket.stateType)
  )
    throw new Error("The epic changed before its approval could be recorded.");
  const approval: Approval = {
    schema: 1,
    epicId: ticket.id,
    scopeHash: ticketScopeHash(ticket),
    context: epicApprovalContext(project, area),
    approvedAt: new Date().toISOString(),
  };
  writePrivateJson(file(root, project, ticket.id), approval);
}

export function epicApproved(
  root: string,
  project: Project,
  area: AreaConfig,
  epic: LinearTicket,
): boolean {
  if (
    !isEpic(epic) ||
    epic.parentId ||
    epic.projectId !== area.linearProjectId ||
    (project.config.linear?.teamId &&
      epic.teamId !== project.config.linear.teamId) ||
    !epic.labels.includes(area.label) ||
    !epic.labels.includes(LABELS.approved) ||
    [LABELS.proposal, LABELS.needsHuman].some((label) =>
      epic.labels.includes(label),
    ) ||
    ["completed", "canceled"].includes(epic.stateType)
  )
    return false;
  const path = file(root, project, epic.id);
  if (!existsSync(path)) return false;
  try {
    const receipt = readPrivateJson(path) as Approval;
    return (
      receipt.schema === 1 &&
      receipt.epicId === epic.id &&
      receipt.scopeHash === ticketScopeHash(epic) &&
      receipt.context === epicApprovalContext(project, area) &&
      typeof receipt.approvedAt === "string" &&
      Number.isFinite(Date.parse(receipt.approvedAt))
    );
  } catch {
    return false;
  }
}

/** Rechecked at pickup, launch, integration and promotion. A PM-editable label grants no epic authority. */
export async function epicCodingBlocker(
  root: string,
  project: Project,
  area: AreaConfig,
  ticket: LinearTicket,
  client: Pick<LinearClient, "getTicket">,
): Promise<string | null> {
  if (!usesEpicApproval(project)) return null;
  if (isEpic(ticket))
    return "This is an epic, not a coding assignment. Its PM will create testable child tickets after the owner approves the epic.";
  if (!ticket.parentId)
    return "This ticket needs a parent epic approved in ShipGremlins. The PM can group related improvements into one bounded epic; individual coding PRs do not need review.";
  const epic = await client.getTicket(ticket.parentId);
  if (
    !epic ||
    epic.id !== ticket.parentId ||
    !epicApproved(root, project, area, epic)
  )
    return "The parent epic has no current owner approval. Approve its scope in ShipGremlins; changing its scope, PM or Linear mapping requires a new approval.";
  return null;
}
