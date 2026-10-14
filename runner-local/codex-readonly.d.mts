export const READONLY_TOOLS: { name: string; [key: string]: unknown }[];
export function createReadonlyTools(roots: {
  repository: string;
  memory: string;
}): (name: string, input: unknown) => string;
