export interface AutonomousApprovalPolicy {
  enabled: boolean;
  allowedPaths: string[];
  requiredLabel: string;
  maxDailyApprovals: number;
  maxOpenTickets: number;
  maxFiles: number;
  maxChangedLines: number;
}
export const defaultApprovalPolicy: AutonomousApprovalPolicy = {
  enabled: false,
  allowedPaths: [],
  requiredLabel: "pm-auto-safe",
  maxDailyApprovals: 2,
  maxOpenTickets: 1,
  maxFiles: 3,
  maxChangedLines: 100,
};
export function safeRepoPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    /^[A-Za-z0-9_.@/-]+$/.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((p) => p === ".." || p === "." || p === "") &&
    !value.includes("//")
  );
}
export function parseAutonomousApproval(
  value: unknown,
): AutonomousApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Automatic approval policy must be an object.");
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !Object.hasOwn(defaultApprovalPolicy, key),
    ) ||
    typeof raw.enabled !== "boolean" ||
    !Array.isArray(raw.allowedPaths) ||
    raw.allowedPaths.length > 20 ||
    !raw.allowedPaths.every((p) =>
      safeRepoPath(typeof p === "string" ? p.replace(/\/$/, "") : p),
    ) ||
    new Set(raw.allowedPaths).size !== raw.allowedPaths.length ||
    typeof raw.requiredLabel !== "string" ||
    !/^pm-auto-[a-z0-9-]{1,40}$/.test(raw.requiredLabel) ||
    (raw.enabled && raw.allowedPaths.length === 0)
  )
    throw new Error(
      "Select bounded repository paths and a dedicated pm-auto- label for automatic approval.",
    );
  for (const [key, max] of Object.entries({
    maxDailyApprovals: 10,
    maxOpenTickets: 4,
    maxFiles: 10,
    maxChangedLines: 500,
  }))
    if (
      !Number.isSafeInteger(raw[key]) ||
      Number(raw[key]) < 1 ||
      Number(raw[key]) > max
    )
      throw new Error(
        `Automatic approval ${key} must be between 1 and ${max}.`,
      );
  return {
    ...raw,
    allowedPaths: raw.allowedPaths.map((p) => (p as string).replace(/\/$/, "")),
  } as unknown as AutonomousApprovalPolicy;
}
