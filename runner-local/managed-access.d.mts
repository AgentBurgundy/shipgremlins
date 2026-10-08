export interface ManagedAccess {
  version: 1;
  endpoint: string;
  token: string;
  receipt?: Record<string, unknown>;
}
export function validateManagedAccess(input: unknown): ManagedAccess;
export function managedAccessRequest(
  access: ManagedAccess,
  path?: string,
): Promise<{
  ok: boolean;
  receipt?: Record<string, unknown>;
  checks?: { name: string; passed: boolean }[];
  screenshot?: string;
}>;
