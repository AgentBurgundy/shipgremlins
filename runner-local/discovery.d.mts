export const DISCOVERY_FILES: string[];
export function discoveryArguments(): string[];
export function discoveryResult(output: string): {
  summary: string;
  documents: Record<string, string>;
};
export function sanitizeKnowledge(
  directory: string,
  redact: (content: string) => string,
): void;
