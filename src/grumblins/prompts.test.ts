import { describe, expect, it } from "vitest";
import { makeProject } from "../services/fakes.ts";
import { buildGrumblinPrompt } from "./prompts.ts";
import { grumblinFixture } from "./runtime-test-support.ts";

describe("Grumblin walkthrough prompt", () => {
  const project = makeProject({ config: { name: "app" } });
  const input = {
    project,
    area: project.areas[0]!,
    checkoutBranch: "main",
    grumblin: grumblinFixture(),
    target: { url: "https://test.invalid", role: "preview" as const },
    memory: {
      "mandate.md": "Keep setup approachable.",
      "discovered-memory.md": "Prior observation, not permission.",
    },
  };
  it("preserves persona first-use behavior before source-informed synthesis", () => {
    const prompt = buildGrumblinPrompt(input);
    expect(prompt).toContain(
      "Keep source inspection and prior PM findings out of the user's first attempt",
    );
    expect(prompt.indexOf("WALK THROUGH THE GOAL NOW")).toBeLessThan(
      prompt.indexOf("PM SYNTHESIS — only after"),
    );
    for (const text of [
      "8-click/tap budget",
      "actual actions",
      "wrong turns",
      "simulated",
      "what works well",
      "no finding quota",
      "competing persona",
      "smallest testable experiment",
      "No Linear reads or writes",
      "unfiled candidates",
      "only the owner can approve",
      "no baseline",
      "neutral filenames",
      "only when the file exists",
      "discovery.md",
      "features.md",
      "queue.md",
      "memory.md",
      "Keep setup approachable.",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain("Search existing Linear issues first");
    expect(prompt).not.toContain("Create any missing labels");
  });
  it("rejects a profile from another app instead of substituting a generic persona", () => {
    expect(() =>
      buildGrumblinPrompt({
        ...input,
        grumblin: grumblinFixture({ project: "other" }),
      }),
    ).toThrow("different project");
  });
});
