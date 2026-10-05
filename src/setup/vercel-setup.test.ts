import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  checked = false;
  id = "";
  open = false;
  scrollTop = 0;
  focus = vi.fn();
  showModal() {
    this.open = true;
    this.scrollTop = 500;
  }
  close() {
    this.open = false;
  }
  constructor(public tagName = "DIV") {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(
    name: string,
    callback: (event: { preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(name, callback);
  }
  fire(name: string) {
    if (name === "click" && this.disabled) return;
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
}
const walk = (element: Element): Element[] => [
  element,
  ...element.children.flatMap(walk),
];
const text = (element: Element): string =>
  element.textContent + element.children.map(text).join("");
const target = {
  kind: "vercel",
  role: "staging",
  projectId: "prj_test",
  connectionId: "test-team",
  teamId: "team_testing",
  branch: "pm-staging",
  customEnvironmentId: "env_staging",
};
const preview = {
  id: "dpl_preview",
  state: "READY",
  environment: "custom",
  branch: "pm-staging",
  sha: "abcdef1234567",
  url: "https://app-staging.vercel.app",
  selectable: true,
  customEnvironmentId: "env_staging",
  target,
};
const initial = () => ({
  project: "forevermods",
  status: "idle",
  message: "",
  revision: "r1",
  configurationRevision: "c1",
  stale: false,
});
const discovered = () => ({
  ...initial(),
  status: "discovered",
  inventory: {
    connectionId: "test-team",
    teamId: "team_testing",
    projects: [
      { id: "prj_test", name: "forevermods-staging", matchesRepository: true },
    ],
    selectedProject: {
      id: "prj_test",
      name: "forevermods-staging",
      matchesRepository: true,
      productionBranch: "main",
      customEnvironments: [{ id: "env_staging", slug: "pm-testing" }],
    },
    deployments: [
      preview,
      {
        id: "dpl_prod",
        state: "READY",
        environment: "production",
        branch: "main",
        selectable: false,
        url: "https://real-production.example.test",
      },
    ],
    truncated: false,
  },
});
const prepared = () => ({
  ...discovered(),
  status: "prepared",
  plan: {
    id: "plan-1",
    projectName: "forevermods-staging",
    branch: "pm-staging",
    baseBranch: "main",
    sha: "abcdef1234567",
    createBranch: true,
    customEnvironmentId: "env_staging",
    warnings: [
      "Preview variables are inherited from the selected Vercel environment.",
    ],
    target,
  },
});
type Panel = {
  mount(container: Element): void;
  setActive(value: boolean): void;
  refresh(): Promise<void>;
  isBusy(): boolean;
  destroy(): void;
};
const panels: Panel[] = [];
const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
function fixture(
  data: object = initial(),
  implementation?: (path: string, body?: unknown) => Promise<object>,
) {
  const api = vi.fn(implementation || (async () => data)),
    selected = vi.fn(),
    document = {
      hidden: false,
      createElement: (tag: string) => new Element(tag.toUpperCase()),
    },
    window = { createVercelSetup: (_options: object): Panel => ({}) as Panel };
  class Option extends Element {
    constructor(label: string, value: string) {
      super("OPTION");
      this.textContent = label;
      this.value = value;
    }
  }
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/vercel-setup.js", import.meta.url),
      "utf8",
    ),
    { window, document, Option, structuredClone, setTimeout, clearTimeout },
  );
  const root = new Element(),
    panel = window.createVercelSetup({
      api,
      project: { name: "forevermods" },
      onSelect: selected,
      getStatus: () => ({
        serviceConnections: [
          {
            provider: "vercel",
            id: "default",
            label: "Personal token",
            method: "token",
            connected: true,
          },
          {
            provider: "vercel",
            id: "test-team",
            label: "Testing account",
            workspace: { name: "My team" },
            method: "oauth",
            connected: true,
          },
          {
            provider: "linear",
            id: "linear-other",
            label: "Different provider",
          },
        ],
      }),
    });
  panels.push(panel);
  panel.mount(root);
  const find = (label: string) =>
    walk(root).find(
      (item) => item.tagName === "BUTTON" && item.textContent === label,
    )!;
  return { root, panel, api, selected, find, document };
}
afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  vi.useRealTimers();
});

