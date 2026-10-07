import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import { createProjectReview } from "./review.ts";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-review-"));
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
  // Preserve coverage of the explicitly supported legacy per-ticket policy.
  const projectPath = join(root, "projects/app/project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.workflow = { kind: "promotion", approvalPolicy: "ticket" };
  writeFileSync(projectPath, JSON.stringify(project));
  const file = join(root, "projects", "app", "areas.json"),
    raw = JSON.parse(readFileSync(file, "utf8"));
  raw.areas.core.linearProjectId = "linear-project";
  writeFileSync(file, JSON.stringify(raw));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const ticket: LinearTicket = {
    id: "ticket-1",
    identifier: "APP-1",
    title: "Fix lost uploads",
    description: "## Acceptance criteria\n- Upload survives reload.",
    labels: ["pm:core"],
    stateType: "unstarted",
    projectId: "linear-project",
    teamId: "team",
    priority: 2,
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    url: "https://linear.app/test/issue/APP-1",
  };
  const addLabel = vi.fn(async () => {}),
    removeLabel = vi.fn(async (_id: string, label: string) => {
      ticket.labels = ticket.labels.filter((value) => value !== label);
    }),
    client = {
      listTickets: vi.fn(async () => [ticket]),
      getTicket: vi.fn(async () => ticket),
      addLabel,
      removeLabel,
    } as unknown as LinearClient;
  return {
    ticket,
    addLabel,
    removeLabel,
    store: createProjectReview({ root, client: async () => client }),
  };
}
describe("review inbox approvals", () => {
  it.each(["project", "pm"])(
    "requires fresh review after the owning %s is recreated with unchanged repo and Linear mappings",
    async (kind) => {
      const f = fixture();
      const prior = (await f.store.list("app")).items[0]!;
      const file = join(
        root,
        "projects/app",
        kind === "project" ? "project.json" : "areas.json",
      );
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "project")
        raw.instanceId = "a1b2c3d4-1111-4222-8333-444444444444";
      else raw.areas.core.instanceId = "a1b2c3d4-1111-4222-8333-444444444444";
      writeFileSync(file, JSON.stringify(raw));
      await expect(
        f.store.approve("app", prior.id, prior.revision),
      ).rejects.toThrow(/changed/);
      expect(f.addLabel).not.toHaveBeenCalled();
      expect((await f.store.list("app")).items[0]!.revision).not.toBe(
        prior.revision,
      );
    },
  );
  it("cannot approve a description that the dashboard cannot show in full", async () => {
    const f = fixture();
    f.ticket.description = "A".repeat(20001);
    const item = (await f.store.list("app")).items[0]!;
    expect(item.truncated).toBe(true);
    expect(item.canApprove).toBe(false);
    await expect(
      f.store.approve("app", "ticket-1", item.revision),
    ).rejects.toThrow(/cannot be approved/);
    expect(f.addLabel).not.toHaveBeenCalled();
  });
  it.each(["promotion", "pull-request"])(
    "requires a finite acceptance checklist before approving %s work",
    async (kind) => {
      const path = join(root, "projects", "app", "project.json"),
        config = JSON.parse(readFileSync(path, "utf8"));
      config.workflow =
        kind === "promotion" ? { kind } : { kind, baseBranch: "main" };
      config.branches = {
        integration: "pm-staging",
        staging: "staging",
        production: "main",
      };
      writeFileSync(path, JSON.stringify(config));
      const f = fixture();
      f.ticket.description = "Make uploads better";
      expect((await f.store.list("app")).items[0]?.canApprove).toBe(false);
      const pending = (await f.store.list("app")).items[0]!;
      expect(pending.reason).toContain("Acceptance criteria");
      await expect(
        f.store.approve("app", pending.id, pending.revision),
      ).rejects.toThrow(/Acceptance criteria/);
      expect(f.addLabel).not.toHaveBeenCalled();
      f.ticket.description =
        "## Acceptance criteria\n- Uploaded rows survive reload.\n- Another tenant cannot see them.";
      expect((await f.store.list("app")).items[0]?.canApprove).toBe(true);
    },
  );
  it("approves the reviewed ticket scope and never changes workflow state", async () => {
    const f = fixture(),
      result = await f.store.list("app");
    expect(result.items[0]?.canApprove).toBe(true);
    await f.store.approve("app", "ticket-1", result.items[0]!.revision);
    expect(f.addLabel).toHaveBeenCalledExactlyOnceWith(
      "ticket-1",
      "pm-approved",
    );
  });
  it("rejects changed scope and cross-project remapping", async () => {
    const f = fixture(),
      rev = (await f.store.list("app")).items[0]!.revision;
    f.ticket.description = "Different broader scope";
    await expect(f.store.approve("app", "ticket-1", rev)).rejects.toThrow(
      /changed/,
    );
    f.ticket.projectId = "another-project";
    await expect(f.store.approve("app", "ticket-1", rev)).rejects.toThrow(
      /owning PM changed/,
    );
    expect(f.addLabel).not.toHaveBeenCalled();
  });
  it("turns an explicitly reviewed PM proposal into approved coding work", async () => {
    const f = fixture();
    f.ticket.labels.push("pm-proposal");
    const item = (await f.store.list("app")).items[0]!;
    expect(item.canApprove).toBe(true);
    await f.store.approve("app", "ticket-1", item.revision);
    expect(f.removeLabel).toHaveBeenCalledExactlyOnceWith(
      "ticket-1",
      "pm-proposal",
    );
    expect(f.addLabel).toHaveBeenCalledExactlyOnceWith(
      "ticket-1",
      "pm-approved",
    );
  });
  it("leaves a changed proposal unapproved after removing its proposal label", async () => {
    const f = fixture();
    f.ticket.labels.push("pm-proposal");
    const item = (await f.store.list("app")).items[0]!;
    f.removeLabel.mockImplementationOnce(async () => {
      f.ticket.labels = ["pm:core"];
      f.ticket.description = "Changed scope while the provider was saving";
    });
    await expect(
      f.store.approve("app", "ticket-1", item.revision),
    ).rejects.toThrow(/changed during review/);
    expect(f.addLabel).not.toHaveBeenCalled();
  });
  it("keeps blockers and already-complete work out of coding approval", async () => {
    const f = fixture();
    for (const label of ["pm-needs-human", "pm-sync"]) {
      f.ticket.labels = ["pm:core", label];
      const item = (await f.store.list("app")).items[0]!;
      expect(item.canApprove).toBe(false);
      await expect(
        f.store.approve("app", "ticket-1", item.revision),
      ).rejects.toThrow(/cannot be approved/);
    }
    f.ticket.stateType = "completed";
    expect((await f.store.list("app")).items).toEqual([]);
    expect(f.addLabel).not.toHaveBeenCalled();
  });
});
