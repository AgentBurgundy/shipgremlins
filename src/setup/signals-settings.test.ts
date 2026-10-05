import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseTelemetry, type TelemetryConfig } from "../telemetry/config.ts";
import { initializeSetup } from "./files.ts";
import { createDashboardServer } from "../commands/dashboard.ts";

type Provider = "sentry" | "datadog" | "mixpanel";
interface Model {
  get(provider: Provider): { enabled: boolean; values: Record<string, string> };
  set(provider: Provider, key: string, value: string): void;
  enable(provider: Provider, enabled: boolean): void;
  setProjectName(name: string): void;
  isDirty(): boolean;
  read(): TelemetryConfig;
}
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(
  join(packageRoot, "dashboard/signals-settings.js"),
  "utf8",
);
function model(initial?: TelemetryConfig, projectName = "my-app"): Model {
  const window = {} as {
    createSignalsSettingsModel(
      initial?: TelemetryConfig,
      options?: { projectName: string },
    ): Model;
  };
  runInNewContext(script, { window, structuredClone });
  return window.createSignalsSettingsModel(initial, { projectName });
}
const sentry: NonNullable<TelemetryConfig["sentry"]> = {
  host: "de.sentry.io",
  organization: "our-org",
  project: "our-app",
  environment: "staging",
  tokenSecret: "SENTRY_AUTH_TOKEN_EXISTING",
};
const mixpanel: NonNullable<TelemetryConfig["mixpanel"]> = {
  region: "eu",
  projectId: "123",
  workspaceId: "456",
  usernameSecret: "MIXPANEL_USERNAME_EXISTING",
  passwordSecret: "MIXPANEL_PASSWORD_EXISTING",
};
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("dashboard signals settings model", () => {
  it("leaves optional providers absent until deliberately enabled", () => {
    const settings = model();
    expect(settings.read()).toEqual({});
    expect(settings.isDirty()).toBe(false);
    settings.setProjectName("renamed-app");
    expect(settings.read()).toEqual({});
    expect(settings.isDirty()).toBe(false);
  });
  it("generates scoped secret references and settings accepted by the backend for all providers", () => {
    const settings = model(undefined, "My-app.example");
    settings.enable("sentry", true);
    settings.set("sentry", "organization", "team");
    settings.set("sentry", "project", "web");
    settings.set("sentry", "environment", "staging");
    settings.enable("datadog", true);
    settings.set("datadog", "site", "ap2.datadoghq.com");
    settings.set("datadog", "service", "web");
    settings.set("datadog", "environment", "staging");
    settings.enable("mixpanel", true);
    settings.set("mixpanel", "projectId", " 123 ");
    settings.set("mixpanel", "workspaceId", "");
    const config = settings.read();
    expect(parseTelemetry(config)).toEqual(config);
    expect(config.sentry?.tokenSecret).toBe("SENTRY_AUTH_TOKEN_MY_APP_EXAMPLE");
    expect(config.datadog?.appKeySecret).toBe("DD_APP_KEY_MY_APP_EXAMPLE");
    expect(config.mixpanel?.usernameSecret).toBe(
      "MIXPANEL_USERNAME_MY_APP_EXAMPLE",
    );
    expect(config.mixpanel).not.toHaveProperty("workspaceId");
    expect(settings.isDirty()).toBe(true);
  });
  it("preserves existing custom references and provider values while changing another provider", () => {
    const original = { sentry, mixpanel };
    const settings = model(original);
    settings.setProjectName("a-new-app");
    settings.enable("datadog", true);
    settings.set("datadog", "service", "backend");
    settings.set("datadog", "environment", "qa");
    expect(settings.read()).toMatchObject(original);
    expect(settings.read().datadog?.apiKeySecret).toBe("DD_API_KEY_A_NEW_APP");
    expect(original).toEqual({ sentry, mixpanel });
  });
  it("renames generated references but preserves deliberately edited custom names", () => {
    const settings = model();
    settings.set("datadog", "apiKeySecret", "DD_API_KEY_SHARED");
    settings.setProjectName("9-special");
    expect(settings.get("datadog").values.apiKeySecret).toBe(
      "DD_API_KEY_SHARED",
    );
    expect(settings.get("datadog").values.appKeySecret).toBe(
      "DD_APP_KEY_APP_9_SPECIAL",
    );
  });
  it("disabling removes only the selected provider and toggling back restores its values", () => {
    const settings = model({ sentry, mixpanel });
    expect(settings.isDirty()).toBe(false);
    settings.enable("sentry", false);
    expect(settings.read()).toEqual({ mixpanel });
    expect(settings.isDirty()).toBe(true);
    settings.enable("sentry", true);
    expect(settings.read()).toEqual({ sentry, mixpanel });
    expect(settings.isDirty()).toBe(false);
  });
  it.each([
    ["sentry", "environment", "*"],
    ["sentry", "host", "attacker.example"],
    ["sentry", "tokenSecret", "real-token-value"],
    ["mixpanel", "projectId", "0"],
    ["mixpanel", "workspaceId", "not-numeric"],
    ["mixpanel", "region", "unknown"],
  ] as const)(
    "rejects invalid %s %s before config submission",
    (provider, key, value) => {
      const settings = model({ sentry, mixpanel });
      settings.set(provider, key, value);
      expect(() => settings.read()).toThrow();
    },
  );
  it("roundtrips generated form settings through the revision-checked dashboard API without changing tokens or unrelated config", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-signals-test-"));
    directories.push(root);
    initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
    writeFileSync(
      join(root, ".env"),
      "SENTRY_AUTH_TOKEN_EXISTING=fixture-value-kept\nOTHER=value\n",
    );
    const session = "b".repeat(64);
    const server = createDashboardServer(root, packageRoot, session);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${session}` };
    const path = "projects/app/project.json";
    const file = (await fetch(
      `${base}/api/config?path=${encodeURIComponent(path)}`,
      { headers: auth },
    ).then((response) => response.json())) as {
      content: string;
      revision: string;
    };
    const original = JSON.parse(file.content);
    const settings = model({ sentry, mixpanel });
    settings.enable("mixpanel", false);
    const response = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        path,
        revision: file.revision,
        content: JSON.stringify({ ...original, telemetry: settings.read() }),
      }),
    });
    expect(response.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(root, path), "utf8"));
    expect(saved.telemetry).toEqual({ sentry });
    expect(saved.commands).toEqual(original.commands);
    expect(saved.workflow).toEqual(original.workflow);
    expect(saved.repo).toBe(original.repo);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(
      "SENTRY_AUTH_TOKEN_EXISTING=fixture-value-kept\nOTHER=value\n",
    );
    const stale = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        path,
        revision: file.revision,
        content: file.content,
      }),
    });
    expect(stale.status).toBe(409);
  });
});
