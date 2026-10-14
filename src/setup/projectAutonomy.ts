import { CronExpressionParser } from "cron-parser";
import { codingPickupEnabled, loadProject } from "../config.ts";
import { jobBelongsToProject } from "../projectIdentity.ts";
import { createPmKnowledge, knowledgeRevision } from "../pmKnowledge/index.ts";
import { foundationNeeded } from "../ideaCrew/foundation.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { CodingPickupView } from "../localRunners/codingPickup.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
import { createScheduleCursor } from "../localRunners/scheduleCursor.ts";
import {
  inspectPmReadiness,
  PmControlError,
  type ReadinessBlocker,
  type ReadinessContext,
} from "./pmReadiness.ts";

/** Describe the work the controller can actually start, including initial discovery. */
export function projectAutonomy(
  root: string,
  name: string,
  jobs: LocalJob[],
  context: ReadinessContext,
  now = new Date(),
  codingPickup?: CodingPickupView,
) {
  const project = loadProject(root, name);
  const readiness = inspectPmReadiness(project, context);
  const investigationEnabled = project.areas.some((area) => area.enabled);
  const codingEnabled = project.areas.some(codingPickupEnabled);
  const enabled = investigationEnabled || codingEnabled;
  const own = jobs.filter((job) => jobBelongsToProject(project.config, job));
  const active = own.filter((job) =>
    ["queued", "running"].includes(job.status),
  );
  const knowledge = createPmKnowledge({ root });
  const pendingDiscovery = project.areas.filter((area) => {
    if (!area.enabled) return false;
    const snapshot = knowledge.read(name, area.key, own);
    return snapshot.state === "empty" || snapshot.stale;
  });
  const foundation = foundationNeeded(root, project);
  const enabledAreas = readiness.areas.filter(
    (area) => area.enabled || area.codingEnabled,
  );
  const blockers: ReadinessBlocker[] = [];
  const add = (blocker: ReadinessBlocker) => {
    if (!blockers.some((item) => item.id === blocker.id))
      blockers.push(blocker);
  };
  if (enabled && foundation)
    add({
      id: "foundation",
      action: "config",
      message:
        "Build and merge the app's foundation before automatic discovery.",
    });
  if (enabled && !foundation) {
    // Repository discovery needs neither Linear nor a hosted environment.
    const discoveryIds = new Set([
      "configuration",
      "source_connection",
      "ai_connection",
      "worker",
      "mandate",
    ]);
    for (const area of enabledAreas) {
      const discovering = pendingDiscovery.some(
        (item) => item.key === area.key,
      );
      for (const blocker of area.blockers)
        if (!discovering || discoveryIds.has(blocker.id)) add(blocker);
    }
  }
  const canDiscover =
    !foundation &&
    pendingDiscovery.some((area) =>
      readiness.areas
        .find((item) => item.key === area.key)!
        .blockers.every(
          (item) =>
            ![
              "configuration",
              "source_connection",
              "ai_connection",
              "worker",
              "mandate",
            ].includes(item.id),
        ),
    );
  const canPatrol =
    !foundation &&
    enabledAreas.some(
      (area) =>
        area.enabled &&
        area.canRun &&
        !area.enableBlockers.some((blocker) => blocker.id === "schedule"),
    );
  const canCode = enabledAreas.some(
    (area) => area.codingEnabled && area.blockers.length === 0,
  );
  let nextRunAt: string | null = null;
  if (enabled && canDiscover) nextRunAt = now.toISOString();
  else if (enabled && canPatrol) {
    for (const area of project.areas.filter((item) => item.enabled)) {
      try {
        const next = CronExpressionParser.parse(area.schedule, {
          currentDate: now,
          tz: "UTC",
        })
          .next()
          .toISOString();
        if (next && (!nextRunAt || next < nextRunAt)) nextRunAt = next;
      } catch {
        /* An invalid schedule is reported below, without hiding other PMs. */
      }
    }
  }
  if (
    enabled &&
    !canDiscover &&
    !canPatrol &&
    !canCode &&
    blockers.length === 0
  )
    add({
      id: "schedule",
      action: "config",
      message:
        "Set a valid UTC patrol schedule or enable approved-ticket coding.",
    });
  for (const area of enabledAreas.filter((item) => item.enabled))
    for (const blocker of area.enableBlockers.filter(
      (item) => item.id === "schedule",
    ))
      add(blocker);
  const state = !enabled
    ? "paused"
    : active.some((job) => job.status === "running")
      ? "running"
      : active.length
        ? "queued"
        : canDiscover || canPatrol || canCode
          ? "waiting"
          : "blocked";
  const message =
    state === "paused"
      ? "Automatic work is paused. Start it once and the controller will resume when connections are ready."
      : state === "running"
        ? "Your crew is working. The controller continues when you close the browser."
        : state === "queued"
          ? "Work is queued for an eligible worker."
          : state === "waiting" &&
              codingEnabled &&
              codingPickup?.state === "current" &&
              codingPickup.needsReview.length
            ? `${codingPickup.needsReview
                .map((ticket) => ticket.identifier)
                .slice(0, 3)
                .join(
                  ", ",
                )} ${codingPickup.needsReview.length === 1 ? "is approved but needs" : "are approved but need"} review of a previous coding attempt. Other eligible work can continue.`
            : canDiscover
              ? "Your crew will explore the repository automatically. Linear and staging can be connected afterward."
              : state === "blocked"
                ? (blockers[0]?.message ??
                  "Complete project setup to continue automatic work.")
                : "Your crew is watching for approved tickets and its next scheduled patrol.";
  return {
    state,
    enabled,
    investigationEnabled,
    codingEnabled,
    codingPickup,
    message,
    nextRunAt,
    blockers,
    revision: readEditableConfig(root, `projects/${name}/areas.json`).revision,
    projectRevision: readEditableConfig(root, `projects/${name}/project.json`)
      .revision,
    discoveryPending: pendingDiscovery.map((area) => ({
      key: area.key,
      revision: knowledgeRevision(project, area),
    })),
  };
}

