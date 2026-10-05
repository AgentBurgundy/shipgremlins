/** Optional execution limits. Omitted daily limits preserve existing installations. */
export interface ExecutionLimits {
  maxConcurrentJobs?: number;
  maxDailyRuns?: number;
  maxDailyRuntimeMinutes?: number;
  maxJobMinutes?: number;
}
export function parseExecutionLimits(
  input: unknown,
): ExecutionLimits | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("execution must be an object of run limits.");
  const limits: Record<keyof ExecutionLimits, number> = {
    maxConcurrentJobs: 4,
    maxDailyRuns: 1000,
    maxDailyRuntimeMinutes: 10080,
    maxJobMinutes: 45,
  };
  const result: ExecutionLimits = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(limits, key))
      throw new Error("execution contains an unsupported limit.");
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > limits[key as keyof ExecutionLimits]
    )
      throw new Error(
        `execution.${key} must be an integer between 1 and ${limits[key as keyof ExecutionLimits]}.`,
      );
    result[key as keyof ExecutionLimits] = value;
  }
  return result;
}
