import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCtx } from "../services/fakes.ts";
import { createAutomationDiagnostics } from "./automationDiagnostics.ts";
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
describe("durable safe automation diagnostics", () => {
  it("survives restart, bounds retries, and clears resolved reasons", () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-diagnostics-"));
    const project = makeCtx().project;
    const store = createAutomationDiagnostics(root),
      now = new Date("2026-10-14T12:00:00Z");
    store.fail(project, "tickets", "tickets", "core", now);
    const next = createAutomationDiagnostics(root);
    expect(next.ready(project, "tickets", "core", now)).toBe(false);
    expect(next.list(project)[0]).toMatchObject({
      code: "tickets",
      nextRetryAt: "2026-10-14T12:05:00.000Z",
      action: { label: "Resolve" },
    });
    store.fail(project, "tickets", "tickets", "core", new Date(+now + 60_000));
    expect(next.list(project)[0]?.nextRetryAt).toBe("2026-10-14T12:05:00.000Z");
    store.fail(
      project,
      "tickets",
      "tickets",
      "core",
      new Date(+now + 5 * 60_000),
    );
    expect(next.list(project)[0]?.nextRetryAt).toBe("2026-10-14T12:15:00.000Z");
    next.resolve(project, "tickets", "core");
    expect(next.list(project)).toEqual([]);
    expect(next.ready(project, "tickets", "core")).toBe(true);
  });
  it("retains only typed safe reasons and isolates deleted-name reuse", () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-diagnostics-"));
    const project = makeCtx().project;
    const store = createAutomationDiagnostics(root);
    store.fail(project, "setup", "verification");
    const directory = join(
      root,
      ".run",
      "automation-diagnostics",
      project.config.name,
    );
    const content = readFileSync(
      join(directory, readdirSync(directory)[0]!),
      "utf8",
    );
    expect(content).not.toContain("token");
    project.config.instanceId = "new-project";
    expect(store.list(project)).toEqual([]);
  });
});
