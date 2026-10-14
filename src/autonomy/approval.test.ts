import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
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
import { defaultApprovalPolicy, parseAutonomousApproval } from "./policy.ts";
import { createProjectReview } from "../projectKnowledge/review.ts";
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(over = {}) {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-auto-approval-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const pf = join(root, "projects/app/project.json"),
    raw = JSON.parse(readFileSync(pf, "utf8"));
  raw.verified = "2026-10-14";
  raw.linear = { teamId: "11111111-1111-4111-8111-111111111111" };
  raw.autonomousApproval = {
    ...defaultApprovalPolicy,
    enabled: true,
    allowedPaths: ["docs", "src/styles", "tests"],
    ...over,
  };
  writeFileSync(pf, JSON.stringify(raw));
  const af = join(root, "projects/app/areas.json"),
    areas = JSON.parse(readFileSync(af, "utf8"));
  areas.areas.core.linearProjectId = "linear-project";
  areas.areas.core.paths = ["docs", "src/styles", "tests"];
  writeFileSync(af, JSON.stringify(areas));
  const project = loadProject(root, "app"),
    area = project.areas[0]!,
    client = new FakeLinear();
  const ticket = client.seedTicket({
    projectId: area.linearProjectId,
    teamId: "11111111-1111-4111-8111-111111111111",
    identifier: "APP-1",
    labels: [area.label, "pm-proposal", "pm-auto-safe"],
    description:
      "## Files\n- docs/start.md\n\n## Acceptance criteria\n- The documented setup works with the configured test environment.",
  });
  return {
    project,
    area,
    client,
    ticket,
    approvals: createAutomaticApprovals(root),
    pf,
  };
}
describe("explicit bounded automatic approval", () => {
  it("returns an automatic ticket to visible owner review and binds deliberate manual approval", async () => {
    const { project, area, client, ticket, approvals } = fixture();
    await approvals.approve(project, area, client);
    const saved = approvals.view("app");
    await expect(
      approvals.returnToReview(
        "app",
        { revision: "old", auditId: saved.audit[0]!.id },
        client,
      ),
    ).rejects.toThrow();
    await approvals.returnToReview(
      "app",
      { revision: saved.revision, auditId: saved.audit[0]!.id },
      client,
    );
    expect(ticket.labels).not.toContain("pm-approved");
    expect(ticket.labels).toContain("pm-proposal");
    expect(approvals.blocker(project, area, ticket)).toBeDefined();
    const review = createProjectReview({ root, client: async () => client }),
      item = (await review.list("app")).items[0]!;
    expect(item.canApprove).toBe(true);
    await review.approve("app", ticket.id, item.revision);
    expect(ticket.labels).toContain("pm-approved");
    expect(approvals.isAutomatic(project, ticket)).toBe(false);
    ticket.description += "\nChanged scope";
    expect(approvals.blocker(project, area, ticket)).toBeDefined();
  });
  it("rechecks saved policy after remote waits instead of trusting a captured project snapshot", async () => {
    const { project, area, client, ticket, approvals, pf } = fixture();
    await approvals.approve(project, area, client);
    const raw = JSON.parse(readFileSync(pf, "utf8"));
    raw.autonomousApproval.enabled = false;
    writeFileSync(pf, JSON.stringify(raw));
    expect(approvals.blocker(project, area, ticket)).toBeDefined();
    expect(
      approvals.changeBlocker(project, ticket, ["docs/start.md"], {
        files: 1,
        additions: 1,
        deletions: 0,
      }),
    ).toBeDefined();
  });
  it("defaults off and rejects broad or unbounded policy values", () => {
    expect(parseAutonomousApproval(undefined)).toBeUndefined();
    for (const invalid of [
      { allowedPaths: ["."] },
      { allowedPaths: ["../src"] },
      { allowedPaths: ["*"] },
      { maxFiles: 11 },
      { maxDailyApprovals: 0 },
      { requiredLabel: "pm-approved" },
    ])
      expect(() =>
        parseAutonomousApproval({ ...defaultApprovalPolicy, ...invalid }),
      ).toThrow();
  });
  it("reserves, approves exact eligible scope, and audits once across restart", async () => {
    const { project, area, client, ticket, approvals } = fixture();
    await approvals.approve(
      project,
      area,
      client,
      new Date("2026-10-14T12:00:00Z"),
    );
    expect(ticket.labels).toContain("pm-approved");
    expect(ticket.labels).toContain(AUTO_APPROVED_LABEL);
    expect(ticket.labels).not.toContain("pm-proposal");
    expect(approvals.blocker(project, area, ticket)).toBeUndefined();
    expect(approvals.view("app").audit).toHaveLength(1);
    expect(await client.listComments(ticket.id)).toHaveLength(1);
    await createAutomaticApprovals(root).approve(
      project,
      area,
      client,
      new Date("2026-10-14T12:01:00Z"),
    );
    expect(await client.listComments(ticket.id)).toHaveLength(1);
    ticket.description += "\nChanged scope";
    expect(approvals.blocker(project, area, ticket)).toContain(
      "no longer matches",
    );
  });
  it("requires exact mapping, finite files and built-in low-risk classes", () => {
    const { project, area, ticket } = fixture();
    expect(automaticApprovalFiles(project, area, ticket)).toEqual([
      "docs/start.md",
    ]);
    for (const file of [
      "src/index.ts",
      "src/auth/auth.test.ts",
      "docs/../secrets.md",
      "docs/*",
      "docs/package.json",
      ".github/run.md",
    ])
      expect(
        automaticApprovalFiles(project, area, {
          ...ticket,
          description: `## Files\n- ${file}\n## Acceptance criteria\n- It works.`,
        }),
      ).toBeUndefined();
    expect(
      automaticApprovalFiles(project, area, { ...ticket, teamId: "other" }),
    ).toBeUndefined();
    project.tiers.ownerOnlyPrefixes.push("docs");
    expect(automaticApprovalFiles(project, area, ticket)).toBeUndefined();
  });
  it("counts pending reservations against finite daily and open limits", async () => {
    const { project, area, client, approvals, ticket } = fixture({
      maxDailyApprovals: 1,
      maxOpenTickets: 1,
    });
    const next = client.seedTicket({
      ...ticket,
      projectId: area.linearProjectId,
      id: "second",
      identifier: "APP-2",
      priority: 4,
      labels: [...ticket.labels],
    });
    await approvals.approve(project, area, client);
    expect(ticket.labels).toContain("pm-approved");
    expect(next.labels).not.toContain("pm-approved");
    ticket.stateType = "completed";
    await approvals.approve(
      project,
      area,
      client,
      new Date(Date.now() + 86400_000),
    );
    expect(next.labels).toContain("pm-approved");
  });
  it("reconciles lost label responses without a second reservation or broadened scope", async () => {
    const { project, area, client, approvals, ticket } = fixture();
    const add = client.addLabel.bind(client);
    let interrupted = true;
    vi.spyOn(client, "addLabel").mockImplementation(async (id, label) => {
      await add(id, label);
      if (label === AUTO_APPROVED_LABEL && interrupted) {
        interrupted = false;
        throw new Error("lost response");
      }
    });
    await expect(approvals.approve(project, area, client)).rejects.toThrow(
      "lost response",
    );
    expect(approvals.blocker(project, area, ticket)).toBeDefined();
    await createAutomaticApprovals(root).approve(project, area, client);
    expect(approvals.view("app").audit).toHaveLength(1);
    expect(approvals.blocker(project, area, ticket)).toBeUndefined();
  });
  it("blocks edits and renamed/protected paths or oversized actual changes", async () => {
    const { project, area, client, approvals, ticket, pf } = fixture();
    await approvals.approve(project, area, client);
    expect(
      approvals.changeBlocker(project, ticket, ["docs/start.md"], {
        files: 1,
        additions: 10,
        deletions: 5,
      }),
    ).toBeUndefined();
    expect(
      approvals.changeBlocker(project, ticket, ["docs/start.md"]),
    ).toBeDefined();
    expect(
      approvals.changeBlocker(
        project,
        ticket,
        ["docs/start.md", "src/index.ts"],
        { files: 1, additions: 1, deletions: 1 },
      ),
    ).toBeDefined();
    expect(
      approvals.changeBlocker(project, ticket, ["docs/start.md"], {
        files: 1,
        additions: 90,
        deletions: 11,
      }),
    ).toBeDefined();
    const raw = JSON.parse(readFileSync(pf, "utf8"));
    raw.autonomousApproval.enabled = false;
    writeFileSync(pf, JSON.stringify(raw));
    expect(
      approvals.blocker(loadProject(root, "app"), area, ticket),
    ).toBeDefined();
  });
  it("requires latest owner-reviewed configuration revision when saving", () => {
    const { approvals } = fixture();
    const current = approvals.view("app");
    expect(() =>
      approvals.save("app", {
        revision: "stale",
        policy: { ...current.policy, enabled: false },
      }),
    ).toThrow();
    expect(
      approvals.save("app", {
        revision: current.revision,
        policy: { ...current.policy, enabled: false },
      }).policy.enabled,
    ).toBe(false);
    expect(() =>
      approvals.save("app", {
        revision: current.revision,
        policy: current.policy,
        token: "secret",
      }),
    ).toThrow();
  });
});
