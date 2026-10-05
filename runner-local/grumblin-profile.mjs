const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const textFields = {
  name: 100,
  role: 200,
  personality: 1200,
  goal: 1000,
  context: 1600,
  relevanceRationale: 1200,
};
const keys = [
  "id",
  "key",
  ...Object.keys(textFields),
  "patience",
  "clickBudget",
  "familiarity",
  "device",
  "successCriteria",
  "assumptions",
  "suggestedArea",
  "project",
  "projectInstanceId",
  "revision",
  "contextRevision",
  "generatedAt",
  "simulation",
];
const text = (value, max) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const name = (value) =>
  typeof value === "string" && value.length <= 63 && slug.test(value);
const localName = (value) =>
  typeof value === "string" &&
  /^[a-z][a-z0-9-]{0,62}$/.test(value) &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value);
const list = (value) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 6 &&
  value.every((item) => text(item, 400)) &&
  new Set(value).size === value.length;

/** One strict schema shared by the controller and the standalone trusted worker. */
export function validateGrumblinProfileSnapshot(value) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !name(value.key) ||
    !localName(value.project) ||
    (value.projectInstanceId !== undefined &&
      (typeof value.projectInstanceId !== "string" ||
        !uuid.test(value.projectInstanceId))) ||
    Object.entries(textFields).some(([key, max]) => !text(value[key], max)) ||
    !["low", "medium", "high"].includes(value.patience) ||
    !Number.isInteger(value.clickBudget) ||
    value.clickBudget < 1 ||
    value.clickBudget > 30 ||
    !["first-time", "occasional", "experienced"].includes(value.familiarity) ||
    !["desktop", "mobile"].includes(value.device) ||
    !list(value.successCriteria) ||
    !list(value.assumptions) ||
    (value.suggestedArea !== null && !localName(value.suggestedArea)) ||
    [value.revision, value.contextRevision].some(
      (item) => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item),
    ) ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    new Date(value.generatedAt).toISOString() !== value.generatedAt ||
    value.simulation !== true
  )
    throw new Error(
      "Choose a valid, generated Grumblin profile. Its saved snapshot is required.",
    );
  return Object.freeze({
    ...value,
    successCriteria: Object.freeze([...value.successCriteria]),
    assumptions: Object.freeze([...value.assumptions]),
  });
}
