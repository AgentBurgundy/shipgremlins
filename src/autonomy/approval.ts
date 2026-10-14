import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadProject,
  matchesPrefix,
  type Project,
  type AreaConfig,
} from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  readPrivateJson,
  writePrivateJson,
} from "../improvements/observations.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import { LABELS } from "../dispatcher/notes.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import {
  defaultApprovalPolicy,
  parseAutonomousApproval,
  safeRepoPath,
} from "./policy.ts";

export const AUTO_APPROVED_LABEL = "pm-auto-approved";
type RecordEntry = {
  id: string;
  ticketId: string;
  identifier: string;
  area: string;
  scopeHash: string;
  policyRevision: string;
  files: string[];
  reservedAt: string;
  status: "reserved" | "approved" | "blocked" | "manual";
  approvedAt?: string;
  approvalAdmissionAt?: string;
  closedAt?: string;
};
type State = { schema: 1; identity: string; records: RecordEntry[] };
const prefix = (file: string, paths: string[]) =>
  paths.some(
    (p) =>
      file === p.replace(/\/$/, "") ||
      file.startsWith(p.replace(/\/$/, "") + "/"),
  );
export const approvalPolicyRevision = (project: Project) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        identity: projectRuntimeKey(project.config),
        repo: project.config.repo,
        provider: project.config.provider,
        server: project.config.serverUrl,
        linear: project.config.linear,
        policy: project.config.autonomousApproval,
        areas: project.areas,
        tiers: project.tiers,
      }),
    )
    .digest("hex");
