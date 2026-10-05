import type { ProjectConfig } from "./config.ts";
import type { LocalJobInput } from "./localRunners/types.ts";

/** Keep legacy paths stable; a replacement project receives an independent namespace. */
export function projectRuntimeKey(
  project: Pick<ProjectConfig, "name" | "instanceId">,
): string {
  return project.instanceId
    ? `${project.name}~${project.instanceId}`
    : project.name;
}

export function jobBelongsToProject(
  project: Pick<ProjectConfig, "name" | "instanceId">,
  job: LocalJobInput,
): boolean {
  return (
    job.project === project.name && job.projectInstanceId === project.instanceId
  );
}
