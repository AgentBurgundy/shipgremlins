export type AiSelection = { provider: "claude" | "codex"; model?: string };
export function validateAiSelection(value: unknown): AiSelection;
export function codexSecretValues(raw: string): string[];
export function codexWorkerAuth(raw: string, now?: () => Date): string;
export function prepareCodexInvocation(options: {
  selection?: AiSelection;
  authJson: string;
  cwd: string;
  directory?: string;
  mcpServers?: Record<string, { command: string; args: string[] }>;
  restricted?: boolean;
  readonlyRoots?: { repository: string; memory: string };
  schema?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  outputPath: string;
  readResult(): string;
  cleanup(): void;
};
