import { loadProject } from "../config.ts";
import { parseFlags, type Io } from "./crons.ts";
import {
  readLogs,
  type LogOptions,
  type TelemetryDeps,
} from "../telemetry/read.ts";

export async function runLogs(
  root: string,
  args: string[],
  io: Io,
  deps: TelemetryDeps = { env: process.env, fetch },
): Promise<number> {
  const usage =
    "gremlins logs --project NAME [--provider all|sentry|datadog] [--hours 24] [--limit 25]";
  const { values, positionals } = parseFlags(args);
  if (values.help) {
    io.log(usage);
    return 0;
  }
  if (
    typeof values.project !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(values.project) ||
    positionals.length ||
    Object.keys(values).some(
      (key) => !["project", "provider", "hours", "limit"].includes(key),
    )
  ) {
    io.error(`usage: ${usage}`);
    return 1;
  }
  const provider = values.provider ?? "all";
  const hours =
    values.hours === undefined
      ? 24
      : typeof values.hours === "string" && /^\d+$/.test(values.hours)
        ? Number(values.hours)
        : NaN;
  const limit =
    values.limit === undefined
      ? 25
      : typeof values.limit === "string" && /^\d+$/.test(values.limit)
        ? Number(values.limit)
        : NaN;
  if (
    typeof provider !== "string" ||
    !["all", "sentry", "datadog"].includes(provider) ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 168 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    io.error("Use provider all, sentry or datadog; hours 1–168; limit 1–100.");
    return 1;
  }
  const project = loadProject(root, values.project);
  const sources = await readLogs(project.config, deps, {
    provider: provider as LogOptions["provider"],
    hours,
    limit,
  });
  io.log(JSON.stringify({ project: project.config.name, sources }, null, 2));
  // Optional telemetry never prevents a PM from using the browser.
  return 0;
}
