export interface PromotionRepair {
  stagingSha: string;
  sourceShas: string[];
  allowedPaths: string[];
}
export function promotionPortRef(nonce: string): string;
export function validatePromotionRepairPayload(input: {
  promotionRepair?: unknown;
  [key: string]: unknown;
}): void;
export function preparePromotionRepairCheckout(input: {
  integrationSha: string;
  repair: PromotionRepair;
  run: (command: string, args: string[]) => Promise<string>;
}): Promise<void>;
export function verifyPromotionRepairSource(input: {
  integrationSha: string;
  repair: PromotionRepair;
  nonce: string;
  commitIdentity: { name: string; email: string };
  run: (command: string, args: string[]) => Promise<string>;
}): Promise<{ promotionSourceSha: string; promotionBaseSha: string }>;