/** Save intent even while credentials are missing; normal admission still checks them. */
export function setProjectAutonomy(
  root: string,
  name: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (key) => !["enabled", "revision", "projectRevision"].includes(key),
    ) ||
    typeof input.enabled !== "boolean" ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    typeof input.projectRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.projectRevision)
  )
    throw new PmControlError(
      "Provide enabled and the current project and crew revisions.",
    );
  const project = loadProject(root, name);
  if (project.areas.length === 0)
    throw new PmControlError("Adopt a PM before starting automatic work.", 409);
  const document = readEditableConfig(root, `projects/${name}/areas.json`);
  if (
    document.revision !== input.revision ||
    readEditableConfig(root, `projects/${name}/project.json`).revision !==
      input.projectRevision
  )
    throw new PmControlError(
      "Project or crew settings changed. Refresh before changing automatic work.",
      409,
    );
  const value = JSON.parse(document.content);
  for (const area of Object.values(value.areas) as Array<
    Record<string, unknown>
  >) {
    area.enabled = input.enabled;
    area.codingEnabled = input.enabled;
  }
  const changed = project.areas.some(
    (area) =>
      area.enabled !== input.enabled ||
      codingPickupEnabled(area) !== input.enabled,
  );
  if (changed)
    saveEditableConfig(root, {
      path: document.path,
      revision: document.revision,
      content: JSON.stringify(value, null, 2) + "\n",
    });
  if (changed) {
    const saved = loadProject(root, name),
      cursor = createScheduleCursor(root);
    for (const area of project.areas.filter(
      (area) => area.enabled !== input.enabled,
    ))
      cursor.reset(saved, new Date(), area.key);
  }
  return { ok: true };
}
