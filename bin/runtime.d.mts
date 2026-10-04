export type RuntimeRelease =
  { sha: string; version: string } | { bootstrap: true; version: string };
export interface ActiveRuntimePointer {
  schema: 1;
  active: RuntimeRelease;
  previous?: RuntimeRelease;
}
export function runtimeLocation(bootstrapRoot: string, home?: string): string;
export function releasePackageRoot(base: string, sha: string): string;
export function readActiveRuntime(
  bootstrapRoot: string,
  home?: string,
): ActiveRuntimePointer | null;
export function validateRuntimePackage(
  packageRoot: string,
  expectedVersion?: string,
): string;
export function resolveRuntime(bootstrapRoot: string, home?: string): string;
