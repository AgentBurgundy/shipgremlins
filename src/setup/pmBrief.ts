import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { loadProject } from "../config.ts";
import {
  parsePmCharter,
  printableBrief,
  type PmCharter,
} from "../pmCharter.ts";
import { assertNoSymlinks } from "./files.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";

export class PmBriefError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PmBriefError";
  }
}
export interface PmBrief {
  name: string;
  mandate: string;
  charter: PmCharter;
  paths: string[];
  sharedTouchpoints: string[];
  metric: string;
  schedule: string;
  wipLimit: number;
}
const fields = [
  "name",
  "mandate",
  "charter",
  "paths",
  "sharedTouchpoints",
  "metric",
  "schedule",
  "wipLimit",
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function identity(project: string, area: string) {
  if (![project, area].every((name) => /^[a-z][a-z0-9-]{0,62}$/.test(name)))
    throw new PmBriefError("Choose an existing project and PM.");
}

export function readPmBrief(root: string, project: string, areaKey: string) {
  identity(project, areaKey);
  const document = readEditableConfig(root, `projects/${project}/areas.json`);
  const loaded = loadProject(root, project);
  const area = loaded.areas.find((item) => item.key === areaKey);
  if (!area)
    throw new PmBriefError(
      "This PM no longer exists. Refresh the project.",
      404,
    );
  let mandate = area.mandate ?? "";
  if (area.mandate === undefined) {
    const location = join(loaded.dir, areaKey, "mandate.md");
    assertNoSymlinks(location);
    if (existsSync(location)) {
      const stat = lstatSync(location);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024)
        throw new PmBriefError(
          "The saved mandate must be a regular Markdown file smaller than 64 KiB.",
        );
      mandate = readFileSync(location, "utf8");
    }
  }
  const brief: PmBrief = {
    name: area.name,
    mandate,
    charter: area.charter ?? {},
    paths: area.paths,
    sharedTouchpoints: area.sharedTouchpoints,
    metric: area.metric,
    schedule: area.schedule,
    wipLimit: area.wipLimit,
  };
  return { project, area: areaKey, revision: document.revision, brief };
}

/** Update the owner's brief only; preserve mappings, automation, and all other PMs. */
export function savePmBrief(
  root: string,
  project: string,
  area: string,
  input: unknown,
) {
  identity(project, area);
  if (
    !record(input) ||
    Object.keys(input).some((key) => !["revision", "brief"].includes(key)) ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    !record(input.brief) ||
    Object.keys(input.brief).some(
      (key) => !fields.includes(key as (typeof fields)[number]),
    )
  )
    throw new PmBriefError(
      "Save the PM's displayed brief with its current revision.",
    );
  const current = readPmBrief(root, project, area);
  if (current.revision !== input.revision)
    throw new PmBriefError(
      "This PM's settings changed. Refresh its brief before saving; your changes were not written.",
      409,
    );
  const value = { ...current.brief, ...input.brief };
  if (
    !printableBrief(value.name, 100) ||
    !value.name.trim() ||
    !printableBrief(value.mandate, 12000) ||
    !value.mandate.trim() ||
    !printableBrief(value.metric, 200) ||
    !value.metric.trim() ||
    !Number.isInteger(value.wipLimit) ||
    Number(value.wipLimit) < 1 ||
    Number(value.wipLimit) > 20
  )
    throw new PmBriefError(
      "Enter a PM name (1–100 characters), mandate (1–12000), metric (1–200), and WIP limit (1–20).",
    );
  const paths = (items: unknown) =>
    Array.isArray(items) &&
    items.length <= 100 &&
    items.every(
      (item) =>
        printableBrief(item, 500) &&
        item.trim() &&
        !/[\r\n\t]/.test(item) &&
        !item.split(/[\\/]/).includes("..") &&
        !/^(?:[\\/]|[a-z]:)/i.test(item),
    );
  if (!paths(value.paths) || !paths(value.sharedTouchpoints))
    throw new PmBriefError(
      "Use up to 100 repository-relative ownership or shared paths; each must be under 500 characters.",
    );
  try {
    if (
      !printableBrief(value.schedule, 100) ||
      value.schedule.trim().split(/\s+/).length !== 5
    )
      throw new Error();
    CronExpressionParser.parse(value.schedule, { tz: "UTC" });
  } catch {
    throw new PmBriefError("Use a valid five-field cron schedule in UTC.");
  }
  let charter: PmCharter;
  try {
    charter = parsePmCharter(value.charter);
  } catch {
    throw new PmBriefError(
      "Check the product brief: text fields allow 4000 characters, lists allow 20 entries of 1000 characters, and the total limit is 24000 bytes.",
    );
  }
  const document = readEditableConfig(root, `projects/${project}/areas.json`);
  const raw = JSON.parse(document.content);
  Object.assign(raw.areas[area], {
    name: value.name.trim(),
    mandate: value.mandate.trim(),
    charter,
    paths: value.paths,
    sharedTouchpoints: value.sharedTouchpoints,
    metric: value.metric.trim(),
    schedule: value.schedule.trim(),
    wipLimit: value.wipLimit,
  });
  saveEditableConfig(root, {
    path: document.path,
    revision: input.revision,
    content: JSON.stringify(raw, null, 2) + "\n",
  });
  return readPmBrief(root, project, area);
}
