import type { Project } from "../config.ts";
import { hasAiCredentials, resolveAiSelection } from "../ai/provider.ts";
import { projectAiTarget } from "../ai/routing.ts";
import {
  inspectPmReadiness,
  type ReadinessBlocker,
  type ReadinessContext,
} from "../setup/pmReadiness.ts";
import {
  codingAgentOwnsArea,
  effectiveCodingAi,
  type CodingAgent,
} from "./index.ts";

/** Coding readiness follows a coder's queues and model, independently of PM automation. */
export function inspectCodingReadiness(
  root: string,
  project: Project,
  agent: CodingAgent,
  context: ReadinessContext,
  reviewedQueues = false,
) {
  const blockers: ReadinessBlocker[] = [];
  const add = (blocker: ReadinessBlocker) => {
    if (
      !blockers.some(
        (item) => item.id === blocker.id && item.message === blocker.message,
      )
    )
      blockers.push(blocker);
  };
  if (!agent.areas.length)
    add({
      id: "coding_queues",
      action: "config",
      message: "Assign at least one PM ticket queue to this coding agent.",
    });
  const readiness = inspectPmReadiness(project, context);
  for (const area of agent.areas) {
    const queue = readiness.areas.find((item) => item.key === area);
    if (
      !queue ||
      (!reviewedQueues && !codingAgentOwnsArea(root, project, agent, area))
    ) {
      add({
        id: "coding_queues",
        action: "config",
        message:
          "A PM queue changed or was removed. Review and save this coder's assigned queues.",
      });
      continue;
    }
    for (const blocker of queue.coding.enableBlockers)
      if (blocker.id !== "ai_connection") add(blocker);
  }
  const ai = reviewedQueues
    ? (agent.ai ??
      resolveAiSelection(root, context.env, projectAiTarget(project, "coder")))
    : effectiveCodingAi(root, project, agent, context.env);
  const configured = hasAiCredentials(root, context.env, ai);
  if (!configured)
    add({
      id: "ai_connection",
      action: "ai",
      message: `Connect ${ai.provider === "codex" ? "Codex" : "Claude Code"} for this coding agent, or choose a connected provider.`,
    });
  return {
    canEnable: blockers.length === 0,
    blockers,
    effectiveAi: { ...ai, configured },
  };
}
