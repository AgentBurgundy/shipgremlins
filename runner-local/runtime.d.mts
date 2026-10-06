export const MAX_JOB_MS: number;
export function validateCommitIdentity(
  identity: unknown,
  provider?: string,
): void;
export function jobEnvironments(
  credentials: Record<string, string>,
  provider: string,
  inherited?: Record<string, string | undefined>,
  commitIdentity?: { name: string; email: string },
): {
  execution: Record<string, string | undefined>;
  publication: Record<string, string | undefined>;
};
export function enforceDeadline(
  stop: () => void,
  exit?: (code: number) => void,
  minutes?: number,
  remainingMs?: number,
): () => void;
export function restoreGitConfig(directory: string, repoUrl: string): void;
export function preparePublication(
  directory: string,
  repoUrl: string,
  publication: Record<string, string | undefined>,
): string;
