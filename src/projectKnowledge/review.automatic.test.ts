import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { FakeLinear } from "../services/fakes.ts";
import { createProjectReview } from "./review.ts";
import { createAutomaticApprovals } from "../autonomy/approval.ts";
import { defaultApprovalPolicy } from "../autonomy/policy.ts";
import { epicCodingBlocker, usesEpicApproval } from "../epics.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function world() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-epic-auto-review-"),
  );
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects/app/project.json");
  const config = JSON.parse(readFileSync(projectFile, "utf8"));
  config.verified = "2026-10-14";
  config.linear = { teamId: "11111111-1111-4111-8111-111111111111" };
  config.autonomousApproval = {
    ...defaultApprovalPolicy,
    enabled: true,
    allowedPaths: ["docs"],
  };
  writeFileSync(projectFile, JSON.stringify(config));
  const areaFile = join(root, "projects/app/areas.json");
  const areas = JSON.parse(readFileSync(areaFile, "utf8"));
  areas.areas.core.linearProjectId = "linear-project";
  areas.areas.core.paths = ["docs"];
  writeFileSync(areaFile, JSON.stringify(areas));
  const project = loadProject(root, "app");
  const area = project.areas[0]!;
  const linear = new FakeLinear();
  const epic = linear.seedTicket({
    id: "epic-1",
    identifier: "APP-1",
    projectId: area.linearProjectId,
    teamId: config.linear.teamId,
    title: "Explain project setup",
    description:
      "## Acceptance criteria\n- The setup guide explains local testing.",
    labels: [area.label, "pm-epic", "pm-proposal", "pm-tier-c"],
  });
  const child = linear.seedTicket({
    id: "child-1",
    identifier: "APP-2",
    projectId: area.linearProjectId,
    teamId: config.linear.teamId,
    parentId: epic.id,
    title: "Document the local test command",
    description:
      "## Files\n- docs/start.md\n\n## Acceptance criteria\n- The guide explains the local test command.",
    labels: [area.label, "pm-auto-safe", "pm-proposal"],
  });
  const approvals = createAutomaticApprovals(root);
  await approvals.approve(project, area, linear);
  const state = approvals.view("app");
  await approvals.returnToReview(
    "app",
    {
      revision: state.revision,
      auditId: state.audit[0]!.id,
    },
    linear,
  );
  const review = createProjectReview({ root, client: async () => linear });
  return { root, project, area, linear, epic, child, approvals, review };
}

describe("audited automatic ticket review under epic approval", () => {
  it("returns an audited child to exact owner review while retaining its independent parent epic gate", async () => {
    const w = await world();
    expect(usesEpicApproval(w.project)).toBe(true);
    expect(w.child.labels).toContain("pm-proposal");
    expect(w.child.labels).not.toContain("pm-auto-approved");
    const pending = (await w.review.list("app")).items;
    const child = pending.find((item) => item.id === w.child.id)!;
    expect(child).toMatchObject({ kind: "ticket", canApprove: true });
    expect(child.reason).toContain("parent epic");
    expect(pending.some((item) => item.id === w.epic.id)).toBe(true);
    expect(
      (await w.review.approve("app", child.id, child.revision)).message,
    ).toContain("parent epic");
    expect(w.approvals.isAutomatic(w.project, w.child)).toBe(false);
    expect(w.child.labels).toContain("pm-approved");
    expect(w.child.labels).not.toContain("pm-proposal");
    expect(
      await epicCodingBlocker(w.root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
    const epic = (await w.review.list("app")).items.find(
      (item) => item.id === w.epic.id,
    )!;
    await w.review.approve("app", epic.id, epic.revision);
    expect(
      await epicCodingBlocker(w.root, w.project, w.area, w.child, w.linear),
    ).toBeNull();
    w.epic.description += "\n- Expand into billing.";
    expect(
      await epicCodingBlocker(w.root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
    expect(w.linear.stateUpdates).toEqual([]);
  });

  it("does not offer unaudited children or marker-only tickets the manual override", async () => {
    const w = await world();
    for (const labels of [
      [w.area.label, "pm-proposal"],
      [w.area.label, "pm-proposal", "pm-auto-approved"],
    ]) {
      const ticket = w.linear.seedTicket({
        ...w.child,
        id: `ordinary-${labels.length}`,
        identifier: `APP-${labels.length + 2}`,
        projectId: w.area.linearProjectId,
        labels,
      });
      expect(
        (await w.review.list("app")).items.some(
          (item) => item.id === ticket.id,
        ),
      ).toBe(false);
      await expect(
        w.review.approve("app", ticket.id, "a".repeat(64)),
      ).rejects.toThrow();
      expect(ticket.labels).not.toContain("pm-approved");
    }
  });

  it("requires a new exact review after child scope changes and rejects a saving race", async () => {
    const w = await world();
    const item = (await w.review.list("app")).items.find(
      (value) => value.id === w.child.id,
    )!;
    w.child.description += "\n- Show the troubleshooting steps.";
    await expect(
      w.review.approve("app", item.id, item.revision),
    ).rejects.toThrow("changed");
    expect(w.child.labels).not.toContain("pm-approved");
    const fresh = (await w.review.list("app")).items.find(
      (value) => value.id === w.child.id,
    )!;
    const add = w.linear.addLabel.bind(w.linear);
    vi.spyOn(w.linear, "addLabel").mockImplementation(async (id, label) => {
      await add(id, label);
      if (id === w.child.id && label === "pm-approved")
        w.child.description += "\n- Another unreviewed outcome.";
    });
    await expect(
      w.review.approve("app", fresh.id, fresh.revision),
    ).rejects.toThrow("changed during manual approval");
    expect(w.approvals.isAutomatic(w.project, w.child)).toBe(true);
    expect(w.approvals.blocker(w.project, w.area, w.child)).toBeDefined();
    expect(
      await epicCodingBlocker(w.root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
  });
});
