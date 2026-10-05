import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type Status = {
  phase?: string;
  checkedAt?: string;
  restartRequired?: boolean;
  [key: string]: unknown;
};
type View = { title: string; action: string | null; disabled: boolean } | null;
const interval = 15 * 60 * 1000;
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T01:00:00Z"));
  const events = new Map<string, () => Promise<void>>();
  const addEventListener = (name: string, callback: () => Promise<void>) =>
    events.set(name, callback);
  const removeEventListener = (name: string) => events.delete(name);
  const document = {
    visibilityState: "visible",
    addEventListener,
    removeEventListener,
  };
  const environment = {
    document,
    addEventListener,
    removeEventListener,
    setTimeout,
    clearTimeout,
  };
  const context = { window: environment, Date };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/update-banner.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const module = (
    environment as unknown as {
      createUpdateBanner: {
        view(status: Status | null, options: Record<string, boolean>): View;
        createRefresh(
          options: {
            check: () => Promise<void>;
            getStatus: () => Status;
            canCheck: () => boolean;
          },
          env: typeof environment,
        ): { start(): void; stop(): void };
      };
    }
  ).createUpdateBanner;
  return { module, environment, events, document };
}
afterEach(() => vi.useRealTimers());

describe("dashboard update banner", () => {
  it("only offers installation when the updater permits it", () => {
    const { module } = fixture();
    const authenticated = { authenticated: true };
    expect(module.view({ phase: "idle" }, authenticated)).toBeNull();
    expect(module.view({ phase: "checking" }, authenticated)).toBeNull();
    expect(module.view({ phase: "available" }, {})).toBeNull();
    expect(
      module.view(
        { phase: "available", latestVersion: "0.7.0" },
        authenticated,
      ),
    ).toMatchObject({
      action: "apply",
      disabled: false,
      title: "ShipGremlins 0.7.0 is available",
    });
    expect(
      module.view({ phase: "available" }, { ...authenticated, busy: true }),
    ).toMatchObject({ action: "apply", disabled: true });
    expect(
      module.view({ phase: "error", latestVersion: "0.7.0" }, authenticated),
    ).toMatchObject({ action: "check" });
  });

  it("distinguishes installing, staged restart and unsupported supervisor restart", () => {
    const { module } = fixture();
    const options = { authenticated: true };
    expect(module.view({ phase: "installing" }, options)).toMatchObject({
      action: null,
      disabled: true,
    });
    expect(
      module.view(
        {
          phase: "ready",
          restartRequired: true,
          installedVersion: "0.7.0",
          latestVersion: "0.8.0",
          canRestart: true,
        },
        options,
      ),
    ).toMatchObject({
      title: "ShipGremlins 0.7.0 is ready",
      action: "restart",
    });
    expect(
      module.view(
        { phase: "ready", restartRequired: true, canRestart: false },
        options,
      ),
    ).toMatchObject({ action: null });
    expect(
      module.view(
        { phase: "ready", restartRequired: true, canRestart: true },
        { ...options, restarting: true },
      ),
    ).toMatchObject({ action: null, disabled: true });
  });

  it("discovers a release after fifteen minutes without reloading the page", async () => {
    const { module, environment } = fixture();
    const check = vi.fn(async () => {});
    const refresh = module.createRefresh(
      { check, getStatus: () => ({ phase: "idle" }), canCheck: () => true },
      environment,
    );
    refresh.start();
    refresh.start();
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    refresh.stop();
  });

  it("checks on returning to a visible stale tab, with no focus/online request storm", async () => {
    const { module, environment, events, document } = fixture();
    const check = vi.fn(async () => {});
    const refresh = module.createRefresh(
      { check, getStatus: () => ({ phase: "idle" }), canCheck: () => true },
      environment,
    );
    refresh.start();
    document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(interval);
    expect(check).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    await events.get("visibilitychange")!();
    await events.get("focus")!();
    await events.get("online")!();
    expect(check).toHaveBeenCalledTimes(1);
    refresh.stop();
  });

  it("respects a fresh manual check and never checks during an update or after staging", async () => {
    const { module, environment, events } = fixture();
    let status: Status = { phase: "idle" };
    let permitted = true;
    const check = vi.fn(async () => {});
    const refresh = module.createRefresh(
      { check, getStatus: () => status, canCheck: () => permitted },
      environment,
    );
    refresh.start();
    await vi.advanceTimersByTimeAsync(interval - 1);
    status.checkedAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).not.toHaveBeenCalled();
    status = { phase: "installing" };
    await vi.advanceTimersByTimeAsync(interval);
    status = { phase: "ready", restartRequired: true };
    await vi.advanceTimersByTimeAsync(interval);
    status = { phase: "idle" };
    permitted = false;
    await events.get("focus")!();
    expect(check).not.toHaveBeenCalled();
    refresh.stop();
  });

  it("does not overlap checks and removes callbacks when the page closes", async () => {
    const { module, environment, events } = fixture();
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = module.createRefresh(
      { check, getStatus: () => ({ phase: "idle" }), canCheck: () => true },
      environment,
    );
    refresh.start();
    await vi.advanceTimersByTimeAsync(interval);
    await events.get("online")!();
    await vi.advanceTimersByTimeAsync(interval);
    expect(check).toHaveBeenCalledTimes(1);
    refresh.stop();
    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(events.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
