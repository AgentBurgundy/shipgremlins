import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  href = "";
  rel = "";
  target = "";
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  root.textContent + root.children.map(text).join(" ");
function fixture() {
  const window = {} as {
    renderPatrolPlan(project: object, options?: object): Element;
    renderPatrolEvidence(input: object): Element;
    patrolEvidence(input: object): {
      calls: number;
      navigations: number;
      interactions: number;
      images: number;
      passed: number;
      failed: number;
      running: number;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/patrol-flow.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      URL,
      document: { createElement: (tag: string) => new Element(tag) },
    },
  );
  return window;
}
const project = (target: object) => ({
  name: "shop",
  verification: { mode: "browser", environment: "pm-staging" },
  environments: { "pm-staging": { role: "staging", ...target } },
});
describe("patrol plan and evidence", () => {
  it("distinguishes hosted browser, disposable Docker, repository-only and incomplete configuration", () => {
    const ui = fixture();
    expect(text(ui.renderPatrolPlan(project({ kind: "railway" })))).toContain(
      "Visit your staging app",
    );
    const docker = ui.renderPatrolPlan(project({ kind: "docker", port: 3000 }));
    expect(text(docker)).toContain("Start app & open browser");
    expect(text(docker)).toContain("private app environment");
    expect(
      all(docker)
        .find((item) => item.tagName === "ol")
        ?.attributes.get("aria-label"),
    ).toContain("not live progress");
    expect(
      text(
        ui.renderPatrolPlan({
          name: "library",
          verification: { mode: "repository" },
        }),
      ),
    ).toContain("Opening an application is not required");
    expect(
      text(
        ui.renderPatrolPlan({
          name: "broken",
          verification: { mode: "browser", environment: "missing" },
        }),
      ),
    ).toContain("needs configuration");
    expect(
      text(ui.renderPatrolPlan(project({ kind: "url", role: "production" }))),
    ).toContain("needs configuration");
  });
  it("keeps the app subpath and account names without exposing credentials or URL session values", () => {
    const root = fixture().renderPatrolPlan(
      project({
        kind: "url",
        url: "https://staging.example.test/dashboard?token=private#session=private",
        access: {
          kind: "password",
          accounts: [
            {
              name: "Admin",
              usernameSecret: "PRIVATE_USERNAME",
              passwordSecret: "PRIVATE_PASSWORD",
            },
          ],
        },
      }),
    );
    expect(text(root)).toContain("Test accounts: Admin");
    expect(text(root)).not.toContain("PRIVATE");
    const open = all(root).find((item) => item.textContent === "Open app ↗")!;
    expect(open.href).toBe("https://staging.example.test/dashboard");
    expect(open.rel).toBe("noopener noreferrer");
    expect(JSON.stringify(root)).not.toContain("token=private");
    const unsafe = fixture().renderPatrolPlan(
      project({ kind: "url", url: "javascript:alert(1)" }),
    );
    expect(all(unsafe).some((item) => item.textContent === "Open app ↗")).toBe(
      false,
    );
  });
  it("counts recorded tool attempts, never summary claims or generic tool results as successful app verification", () => {
    const result = fixture().patrolEvidence({
      events: [
        {
          id: "1",
          type: "tool",
          title: "mcp__playwright__browser_navigate",
          status: "running",
        },
        {
          id: "1",
          type: "tool",
          title: "mcp__playwright__browser_navigate",
          status: "running",
        },
        { id: "2", type: "tool", title: "Tool result", status: "failed" },
        { id: "3", type: "progress", title: "mcp__playwright__browser_click" },
        {
          id: "4",
          type: "tool",
          title: "Bash",
          detail: "browser_navigate succeeded",
        },
      ],
      summary: "I verified all browser workflows.",
      files: [{ name: "fixture.png" }, { name: "fixture.png" }],
      checks: [{ name: "Test", status: "failed" }],
    });
    expect(result).toEqual({
      calls: 1,
      navigations: 1,
      interactions: 0,
      images: 1,
      passed: 0,
      failed: 1,
      running: 0,
    });
  });
  it("shows missing evidence after a successful process, without treating empty or failed loads as proof", () => {
    const ui = fixture(),
      input = {
        job: { type: "pm", status: "succeeded" },
        activity: { events: [], summary: "Everything tested" },
        artifacts: [],
        artifactState: "ready",
        onTab: vi.fn(),
      };
    const ready = ui.renderPatrolEvidence({ ...input, activityState: "ready" });
    expect(text(ready)).toContain("No browser calls recorded");
    expect(text(ready)).toContain("does not prove the app was tested");
    expect(ready.dataset.tone).toBe("attention");
    expect(
      text(ui.renderPatrolEvidence({ ...input, activityState: "partial" })),
    ).toContain("activity is incomplete");
    expect(
      text(ui.renderPatrolEvidence({ ...input, activityState: "error" })),
    ).toContain("activity unavailable");
    expect(
      text(ui.renderPatrolEvidence({ ...input, activityState: "loading" })),
    ).toContain("Loading browser activity");
    expect(
      text(
        ui.renderPatrolEvidence({
          ...input,
          activityState: "ready",
          job: { status: "running" },
        }),
      ),
    ).toContain("Waiting for browser activity");
  });
  it("links directly to recorded actions and files and labels images as possible fixtures", () => {
    const onTab = vi.fn(),
      root = fixture().renderPatrolEvidence({
        job: { status: "succeeded" },
        activityState: "ready",
        artifactState: "ready",
        onTab,
        activity: {
          events: [
            { id: "1", type: "tool", title: "mcp__playwright__browser_click" },
          ],
        },
        artifacts: [{ name: "test-fixture.png" }],
      });
    expect(text(root)).toContain("Browser activity recorded");
    expect(text(root)).toContain("Calls show attempts");
    expect(text(root)).toContain("images may also be test fixtures");
    const buttons = all(root).filter((item) => item.tagName === "button");
    buttons[0]!.listeners.get("click")!();
    buttons[1]!.listeners.get("click")!();
    expect(onTab.mock.calls).toEqual([["activity"], ["artifacts"]]);
  });
  it("explains discovery instead of suggesting that missing browser evidence is a failed patrol", () => {
    const root = fixture().renderPatrolEvidence({
      job: { type: "pm", pmMode: "discovery", status: "succeeded" },
    });
    expect(text(root)).toContain("Discovery reads code, not the running app");
    expect(all(root).some((item) => item.tagName === "button")).toBe(false);
    expect(root.dataset.tone).toBe("neutral");
  });
});
