import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
const render = app.slice(
  app.indexOf("  function renderLinearSetup() {"),
  app.indexOf("  async function refreshLinearResources() {"),
);
class Select {
  value = "";
  options: { value: string; label: string }[] = [];
  disabled = false;
  hidden = false;
  required = false;
  textContent = "";
  replaceChildren(...options: Select["options"]) {
    this.options = options;
    this.value = options[0]?.value || "";
  }
  append(option: Select["options"][number]) {
    this.options.push(option);
  }
}
function fixture() {
  const elements = new Map<string, Select>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Select());
    return elements.get(id)!;
  };
  const projects = ["first", "second"].map((name) => ({
    name,
    linear: { teamId: "same-team", connectionId: "default" },
  }));
  $("pm-project").value = "first";
  const state = {
    $,
    linearConnected: () => true,
    formsLocked: false,
    linearResourcesLoading: false,
    linearModeEdited: false,
    linearResources: { teams: [] },
    pmCreating: false,
    pmPlanning: false,
    pmDraft: null,
    pmLinearContext: "",
    currentStatus: { projects },
    linearResourceCache: new Map([
      [
        "default",
        {
          projects: [
            {
              name: "Shared existing project",
              id: "existing-id",
              teamIds: ["same-team"],
            },
          ],
        },
      ],
    ]),
    Option: class {
      constructor(
        public label: string,
        public value: string,
      ) {}
    },
  };
  const paint = runInNewContext(
    render + "\nrenderLinearSetup",
    state,
  ) as () => void;
  return { $, paint, state };
}
describe("new PM Linear project selection", () => {
  it("defaults to explicit creation and retains a deliberate reuse choice during same-app refresh", () => {
    const f = fixture();
    f.paint();
    expect(f.$("pm-linear-project").value).toBe("");
    expect(f.$("pm-linear-project").options[0]!.label).toContain(
      "Create a new",
    );
    expect(f.$("pm-linear-project").options[1]!.label).toBe(
      "Use existing: Shared existing project",
    );
    f.$("pm-linear-project").value = "existing-id";
    f.paint();
    expect(f.$("pm-linear-project").value).toBe("existing-id");
  });
  it("does not silently carry an existing Linear project to another app sharing its team", () => {
    const f = fixture();
    f.paint();
    f.$("pm-linear-project").value = "existing-id";
    f.$("pm-project").value = "second";
    f.paint();
    expect(f.$("pm-linear-project").value).toBe("");
    f.$("pm-project").value = "first";
    f.paint();
    expect(f.$("pm-linear-project").value).toBe("");
  });
  it("also resets reuse when the same app changes Linear accounts", () => {
    const f = fixture();
    f.paint();
    f.$("pm-linear-project").value = "existing-id";
    f.state.linearResourceCache.set(
      "another",
      f.state.linearResourceCache.get("default")!,
    );
    f.state.currentStatus.projects[0]!.linear.connectionId = "another";
    f.paint();
    expect(f.$("pm-linear-project").value).toBe("");
  });
});
