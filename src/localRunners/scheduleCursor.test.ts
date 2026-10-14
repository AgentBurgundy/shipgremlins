import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCtx } from "../services/fakes.ts";
import { createScheduleCursor } from "./scheduleCursor.ts";
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-schedule-"));
  const project = makeCtx().project;
  project.config.verified = "2026-10-14";
  const area = project.areas[0]!;
  area.enabled = true;
  area.schedule = "0 * * * *";
  return { project, area, cursor: createScheduleCursor(root) };
}
describe("durable bounded schedule catch-up", () => {
  it("admits the current slot once and waits for actual queue acknowledgment", () => {
    const { project, area, cursor } = fixture(),
      now = new Date("2026-10-14T12:00:05Z");
    const due = cursor.due(project, area, now)!;
    expect(due).toBeDefined();
    expect(createScheduleCursor(root).due(project, area, now)).toEqual(due);
    cursor.admitted({ type: "pm", idempotencyKey: cursor.inputKey(due) });
    expect(createScheduleCursor(root).due(project, area, now)).toBeUndefined();
  });
  it("coalesces downtime into one latest slot and has no first-connect backlog", () => {
    const { project, area, cursor } = fixture();
    expect(
      cursor.due(project, area, new Date("2026-10-01T12:01:00Z")),
    ).toBeUndefined();
    const due = createScheduleCursor(root).due(
      project,
      area,
      new Date("2026-10-14T18:42:00Z"),
    )!;
    expect(due.slot).toBe(+new Date("2026-10-14T18:00:00Z"));
    cursor.admitted({ type: "pm", idempotencyKey: cursor.inputKey(due) });
    expect(
      cursor.due(project, area, new Date("2026-10-14T18:43:00Z")),
    ).toBeUndefined();
  });
  it("does not replay paused slots or reuse a replaced PM's identity", () => {
    const { project, area, cursor } = fixture();
    cursor.due(project, area, new Date("2026-10-14T12:01:00Z"));
    area.enabled = false;
    cursor.due(project, area, new Date("2026-10-14T17:10:00Z"));
    area.enabled = true;
    expect(
      cursor.due(project, area, new Date("2026-10-14T17:11:00Z")),
    ).toBeUndefined();
    area.instanceId = "replaced";
    expect(
      cursor.due(project, area, new Date("2026-10-14T17:12:00Z")),
    ).toBeUndefined();
    expect(
      cursor.due(project, area, new Date("2026-10-14T18:00:00Z")),
    ).toBeDefined();
  });
  it("does not replay clock rollback or schedules older than the catch-up window", () => {
    const { project, area, cursor } = fixture();
    area.schedule = "0 12 1 * *";
    cursor.due(project, area, new Date("2026-10-01T12:01:00Z"));
    expect(
      cursor.due(project, area, new Date("2026-10-28T13:00:00Z")),
    ).toBeUndefined();
    cursor.reset(project, new Date("2026-10-14T12:00:00Z"));
    expect(
      cursor.due(project, area, new Date("2026-10-13T12:00:00Z")),
    ).toBeUndefined();
  });
  it("resetting one PM preserves an unrelated PM's pending catch-up slot", () => {
    const { project, area, cursor } = fixture();
    const sibling = { ...area, key: "sibling", instanceId: "sibling-instance" };
    project.areas.push(sibling);
    const observed = new Date("2026-10-14T12:01:00Z"),
      current = new Date("2026-10-14T13:02:00Z");
    cursor.due(project, area, observed);
    cursor.due(project, sibling, observed);
    const siblingSlot = cursor.due(project, sibling, current);
    expect(siblingSlot?.slot).toBe(+new Date("2026-10-14T13:00:00Z"));
    cursor.reset(project, current, area.key);
    expect(cursor.due(project, area, current)).toBeUndefined();
    expect(cursor.due(project, sibling, current)).toEqual(siblingSlot);
  });
});
