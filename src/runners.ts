// The self-hosted ↔ GCE switch for the three workflows' `run` job. Every
// workflow's `launch` job runs `npx tsx src/runners.ts resolve …` and pipes
// the lines into $GITHUB_OUTPUT, so the YAML never encodes the mode itself.

import { pathToFileURL } from "node:url";
import {
  loadHub,
  loadProject,
  type HubConfig,
  type ProjectConfig,
} from "./config.ts";

/** JSON array string for `runs-on`, e.g. `["self-hosted","pm"]` or `["pm-123"]` in gce mode. */
export function resolveRunsOn(
  hub: HubConfig,
  project: ProjectConfig | null,
  runLabel: string,
): string {
  if (hub.runners.mode === "local")
    throw new Error(
      "Local Docker workers do not use GitHub Actions runs-on. Start gremlins setup to manage them.",
    );
  if (hub.runners.mode === "gce") return JSON.stringify([runLabel]);
  const label = project?.runnerLabel ?? hub.runners.label;
  return JSON.stringify(["self-hosted", label]);
}

/** true when the `launch` job must create a VM (and `teardown` delete it). */
export function launchNeeded(hub: HubConfig): boolean {
  return hub.runners.mode === "gce";
}

/** Every line the `launch` job appends to $GITHUB_OUTPUT. */
export function launchOutputs(
  hub: HubConfig,
  project: ProjectConfig | null,
  runLabel: string,
): Record<string, string> {
  return {
    runsOn: resolveRunsOn(hub, project, runLabel),
    launch: String(launchNeeded(hub)),
    runLabel,
    vmName: runLabel,
    gcpProject: hub.gce.project,
    zone: hub.gce.zone,
    image: hub.gce.image,
    machineType: hub.gce.machineType,
    spot: String(hub.gce.spot),
  };
}

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
}

export function main(argv: string[], root = process.cwd()): string {
  const [cmd] = argv;
  if (cmd !== "resolve") {
    throw new Error(
      "usage: tsx src/runners.ts resolve --run-label <label> [--project <name>]",
    );
  }
  const runLabel = arg(argv, "--run-label");
  if (!runLabel) throw new Error("--run-label is required");
  const hub = loadHub(root);
  const projectName = arg(argv, "--project");
  const project = projectName ? loadProject(root, projectName).config : null;
  return Object.entries(launchOutputs(hub, project, runLabel))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.stdout.write(main(process.argv.slice(2)) + "\n");
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
