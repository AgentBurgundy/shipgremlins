// `hub crons` — the PM schedules. pm-agent.yml carries ONE `schedule:` block
// generated from every verified project's enabled areas, between two marker
// comments; `--check` fails hub CI when areas.json and the workflow drift.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllProjects, type Project } from "../config.ts";

export interface CronEntry {
  project: string;
  area: string;
  cron: string;
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** `--key value`, `--key=value`, `--flag` (→ true); everything else is positional */
export function parseFlags(args: string[]): {
  values: Record<string, string | true>;
  positionals: string[];
} {
  const values: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[arg.slice(2)] = next;
      i++;
    } else values[arg.slice(2)] = true;
  }
  return { values, positionals };
}

export const CRONS_START = "# generated-crons-start";
export const CRONS_END = "# generated-crons-end";
export const PM_AGENT_WORKFLOW = join(".github", "workflows", "pm-agent.yml");

/** enabled areas of verified projects, in project then area order */
export function cronEntries(projects: Project[]): CronEntry[] {
  return [...projects]
    .sort((a, b) => a.config.name.localeCompare(b.config.name))
    .filter((p) => p.config.verified !== null)
    .flatMap((p) =>
      p.areas
        .filter((a) => a.enabled)
        .map((a) => ({
          project: p.config.name,
          area: a.key,
          cron: a.schedule,
        })),
    );
}

/**
 * The generated list items under `on.schedule:` in pm-agent.yml, between the
 * markers (which sit INSIDE `schedule:`); one `- cron:` per distinct cron.
 * GitHub refuses an empty schedule, so with nothing verified a placeholder
 * cron keeps the workflow valid — the plan job finds no (project, area) for
 * it and the run job is skipped.
 */
export function scheduleBlock(entries: CronEntry[]): string {
  const lines = [
    "# generated: do not edit — `npx tsx src/cli.ts crons write` rewrites this",
    "# block from projects/*/areas.json; hub CI runs `crons --check` on drift.",
  ];
  if (entries.length === 0) {
    lines.push(
      '- cron: "0 13 * * 1-5" # placeholder until the first project passes `hub doctor`',
    );
    return lines.join("\n");
  }
  const byCron = new Map<string, string[]>();
  for (const e of entries) {
    const list = byCron.get(e.cron) ?? [];
    list.push(`${e.project}/${e.area}`);
    byCron.set(e.cron, list);
  }
  for (const [cron, owners] of byCron)
    lines.push(`- cron: "${cron}" # ${owners.join(", ")}`);
  return lines.join("\n");
}

/** the lines between the markers, dedented by the start marker's indent */
export function extractCronsBlock(
  yaml: string,
): { indent: string; lines: string[] } | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === CRONS_START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === CRONS_END);
  if (start < 0 || end < 0) return null;
  const indent = lines[start]!.slice(0, lines[start]!.indexOf(CRONS_START));
  const inner = lines
    .slice(start + 1, end)
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()))
    .map((l) => l.trimEnd());
  return { indent, lines: inner };
}

export function checkCrons(
  yaml: string,
  entries: CronEntry[],
): { ok: boolean; expected: string; actual: string | null } {
  const expected = scheduleBlock(entries);
  const block = extractCronsBlock(yaml);
  const actual = block ? block.lines.join("\n") : null;
  return { ok: actual === expected, expected, actual };
}

/** the same yaml with the block between the markers regenerated in place */
export function writeCronsBlock(yaml: string, entries: CronEntry[]): string {
  const block = extractCronsBlock(yaml);
  if (!block)
    throw new Error(
      `${CRONS_START} / ${CRONS_END} markers not found — add them under \`on:\``,
    );
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === CRONS_START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === CRONS_END);
  const fresh = scheduleBlock(entries)
    .split("\n")
    .map((l) => block.indent + l);
  return [...lines.slice(0, start + 1), ...fresh, ...lines.slice(end)].join(
    "\n",
  );
}

export async function runCrons(
  root: string,
  args: string[],
  io: Io,
): Promise<number> {
  const entries = cronEntries(loadAllProjects(root));
  const file = join(root, PM_AGENT_WORKFLOW);
  if (args.includes("--json")) {
    io.log(JSON.stringify(entries));
    return 0;
  }
  if (args.includes("--check")) {
    if (!existsSync(file)) {
      io.error(
        `${PM_AGENT_WORKFLOW} is missing — nothing to check the crons against`,
      );
      return 1;
    }
    const result = checkCrons(readFileSync(file, "utf8"), entries);
    if (result.ok) {
      io.log(`crons in ${PM_AGENT_WORKFLOW} match projects/*`);
      return 0;
    }
    io.error(
      `cron drift in ${PM_AGENT_WORKFLOW} — run \`npx tsx src/cli.ts crons write\`\n--- expected\n${result.expected}\n--- found\n${result.actual ?? "(no marker block)"}`,
    );
    return 1;
  }
  if (args.includes("write")) {
    if (!existsSync(file)) {
      io.error(`${PM_AGENT_WORKFLOW} is missing`);
      return 1;
    }
    writeFileSync(file, writeCronsBlock(readFileSync(file, "utf8"), entries));
    io.log(`wrote ${entries.length} schedule(s) to ${PM_AGENT_WORKFLOW}`);
    return 0;
  }
  io.log(scheduleBlock(entries));
  return 0;
}
