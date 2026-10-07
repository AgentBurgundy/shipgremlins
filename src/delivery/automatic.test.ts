import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAutomaticPromotions } from "./automatic.ts";

const roots: string[] = [];
const A = "a".repeat(64),
  B = "b".repeat(64),
  C = "c".repeat(64);
const item = { project: "shop", area: "checkout", key: A };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-automatic-")));
  roots.push(root);
  return {
    root,
    queue: createAutomaticPromotions({ root }),
    file: join(root, ".run", "delivery", "automatic.json"),
    lock: join(root, ".run", "delivery", "automatic.lock"),
  };
}
function deadPid() {
  const child = spawnSync(
    process.execPath,
    ["-e", "console.log(process.pid)"],
    {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    },
  );
  expect(child.status).toBe(0);
  const pid = Number(child.stdout.trim());
  expect(pid).toBeGreaterThan(0);
  return pid;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("durable automatic promotion intents", () => {
  it("backs off incomplete promotion work across restart and admits newer QA immediately", () => {
    const f = fixture();
    let time = 1_000_000;
    const queue = createAutomaticPromotions({ root: f.root, now: () => time });
    queue.enqueue(item.project, item.area, item.key);
    const token = queue.claim(item)!;
    queue.finish(item, token, { retry: true });
    const restarted = createAutomaticPromotions({
      root: f.root,
      now: () => time,
    });
    expect(restarted.pending()).toEqual([item]);
    expect(restarted.pending({ readyOnly: true })).toEqual([]);
    expect(restarted.claim(item)).toBeNull();
    time += 60_000;
    expect(restarted.pending({ readyOnly: true })).toEqual([item]);
    const second = restarted.claim(item)!;
    restarted.finish(item, second, { retry: true });
    time += 60_000;
    expect(restarted.claim(item)).toBeNull();
    restarted.enqueue(item.project, item.area, B);
    expect(restarted.pending({ readyOnly: true })).toEqual([
      { ...item, key: B },
    ]);
    const third = restarted.claim({ ...item, key: B })!;
    restarted.finish({ ...item, key: B }, third);
    expect(restarted.pending()).toEqual([]);
  });
  it("does not create state during reads and resumes queued intents after restart", () => {
    const { root, queue, file } = fixture();
    expect(queue.pending()).toEqual([]);
    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
    queue.enqueue(item.project, item.area, item.key);
    queue.enqueue(item.project, item.area, item.key);
    expect(createAutomaticPromotions({ root }).pending()).toEqual([item]);
    if (process.platform !== "win32")
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("claims exclusively and leaves a finished verification digest idempotent", () => {
    const { root, queue } = fixture();
    queue.enqueue(item.project, item.area, A);
    const token = queue.claim(item)!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const secondController = createAutomaticPromotions({ root });
    expect(secondController.claim(item)).toBeNull();
    secondController.finish(item, B);
    expect(queue.pending()).toEqual([item]);
    queue.finish(item, token);
    queue.finish(item, token);
    queue.enqueue(item.project, item.area, A);
    expect(queue.pending()).toEqual([]);
    expect(queue.claim(item)).toBeNull();
  });

  it("an older finish cannot erase a newer intent, and a stale finish cannot complete it", () => {
    const { root, queue } = fixture();
    queue.enqueue(item.project, item.area, A);
    const oldToken = queue.claim(item)!;
    const next = { ...item, key: B };
    createAutomaticPromotions({ root }).enqueue(next.project, next.area, B);
    expect(queue.pending()).toEqual([item]);
    expect(queue.claim(next)).toBeNull();
    queue.finish(item, oldToken);
    expect(queue.pending()).toEqual([next]);
    const newToken = queue.claim(next)!;
    queue.finish(item, oldToken);
    queue.finish(next, oldToken);
    expect(queue.pending()).toEqual([next]);
    queue.finish(next, newToken);
    expect(queue.pending()).toEqual([]);
  });

  it("coalesces unstarted snapshots while retaining distinct project/PM slots", () => {
    const { queue } = fixture();
    queue.enqueue("shop", "checkout", A);
    queue.enqueue("shop", "checkout", B);
    queue.enqueue("shop", "search", C);
    queue.enqueue("docs", "checkout", A);
    expect(queue.pending()).toEqual([
      { project: "shop", area: "checkout", key: B },
      { project: "shop", area: "search", key: C },
      { project: "docs", area: "checkout", key: A },
    ]);
    expect(queue.claim(item)).toBeNull();
  });

  it("recovers a real departed controller's claim without losing a newer queued key", () => {
    const { root, queue } = fixture();
    queue.enqueue(item.project, item.area, A);
    const module = pathToFileURL(
      join(process.cwd(), "src/delivery/automatic.ts"),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {createAutomaticPromotions} from ${JSON.stringify(module)};
       const q=createAutomaticPromotions({root:process.argv[1]});
       console.log(q.claim(${JSON.stringify(item)}));`,
        root,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    expect(child.status, child.stderr).toBe(0);
    const oldToken = child.stdout.trim();
    expect(oldToken).toMatch(/^[a-f0-9]{64}$/);
    queue.enqueue(item.project, item.area, B);
    const recoveredToken = queue.claim(item)!;
    expect(recoveredToken).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveredToken).not.toBe(oldToken);
    queue.finish(item, oldToken);
    expect(queue.pending()).toEqual([item]);
    queue.finish(item, recoveredToken);
    expect(queue.pending()).toEqual([{ ...item, key: B }]);
  });

  it("recovers an abandoned write lock but does not steal a live lock", () => {
    const { queue, lock } = fixture();
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: B }));
    queue.enqueue(item.project, item.area, A);
    expect(lstatSync(lock, { throwIfNoEntry: false })).toBeUndefined();
    const live = JSON.stringify({ pid: process.pid, token: C });
    writeFileSync(lock, live);
    expect(() => queue.claim(item)).toThrow(/busy/);
    expect(readFileSync(lock, "utf8")).toBe(live);
    expect(queue.pending()).toEqual([item]);
  });

  it("fails closed on malformed and oversize state without overwriting it", () => {
    const { queue, file } = fixture();
    mkdirSync(dirname(file), { recursive: true });
    for (const data of [
      "not json",
      JSON.stringify({ schema: 2, slots: [] }),
      JSON.stringify({
        schema: 1,
        slots: [{ project: "shop", area: "checkout", queued: "not-a-digest" }],
      }),
      " ".repeat(256 * 1024 + 1),
    ]) {
      writeFileSync(file, data);
      expect(() => queue.pending()).toThrow(/cannot be read safely/);
      expect(() => queue.enqueue(item.project, item.area, A)).toThrow(
        /cannot be read safely/,
      );
      expect(readFileSync(file, "utf8")).toBe(data);
    }
  });

  it("enforces the 200 project/PM limit before writing and still updates existing slots", () => {
    const { queue, file } = fixture();
    mkdirSync(dirname(file), { recursive: true });
    const data = JSON.stringify({
      schema: 1,
      slots: Array.from({ length: 200 }, (_, i) => ({
        project: `app-${i}`,
        area: "core",
        finished: A,
      })),
    });
    writeFileSync(file, data);
    expect(() => queue.enqueue("extra", "core", B)).toThrow(/200/);
    expect(readFileSync(file, "utf8")).toBe(data);
    queue.enqueue("app-0", "core", B);
    expect(queue.pending()).toEqual([
      { project: "app-0", area: "core", key: B },
    ]);
  });

  it("rejects unsafe identifiers without echoing submitted values", () => {
    const { queue, file } = fixture();
    for (const bad of [
      "../secret",
      "CON",
      "nul",
      "app/x",
      "a\ncredential",
      "a".repeat(64),
    ]) {
      expect(() => queue.enqueue(bad, "core", A)).toThrow(/valid project/);
    }
    expect(() => queue.enqueue("app", "core", "synthetic-secret")).toThrow(
      /verification identifiers/,
    );
    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("rejects hard-linked state and locks without modifying the other link", () => {
    const { root, queue, file, lock } = fixture();
    queue.enqueue(item.project, item.area, A);
    const outside = join(root, "original.json");
    linkSync(file, outside);
    const original = readFileSync(outside, "utf8");
    expect(() => queue.pending()).toThrow(/cannot be read safely/);
    expect(() => queue.enqueue(item.project, item.area, B)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe(original);
    rmSync(outside);
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: C }));
    linkSync(lock, outside);
    expect(() => queue.claim(item)).toThrow();
    expect(lstatSync(lock).nlink).toBe(2);
  });

  it("rejects symlinked parent directories without creating outside state", () => {
    const { root, queue } = fixture();
    const outside = fixture().root;
    symlinkSync(
      outside,
      join(root, ".run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => queue.pending()).toThrow(/cannot be read safely/);
    expect(() => queue.enqueue(item.project, item.area, A)).toThrow();
    expect(
      lstatSync(join(outside, "delivery"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });
});
