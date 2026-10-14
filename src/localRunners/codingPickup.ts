import { createHash } from "node:crypto";
import {
  codingPickupEnabled,
  loadProject,
  type AreaConfig,
  type Project,
} from "../config.ts";
import { jobBelongsToProject } from "../projectIdentity.ts";
import type { LinearTicket } from "../services/types.ts";
import type { LocalJob } from "./types.ts";

export interface CodingPickupHold {
  ticketId: string;
  identifier: string;
  area: string;
  jobId: string;
  runId: number;
  status: "failed" | "canceled";
  reason: "previous-failed" | "previous-canceled";
  href: string;
}

export interface CodingPickupView {
  state: "checking" | "current" | "unavailable";
  observedAt?: string;
  needsReview: CodingPickupHold[];
}

const MAX_AGE_MS = 2 * 60_000;
const MAX_PROJECTS = 100;
const MAX_AREAS = 100;
const MAX_TICKETS = 500;
type TicketIdentity = Pick<LinearTicket, "id" | "identifier">;
type AreaObservation = {
  state: "current" | "unavailable";
  at: number;
  connectionId?: string;
  workspaceId?: string;
  tickets: TicketIdentity[];
};
type Observation = {
  name: string;
  fingerprint: string;
  areas: Map<string, AreaObservation>;
};

const fingerprint = (project: Project) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        config: project.config,
        areas: project.areas,
        tiers: project.tiers,
      }),
    )
    .digest("hex");

/** Observations explain existing holds; they never authorize a launch or retry. */
export function createCodingPickup(
  root: string,
  options: { now?: () => Date } = {},
) {
  const snapshots = new Map<string, Observation>();
  const now = () => (options.now?.() ?? new Date()).getTime();
  const current = (observation: Observation) =>
    snapshots.get(observation.name) === observation;

  function begin(project: Project) {
    const observation: Observation = {
      name: project.config.name,
      fingerprint: fingerprint(project),
      areas: new Map(),
    };
    snapshots.delete(observation.name);
    snapshots.set(observation.name, observation);
    while (snapshots.size > MAX_PROJECTS)
      snapshots.delete(snapshots.keys().next().value!);
    return observation;
  }

  function unavailable(observation: Observation, area?: AreaConfig) {
    if (!current(observation)) return;
    if (
      area &&
      (observation.areas.has(area.key) || observation.areas.size < MAX_AREAS)
    )
      observation.areas.set(area.key, {
        state: "unavailable",
        at: now(),
        tickets: [],
      });
    else {
      // One project-wide failure must also cover queues that were not reached.
      observation.areas.set("", {
        state: "unavailable",
        at: now(),
        tickets: [],
      });
    }
  }

  function observe(
    observation: Observation,
    area: AreaConfig,
    tickets: LinearTicket[],
    scope: { connectionId: string; workspaceId?: string },
  ) {
    if (!current(observation)) return;
    if (
      !observation.areas.has(area.key) &&
      observation.areas.size >= MAX_AREAS
    ) {
      unavailable(observation);
      return;
    }
    const identities = new Map<string, TicketIdentity>();
    for (const ticket of tickets) {
      if (
        typeof ticket.id !== "string" ||
        !ticket.id ||
        ticket.id.length > 100 ||
        typeof ticket.identifier !== "string" ||
        !ticket.identifier ||
        ticket.identifier.length > 80
      ) {
        unavailable(observation, area);
        return;
      }
      identities.set(ticket.id, {
        id: ticket.id,
        identifier: ticket.identifier,
      });
      if (identities.size > MAX_TICKETS) {
        unavailable(observation, area);
        return;
      }
    }
    const otherTickets = [...observation.areas.entries()]
      .filter(([key]) => key !== area.key)
      .reduce((count, [, value]) => count + value.tickets.length, 0);
    if (otherTickets + identities.size > MAX_TICKETS) {
      unavailable(observation, area);
      return;
    }
    observation.areas.set(area.key, {
      state: "current",
      at: now(),
      ...scope,
      tickets: [...identities.values()],
    });
  }

  function read(name: string, currentJobs: LocalJob[]): CodingPickupView {
    let project: Project;
    try {
      project = loadProject(root, name);
    } catch {
      return { state: "unavailable", needsReview: [] };
    }
    const observation = snapshots.get(name);
    try {
      if (!observation || observation.fingerprint !== fingerprint(project))
        return { state: "checking", needsReview: [] };
    } catch {
      return { state: "unavailable", needsReview: [] };
    }
    const time = now();
    const fresh = (entry: AreaObservation) =>
      entry.at <= time && time - entry.at <= MAX_AGE_MS;
    const projectFailure = observation.areas.get("");
    if (projectFailure && fresh(projectFailure))
      return { state: "unavailable", needsReview: [] };
    const areas = project.areas.filter(codingPickupEnabled);
    const history = currentJobs
      .filter(
        (job) =>
          job.type === "developer" && jobBelongsToProject(project.config, job),
      )
      .sort((a, b) => b.runId - a.runId);
    const needsReview: CodingPickupHold[] = [];
    let state: CodingPickupView["state"] = areas.length
      ? "current"
      : "checking";
    let observedAt: number | undefined;
    for (const area of areas) {
      const entry = observation.areas.get(area.key);
      if (!entry || !fresh(entry)) {
        if (state !== "unavailable") state = "checking";
        continue;
      }
      if (entry.state === "unavailable") {
        state = "unavailable";
        continue;
      }
      observedAt = Math.min(observedAt ?? entry.at, entry.at);
      for (const ticket of entry.tickets) {
        const latest = history.find((job) => {
          const binding = job.linearBinding;
          // Legacy identifiers are conservative only within this project incarnation.
          if (!binding?.ticketId) return job.ticket === ticket.identifier;
          if (binding.ticketId !== ticket.id) return false;
          return binding.workspaceId && entry.workspaceId
            ? binding.workspaceId === entry.workspaceId
            : binding.connectionId === entry.connectionId;
        });
        if (!latest || !["failed", "canceled"].includes(latest.status))
          continue;
        const status = latest.status as CodingPickupHold["status"];
        needsReview.push({
          ticketId: ticket.id,
          identifier: ticket.identifier,
          area: area.key,
          jobId: latest.id,
          runId: latest.runId,
          status,
          reason: status === "failed" ? "previous-failed" : "previous-canceled",
          href: `/activity?run=${encodeURIComponent(latest.id)}`,
        });
      }
    }
    return {
      state,
      ...(observedAt === undefined
        ? {}
        : { observedAt: new Date(observedAt).toISOString() }),
      needsReview: needsReview.sort(
        (a, b) => b.runId - a.runId || a.identifier.localeCompare(b.identifier),
      ),
    };
  }
  return { begin, observe, unavailable, read };
}
