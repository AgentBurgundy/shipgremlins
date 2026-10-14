import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { FakeLinear } from "../services/fakes.ts";
import {
  createAutomaticApprovals,
  automaticApprovalFiles,
  AUTO_APPROVED_LABEL,
} from "./approval.ts";
import { defaultApprovalPolicy } from "./policy.ts";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(over: Record<string, unknown> = {}) {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-approval-safety-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects/app/project.json"),
    config = JSON.parse(readFileSync(projectFile, "utf8"));
  config.verified = "2026-10-14";
  config.linear = { teamId: "11111111-1111-4111-8111-111111111111" };
  config.autonomousApproval = {
    ...defaultApprovalPolicy,
    enabled: true,
    allowedPaths: ["docs", "tests", "stories"],
    maxDailyApprovals: 3,
    maxOpenTickets: 1,
    ...over,
  };
  writeFileSync(projectFile, JSON.stringify(config));
  const areaFile = join(root, "projects/app/areas.json"),
    areas = JSON.parse(readFileSync(areaFile, "utf8"));
  areas.areas.core.linearProjectId = "linear-project";
  areas.areas.core.paths = ["docs", "tests", "stories"];
  writeFileSync(areaFile, JSON.stringify(areas));
  const project = loadProject(root, "app"),
    area = project.areas[0]!,
    client = new FakeLinear();
  const ticket = client.seedTicket({
    projectId: area.linearProjectId,
    teamId: config.linear.teamId,
    identifier: "APP-1",
    labels: [area.label, "pm-proposal", "pm-auto-safe"],
    description:
      "## Files\n- docs/start.md\n\n## Acceptance criteria\n- The documented setup opens the disposable app.",
  });
  return {
    project,
    area,
    client,
    ticket,
    approvals: createAutomaticApprovals(root),
  };
}
describe("automatic approval authority boundaries", () => {
  it("charges delayed reservations against the day they actually grant approval", async () => {
    const f = fixture({ maxDailyApprovals: 1, maxOpenTickets: 2 });
    const add = f.client.addLabel.bind(f.client);
    let interrupt = true;
    vi.spyOn(f.client, "addLabel").mockImplementation(async (id, label) => {
      await add(id, label);
      if (interrupt && label === AUTO_APPROVED_LABEL)
        throw Error("lost marker response");
    });
    await expect(
      f.approvals.approve(
        f.project,
        f.area,
        f.client,
        new Date("2026-10-10T12:00:00Z"),
      ),
    ).rejects.toThrow("lost marker response");
    f.ticket.labels = f.ticket.labels.filter(
      (label) => label !== "pm-auto-safe",
    );
    const next = f.client.seedTicket({
      ...f.ticket,
      projectId: f.area.linearProjectId,
      id: "delayed-second",
      identifier: "APP-2",
      labels: [f.area.label, "pm-proposal", "pm-auto-safe"],
    });
    await expect(
      f.approvals.approve(
        f.project,
        f.area,
        f.client,
        new Date("2026-10-11T12:00:00Z"),
      ),
    ).rejects.toThrow("lost marker response");
    f.ticket.labels.push("pm-auto-safe");
    interrupt = false;
    await f.approvals.approve(
      f.project,
      f.area,
      f.client,
      new Date("2026-10-12T12:00:00Z"),
    );
    expect(
      [f.ticket, next].filter((ticket) =>
        ticket.labels.includes("pm-approved"),
      ),
    ).toHaveLength(1);
    expect(
      f.approvals
        .view("app")
        .audit.filter((record) => record.status === "reserved"),
    ).toHaveLength(1);
    await f.approvals.approve(
      f.project,
      f.area,
      f.client,
      new Date("2026-10-13T12:00:00Z"),
    );
    expect(
      [f.ticket, next].filter((ticket) =>
        ticket.labels.includes("pm-approved"),
      ),
    ).toHaveLength(2);
  });
  it("does not interpret removal of the origin marker as owner review", async () => {
    const f = fixture();
    await f.approvals.approve(f.project, f.area, f.client);
    await f.client.removeLabel(f.ticket.id, AUTO_APPROVED_LABEL);
    f.ticket.description =
      "## Files\n- docs/new-scope.md\n\n## Acceptance criteria\n- Replace the entire documented release process.";
    expect(f.ticket.labels).toContain("pm-approved");
    expect(f.approvals.isAutomatic(f.project, f.ticket)).toBe(true);
    expect(f.approvals.blocker(f.project, f.area, f.ticket)).toBeDefined();
    expect(
      f.approvals.changeBlocker(f.project, f.ticket, ["docs/new-scope.md"], {
        files: 1,
        additions: 1,
        deletions: 0,
      }),
    ).toBeDefined();
  });
  it("requires new owner review when a closed automatically approved ticket is reopened", async () => {
    const f = fixture();
    await f.approvals.approve(f.project, f.area, f.client);
    f.ticket.stateType = "completed";
    const next = f.client.seedTicket({
      ...f.ticket,
      projectId: f.area.linearProjectId,
      id: "second",
      identifier: "APP-2",
      stateType: "backlog",
      labels: [f.area.label, "pm-proposal", "pm-auto-safe"],
    });
    await f.approvals.approve(f.project, f.area, f.client);
    expect(next.labels).toContain("pm-approved");
    f.ticket.stateType = "backlog";
    expect(f.approvals.blocker(f.project, f.area, f.ticket)).toBeDefined();
    await f.approvals.approve(f.project, f.area, f.client);
    expect(f.approvals.blocker(f.project, f.area, f.ticket)).toBeDefined();
  });
  it("binds the manual-origin override to the exact scope reviewed by the owner", async () => {
    const f = fixture();
    await f.approvals.approve(f.project, f.area, f.client);
    await f.client.removeLabel(f.ticket.id, AUTO_APPROVED_LABEL);
    await f.approvals.markManual(f.project, f.ticket);
    expect(f.approvals.isAutomatic(f.project, f.ticket)).toBe(false);
    expect(f.approvals.blocker(f.project, f.area, f.ticket)).toBeUndefined();
    f.ticket.description +=
      "\n## Extra work\n- Change the authentication and release systems.";
    expect(f.approvals.isAutomatic(f.project, f.ticket)).toBe(true);
    expect(f.approvals.blocker(f.project, f.area, f.ticket)).toBeDefined();
  });
  it.each([
    "docs/deploy.sh",
    "docs/server.ts",
    "docs/AGENTS.md",
    "stories/production-deploy.js",
    "docs/interactive.mdx",
  ])(
    "does not classify arbitrary executable or agent-instruction file %s as low-risk",
    (path) => {
      const f = fixture();
      f.ticket.description = `## Files\n- ${path}\n\n## Acceptance criteria\n- It works.`;
      expect(
        automaticApprovalFiles(f.project, f.area, f.ticket),
      ).toBeUndefined();
    },
  );
});
