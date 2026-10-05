import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardOutputReader,
  dashboardOutputDeadline,
} from "./dashboardOutput.ts";

afterEach(() => vi.useRealTimers());

describe("bounded dashboard output reads", () => {
  it("retains a useful snapshot while a slow refresh runs only once", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-05") });
    const read = createDashboardOutputReader();
    let finish!: (value: string[]) => void;
    const load = vi.fn(async () => ["First output"]);
    expect(await read("logs", load, 1500)).toMatchObject({
      value: ["First output"],
      pending: false,
    });
    load.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(800);
    const refresh = read("logs", load, 1500);
    await vi.advanceTimersByTimeAsync(50);
    expect(await refresh).toMatchObject({
      value: ["First output"],
      available: true,
      pending: true,
    });
    const repeated = read("logs", load, 1500);
    await vi.advanceTimersByTimeAsync(50);
    expect(await repeated).toMatchObject({
      value: ["First output"],
      pending: true,
    });
    expect(load).toHaveBeenCalledTimes(2);
    finish(["New public action"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await read("logs", load, 1500)).toMatchObject({
      value: ["New public action"],
      pending: false,
    });
  });

  it("caps stuck output sources and does not queue unlimited reads", async () => {
    const read = createDashboardOutputReader();
    const load = vi.fn(() => new Promise<never>(() => {}));
    await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        read(`output-${index}`, load, 0),
      ),
    );
    expect(load).toHaveBeenCalledTimes(128);
  });

  it("bounds one-off downloads without retaining late bytes", async () => {
    vi.useFakeTimers();
    const result = dashboardOutputDeadline(
      () => new Promise<never>(() => {}),
      5000,
    );
    const assertion = expect(result).rejects.toThrow("Output read timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
