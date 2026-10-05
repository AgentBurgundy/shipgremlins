import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(
  new URL("../../dashboard/job-output.js", import.meta.url),
  "utf8",
);
type Resource = "activity" | "logs" | "artifacts";
interface Context {
  id: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
interface Controller {
  select(id: string): boolean;
  refresh(): Promise<unknown>;
  resume(): Promise<unknown>;
  pause(): void;
  close(): void;
  invalidate(resource: Resource): void;
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
function fixture(
  load: (
    resource: Resource,
    id: string,
    signal: AbortSignal,
  ) => unknown = async (resource) => ({ resource }),
  paint?: (resource: Resource, value: unknown, context: Context) => unknown,
) {
  const window = {} as { createJobOutput: (options: object) => Controller };
  runInNewContext(script, { window, AbortController });
  const requests = vi.fn(load),
    render = vi.fn(paint || (() => {})),
    errors = vi.fn(),
    busy = vi.fn();
  const helper = window.createJobOutput({
    load: requests,
    render,
    onError: errors,
    onBusy: busy,
  });
  return { helper, requests, render, errors, busy };
}

describe("visible job output", () => {
  it("paints activity and logs before a slow artifact list finishes", async () => {
    const artifacts = deferred();
    const f = fixture(async (resource) =>
      resource === "artifacts" ? artifacts.promise : { resource },
    );
    f.helper.select("first");
    const pending = f.helper.resume();
    await flush();
    expect(f.render.mock.calls.map(([name]) => name)).toEqual([
      "activity",
      "logs",
    ]);
    artifacts.resolve({ files: [] });
    await pending;
    expect(f.render).toHaveBeenCalledTimes(3);
  });
  it("deduplicates in-flight resources while allowing fresh logs during a slow screenshot render", async () => {
    const image = deferred();
    const f = fixture(undefined, async (resource) =>
      resource === "artifacts" ? image.promise : undefined,
    );
    f.helper.select("first");
    const first = f.helper.resume();
    const second = f.helper.refresh();
    await flush();
    expect(f.requests).toHaveBeenCalledTimes(3);
    const third = f.helper.refresh();
    await flush();
    expect(
      f.requests.mock.calls.filter(([name]) => name === "artifacts"),
    ).toHaveLength(1);
    expect(
      f.requests.mock.calls.filter(([name]) => name === "logs"),
    ).toHaveLength(2);
    image.resolve(undefined);
    await Promise.all([first, second, third]);
  });
  it("retains unchanged resource DOM across polling and repeated selection", async () => {
    const f = fixture();
    expect(f.helper.select("first")).toBe(true);
    await f.helper.resume();
    expect(f.helper.select("first")).toBe(false);
    await f.helper.refresh();
    expect(f.requests).toHaveBeenCalledTimes(6);
    expect(f.render).toHaveBeenCalledTimes(3);
  });
  it("switches immediately and ignores old successes and failures even if transport ignores abort", async () => {
    const old = deferred();
    const f = fixture(async (resource, id) =>
      id === "first" ? old.promise : { id, resource },
    );
    f.helper.select("first");
    const first = f.helper.resume();
    await flush();
    const signals = f.requests.mock.calls.map(([, , signal]) => signal);
    f.helper.select("second");
    await f.helper.resume();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    old.reject(new Error("old failure"));
    await first;
    expect(
      f.render.mock.calls.every(([, , context]) => context.id === "second"),
    ).toBe(true);
    expect(f.errors.mock.calls.some(([, error]) => error)).toBe(false);
  });
  it("closing stops work and prevents late responses from repainting or scheduling a retry", async () => {
    const response = deferred();
    const f = fixture(async () => response.promise);
    f.helper.select("first");
    const pending = f.helper.resume();
    await flush();
    f.helper.close();
    response.resolve({ lines: ["late"] });
    await pending;
    await f.helper.refresh();
    expect(f.render).not.toHaveBeenCalled();
    expect(f.requests).toHaveBeenCalledTimes(3);
    expect(f.busy).toHaveBeenLastCalledWith(false);
  });
  it("pauses hidden pages and resumes without throwing away loaded resources", async () => {
    const f = fixture();
    f.helper.select("first");
    await f.helper.resume();
    f.helper.pause();
    await f.helper.refresh();
    expect(f.requests).toHaveBeenCalledTimes(3);
    await f.helper.resume();
    expect(f.requests).toHaveBeenCalledTimes(6);
    expect(f.render).toHaveBeenCalledTimes(3);
  });
  it("keeps successful resources independent from errors and retries failed resources", async () => {
    let failed = true;
    const f = fixture(async (resource) => {
      if (resource === "logs" && failed) throw new Error("output pending");
      return { resource };
    });
    f.helper.select("first");
    await f.helper.resume();
    expect(f.render.mock.calls.map(([name]) => name)).toEqual([
      "activity",
      "artifacts",
    ]);
    expect(f.errors).toHaveBeenCalledWith(
      "logs",
      expect.objectContaining({ message: "output pending" }),
    );
    failed = false;
    await f.helper.refresh();
    expect(f.render.mock.calls.map(([name]) => name)).toEqual([
      "activity",
      "artifacts",
      "logs",
    ]);
    expect(f.errors).toHaveBeenCalledWith("logs", null);
  });
  it("invalidates a pending artifact render on selection changes and allows explicit blob restoration", async () => {
    const image = deferred();
    let captured: Context | undefined;
    const f = fixture(undefined, async (resource, _value, context) => {
      if (resource === "artifacts") {
        captured = context;
        await image.promise;
      }
    });
    f.helper.select("first");
    const first = f.helper.resume();
    await flush();
    f.helper.pause();
    expect(captured?.isCurrent()).toBe(false);
    expect(captured?.signal.aborted).toBe(true);
    image.resolve(undefined);
    await first;
    await f.helper.resume();
    f.helper.invalidate("artifacts");
    await f.helper.refresh();
    expect(
      f.render.mock.calls.filter(([name]) => name === "artifacts"),
    ).toHaveLength(3);
  });
});
