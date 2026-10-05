/** Owner-authored product direction. Learned PM notes never change these fields. */
export interface PmCharter {
  ambition?: string;
  goal?: string;
  metricDefinition?: string;
  users?: string[];
  expectedToBuild?: string[];
  nonGoals?: string[];
  guardrails?: string[];
  standingPriorities?: string[];
}

export const CHARTER_TEXT_FIELDS = [
  "ambition",
  "goal",
  "metricDefinition",
] as const;
export const CHARTER_LIST_FIELDS = [
  "users",
  "expectedToBuild",
  "nonGoals",
  "guardrails",
  "standingPriorities",
] as const;

export function printableBrief(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return (point < 32 && ![9, 10, 13].includes(point)) || point === 127;
    })
  );
}

/** Validate before persisting or exposing any AI-suggested charter. */
export function parsePmCharter(value: unknown): PmCharter {
  const fail = () =>
    new Error(
      "Use supported product-brief fields: text up to 4000 characters, lists up to 20 entries of 1000 characters, and 24000 bytes in total.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const input = value as Record<string, unknown>;
  const allowed = new Set<string>([
    ...CHARTER_TEXT_FIELDS,
    ...CHARTER_LIST_FIELDS,
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw fail();
  if (Buffer.byteLength(JSON.stringify(input)) > 24000) throw fail();
  const result: PmCharter = {};
  for (const field of CHARTER_TEXT_FIELDS) {
    if (input[field] === undefined) continue;
    if (!printableBrief(input[field], 4000)) throw fail();
    const text = input[field].trim();
    if (text) result[field] = text;
  }
  for (const field of CHARTER_LIST_FIELDS) {
    const entries = input[field];
    if (entries === undefined) continue;
    if (
      !Array.isArray(entries) ||
      entries.length > 20 ||
      !entries.every((item) => printableBrief(item, 1000))
    )
      throw fail();
    const cleaned = entries.map((item) => item.trim()).filter(Boolean);
    if (cleaned.length) result[field] = [...new Set(cleaned)];
  }
  return result;
}
