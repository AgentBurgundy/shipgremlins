// `hub add-project <name> --repo owner/name [--area core]` — seeds
// projects/<name>/ from projects/_templates/ and prints the owner's checklist.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFlags, type Io } from "./crons.ts";
import { assertResourceAvailable } from "../setup/resourceDeletion.ts";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const CONFIG_FILES = ["project.json", "areas.json", "tiers.json"] as const;
const AREA_FILES = [
  "mandate.md",
  "features.md",
  "queue.md",
  "memory.md",
] as const;

export interface AddProjectInput {
  name: string;
  repo: string;
  area?: string;
  /** ISO date stamped into the memory/features seeds; defaults to today (UTC) */
  today?: string;
}

export interface AddProjectResult {
  dir: string;
  /** paths relative to the hub root, in write order */
  files: string[];
  vars: Record<string, string>;
}

export const CHECKLIST = `Next, in this order:
  1. Open gremlins setup and connect GitHub or GitLab, Linear, and your AI runtime.
  2. Choose this repository's base branch and install/test commands. New projects review repositories and open draft PRs to main.
  3. Optionally select browser verification and a preview/staging environment. Hosting credentials are needed only for the selected provider.
  4. Set up the app's Linear team and each PM's project in the dashboard, or preserve existing IDs.
  5. Write and review each PM mandate, then run gremlins doctor for this app.
  6. Create a local worker and enable reviewed PMs. No additional branches or hosting provider are required for repository review.`;

export function templateVars(
  input: Required<Pick<AddProjectInput, "name" | "repo" | "area" | "today">>,
): Record<string, string> {
  return {
    name: input.name,
    NAME: input.name.toUpperCase().replace(/-/g, "_"),
    repo: input.repo,
    area: input.area,
    Area: input.area.charAt(0).toUpperCase() + input.area.slice(1),
    date: input.today,
  };
}

export function fillTemplate(
  text: string,
  vars: Record<string, string>,
): string {
  return text.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => vars[key] ?? whole,
  );
}

export function addProject(
  root: string,
  input: AddProjectInput,
  templatesRoot = root,
): AddProjectResult {
  const { name, repo } = input;
  const area = input.area ?? "core";
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (!NAME_RE.test(name))
    throw new Error(`project name "${name}" must be lowercase kebab-case`);
  if (!REPO_RE.test(repo))
    throw new Error(`--repo must be "owner/name", got "${repo}"`);
  if (!NAME_RE.test(area))
    throw new Error(`area "${area}" must be lowercase kebab-case`);
  assertResourceAvailable(root, name, area);

  const templates = join(templatesRoot, "projects", "_templates");
  const dir = join(root, "projects", name);
  if (existsSync(dir))
    throw new Error(`projects/${name} already exists — refusing to overwrite`);
  for (const f of [...CONFIG_FILES, ...AREA_FILES])
    if (!existsSync(join(templates, f)))
      throw new Error(
        `projects/_templates/${f} is missing — cannot seed the project`,
      );

  const vars = templateVars({ name, repo, area, today });
  const files: string[] = [];
  const write = (target: string, source: string): void => {
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, fillTemplate(readFileSync(source, "utf8"), vars));
    files.push(relative(root, target));
  };
  mkdirSync(join(dir, area), { recursive: true });
  for (const f of CONFIG_FILES) {
    write(join(dir, f), join(templates, f));
    if (f === "areas.json") {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const area of Object.values(raw.areas) as Array<{
        enabled: boolean;
      }>)
        area.enabled = false;
      writeFileSync(join(dir, f), JSON.stringify(raw, null, 2) + "\n");
    }
  }
  for (const f of AREA_FILES) write(join(dir, area, f), join(templates, f));
  return { dir, files, vars };
}

export async function runAddProject(
  root: string,
  args: string[],
  io: Io,
  templatesRoot = root,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  const name = positionals[0];
  const repo = values.repo;
  const area = values.area;
  if (
    !name ||
    typeof repo !== "string" ||
    (area !== undefined && typeof area !== "string")
  ) {
    io.error(
      "usage: gremlins add-project <name> --repo owner/name [--area core]",
    );
    return 1;
  }
  try {
    const result = addProject(root, { name, repo, area }, templatesRoot);
    io.log(`Created projects/${name}/ (${result.files.length} files):`);
    for (const f of result.files) io.log(`  ${f.replace(/\\/g, "/")}`);
    io.log("");
    io.log(CHECKLIST);
    io.log("");
    io.log(
      "Save connections through the local dashboard. Hosting and preview secrets are optional until browser verification is selected.",
    );
    io.log(
      `Then run \`gremlins doctor ${name}\`; PM schedules start when verification passes, the PM is enabled, and the controller is running.`,
    );
    return 0;
  } catch (err) {
    io.error((err as Error).message);
    return 1;
  }
}
