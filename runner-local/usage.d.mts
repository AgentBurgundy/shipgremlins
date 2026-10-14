export type ClaudeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number;
  complete: boolean;
  model?: string;
};
export type UsageArtifact = ClaudeUsage & {
  schemaVersion: 1;
  source: "claude-code" | "codex";
  reportedAt: string;
};
export const MAX_USAGE_BYTES: number;
export function parseClaudeUsage(record: unknown): ClaudeUsage | undefined;
export function parseCodexUsage(record: unknown): ClaudeUsage | undefined;
export function createUsageCollector(options?: {
  now?: () => Date;
  provider?: "claude" | "codex";
  model?: string;
}): {
  modelRecord(record: unknown): void;
  snapshot(): UsageArtifact | undefined;
};
export function writeUsageArtifact(
  directory: string,
  value: UsageArtifact | undefined,
): void;
