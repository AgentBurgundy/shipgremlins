import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
const start = app.indexOf("  function adoptLinearProjectSnapshot(");
const end = app.indexOf("\n  let projectLinearSettings", start);
function fixture() {
  const editor = {
    name: "shop",
    path: "projects/shop/project.json",
    revision: "original",
    config: {
      name: "shop",
      commands: { test: "npm test" },
      linear: { teamId: "old" },
      verified: "2026-10-05",
    },
    form: { draft: "npm run my-unsaved-test" },
  };
  const message = vi.fn();
  const adopt = runInNewContext(`(${app.slice(start, end).trim()})`, {
    projectEditor: editor,
    message,
    $: (id: string) => id,
  }) as (
    project: string,
    document: { path: string; content: string; revision: string },
  ) => boolean;
  return { editor, message, adopt };
}
describe("project form rebase after Linear repair", () => {
  it("uses only the exact repair revision, preserving a local form draft and detecting a later edit on the next save", () => {
    const { editor, adopt } = fixture();
    const repaired = {
      ...editor.config,
      linear: { teamId: "new" },
      verified: null,
    };
    expect(
      adopt("shop", {
        path: editor.path,
        content: JSON.stringify(repaired),
        revision: "repair-commit",
      }),
    ).toBe(true);
    // Another process changes hosting after the repair response. Its revision
    // must not silently become this still-open form's optimistic version.
    const latestServerRevision = "other-operator-edit";
    expect(editor.revision).toBe("repair-commit");
    expect(editor.revision).not.toBe(latestServerRevision);
    expect(editor.config.linear.teamId).toBe("new");
    expect(editor.form.draft).toBe("npm run my-unsaved-test");
  });
  it("refuses to advance a stale main form over non-Linear changes already present in the repair snapshot", () => {
    const { editor, adopt, message } = fixture();
    const original = structuredClone(editor);
    const repaired = {
      ...editor.config,
      commands: { test: "npm run other-operator-test" },
      linear: { teamId: "new" },
    };
    expect(
      adopt("shop", {
        path: editor.path,
        content: JSON.stringify(repaired),
        revision: "repair-commit",
      }),
    ).toBe(false);
    expect(editor).toEqual(original);
    expect(message).toHaveBeenCalledWith(
      "project-settings-message",
      expect.stringContaining("other project settings changed"),
      true,
    );
  });
  it("does not rebase a different project's open editor", () => {
    const { editor, adopt } = fixture();
    expect(
      adopt("other", {
        path: "projects/other/project.json",
        content: "{}",
        revision: "wrong",
      }),
    ).toBe(false);
    expect(editor.revision).toBe("original");
  });
});
