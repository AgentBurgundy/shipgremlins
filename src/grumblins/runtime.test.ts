import { describe, expect, it } from "vitest";
import { validateGrumblinProfileSnapshot } from "../../runner-local/grumblin-profile.mjs";
import { validateGrumblinPayload } from "../../runner-local/grumblin-runtime.mjs";
import {
  validatePayload,
  type DockerJobPayload,
} from "../localRunners/docker.ts";
import { grumblinFixture } from "./runtime-test-support.ts";

const payload = (): DockerJobPayload => ({
  kind: "pm",
  pmMode: "grumblin",
  project: "app",
  browserVerification: true,
  grumblin: grumblinFixture(),
  grumblinTarget: { url: "https://app-test.invalid", role: "preview" },
  repoUrl: "https://github.com/example/app.git",
  branch: "main",
  provider: "github",
  prompt: "Simulated walkthrough",
  credentials: {
    GITHUB_TOKEN: "read-source",
    CLAUDE_CODE_OAUTH_TOKEN: "model",
    GREMLINS_TEST_USERNAME_1: "synthetic",
    GREMLINS_TEST_PASSWORD_1: "synthetic",
  },
});

describe("Grumblin runtime admission", () => {
  it("takes an independent deeply frozen profile snapshot", () => {
    const input = grumblinFixture();
    const saved = validateGrumblinProfileSnapshot(input);
    input.name = "Later rename";
    input.successCriteria.push("Later criterion");
    expect(saved.name).toBe("Sam");
    expect(saved.successCriteria).toEqual(["A saved plan is visible."]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.successCriteria)).toBe(true);
    expect(Object.isFrozen(saved.assumptions)).toBe(true);
  });
  it("supports existing portable project and PM names while keeping generated profile keys strict", () => {
    expect(
      validateGrumblinProfileSnapshot(
        grumblinFixture({ project: "my--app-", suggestedArea: "core--" }),
      ).project,
    ).toBe("my--app-");
    expect(() =>
      validateGrumblinProfileSnapshot(grumblinFixture({ project: "con" })),
    ).toThrow();
    expect(() =>
      validateGrumblinProfileSnapshot(grumblinFixture({ key: "my--persona" })),
    ).toThrow();
  });
  it.each([
    undefined,
    {},
    { ...grumblinFixture(), id: "fallback" },
    { ...grumblinFixture(), simulation: false },
    { ...grumblinFixture(), clickBudget: 0 },
    { ...grumblinFixture(), clickBudget: 31 },
    { ...grumblinFixture(), commands: "remote writes" },
    { ...grumblinFixture(), goal: "\u0000" },
    { ...grumblinFixture(), goal: "x".repeat(1001) },
    { ...grumblinFixture(), assumptions: [] },
    { ...grumblinFixture(), successCriteria: ["one", "one"] },
    { ...grumblinFixture(), generatedAt: "yesterday" },
    { ...grumblinFixture(), revision: "draft" },
    { ...grumblinFixture(), suggestedArea: "../other" },
  ])(
    "rejects forged or incomplete profiles instead of selecting defaults (%#)",
    (input) => {
      expect(() => validateGrumblinProfileSnapshot(input)).toThrow(
        "valid, generated",
      );
    },
  );
  it("uses the same exact mode/profile/target contract in controller and standalone worker", () => {
    const input = payload();
    expect(JSON.parse(validatePayload(input))).toEqual(input);
    expect(validateGrumblinPayload(input)).toEqual(input.grumblin);
  });
  it.each([
    { pmMode: undefined },
    { pmMode: "exploration" },
    { kind: "developer" },
    { grumblin: undefined },
    { browserVerification: false },
    { project: "other" },
    { grumblinTarget: undefined },
    {
      grumblinTarget: { url: "https://production.invalid", role: "production" },
    },
    {
      grumblinTarget: {
        url: "https://user:password@test.invalid",
        role: "preview",
      },
    },
    { credentials: { LINEAR_API_KEY: "forbidden" } },
    { credentials: { VERCEL_TOKEN: "forbidden" } },
    { credentials: { GREMLINS_PREVIEW_DATABASE_URL: "forbidden" } },
    { delivery: {} },
    { reviewPlan: {} },
  ])(
    "rejects mode confusion and write-capable provider contexts at both boundaries (%#)",
    (change) => {
      const input = { ...payload(), ...change } as DockerJobPayload;
      expect(() => validateGrumblinPayload(input)).toThrow();
      expect(() => validatePayload(input)).toThrow();
    },
  );
});
