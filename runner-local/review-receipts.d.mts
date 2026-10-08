import type { PmReviewPlan } from "../src/delivery/types.ts";
export function validateReviewPlan(plan: unknown): PmReviewPlan;
export function runReviewReceipts(input: {
  plan: PmReviewPlan;
  commitSha: string;
  outputDirectory: string;
  chromium: unknown;
  contextFactory?: (viewport: { width: number; height: number }) => Promise<{
    context: unknown;
    page: unknown;
    screenshot: (options: { fullPage: boolean }) => Promise<string>;
  }>;
  bypass?: string;
  sessionDirectory?: string;
  now?: () => Date;
}): Promise<{ reviewProof: { file: string; sha256: string; planId: string } }>;
