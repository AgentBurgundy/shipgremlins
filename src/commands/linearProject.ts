// `hub linear-project <project> <area> [--id <uuid|url>] [--team <key>]`
//
// Creates (or, with --id, updates) the Linear project an area files into,
// from projects/<project>/<area>/linear-project.md — the first `# ` line is
// the name, the first `> ` line is the short description, the rest is the
// project document — and writes the uuid into areas.json. Runs locally with
// LINEAR_API_KEY in the environment; nothing is stored but the id.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "./crons.ts";
import { parseFlags } from "./crons.ts";

export interface LinearProjectApi {
  listProjects(): Promise<{ id: string; name: string; url: string }[]>;
  listTeams(): Promise<{ id: string; key: string; name: string }[]>;
  createProject(input: {
    teamId: string;
    name: string;
    description: string;
    content: string;
    icon?: string;
    color?: string;
  }): Promise<{ id: string; url: string }>;
  updateProject(
    id: string,
    input: { name?: string; description?: string; content?: string },
  ): Promise<{ id: string; url: string }>;
}

export interface ParsedProjectDoc {
  name: string;
  description: string;
  content: string;
}

/** `# Name` → name; `> text` → description; everything after the quote → content. */
export function parseProjectDoc(markdown: string): ParsedProjectDoc {
  const lines = markdown.split(/\r?\n/);
  let name = "";
  let description = "";
  const rest: string[] = [];
  for (const line of lines) {
    if (!name && line.startsWith("# ")) {
      name = line.slice(2).trim();
      continue;
    }
    if (name && !description && line.startsWith("> ")) {
      description = line.slice(2).trim();
      continue;
    }
    if (name) rest.push(line);
  }
  if (!name) throw new Error("linear-project.md needs a `# Name` first line");
  return { name, description, content: rest.join("\n").trim() + "\n" };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid is returned as is; a Linear URL or slug is matched against the key's projects. */
export async function resolveProjectId(
  api: Pick<LinearProjectApi, "listProjects">,
  idOrUrl: string,
): Promise<string> {
  if (UUID_RE.test(idOrUrl)) return idOrUrl;
  const slug =
    idOrUrl
      .replace(/\/overview\/?$/, "")
      .split("/")
      .pop() ?? "";
  const suffix = slug.split("-").pop() ?? "";
  const projects = await api.listProjects();
  const hit = projects.find(
    (p) =>
      p.url.replace(/\/overview\/?$/, "").endsWith(`/${slug}`) ||
      (suffix.length >= 8 && p.id.replace(/-/g, "").startsWith(suffix)),
  );
  if (!hit)
    throw new Error(
      `no Linear project matches "${idOrUrl}" — run \`linear-projects\` to see what the key can reach`,
    );
  return hit.id;
}

export function writeAreaProjectId(
  root: string,
  project: string,
  area: string,
  id: string,
): void {
  const file = join(root, "projects", project, "areas.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    areas: Record<string, { linearProjectId: string }>;
  };
  const entry = raw.areas[area];
  if (!entry) throw new Error(`areas.json has no area "${area}"`);
  entry.linearProjectId = id;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

export async function runLinearProject(
  root: string,
  api: LinearProjectApi,
  args: string[],
  io: Io,
): Promise<number> {
  const { positionals, values } = parseFlags(args);
  const [project, area] = positionals;
  if (!project || !area) {
    io.error(
      "usage: linear-project <project> <area> [--id <uuid|url>] [--team <key>]",
    );
    return 1;
  }
  const doc = parseProjectDoc(
    readFileSync(
      join(root, "projects", project, area, "linear-project.md"),
      "utf8",
    ),
  );
  const idFlag = typeof values.id === "string" ? values.id : null;
  let result: { id: string; url: string };
  if (idFlag) {
    const id = await resolveProjectId(api, idFlag);
    result = await api.updateProject(id, doc);
    io.log(`updated ${doc.name} → ${result.url}`);
  } else {
    const teams = await api.listTeams();
    const wanted = typeof values.team === "string" ? values.team : null;
    const team = wanted
      ? teams.find((t) => t.key === wanted || t.name === wanted)
      : teams.length === 1
        ? teams[0]
        : undefined;
    if (!team) {
      io.error(
        `pick a team with --team <key>: ${teams.map((t) => `${t.key} (${t.name})`).join(", ") || "none visible"}`,
      );
      return 1;
    }
    result = await api.createProject({
      teamId: team.id,
      ...doc,
      icon: "Rocket",
    });
    io.log(`created ${doc.name} in ${team.key} → ${result.url}`);
  }
  writeAreaProjectId(root, project, area, result.id);
  io.log(`areas.json: ${area}.linearProjectId = ${result.id}`);
  return 0;
}
