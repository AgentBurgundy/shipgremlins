import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "./setup/files.ts";
import { loadProject } from "./config.ts";
import { FakeLinear } from "./services/fakes.ts";
import {
  approveEpic,
  epicApproved,
  epicCodingBlocker,
  isEpic,
  usesEpicApproval,
} from "./epics.ts";
import { createProjectReview } from "./projectKnowledge/review.ts";
import { ticketScopeHash } from "./lifecycle/manifest.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-epics-"));
  initializeSetup(root, fileURLToPath(new URL("..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
  const path = join(root, "projects/app/areas.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.areas.core.linearProjectId = "linear-project";
  writeFileSync(path, JSON.stringify(value));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function world() {
  const project = loadProject(root, "app"),
    area = project.areas[0]!,
    linear = new FakeLinear();
  const epic = linear.seedTicket({
    id: "epic-1",
    identifier: "APP-1",
    projectId: area.linearProjectId,
    title: "Reliable uploads",
    description:
      "## Acceptance criteria\n- Uploads survive reload.\n- Invalid files explain the problem.",
    labels: [area.label, "pm-epic", "pm-proposal", "pm-tier-c"],
  });
  const child = linear.seedTicket({
    id: "child-1",
    identifier: "APP-2",
    projectId: area.linearProjectId,
    parentId: epic.id,
    title: "Persist uploaded rows",
    description: "## Acceptance criteria\n- Rows survive reload.",
    labels: [area.label, "pm-approved", "pm-tier-a"],
  });
  const review = createProjectReview({ root, client: async () => linear });
  async function approve() {
    const item = (await review.list("app")).items.find(
      (item) => item.id === epic.id,
    )!;
    return review.approve("app", epic.id, item.revision);
  }
  return { project, area, linear, epic, child, review, approve };
}
describe("controller-owned epic approval", () => {
  it("new projects require epic approval and never execute the epic itself", async () => {
    const w = world();
    expect(usesEpicApproval(w.project)).toBe(true);
    expect(isEpic(w.epic)).toBe(true);
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
    await w.linear.removeLabel(w.epic.id, "pm-proposal");
    await w.linear.addLabel(w.epic.id, "pm-approved");
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
    expect((await w.review.list("app")).items).toHaveLength(1);
    expect((await w.approve()).message).toContain("Epic approved");
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toBeNull();
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.epic, w.linear),
    ).toContain("not a coding assignment");
    expect((await w.review.list("app")).items).toHaveLength(0);
  });
  it("approves one epic and permits multiple independent child tickets without individual approval", async () => {
    const w = world();
    await w.approve();
    const other = w.linear.seedTicket({
      ...w.child,
      projectId: w.area.linearProjectId,
      id: "child-2",
      identifier: "APP-3",
      title: "Explain invalid files",
    });
    expect(
      await epicCodingBlocker(root, w.project, w.area, other, w.linear),
    ).toBeNull();
    expect((await w.review.list("app")).items).toHaveLength(0);
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it.each([
    "scope",
    "parent",
    "hold",
    "canceled",
    "team",
    "mapping",
    "mandate",
    "instance",
    "connection",
  ])("revokes inherited authorization after %s changes", async (kind) => {
    const w = world();
    await w.approve();
    if (kind === "scope") w.epic.description += "\n- Charge customer accounts.";
    if (kind === "parent") w.child.parentId = "another-epic";
    if (kind === "hold") w.epic.labels.push("pm-needs-human");
    if (kind === "canceled") w.epic.stateType = "canceled";
    if (kind === "team") w.project.config.linear = { teamId: "different-team" };
    if (kind === "mapping") w.area.linearProjectId = "another-project";
    if (kind === "mandate") w.area.mandate = "A different scope";
    if (kind === "instance")
      w.project.config.instanceId = "11111111-1111-4111-8111-111111111111";
    if (kind === "connection")
      w.project.config.linear = { connectionId: "another" };
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toContain("no current owner approval");
  });
  it("requires a native parent and includes parent changes in admitted ticket scope", async () => {
    const w = world();
    await w.approve();
    const scope = ticketScopeHash(w.child);
    delete w.child.parentId;
    expect(ticketScopeHash(w.child)).not.toBe(scope);
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toContain("needs a parent epic");
  });
  it("does not let an ordinary ticket use the epic approval route", async () => {
    const w = world();
    w.epic.labels = w.epic.labels.filter((label) => label !== "pm-epic");
    expect((await w.review.list("app")).items).toHaveLength(0);
    expect(() => approveEpic(root, w.project, w.area, w.epic)).toThrow();
  });
  it("retains legacy ticket workflow until an owner chooses epic approval", async () => {
    const w = world();
    w.project.config.workflow = { kind: "promotion" };
    delete w.child.parentId;
    expect(
      await epicCodingBlocker(root, w.project, w.area, w.child, w.linear),
    ).toBeNull();
    expect(epicApproved(root, w.project, w.area, w.epic)).toBe(false);
  });
});
