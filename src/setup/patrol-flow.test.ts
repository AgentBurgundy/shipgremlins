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
    expect(text(root)).toContain("Signed-in testing planned");
    expect(text(root)).toContain("Open app & attempt sign-in");
    expect(text(root)).toContain(
      "Saved accounts do not prove that login or signed-in features work",
    );
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
  it.each([{}, { access: { kind: "password", accounts: [] } }])(
    "makes an unconfigured app login actionable before a browser patrol: %j",
    (access) => {
      const root = fixture().renderPatrolPlan(
        project({ kind: "vercel", ...access }),
      );
      expect(text(root)).toContain("Choose how your gremlin signs in");
      expect(text(root)).toContain(
        "Signed-in features need a dedicated test account",
      );
      expect(text(root)).toContain(
        "Vercel access opens the preview. A test account signs the gremlin into your app.",
      );
      const action = all(root).find(
        (item) => item.textContent === "Set up app sign-in",
      );
      expect(action?.href).toBe("/projects/shop?tab=environment");
      expect(
        all(root).find((item) => item.className === "patrol-plan-coverage")
          ?.dataset.tone,
      ).toBe("attention");
      expect(text(root)).not.toContain("Open app & sign in");
      expect(text(root)).not.toContain("Signed-in testing planned");
    },
  );
  it("makes the public-only limit visible even in a compact plan", () => {
    const ui = fixture(),
      input = project({ kind: "url", access: { kind: "public" } }),
      root = ui.renderPatrolPlan(input, { compact: true });
    expect(text(root)).toContain("Public pages only");
    expect(text(root)).toContain(
      "To test anything behind a login, add a dedicated test account",
    );
    expect(text(root)).toContain("Set up app sign-in");
    expect(root.dataset.compact).toBe("true");
    expect(all(root).find((item) => item.tagName === "h3")?.textContent).toBe(
      "Public pages only",
    );
    expect(
      all(root).some((item) => item.className === "patrol-plan-coverage"),
    ).toBe(false);
    expect(all(root).some((item) => item.tagName === "ol")).toBe(false);
    const full = ui.renderPatrolPlan(input),
      steps = all(full).find((item) => item.tagName === "ol")!;
    expect(text(steps)).toContain("Open public pages");
    expect(text(steps)).toContain("Explore public flows & capture evidence");
    expect(text(steps)).not.toContain("sign-in");
  });
  it.each([
    project({ kind: "vercel" }),
    { name: "legacy", vercel: { projectId: "preview-project" } },
  ])("recognizes a saved legacy sign-in recipe: %j", (input) => {
    const root = fixture().renderPatrolPlan({
      ...input,
      signIn: {
        kind: "neon-auth-otp",
        email: "private-test@example.test",
        path: "/sign-in",
        databaseUrlSecret: "PRIVATE_DATABASE",
      },
    });
    expect(text(root)).toContain("Existing email-code sign-in recipe");
    expect(text(root)).toContain("attempt the saved email-code login");
    expect(text(root)).toContain(
      "Check browser evidence to confirm sign-in and signed-in features actually work",
    );
    expect(text(root)).toContain("Open app & attempt sign-in");
    expect(text(root)).toContain("Environment & accounts");
    expect(text(root)).not.toContain("Choose how your gremlin signs in");
    expect(text(root)).not.toContain("Set up app sign-in");
    expect(text(root)).not.toContain("PRIVATE_DATABASE");
    expect(text(root)).not.toContain("private-test@example.test");
  });
  it("uses the selected public coverage before an older project-wide login recipe", () => {
    const root = fixture().renderPatrolPlan({
      ...project({ kind: "vercel", access: { kind: "public" } }),
      signIn: { kind: "neon-auth-otp" },
    });
    expect(text(root)).toContain("Public pages only");
    expect(text(root)).not.toContain("email-code");
    expect(text(root)).not.toContain("attempt sign-in");
  });
  it("does not require app sign-in for repository-only patrols", () => {
    const root = fixture().renderPatrolPlan({
      ...project({ kind: "vercel" }),
      verification: { mode: "repository" },
    });
    expect(text(root)).toContain("Run repository checks");
    expect(text(root)).toContain("Add browser testing");
    expect(text(root)).not.toContain("test account");
    expect(
      all(root).some((item) => item.className === "patrol-plan-coverage"),
    ).toBe(false);
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
  it("explains a pre-start environment wait without reporting missing browser evidence", () => {
    const ui = fixture(),
      input = {
        job: { status: "queued", failure: { category: "environment-wait" } },
        activityState: "partial",
        artifactState: "partial",
        activity: {
          events: [
            {
              id: "lifecycle:queued",
              type: "progress",
              title: "Run queued",
            },
          ],
          checks: [],
        },
        artifacts: [],
      },
      pending = ui.renderPatrolEvidence(input);
    expect(text(pending)).toContain("Preparing the test environment");
    expect(text(pending)).toContain("do not start another AI run");
    expect(text(pending)).not.toMatch(/incomplete|unavailable|0 passed/);
    expect(pending.dataset.tone).toBe("neutral");
    expect(all(pending).some((item) => item.tagName === "button")).toBe(false);
    expect(
      text(ui.renderPatrolEvidence({ ...input, job: { status: "queued" } })),
    ).toContain("Waiting to start");

    // Evidence from an earlier attempt must remain visible even while requeued.
    const prior = ui.renderPatrolEvidence({
      ...input,
      activity: { checks: [{ name: "Login", status: "failed" }] },
    });
    expect(text(prior)).not.toContain("has not started yet");
    expect(text(prior)).toContain("1 failed");
    expect(
      text(
        ui.renderPatrolEvidence({
          ...input,
          job: { ...input.job, startedAt: "2026-10-07T19:37:00Z" },
        }),
      ),
    ).toContain("Browser activity is incomplete");
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
  it("labels a finished Grumblin as a customer simulation whose journey still needs evidence", () => {
    const root = fixture().renderPatrolEvidence({
      job: { type: "pm", pmMode: "grumblin", status: "succeeded" },
      activityState: "ready",
      artifactState: "ready",
      activity: { events: [] },
      artifacts: [],
    });
    expect(text(root)).toContain(
      "A completed run alone does not prove this customer journey was tested. Check the recorded actions and screenshots.",
    );
    expect(text(root)).not.toContain("Repository-only patrols");
  });
});
