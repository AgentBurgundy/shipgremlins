import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Project } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  readPrivateJson,
  writePrivateJson,
} from "../improvements/observations.ts";

const reasons = {
  setup: [
    "Automatic setup needs attention.",
    "Review environment setup and saved connections.",
    "environment",
  ],
  mapping: [
    "Automatic ticket mapping could not finish.",
    "Reconnect Linear or repair this PM's project mapping.",
    "mapping",
  ],
  verification: [
    "The project environment could not be verified.",
    "Open environment setup and test the selected target.",
    "environment",
  ],
  discovery: [
    "Repository discovery is waiting for access.",
    "Check the source and AI connections, then retry discovery.",
    "connections",
  ],
  source: [
    "A saved connection is unavailable for automatic work.",
    "Reconnect the selected account in Connections.",
    "connections",
  ],
  tickets: [
    "The ticket queue could not be read.",
    "Check Linear access and this PM's mapping.",
    "mapping",
  ],
  schedule: [
    "The saved schedule could not be evaluated.",
    "Review the PM's five-field UTC schedule in project settings.",
    "settings",
  ],
  approval: [
    "Automatic approval could not finish safely.",
    "Review the approval policy and pending reservations before retrying.",
    "policy",
  ],
} as const;
export type AutomationFailureCode = keyof typeof reasons;
type Saved = {
  schema: 1;
  identity: string;
  lane: string;
  area?: string;
  code: AutomationFailureCode;
  firstOccurredAt: string;
  lastOccurredAt: string;
  nextRetryAt: string;
  count: number;
  resolvedAt?: string;
};
export function createAutomationDiagnostics(root: string) {
  const directory = (project: Project) =>
    join(
      root,
      ".run",
      "automation-diagnostics",
      projectRuntimeKey(project.config),
    );
  const file = (project: Project, lane: string, area?: string) =>
    join(
      directory(project),
      createHash("sha256")
        .update(JSON.stringify([lane, area]))
        .digest("hex") + ".json",
    );
  function read(
    project: Project,
    lane: string,
    area?: string,
  ): Saved | undefined {
    const path = file(project, lane, area);
    if (!existsSync(path)) return;
    const value = readPrivateJson(path) as Saved;
    if (
      value.schema !== 1 ||
      value.identity !== projectRuntimeKey(project.config) ||
      value.lane !== lane ||
      value.area !== area ||
      !Object.hasOwn(reasons, value.code) ||
      !Number.isSafeInteger(value.count) ||
      value.count < 1 ||
      ![value.firstOccurredAt, value.lastOccurredAt, value.nextRetryAt].every(
        (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
      )
    )
      throw new Error("Automation diagnostics need repair.");
    return value;
  }
  function fail(
    project: Project,
    lane: string,
    code: AutomationFailureCode,
    area?: string,
    now = new Date(),
  ) {
    const old = read(project, lane, area),
      count = old && !old.resolvedAt ? old.count + 1 : 1;
    if (old && !old.resolvedAt && Date.parse(old.nextRetryAt) > +now) return;
    const value: Saved = {
      schema: 1,
      identity: projectRuntimeKey(project.config),
      lane,
      ...(area ? { area } : {}),
      code,
      firstOccurredAt:
        old && !old.resolvedAt ? old.firstOccurredAt : now.toISOString(),
      lastOccurredAt: now.toISOString(),
      nextRetryAt: new Date(
        +now + Math.min(30, 5 * 2 ** Math.min(count - 1, 3)) * 60_000,
      ).toISOString(),
      count,
    };
    writePrivateJson(file(project, lane, area), value);
  }
  function resolve(
    project: Project,
    lane: string,
    area?: string,
    now = new Date(),
  ) {
    const old = read(project, lane, area);
    if (old && !old.resolvedAt)
      writePrivateJson(file(project, lane, area), {
        ...old,
        resolvedAt: now.toISOString(),
      });
  }
  function ready(
    project: Project,
    lane: string,
    area?: string,
    now = new Date(),
  ) {
    const old = read(project, lane, area);
    return !old || !!old.resolvedAt || Date.parse(old.nextRetryAt) <= +now;
  }
  function list(project: Project) {
    const dir = directory(project);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .slice(0, 500)
      .flatMap((n) => {
        const raw = readPrivateJson(join(dir, n)) as Saved;
        const value = read(project, raw.lane, raw.area);
        if (!value || value.resolvedAt) return [];
        const [message, remedy, target] = reasons[value.code];
        const name = project.config.name;
        return [
          {
            id: `automation:${n.slice(0, 64)}`,
            area: value.area,
            code: value.code,
            message,
            remedy,
            nextRetryAt: value.nextRetryAt,
            lastOccurredAt: value.lastOccurredAt,
            action: {
              label: "Resolve",
              href:
                target === "connections"
                  ? "/connections"
                  : target === "mapping"
                    ? `/projects/${name}?pm=${value.area ?? project.areas[0]?.key ?? ""}&tab=brief`
                    : target === "settings"
                      ? `/projects/${name}?tab=settings`
                      : target === "policy"
                        ? `/projects/${name}#approval-policy`
                        : `/projects/${name}?tab=environment`,
            },
          },
        ];
      });
  }
  return { fail, resolve, ready, list };
}
