export function validateSyncRepairPayload(input: {
  syncRepair?: unknown;
  [key: string]: unknown;
}): void;
export function prepareSyncRepairCheckout(input: {
  integrationSha: string;
  stagingSha: string;
  run: (command: string, args: string[]) => Promise<string>;
}): Promise<void>;
export function verifySyncRepairAncestry(input: {
  integrationSha: string;
  stagingSha: string;
  run: (command: string, args: string[]) => Promise<string>;
}): Promise<void>;
