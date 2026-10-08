export class RedactionBudgetError extends Error {}
export function createAccessRedaction(
  initial?: Array<string | undefined>,
  limits?: {
    maxBytes?: number;
    maxValues?: number;
    maxNodes?: number;
    maxDepth?: number;
  },
): {
  collect(value: unknown): void;
  redact(value: unknown): string;
  screenshotPlan(): { maskAll: boolean; values: string[] };
};
