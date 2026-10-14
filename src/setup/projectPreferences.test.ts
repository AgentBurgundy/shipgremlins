import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectPreferenceId } from "./projectPreferences.ts";
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
it("persists legacy display identity without changing execution identity and isolates replacements", () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-preferences-"));
  const project = { name: "app" };
  const first = projectPreferenceId(root, project);
  expect(projectPreferenceId(root, project)).toBe(first);
  expect(project).toEqual({ name: "app" });
  expect(
    projectPreferenceId(root, {
      name: "app",
      instanceId: "11111111-1111-4111-8111-111111111111",
    }),
  ).not.toBe(first);
  expect(projectPreferenceId(root, { name: "other" })).not.toBe(first);
});
