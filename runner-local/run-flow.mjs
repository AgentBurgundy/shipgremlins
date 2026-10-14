import { createHmac, timingSafeEqual } from "node:crypto";

export const RUN_FLOW_PREFIX = "GREMLINS_FLOW ";
export const RUN_FLOW_PHASES = {
  developer: [
    ["understand", "Understand the task"],
    ["baseline", "Check the baseline"],
    ["tests", "Add focused tests"],
    ["build", "Make the change"],
    ["review", "Review the change"],
    ["verify", "Verify the result"],
    ["publish", "Publish the result"],
  ],
  pm: [
    ["prepare", "Prepare the workspace"],
    ["investigate", "Investigate the project"],
    ["record", "Record the findings"],
    ["complete", "Complete the patrol"],
  ],
  verify: [
    ["prepare", "Prepare the workspace"],
    ["browser", "Check browser access"],
    ["complete", "Complete verification"],
  ],
};
export const RUN_FLOW_STRATEGIES = [
  "tdd",
  "regression",
  "refactor",
  "visual",
  "integration",
  "fast",
];
export const RUN_FLOW_SUMMARIES = {
  "checks-passed": "Checks passed.",
  "checks-failed": "Checks failed.",
  blocked: "Required access or setup is unavailable.",
  "not-applicable": "This step does not apply.",
  "repair-started": "A bounded repair attempt has started.",
  "repair-exhausted": "The repair limit has been reached.",
  "baseline-failed": "Existing checks failed before the change.",
  published: "The reviewable result was published.",
  complete: "The run is complete.",
};
const statuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "blocked",
];
const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) =>
  Object.keys(value).every((key) => keys.includes(key));
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const jobName = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
export function validRunFlowAuthorization(value) {
  return (
    object(value) &&
    only(value, ["version", "key", "maxRepairs"]) &&
    value.version === 1 &&
    typeof value.key === "string" &&
    /^[a-f0-9]{64}$/.test(value.key) &&
    value.maxRepairs === 2
  );
}
function unsigned(event) {
  return {
    version: 1,
    jobId: event.jobId,
    kind: event.kind,
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    ...(event.type === "phase"
      ? {
          phase: event.phase,
          status: event.status,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        }
      : {}),
    ...(event.strategy === undefined ? {} : { strategy: event.strategy }),
    ...(event.repairUsed === undefined ? {} : { repairUsed: event.repairUsed }),
  };
}
function mac(event, key) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(unsigned(event)))
    .digest("hex");
}
export function parseRunFlowLine(line, { authorization, jobId, kind }) {
  if (
    !validRunFlowAuthorization(authorization) ||
    !jobName(jobId) ||
    !RUN_FLOW_PHASES[kind] ||
    typeof line !== "string" ||
    line.length > 2048 ||
    !line.startsWith(RUN_FLOW_PREFIX)
  )
    return undefined;
  try {
    const event = JSON.parse(line.slice(RUN_FLOW_PREFIX.length));
    if (
      !object(event) ||
      event.version !== 1 ||
      event.jobId !== jobId ||
      event.kind !== kind ||
      !Number.isInteger(event.sequence) ||
      event.sequence < 1 ||
      event.sequence > 256 ||
      !date(event.at) ||
      (event.strategy !== undefined &&
        !RUN_FLOW_STRATEGIES.includes(event.strategy)) ||
      (event.repairUsed !== undefined &&
        (!Number.isInteger(event.repairUsed) ||
          event.repairUsed < 0 ||
          event.repairUsed > authorization.maxRepairs)) ||
      typeof event.mac !== "string" ||
      !/^[a-f0-9]{64}$/.test(event.mac)
    )
      return undefined;
    if (event.type === "phase") {
      if (
        !only(event, [
          "version",
          "jobId",
          "kind",
          "sequence",
          "at",
          "type",
          "phase",
          "status",
          "summary",
          "strategy",
          "repairUsed",
          "mac",
        ]) ||
        !RUN_FLOW_PHASES[kind].some(([id]) => id === event.phase) ||
        !statuses.includes(event.status) ||
        event.repairUsed === undefined ||
        (event.summary !== undefined &&
          !Object.values(RUN_FLOW_SUMMARIES).includes(event.summary))
      )
        return undefined;
    } else if (event.type === "checkpoint") {
      if (
        !only(event, [
          "version",
          "jobId",
          "kind",
          "sequence",
          "at",
          "type",
          "strategy",
          "repairUsed",
          "mac",
        ]) ||
        (event.strategy === undefined && event.repairUsed === undefined) ||
        (event.strategy !== undefined &&
          !RUN_FLOW_STRATEGIES.includes(event.strategy)) ||
        (event.repairUsed !== undefined &&
          (!Number.isInteger(event.repairUsed) ||
            event.repairUsed < 0 ||
            event.repairUsed > authorization.maxRepairs))
      )
        return undefined;
    } else return undefined;
    if (
      !timingSafeEqual(
        Buffer.from(event.mac, "hex"),
        Buffer.from(mac(event, authorization.key), "hex"),
      )
    )
      return undefined;
    return { ...unsigned(event), mac: event.mac };
  } catch {
    return undefined;
  }
}
export function applyRunFlowEvent(previous, event) {
  if (event.sequence <= (previous?.sequence ?? 0)) return previous;
  const repairUsed = event.repairUsed ?? previous?.repairUsed ?? 0;
  if (repairUsed < (previous?.repairUsed ?? 0)) return previous;
  const state = {
    sequence: event.sequence,
    repairUsed,
    ...(previous?.strategy === undefined
      ? {}
      : { strategy: previous.strategy }),
    ...(event.strategy === undefined ? {} : { strategy: event.strategy }),
    ...(previous?.snapshot === undefined
      ? {}
      : { snapshot: previous.snapshot }),
  };
  if (event.type === "checkpoint") {
    if (state.snapshot)
      state.snapshot = {
        ...state.snapshot,
        repairUsed,
        updatedAt: event.at,
        ...(state.strategy === undefined ? {} : { strategy: state.strategy }),
      };
    return state;
  }
  const phases = (
    previous?.snapshot?.phases ??
    RUN_FLOW_PHASES[event.kind].map(([id, label]) => ({
      id,
      label,
      status: "pending",
    }))
  ).map((phase) =>
    phase.id !== event.phase
      ? phase
      : {
          id: phase.id,
          label: phase.label,
          status: event.status,
          ...(phase.startedAt === undefined && event.status === "pending"
            ? {}
            : { startedAt: phase.startedAt ?? event.at }),
          ...(["passed", "failed", "skipped", "blocked"].includes(event.status)
            ? { finishedAt: event.at }
            : {}),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        },
  );
  const last = RUN_FLOW_PHASES[event.kind].at(-1)[0];
  state.snapshot = {
    version: 1,
    kind: event.kind,
    phase: event.phase,
    status: ["failed", "blocked"].includes(event.status)
      ? event.status
      : event.phase === last && ["passed", "skipped"].includes(event.status)
        ? "passed"
        : "running",
    ...(state.strategy === undefined ? {} : { strategy: state.strategy }),
    repairUsed,
    repairLimit: 2,
    updatedAt: event.at,
    phases,
    events: [
      ...(previous?.snapshot?.events ?? []),
      {
        id: `${event.jobId}:${event.sequence}`,
        phase: event.phase,
        status: event.status,
        at: event.at,
        ...(event.summary === undefined ? {} : { summary: event.summary }),
      },
    ].slice(-64),
  };
  return state;
}
export function createRunFlowWriter({
  authorization,
  jobId,
  kind,
  write,
  now = () => new Date(),
}) {
  if (
    !validRunFlowAuthorization(authorization) ||
    !jobName(jobId) ||
    !RUN_FLOW_PHASES[kind] ||
    typeof write !== "function"
  )
    throw new Error("Invalid run progress authorization.");
  let state;
  function emit(fields) {
    const event = {
      version: 1,
      jobId,
      kind,
      sequence: (state?.sequence ?? 0) + 1,
      at: now().toISOString(),
      ...(state?.strategy === undefined ? {} : { strategy: state.strategy }),
      repairUsed: state?.repairUsed ?? 0,
      ...fields,
    };
    const signed = { ...event, mac: mac(event, authorization.key) };
    const line = RUN_FLOW_PREFIX + JSON.stringify(signed);
    const parsed = parseRunFlowLine(line, { authorization, jobId, kind });
    if (!parsed) throw new Error("Invalid run progress event.");
    const next = applyRunFlowEvent(state, parsed);
    if (next === state)
      throw new Error("Run progress cannot rewind repair history.");
    state = next;
    write(line + "\n");
  }
  return {
    phase(id, status, summary) {
      if (summary !== undefined && !Object.hasOwn(RUN_FLOW_SUMMARIES, summary))
        throw new Error("Run progress summaries must use a fixed public tag.");
      emit({
        type: "phase",
        phase: id,
        status,
        ...(summary === undefined
          ? {}
          : { summary: RUN_FLOW_SUMMARIES[summary] }),
      });
    },
    checkpoint(value) {
      if (!object(value) || !only(value, ["strategy", "repairUsed"]))
        throw new Error("Invalid run progress checkpoint.");
      emit({ type: "checkpoint", ...value });
    },
    snapshot() {
      return state?.snapshot ? structuredClone(state.snapshot) : undefined;
    },
  };
}
