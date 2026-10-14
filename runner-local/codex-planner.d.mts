import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { AiSelection, prepareCodexInvocation } from "./codex.mjs";
import type { UsageArtifact } from "./usage.mjs";

export interface CodexPlannerInput {
  ai?: AiSelection;
  credential: string;
  prompt: string;
  system: string;
  schema: Record<string, unknown>;
}
export function executeCodexPlanner(
  input: CodexPlannerInput,
  dependencies?: {
    prepare?: typeof prepareCodexInvocation;
    spawn?: (
      command: string,
      args: string[],
      options: SpawnOptionsWithoutStdio,
    ) => ChildProcessWithoutNullStreams;
    timeoutMs?: number;
  },
): Promise<{
  plannerEnvelope?: 1;
  plannerOutput?: unknown;
  plannerError?: string;
  plannerUsage?: UsageArtifact | null;
}>;
export function runCodexPlanner(): void;
