import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
}
export function readAiModelCatalog(
  input: { provider: "claude" | "codex"; auth?: string },
  dependencies?: {
    directory?: string;
    timeoutMs?: number;
    spawn?: (
      command: string,
      args: string[],
      options: SpawnOptionsWithoutStdio,
    ) => ChildProcessWithoutNullStreams;
  },
): Promise<{ models: CatalogModel[] }>;
export function runAiModels(): Promise<void>;
