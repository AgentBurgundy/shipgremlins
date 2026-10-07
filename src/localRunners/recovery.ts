export type FailureCategory =
  | "infrastructure"
  | "configuration"
  | "credential-wait"
  | "environment-wait"
  | "worker-exit"
  | "completion"
  | "ambiguous-launch"
  | "runtime-limit";
export interface JobFailure {
  category: FailureCategory;
  at: string;
  retryable: boolean;
}
export const MAX_INFRASTRUCTURE_RETRIES = 2;
/** Only failures before confirmed execution qualify. Never retry agent/publication work. */
export function infrastructureRetry(
  retries: number,
  launched: boolean,
  now: Date,
): { retries: number; nextAttemptAt: string } | null {
  if (launched || retries >= MAX_INFRASTRUCTURE_RETRIES) return null;
  return {
    retries: retries + 1,
    nextAttemptAt: new Date(
      now.getTime() + (retries === 0 ? 15_000 : 60_000),
    ).toISOString(),
  };
}
export function validFailure(value: unknown): value is JobFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      ["category", "at", "retryable"].includes(key),
    ) &&
    [
      "infrastructure",
      "configuration",
      "credential-wait",
      "environment-wait",
      "worker-exit",
      "completion",
      "ambiguous-launch",
      "runtime-limit",
    ].includes(String(item.category)) &&
    typeof item.retryable === "boolean" &&
    typeof item.at === "string" &&
    Number.isFinite(Date.parse(item.at))
  );
}
