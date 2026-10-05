import { afterEach, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { readConnections } from "./setup/connections.ts";
import { runController } from "./commands/controller.ts";

vi.mock("./commands/controller.ts", () => ({
  runController: vi.fn(async () => 0),
}));
vi.mock("./setup/connections.ts", async (original) => ({
  ...(await original<typeof import("./setup/connections.ts")>()),
  readConnections: vi.fn(() => ({ RAILWAY_TOKEN: "saved-fixture-token" })),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each(["start", "stop", "status"])(
  "%s does not freeze saved credentials into the controller's inherited environment",
  async (command) => {
    vi.stubEnv("RAILWAY_TOKEN", undefined);
    expect(await main([command])).toBe(0);
    expect(runController).toHaveBeenCalledOnce();
    expect(readConnections).not.toHaveBeenCalled();
    expect(process.env.RAILWAY_TOKEN).toBeUndefined();
  },
);

it("preserves explicitly exported credentials for a background controller", async () => {
  vi.stubEnv("RAILWAY_TOKEN", "exported-fixture-token");
  expect(await main(["start"])).toBe(0);
  expect(process.env.RAILWAY_TOKEN).toBe("exported-fixture-token");
  expect(readConnections).not.toHaveBeenCalled();
});
