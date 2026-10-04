export const MAX_JOB_MS: number;
export function jobEnvironments(
  credentials: Record<string, string>,
  provider: string,
  inherited?: Record<string, string | undefined>,
): {
  execution: Record<string, string | undefined>;
  publication: Record<string, string | undefined>;
};
export function enforceDeadline(
  stop: () => void,
  exit?: (code: number) => void,
): () => void;
export function restoreGitConfig(directory: string, repoUrl: string): void;
