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
    description: "Acceptance: upload survives reload",
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
  it("requires a finite acceptance checklist before approving promotion work", async () => {
    const path = join(root, "projects", "app", "project.json"),
      config = JSON.parse(readFileSync(path, "utf8"));
    config.workflow = { kind: "promotion" };
    config.branches = {
      integration: "pm-staging",
      staging: "staging",
      production: "main",
    };
    writeFileSync(path, JSON.stringify(config));
    const f = fixture();
    expect((await f.store.list("app")).items[0]?.canApprove).toBe(false);
    f.ticket.description =
      "## Acceptance criteria\n- Uploaded rows survive reload.\n- Another tenant cannot see them.";
    expect((await f.store.list("app")).items[0]?.canApprove).toBe(true);
  });
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
