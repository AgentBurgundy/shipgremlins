import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import type { ReadinessContext } from "../setup/pmReadiness.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { projectOperations } from "./operations.ts";

let root: string;
const context: ReadinessContext = {
  env: {},
  sourceConnections: [],
  serviceConnections: [],
  workers: [],
  localMode: true,
};
beforeEach(() => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-project-operations-"),
  );
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function markIdea() {
  const file = join(root, "projects/app/project.json"),
    config = JSON.parse(readFileSync(file, "utf8"));
  config.ideaPlanId = randomUUID();
  writeFileSync(file, JSON.stringify(config));
}
describe("project operations priorities", () => {
  it("gives a fresh idea one foundation action instead of premature discovery and environment tasks", () => {
    markIdea();
    const result = projectOperations(root, "app", [], context);
    expect(result.inbox).toEqual([
      expect.objectContaining({
        id: "setup:foundation",
        kind: "setup",
        action: {
          label: "Build foundation",
          href: "/projects/app?tab=environment",
        },
      }),
    ]);
    expect(result.knowledge.areas).toHaveLength(1);
  });
  it("keeps actual failed runs visible while avoiding empty-repository PM setup noise", () => {
    markIdea();
    const job: LocalJob = {
      id: "foundation-failed",
      runId: 1,
      type: "developer",
      project: "app",
      area: "core",
      status: "failed",
      createdAt: "2026-10-05",
      message: "The runner disconnected.",
    };
    const result = projectOperations(root, "app", [job], context);
    expect(result.inbox.map((item) => item.id)).toEqual([
      "setup:foundation",
      "run:foundation-failed",
    ]);
    expect(result.inbox[1]!.detail).toBe("The runner disconnected.");
  });
  it("preserves setup remedies and discovery for an existing application", () => {
    const result = projectOperations(root, "app", [], context);
    expect(result.inbox.some((item) => item.kind === "knowledge")).toBe(true);
    expect(result.inbox.some((item) => item.kind === "setup")).toBe(true);
    expect(result.inbox.some((item) => item.id === "setup:foundation")).toBe(
      false,
    );
  });
});
