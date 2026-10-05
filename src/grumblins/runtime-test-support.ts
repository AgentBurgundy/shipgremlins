import type { GrumblinProfileSnapshot } from "./schema.ts";

export function grumblinFixture(
  overrides: Partial<GrumblinProfileSnapshot> = {},
): GrumblinProfileSnapshot {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    key: "busy-planner",
    name: "Sam",
    role: "Team planner",
    personality: "Direct, impatient with repeated setup.",
    goal: "Create a first useful plan.",
    context: "Has five minutes and no knowledge of the app's internal model.",
    patience: "low",
    clickBudget: 8,
    familiarity: "first-time",
    device: "mobile",
    successCriteria: ["A saved plan is visible."],
    relevanceRationale: "The owner's goal is approachable planning.",
    assumptions: ["The planner is evaluating the app without onboarding help."],
    suggestedArea: "core",
    project: "app",
    revision: "a".repeat(64),
    contextRevision: "b".repeat(64),
    generatedAt: "2026-10-05T12:00:00.000Z",
    simulation: true,
    ...overrides,
  };
}
