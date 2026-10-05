import { loadProject } from "../config.ts";
import { jobBelongsToProject } from "../projectIdentity.ts";
import { effectiveWorkflow } from "../projectCapabilities.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import {
  inspectPmReadiness,
  type ReadinessContext,
} from "../setup/pmReadiness.ts";
import { parseExecutionLimits } from "../execution.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { ProjectExecutionUsage } from "../localRunners/budgets.ts";
import { createProjectKnowledge } from "./index.ts";
import type { DeliveryRecord } from "../delivery/types.ts";
import { foundationNeeded } from "../ideaCrew/foundation.ts";

export function projectOperations(
  root: string,
  name: string,
  jobs: LocalJob[],
  readiness: ReadinessContext,
  execution: ProjectExecutionUsage[] = [],
  deliveries: DeliveryRecord[] = [],
) {
  const project = loadProject(root, name),
    config = project.config;
  const document = readEditableConfig(root, `projects/${name}/project.json`);
  const knowledge = createProjectKnowledge({ root }).read(name, jobs);
  const workflow = effectiveWorkflow(config);
  const ready = inspectPmReadiness(project, readiness);
  type Item = {
    id: string;
    kind: "setup" | "run" | "delivery" | "knowledge";
    title: string;
    detail: string;
    action: { label: string; href: string } | null;
  };
  const inbox: Item[] = [];
  const seen = new Set<string>();
  const needsFoundation = foundationNeeded(root, project);
  if (needsFoundation)
    inbox.push({
      id: "setup:foundation",
      kind: "setup",
      title: "Build your app's foundation",
      detail:
        "Review the first milestone and start a Coding Gremlin. Environment setup and PM discovery come after the first app is built.",
      action: {
        label: "Build foundation",
        href: `/projects/${name}?tab=environment`,
      },
    });
  for (const area of needsFoundation ? [] : ready.areas)
    for (const blocker of area.blockers) {
      const id = `${blocker.id}:${["mandate", "mapping"].includes(blocker.action) ? area.key : "project"}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const page = ["source", "ai", "linear"].includes(blocker.action)
        ? "/connections"
        : blocker.action === "worker"
          ? "/runners"
          : `/projects/${name}${blocker.action === "mandate" ? `?pm=${area.key}&tab=brief` : ""}`;
      inbox.push({
        id: `setup:${id}`,
        kind: "setup",
        title: `${area.key}: ${blocker.id.replace(/_/g, " ")}`,
        detail: blocker.message,
        action: { label: "Complete setup", href: page },
      });
    }
  for (const area of needsFoundation ? [] : knowledge.areas)
    if (["empty", "stale"].includes(area.state))
      inbox.push({
        id: `knowledge:${area.key}`,
        kind: "knowledge",
        title: `${area.name} needs ${area.state === "stale" ? "fresh" : "first"} discovery`,
        detail: area.summary,
        action: {
          label: "Review discovery",
          href: `/projects/${name}?pm=${area.key}&tab=discovery`,
        },
      });
  const own = jobs.filter((j) => jobBelongsToProject(config, j));
  for (const job of own
    .filter((j) => j.status === "failed")
    .sort((a, b) => b.runId - a.runId)
    .slice(0, 10)) {
    // A newer successful attempt on the same work resolves the older alert.
    if (
      own.some(
        (j) =>
          j.runId > job.runId &&
          j.type === job.type &&
          j.pmMode === job.pmMode &&
          j.area === job.area &&
          j.ticket === job.ticket &&
          j.status === "succeeded",
      )
    )
      continue;
    inbox.push({
      id: `run:${job.id}`,
      kind: "run",
      title: `${job.type === "developer" ? "Coding" : "PM"} run ${job.runId} needs attention`,
      detail:
        job.message || "Open the run to review its output before retrying.",
      action: { label: "View run", href: `/activity?run=${job.id}` },
    });
  }
  const midnight = new Date();
  for (const item of deliveries.filter((item) => item.status !== "promoted")) {
    inbox.push({
      id: `delivery:${item.id}`,
      kind: "delivery",
      title: `${item.ticket.identifier}: ${item.ticket.title}`,
      detail: item.message,
      action: {
        label:
          item.status === "awaiting-merge" ? "Review draft" : "Review delivery",
        href:
          item.status === "awaiting-merge"
            ? item.implementation.url
            : `/projects/${name}?tab=delivery`,
      },
    });
  }
  midnight.setUTCHours(0, 0, 0, 0);
  const usage = {
    runsToday: own.filter(
      (j) => j.startedAt && Date.parse(j.startedAt) >= +midnight,
    ).length,
    runtimeMinutesToday:
      Math.round(
        own.reduce(
          (sum, j) =>
            j.startedAt
              ? sum +
                Math.max(
                  0,
                  (Date.parse(j.finishedAt ?? new Date().toISOString()) -
                    Math.max(+midnight, Date.parse(j.startedAt))) /
                    60000,
                )
              : sum,
          0,
        ) * 10,
      ) / 10,
    activeJobs: own.filter((j) => j.status === "running").length,
  };
  const measured = execution.find((item) => item.project === name);
  if (measured) {
    usage.runsToday = measured.runsStarted;
    usage.runtimeMinutesToday = Math.round(measured.runtimeMinutes * 10) / 10;
    usage.activeJobs = measured.runningJobs;
  }
  return {
    project: name,
    inbox,
    knowledge,
    delivery: {
      mode: workflow.kind,
      branches:
        workflow.kind === "promotion"
          ? config.branches
          : { base: workflow.baseBranch },
      items: deliveries.map((item) => ({
        ...item,
        title: `${item.ticket.identifier}: ${item.ticket.title}`,
        detail: item.message,
        stage: item.status,
        href: item.promotion?.url ?? item.implementation.url,
      })),
    },
    budgets: {
      revision: document.revision,
      limits: config.execution ?? {},
      usage,
      ...(measured
        ? {
            reservedRuntimeMinutes: measured.reservedRuntimeMinutes,
            blockedReason: measured.blockedReason,
          }
        : {}),
      cost: {
        state: "unavailable",
        reason:
          "Claude subscription access does not report a billable dollar cost. Run counts and runtime are measured.",
      },
    },
  };
}

export function saveExecution(
  root: string,
  name: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some((key) => !["limits", "revision"].includes(key)) ||
    !Object.hasOwn(input, "limits") ||
    typeof input.revision !== "string"
  )
    throw new Error("Use limits and the latest project revision.");
  const limits = parseExecutionLimits(input.limits);
  const document = readEditableConfig(root, `projects/${name}/project.json`);
  const raw = JSON.parse(document.content);
  raw.execution = limits;
  return saveEditableConfig(root, {
    path: document.path,
    revision: input.revision,
    content: JSON.stringify(raw, null, 2) + "\n",
  });
}
