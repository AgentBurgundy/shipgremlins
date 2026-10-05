export interface Delivery {
  ticket: string;
  title: string;
  base: string;
  branch: string;
  repo: string;
}
export function validateDelivery(delivery: unknown): void;
export function runCheckedDelivery(input: {
  commands: Partial<
    Record<"install" | "test" | "lint" | "typecheck" | "build", string | null>
  >;
  delivery: Delivery;
  baseSha: string;
  repoUrl: string;
  provider: "github" | "gitlab";
  run: (command: string, args: string[]) => Promise<string>;
  publish: (command: string, args: string[]) => Promise<string>;
  writeBody: (body: string) => void | Promise<void>;
  prepareRepository: () => void | Promise<void>;
  onCheck?: (name: string, status: "running" | "succeeded" | "failed") => void;
}): Promise<{
  checks: string[];
  prUrl?: string;
  noChanges?: boolean;
  headSha?: string;
}>;