describe("Vercel setup conversation", () => {
  it("opens team and help dialogs at their heading, preserves edits on close, and closes on navigation", async () => {
    const f = fixture();
    await settle();
    expect(walk(f.root).some((item) => item.tagName === "DETAILS")).toBe(false);
    for (const label of ["Use another team", "Get setup help"]) {
      await f.find(label).fire("click");
      const dialog = walk(f.root).find(
          (item) => item.tagName === "DIALOG" && item.open,
        )!,
        header = dialog.children[0]!,
        heading = header.children[0]!,
        field = walk(dialog).find((item) =>
          ["INPUT", "TEXTAREA"].includes(item.tagName),
        )!;
      expect(header.tagName).toBe("HEADER");
      expect(header.children[1]!.textContent).toBe("Close");
      expect(heading.attributes.get("tabindex")).toBe("-1");
      expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(dialog.scrollTop).toBe(0);
      field.value =
        label === "Use another team"
          ? "team_review"
          : "My unsent setup question";
      const expected = field.value;
      await header.children[1]!.fire("click");
      expect(dialog.open).toBe(false);
      await f.find(label).fire("click");
      expect(field.value).toBe(expected);
      f.panel.setActive(false);
      expect(dialog.open).toBe(false);
      f.panel.setActive(true);
      await settle();
    }
  });
  it("reviews new preview options in a focused dialog before preparing them", async () => {
    const f = fixture(discovered());
    await settle();
    await f.find("Prepare a new preview").fire("click");
    const dialog = walk(f.root).find(
      (item) => item.tagName === "DIALOG" && item.open,
    )!;
    expect(dialog.children[0]!.children[0]!.textContent).toBe(
      "Create a dedicated test preview",
    );
    expect(dialog.scrollTop).toBe(0);
    expect(
      f.api.mock.calls.some(
        ([path]) => path.endsWith("/prepare") || path.endsWith("/deploy"),
      ),
    ).toBe(false);
  });
  it("uses saved token and OAuth connections without requiring a new login", async () => {
    const f = fixture();
    await settle();
    expect(text(f.root)).toContain("Personal token");
    expect(text(f.root)).toContain("Testing account · My team");
    expect(text(f.root)).not.toContain("Different provider");
    expect(text(f.root)).not.toContain("Connect Vercel");
    const connection = walk(f.root).find((item) =>
      item.id.endsWith("vercel-connection"),
    )!;
    connection.value = "test-team";
    connection.fire("change");
    await f.find("Find my Vercel environment").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/onboarding/vercel/discover",
      { revision: "r1", connectionId: "test-team" },
    );
    expect(f.api.mock.calls.some(([path]) => path.endsWith("/deploy"))).toBe(
      false,
    );
  });

  it("selects a separate staging project with full provider identity and excludes production", async () => {
    const f = fixture(discovered());
    await settle();
    expect(text(f.root)).toContain("forevermods-staging · same repository");
    expect(text(f.root)).toContain("pm-testing · pm-staging");
    expect(text(f.root)).not.toContain("real-production.example.test");
    expect(text(f.root)).toContain("1 production deployment is excluded");
    await f.find("Use this preview").fire("click");
    expect(f.selected).toHaveBeenCalledWith({
      target,
      label: "forevermods-staging · pm-staging",
    });
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(text(f.root)).toContain("save the environment, then test access");
  });

  it("cannot choose a failed preview or a candidate whose target is production", async () => {
    const data = discovered();
    data.inventory.deployments = [
      {
        ...preview,
        state: "ERROR",
        selectable: false,
        reason: "Deployment failed",
      } as typeof preview,
      {
        ...preview,
        id: "bad-target",
        target: { ...target, role: "production" },
      },
    ];
    const f = fixture(data);
    await settle();
    expect(f.find("Use this preview")).toBeUndefined();
    expect(f.selected).not.toHaveBeenCalled();
    expect(text(f.root)).toContain("Deployment failed");
  });

  it("requires review and explicit test-data confirmation before deployment", async () => {
    const f = fixture(prepared());
    await settle();
    expect(text(f.root)).toContain("REVIEW BEFORE CREATING");
    expect(text(f.root)).toContain("Create pm-staging");
    expect(text(f.root)).toContain("main · abcdef1");
    const deploy = f.find("Create test preview");
    expect(deploy.disabled).toBe(true);
    await deploy.fire("click");
    expect(f.api).toHaveBeenCalledTimes(1);
    const checkbox = walk(f.root).find(
      (item) =>
        item.tagName === "INPUT" &&
        item.value === "" &&
        item.listeners.has("change"),
    )!;
    checkbox.checked = true;
    checkbox.fire("change");
    expect(deploy.disabled).toBe(false);
    await deploy.fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/onboarding/vercel/deploy",
      { revision: "r1", confirmTestData: true },
    );
  });

  it("prepares custom-environment and source choices without silently deploying", async () => {
    const f = fixture(discovered());
    await settle();
    const branch = walk(f.root).find((item) =>
      item.id.endsWith("test-branch"),
    )!;
    branch.value = "pm/forevermods";
    branch.fire("input");
    const environment = walk(f.root).find((item) =>
      item.id.endsWith("vercel-environment"),
    )!;
    environment.value = "env_staging";
    environment.fire("change");
    await f.find("Review preview setup").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/onboarding/vercel/prepare",
      {
        revision: "r1",
        branch: "pm/forevermods",
        baseBranch: "main",
        customEnvironmentId: "env_staging",
      },
    );
  });

  it("makes chat read-only and renders answers as text, never executable markup", async () => {
    const f = fixture(initial(), async (path) =>
      path.endsWith("/chat")
        ? {
            answer:
              '<script>alert("bad")</script> Check the preview variables.',
          }
        : initial(),
    );
    await settle();
    const question = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    question.value = "Please create a preview for me";
    await walk(f.root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/onboarding/vercel/chat",
      { message: "Please create a preview for me" },
    );
    expect(
      f.api.mock.calls.some(
        ([path]) => path.endsWith("/deploy") || path.endsWith("/prepare"),
      ),
    ).toBe(false);
    expect(text(f.root)).toContain('<script>alert("bad")</script>');
    expect(walk(f.root).some((item) => item.tagName === "SCRIPT")).toBe(false);
    expect(question.value).toBe("");
  });

  it("shows discovery failures with a retry action and preserves typed chat questions", async () => {
    const f = fixture(initial(), async (path) => {
      if (path.endsWith("/discover"))
        throw new Error("The selected team is unavailable.");
      return initial();
    });
    await settle();
    const question = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    question.value = "Which team should I use?";
    await f.find("Find my Vercel environment").fire("click");
    expect(text(f.root)).toContain("The selected team is unavailable.");
    expect(f.find("Find my Vercel environment").disabled).toBe(false);
    expect(question.value).toBe("Which team should I use?");
  });

  it("polls an in-progress build without replacing the chat composer, and pauses off-page", async () => {
    vi.useFakeTimers();
    const f = fixture({ ...prepared(), status: "deploying" });
    await settle();
    const question = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    question.value = "My unsent question";
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.api).toHaveBeenCalledTimes(2);
    expect(walk(f.root)).toContain(question);
    expect(question.value).toBe("My unsent question");
    f.panel.setActive(false);
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.api).toHaveBeenCalledTimes(2);
    f.panel.setActive(true);
    await settle();
    expect(f.api).toHaveBeenCalledTimes(3);
  });

  it("requires rediscovery when the saved plan belongs to older project settings", async () => {
    const f = fixture({ ...prepared(), stale: true });
    await settle();
    expect(text(f.root)).toContain("Project settings changed");
    expect(f.find("Create test preview")).toBeUndefined();
    expect(f.find("Review preview setup")).toBeUndefined();
    expect(f.find("Find environments again")).toBeDefined();
  });

  it("continues polling while Vercel reports a created deployment that is still building", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const f = fixture(undefined, async () => ({
      ...discovered(),
      status: "deployed",
      deployment: { ...preview, state: ++calls < 3 ? "BUILDING" : "READY" },
      target,
    }));
    await settle();
    expect(text(f.root)).toContain("Building your test deployment");
    expect(f.find("Use this preview")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.api).toHaveBeenCalledTimes(3);
    expect(text(f.root)).toContain("Your preview is ready");
    expect(f.find("Use this preview")).toBeDefined();
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.api).toHaveBeenCalledTimes(3);
  });

  it("loads the new server revision after a failed mutation before retrying", async () => {
    let failed = false;
    const f = fixture(undefined, async (path) => {
      if (path.endsWith("/prepare") && !failed) {
        failed = true;
        throw new Error("The requested branch could not be read.");
      }
      return { ...discovered(), revision: failed ? "r2" : "r1" };
    });
    await settle();
    await f.find("Review preview setup").fire("click");
    expect(text(f.root)).toContain("The requested branch could not be read.");
    await f.find("Review preview setup").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/onboarding/vercel/prepare",
      { revision: "r2", branch: "pm-staging", baseBranch: "main" },
    );
  });
});
