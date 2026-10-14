import {
  codingPickupEnabled,
  listProjectNames,
  loadHub,
  loadProject,
  type Project,
} from "../config.ts";
import { projectRuntimeKey, jobBelongsToProject } from "../projectIdentity.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { foundationNeeded } from "../ideaCrew/foundation.ts";
import {
  hasPmMapping,
  inspectPmReadiness,
  type ReadinessContext,
} from "./pmReadiness.ts";
import {
  createAutomationDiagnostics,
  type AutomationFailureCode,
} from "./automationDiagnostics.ts";

/** Resume ordinary setup from saved intent without repeated Run now clicks. */
export function createAutomaticPreparation(options: {
  root: string;
  context(): Promise<ReadinessContext>;
  jobs(): Promise<LocalJob[]>;
  provision(name: string, area: string): Promise<boolean>;
  verify(project: Project): Promise<void>;
  now?: () => number;
}) {
  const attempted = new Map<string, number>();
  const diagnostics = createAutomationDiagnostics(options.root);
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      if (loadHub(options.root).runners.mode !== "local") return;
      const [context, jobs] = await Promise.all([
        options.context(),
        options.jobs(),
      ]);
      for (const name of listProjectNames(options.root)) {
        let currentProject: Project | undefined;
        let phase: AutomationFailureCode = "setup";
        try {
          let project = loadProject(options.root, name);
          currentProject = project;
          if (project.config.verified)
            diagnostics.resolve(
              project,
              "setup",
              undefined,
              new Date(options.now?.() ?? Date.now()),
            );
          if (
            project.config.verified ||
            foundationNeeded(options.root, project)
          )
            continue;
          const areas = project.areas.filter(
            (area) => area.enabled || codingPickupEnabled(area),
          );
          if (
            !areas.length ||
            jobs.some(
              (job) =>
                jobBelongsToProject(project.config, job) &&
                ["running", "queued"].includes(job.status),
            )
          )
            continue;
          const readiness = inspectPmReadiness(project, context);
          if (
            !readiness.areas.some(
              (area) =>
                areas.some((item) => item.key === area.key) &&
                area.blockers.every((blocker) =>
                  ["linear_mapping", "verification"].includes(blocker.id),
                ),
            )
          )
            continue;
          const key = projectRuntimeKey(project.config);
          const now = options.now?.() ?? Date.now();
          if (!diagnostics.ready(project, "setup", undefined, new Date(now)))
            continue;
          const lastAttempt = attempted.get(key);
          if (lastAttempt !== undefined && now - lastAttempt < 5 * 60_000)
            continue;
          attempted.set(key, now);
          for (const area of areas) {
            phase = "mapping";
            if (
              !hasPmMapping(area) &&
              !(await options.provision(name, area.key))
            ) {
              diagnostics.fail(
                project,
                "setup",
                "mapping",
                undefined,
                new Date(now),
              );
              continue;
            }
          }
          project = loadProject(options.root, name);
          if (projectRuntimeKey(project.config) !== key) continue;
          const current = inspectPmReadiness(project, context);
          if (
            current.areas.some(
              (area) =>
                areas.some((item) => item.key === area.key) &&
                area.blockers.every((blocker) => blocker.id === "verification"),
            )
          ) {
            phase = "verification";
            await options.verify(project);
            const checked = loadProject(options.root, name);
            if (projectRuntimeKey(checked.config) !== key) continue;
            if (checked.config.verified)
              diagnostics.resolve(checked, "setup", undefined, new Date(now));
            else
              diagnostics.fail(
                checked,
                "setup",
                "verification",
                undefined,
                new Date(now),
              );
          }
        } catch {
          if (currentProject)
            diagnostics.fail(
              currentProject,
              "setup",
              phase,
              undefined,
              new Date(options.now?.() ?? Date.now()),
            );
        }
      }
    } catch {
      // Shared readiness failures must remain actionable after restart. A safe
      // controller-owned reason is sufficient; provider error bodies stay private.
      try {
        for (const name of listProjectNames(options.root)) {
          try {
            const project = loadProject(options.root, name);
            if (
              project.areas.some(
                (area) => area.enabled || codingPickupEnabled(area),
              )
            )
              diagnostics.fail(
                project,
                "setup",
                "setup",
                undefined,
                new Date(options.now?.() ?? Date.now()),
              );
          } catch {
            /* Preserve diagnostics for other valid projects. */
          }
        }
      } catch {
        /* Missing project configuration remains visible in setup. */
      }
    } finally {
      busy = false;
    }
  };
}
