export function suggestedPm(
  key = "account-journey",
  name = "Sprout",
  path = "src/login.tsx",
) {
  return {
    name,
    mandate: `Continuously investigate and improve ${key}; verify approved changes against the real user journey.`,
    evidence: [{ path, quote: "Sign in" }],
    rationale: `The inspected ${path} grounds this proposed responsibility.`,
    draft: {
      name,
      key,
      paths: [path],
      sharedTouchpoints: [] as string[],
      metric: `${key} completion`,
      schedule: "0 13 * * *",
      wipLimit: 2,
      charter: {
        ambition: `Make ${key} understandable and dependable.`,
        goal: `Identify and verify focused improvements in ${key}.`,
        metricDefinition:
          "Record reproducible journey evidence; establish a baseline before claiming improvement.",
        users: ["People using this application; confirm their needs."],
        expectedToBuild: [
          "Specify finite improvements grounded in observed behavior.",
        ],
        nonGoals: ["Unrelated product areas."],
        guardrails: [
          "Use the configured test environment and respect the project's approval policy.",
        ],
        standingPriorities: [
          "Investigate the configured customer journey and QA approved implementations.",
        ],
      },
    },
  };
}
