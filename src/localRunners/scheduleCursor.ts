import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { CronExpressionParser } from "cron-parser";
import type { Project, AreaConfig } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  readPrivateJson,
  writePrivateJson,
} from "../improvements/observations.ts";
import type { LocalJobInput } from "./types.ts";

const MINUTE = 60_000,
  LOOKBACK = 7 * 24 * 60 * MINUTE;
type Cursor = { identity: string; observed: number; admitted?: number };
export function createScheduleCursor(root: string) {
  const identity = (project: Project, area: AreaConfig) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          projectRuntimeKey(project.config),
          area.key,
          area.instanceId,
          area.schedule,
        ]),
      )
      .digest("hex");
  const file = (key: string) =>
    join(root, ".run", "schedule-cursors", `${key}.json`);
  function read(key: string): Cursor | undefined {
    if (!existsSync(file(key))) return undefined;
    const value = readPrivateJson(file(key)) as Cursor | undefined;
    if (value === undefined || value === null) return undefined;
    if (
      value.identity !== key ||
      !Number.isFinite(value.observed) ||
      (value.admitted !== undefined && !Number.isFinite(value.admitted))
    )
      throw new Error(
        "Saved schedule cursor is invalid. Review scheduling state.",
      );
    return value;
  }
  function due(
    project: Project,
    area: AreaConfig,
    now: Date,
  ): { slot: number; key: string } | undefined {
    const key = identity(project, area),
      minute = Math.floor(+now / MINUTE) * MINUTE;
    const previous = read(key);
    // Persist the first observation, not seven days of unowned history.
    const start = previous?.observed ?? minute - 1;
    if (!previous)
      writePrivateJson(file(key), { identity: key, observed: start });
    if (!area.enabled || !project.config.verified) {
      writePrivateJson(file(key), {
        identity: key,
        observed: Math.max(previous?.observed ?? minute, minute),
        ...(previous?.admitted !== undefined
          ? { admitted: previous.admitted }
          : {}),
      });
      return undefined;
    }
    if (area.schedule.trim().split(/\s+/).length !== 5)
      throw new Error("Use a five-field UTC schedule.");
    const slot = CronExpressionParser.parse(area.schedule, {
      currentDate: new Date(minute + 1),
      tz: "UTC",
    })
      .prev()
      .getTime();
    const lower = Math.max(
      start,
      previous?.admitted ?? -Infinity,
      minute - LOOKBACK,
    );
    return slot > lower && slot <= minute ? { slot, key } : undefined;
  }
  function inputKey(due: { slot: number; key: string }) {
    return `pm-slot:${due.key}:${due.slot}`;
  }
  function reset(project: Project, now = new Date(), areaKey?: string) {
    for (const area of project.areas.filter(
      (area) => !areaKey || area.key === areaKey,
    )) {
      const key = identity(project, area),
        previous = read(key);
      writePrivateJson(file(key), {
        identity: key,
        observed: Math.max(
          previous?.observed ?? -Infinity,
          Math.floor(+now / MINUTE) * MINUTE,
        ),
        ...(previous?.admitted !== undefined
          ? { admitted: previous.admitted }
          : {}),
      });
    }
  }
  function admitted(input: LocalJobInput) {
    const match = /^pm-slot:([a-f0-9]{64}):(\d+)$/.exec(
      input.idempotencyKey ?? "",
    );
    if (!match) return;
    const key = match[1]!,
      slot = Number(match[2]),
      saved = read(key);
    if (!saved) throw new Error("Schedule cursor is missing.");
    if (slot <= (saved.admitted ?? -Infinity)) return;
    writePrivateJson(file(key), {
      ...saved,
      admitted: slot,
      observed: Math.max(saved.observed, slot),
    });
  }
  return { due, inputKey, admitted, reset };
}