function lowRiskPath(file: string) {
  // A label or model-authored risk claim cannot expand the built-in low-risk classes.
  return (
    (/\.(md|txt|css|scss|sass|less)$/i.test(file) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) &&
    !/(^|\/)(auth|security|billing|payments?|migrations?|infra|\.github|\.gitlab|secrets?|production)(\/|\.)/i.test(
      file,
    ) &&
    !/(^|\/)(AGENTS\.md|CLAUDE\.md|SKILL\.md|package(-lock)?\.json|.*lock|Dockerfile|\.env[^/]*|.*config\.[^/]+)$/i.test(
      file,
    )
  );
}
export function automaticApprovalFiles(
  project: Project,
  area: AreaConfig,
  ticket: LinearTicket,
): string[] | undefined {
  const policy = project.config.autonomousApproval;
  if (
    !policy?.enabled ||
    !project.config.verified ||
    ticket.projectId !== area.linearProjectId ||
    !project.config.linear?.teamId ||
    ticket.teamId !== project.config.linear.teamId ||
    project.areas.filter(
      (a) =>
        a.linearProjectId === ticket.projectId &&
        ticket.labels.includes(a.label),
    ).length !== 1 ||
    !ticket.labels.includes(area.label) ||
    !ticket.labels.includes(policy.requiredLabel) ||
    ["completed", "canceled"].includes(ticket.stateType) ||
    ticket.description.length > 20000 ||
    [
      LABELS.needsHuman,
      LABELS.sync,
      LABELS.port,
      LABELS.ci,
      "pm-deployed",
      "pm-done",
    ].some((l) => ticket.labels.includes(l))
  )
    return;
  const criteria =
    /^## Acceptance criteria\s*\r?\n([\s\S]*?)(?=^##? |$(?![\s\S]))/im.exec(
      ticket.description,
    )?.[1];
  if (!criteria || !/^\s*[-*] +\S/m.test(criteria)) return;
  const section = /^## Files\s*\r?\n([\s\S]*?)(?=^##? |$(?![\s\S]))/im.exec(
    ticket.description,
  )?.[1];
  if (!section) return;
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (
    !lines.length ||
    lines.length > policy.maxFiles ||
    !lines.every((l) => /^[-*] +`?[A-Za-z0-9_.@/-]+`?$/.test(l))
  )
    return;
  const files = lines.map((l) =>
    l.replace(/^[-*] +/, "").replace(/^`|`$/g, ""),
  );
  if (
    new Set(files).size !== files.length ||
    files.some(
      (f) =>
        !safeRepoPath(f) ||
        !lowRiskPath(f) ||
        !prefix(f, policy.allowedPaths) ||
        !prefix(f, [...area.paths, ...area.sharedTouchpoints]) ||
        matchesPrefix(f, [
          ...project.tiers.ownerOnlyPrefixes,
          ...project.tiers.hubOwnerOnly,
        ]),
    )
  )
    return;
  return files;
}
export function createAutomaticApprovals(root: string) {
  const dir = (project: Project) =>
    join(
      root,
      ".run",
      "automatic-approvals",
      projectRuntimeKey(project.config),
    );
  const file = (project: Project) => join(dir(project), "audit.json");
  function read(project: Project): State {
    if (!existsSync(file(project)))
      return {
        schema: 1,
        identity: projectRuntimeKey(project.config),
        records: [],
      };
    const value = readPrivateJson(file(project)) as State;
    if (
      value.schema !== 1 ||
      value.identity !== projectRuntimeKey(project.config) ||
      !Array.isArray(value.records) ||
      value.records.length > 2000 ||
      value.records.some(
        (r) =>
          !r.id ||
          !r.ticketId ||
          !/^[a-f0-9]{64}$/.test(r.scopeHash) ||
          !/^[a-f0-9]{64}$/.test(r.policyRevision) ||
          !Array.isArray(r.files) ||
          !r.files.every(safeRepoPath) ||
          !["reserved", "approved", "blocked", "manual"].includes(r.status) ||
          !Number.isFinite(Date.parse(r.reservedAt)),
      )
    )
      throw new Error(
        "Automatic approval audit needs review before more work can start.",
      );
    return value;
  }
  async function locked<T>(
    project: Project,
    work: () => Promise<T>,
  ): Promise<T> {
    const lock = join(dir(project), "approval.lock");
    assertNoSymlinks(lock);
    mkdirSync(dir(project), { recursive: true, mode: 0o700 });
    if (existsSync(lock)) {
      const previous = JSON.parse(readFileSync(lock, "utf8")) as {
        pid: number;
      };
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
        throw new Error("Automatic approval lock needs review.");
      let dead = false;
      try {
        process.kill(previous.pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead)
        throw new Error("Automatic approval is already being checked.");
      unlinkSync(lock);
    }
    const fd = openSync(lock, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(fd);
    }
    try {
      return await work();
    } finally {
      unlinkSync(lock);
    }
  }
  function isAutomatic(project: Project, ticket: LinearTicket): boolean {
    return (
      ticket.labels.includes(AUTO_APPROVED_LABEL) ||
      read(project).records.some(
        (r) =>
          r.ticketId === ticket.id &&
          (r.status !== "manual" || r.scopeHash !== ticketScopeHash(ticket)),
      )
    );
  }
  async function markManual(project: Project, ticket: LinearTicket) {
    await locked(project, async () => {
      if (
        approvalPolicyRevision(loadProject(root, project.config.name)) !==
        approvalPolicyRevision(project)
      )
        throw new Error("Project changed during owner review.");
      const state = read(project),
        record = state.records.find((r) => r.ticketId === ticket.id);
      if (record) {
        record.status = "manual";
        record.scopeHash = ticketScopeHash(ticket);
        writePrivateJson(file(project), state);
      }
    });
  }
  function blocker(
    project: Project,
    area: AreaConfig,
    ticket: LinearTicket,
  ): string | undefined {
    if (!isAutomatic(project, ticket)) return;
    const record = read(project).records.find(
      (r) => r.ticketId === ticket.id && r.status === "approved",
    );
    const files = automaticApprovalFiles(project, area, ticket);
    if (
      !record ||
      record.closedAt ||
      !ticket.labels.includes(AUTO_APPROVED_LABEL) ||
      !files ||
      record.scopeHash !== ticketScopeHash(ticket) ||
      record.policyRevision !== approvalPolicyRevision(project) ||
      record.policyRevision !==
        approvalPolicyRevision(loadProject(root, project.config.name)) ||
      JSON.stringify(record.files) !== JSON.stringify(files)
    )
      return "Automatic approval no longer matches this ticket and owner policy. Review its scope and approve it manually before coding.";
  }
  async function approve(
    project: Project,
    area: AreaConfig,
    client: Pick<
      LinearClient,
      | "getTicket"
      | "listTickets"
      | "addLabel"
      | "removeLabel"
      | "addComment"
      | "listComments"
    >,
    now = new Date(),
  ) {
    if (!project.config.autonomousApproval?.enabled) return;
    return locked(project, async () => {
      const policy = project.config.autonomousApproval!,
        state = read(project),
        revision = approvalPolicyRevision(project);
      const candidates = await client.listTickets(area.linearProjectId, [
        area.label,
      ]);
      const live = new Map(candidates.map((t) => [t.id, t]));
      for (const record of state.records.filter(
        (r) => ["reserved", "approved"].includes(r.status) && !r.closedAt,
      )) {
        const ticket =
          live.get(record.ticketId) ??
          (await client.getTicket(record.ticketId));
        if (ticket && ["completed", "canceled"].includes(ticket.stateType))
          record.closedAt = now.toISOString();
      }
      writePrivateJson(file(project), state);
      const day = now.toISOString().slice(0, 10);
      for (const candidate of candidates.sort(
        (a, b) =>
          (a.priority || 5) - (b.priority || 5) ||
          a.createdAt.localeCompare(b.createdAt),
      )) {
        if (
          candidate.labels.includes(LABELS.approved) &&
          !candidate.labels.includes(AUTO_APPROVED_LABEL)
        )
          continue;
        const files = automaticApprovalFiles(project, area, candidate);
        if (!files) continue;
        let record = state.records.find((r) => r.ticketId === candidate.id);
        if (
          record?.status === "approved" ||
          record?.status === "blocked" ||
          record?.status === "manual"
        )
          continue;
        if (!record) {
          if (
            state.records.filter((r) => r.reservedAt.startsWith(day)).length >=
              policy.maxDailyApprovals ||
            state.records.filter(
              (r) => ["reserved", "approved"].includes(r.status) && !r.closedAt,
            ).length >= policy.maxOpenTickets ||
            state.records.length >= 2000
          )
            break;
          record = {
            id: randomUUID(),
            ticketId: candidate.id,
            identifier: candidate.identifier,
            area: area.key,
            scopeHash: ticketScopeHash(candidate),
            policyRevision: revision,
            files,
            reservedAt: now.toISOString(),
            status: "reserved",
          };
          state.records.push(record);
          writePrivateJson(file(project), state);
        }
        const currentProject = loadProject(root, project.config.name),
          current = await client.getTicket(candidate.id);
        if (
          !current ||
          approvalPolicyRevision(currentProject) !== record.policyRevision ||
          ticketScopeHash(current) !== record.scopeHash ||
          !automaticApprovalFiles(currentProject, area, current)
        ) {
          record.status = "blocked";
          writePrivateJson(file(project), state);
          continue;
        }
        // Marker is applied first: a lost response always fails closed until this durable claim is acknowledged.
        await client.addLabel(current.id, AUTO_APPROVED_LABEL);
        const fresh = await client.getTicket(current.id);
        if (
          !fresh ||
          ticketScopeHash(fresh) !== record.scopeHash ||
          approvalPolicyRevision(loadProject(root, project.config.name)) !==
            revision
        )
          throw new Error("Automatic approval scope changed during admission.");
        const alreadyGranted =
          fresh.labels.includes(LABELS.approved) &&
          !fresh.labels.includes(LABELS.proposal);
        if (!alreadyGranted && !record.approvalAdmissionAt?.startsWith(day)) {
          if (
            state.records.filter(
              (r) =>
                r.approvalAdmissionAt?.startsWith(day) ||
                r.approvedAt?.startsWith(day),
            ).length >= policy.maxDailyApprovals
          )
            continue;
          record.approvalAdmissionAt = now.toISOString();
          writePrivateJson(file(project), state);
        }
        if (!fresh.labels.includes(LABELS.approved))
          await client.addLabel(current.id, LABELS.approved);
        if (fresh.labels.includes(LABELS.proposal))
          await client.removeLabel(current.id, LABELS.proposal);
        const acknowledged = await client.getTicket(current.id);
        if (
          !acknowledged ||
          ticketScopeHash(acknowledged) !== record.scopeHash ||
          !acknowledged.labels.includes(AUTO_APPROVED_LABEL) ||
          !acknowledged.labels.includes(LABELS.approved) ||
          acknowledged.labels.includes(LABELS.proposal)
        )
          throw new Error("Automatic approval acknowledgment is pending.");
        record.status = "approved";
        record.approvedAt = now.toISOString();
        writePrivateJson(file(project), state);
        const marker = `<!-- shipgremlins-auto-approval:${record.id} -->`;
        if (
          !(await client.listComments(current.id)).some((c) =>
            c.body.includes(marker),
          )
        )
          await client.addComment(
            current.id,
            `${marker}\nOwner policy automatically approved this exact low-risk scope. Files: ${files.map((f) => `\`${f}\``).join(", ")}. Maximum ${policy.maxChangedLines} changed lines. Protected files and production release still require their existing gates.`,
          );
      }
    });
  }
  function changeBlocker(
    project: Project,
    ticket: LinearTicket,
    paths: string[],
    stats?: { files: number; additions: number; deletions: number },
  ) {
    if (!isAutomatic(project, ticket)) return;
    const record = read(project).records.find(
      (r) => r.ticketId === ticket.id && r.status === "approved",
    );
    if (!record)
      return "No durable automatic approval exists for this change. Owner review is required.";
    const policy = project.config.autonomousApproval;
    if (
      !policy?.enabled ||
      approvalPolicyRevision(project) !== record.policyRevision ||
      approvalPolicyRevision(loadProject(root, project.config.name)) !==
        record.policyRevision ||
      !stats ||
      paths.length === 0 ||
      paths.some((p) => !record.files.includes(p)) ||
      stats.files > policy.maxFiles ||
      paths.length > policy.maxFiles ||
      ![stats.files, stats.additions, stats.deletions].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      stats.additions + stats.deletions > policy.maxChangedLines
    )
      return "This change exceeds its automatic approval policy or lacks exact-head diff evidence. Owner review is required.";
  }
  function view(name: string) {
    const project = loadProject(root, name),
      document = readEditableConfig(root, `projects/${name}/project.json`);
    return {
      revision: document.revision,
      policy: project.config.autonomousApproval ?? defaultApprovalPolicy,
      audit: read(project).records.slice(-50).reverse(),
      riskClasses: ["Documentation", "Static styles", "Tests"],
      protectedGates: true,
    };
  }
  function save(name: string, input: Record<string, unknown>) {
    if (
      Object.keys(input).some((k) => !["revision", "policy"].includes(k)) ||
      typeof input.revision !== "string"
    )
      throw new Error("Use the current policy revision.");
    const policy = parseAutonomousApproval(input.policy);
    if (!policy)
      throw new Error("Choose an explicit automatic approval policy.");
    const document = readEditableConfig(root, `projects/${name}/project.json`),
      raw = JSON.parse(document.content);
    raw.autonomousApproval = policy;
    saveEditableConfig(root, {
      path: document.path,
      revision: input.revision,
      content: JSON.stringify(raw, null, 2) + "\n",
    });
    return view(name);
  }
  async function returnToReview(
    name: string,
    input: Record<string, unknown>,
    client: Pick<LinearClient, "getTicket" | "addLabel" | "removeLabel">,
  ) {
    if (
      Object.keys(input).some((k) => !["revision", "auditId"].includes(k)) ||
      typeof input.revision !== "string" ||
      typeof input.auditId !== "string"
    )
      throw new Error(
        "Choose the current audited approval to return for owner review.",
      );
    const project = loadProject(root, name);
    await locked(project, async () => {
      if (
        readEditableConfig(root, `projects/${name}/project.json`).revision !==
        input.revision
      )
        throw new Error("Project changed. Refresh the approval policy first.");
      const state = read(project),
        record = state.records.find((r) => r.id === input.auditId);
      if (!record || record.status === "manual")
        throw new Error(
          "This automatic approval is unavailable or already reviewed manually.",
        );
      const ticket = await client.getTicket(record.ticketId),
        area = project.areas.find((a) => a.key === record.area);
      if (
        !ticket ||
        !area ||
        ticket.projectId !== area.linearProjectId ||
        ticket.teamId !== project.config.linear?.teamId ||
        approvalPolicyRevision(loadProject(root, name)) !==
          approvalPolicyRevision(project)
      )
        throw new Error(
          "The ticket or owning project changed. Repair its mapping before returning it for review.",
        );
      record.status = "blocked";
      writePrivateJson(file(project), state);
      // Reduce authority first. Lost responses leave the ticket stopped and retryable.
      await client.removeLabel(ticket.id, LABELS.approved);
      await client.addLabel(ticket.id, LABELS.proposal);
      await client.removeLabel(ticket.id, AUTO_APPROVED_LABEL);
    });
    return view(name);
  }
  return {
    approve,
    blocker,
    changeBlocker,
    view,
    save,
    isAutomatic,
    markManual,
    returnToReview,
  };
}
