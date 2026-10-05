import type { CrewPlan } from "./plan.ts";
export const samplePlan = (): CrewPlan => ({
  name: "Studio Bookings",
  summary:
    "Help students book pottery classes and let the owner manage capacity.",
  users: ["Students", "Studio owner"],
  firstMilestone:
    "A student can reserve a seat in a class without exceeding capacity.",
  nonGoals: ["Online payments", "Multiple studio locations"],
  assumptions: ["The first version serves one studio."],
  crew: [
    {
      key: "foundation",
      name: "Studio Foundation",
      mission: "Own the shared app and first booking journey.",
      why: "The crew needs one working app and data model.",
      firstTask:
        "Implement the initial Node.js app, package.json, npm start, and meaningful npm test checks for the first booking journey.",
      acceptanceCriteria: [
        "A student can view a class and reserve a seat.",
        "A full class rejects additional reservations.",
      ],
      dependsOn: [],
    },
    {
      key: "schedule",
      name: "Class Schedule",
      mission: "Help the owner manage class times and capacity.",
      why: "Owners need to maintain the class schedule.",
      firstTask:
        "Add owner controls for class times and capacity after the booking foundation works.",
      acceptanceCriteria: [
        "The owner can add a class.",
        "Capacity cannot be reduced below existing reservations.",
      ],
      dependsOn: ["foundation"],
    },
  ],
});
