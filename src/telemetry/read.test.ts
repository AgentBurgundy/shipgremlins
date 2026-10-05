import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type Project } from "../config.ts";
import { addProject } from "../commands/addProject.ts";
import { runLogs } from "../commands/logs.ts";
import { runMetric } from "../commands/metric.ts";
import { doctorChecks } from "../commands/doctor.ts";
import { inspectSetup } from "../setup/preflight.ts";
import { readConnections, saveConnections } from "../setup/connections.ts";
import { parseTelemetry } from "./config.ts";
import { readLogs, readMixpanel, type TelemetryDeps } from "./read.ts";
import { createJobPreparation } from "../localRunners/jobs.ts";
import { pmTelemetrySnapshot } from "./snapshot.ts";
import { createDashboardServer } from "../commands/dashboard.ts";
import type { AddressInfo } from "node:net";

const templates = fileURLToPath(new URL("../..", import.meta.url));
const settings = {
  sentry: {
    host: "de.sentry.io",
    organization: "acme",
    project: "checkout",
    environment: "production",
    tokenSecret: "SENTRY_AUTH_TOKEN_SHOP",
  },
  datadog: {
    site: "datadoghq.eu",
    service: "checkout-api",
    environment: "production",
    apiKeySecret: "DD_API_KEY_SHOP",
    appKeySecret: "DD_APP_KEY_SHOP",
  },
  mixpanel: {
    region: "eu",
    projectId: "123",
    workspaceId: "45",
    usernameSecret: "MIXPANEL_USERNAME_SHOP",
    passwordSecret: "MIXPANEL_PASSWORD_SHOP",
  },
};
const env = {
  SENTRY_AUTH_TOKEN_SHOP: "sentry-test-secret",
  DD_API_KEY_SHOP: "dd-api-secret",
  DD_APP_KEY_SHOP: "dd-app-secret",
  MIXPANEL_USERNAME_SHOP: "service-account-test",
  MIXPANEL_PASSWORD_SHOP: "mixpanel-test-secret",
};
const now = () => new Date("2026-10-04T12:00:00Z");
const report = {
  computed_at: "2026-10-04T11:59:00Z",
  date_range: {
    from_date: "2026-09-01T00:00:00Z",
    to_date: "2026-09-30T23:59:59Z",
  },
  headers: ["$event"],
  series: { "Checkout complete": { "2026-09-01": 0, "2026-09-02": 12 } },
};
let root: string;
let project: Project;
let output: string[];
let errors: string[];
const io = {
  log: (line: string) => output.push(line),
  error: (line: string) => errors.push(line),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sg-telemetry-"));
  addProject(root, { name: "shop", repo: "acme/shop" }, templates);
  const path = join(root, "projects/shop/project.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...JSON.parse(readFileSync(path, "utf8")),
      telemetry: settings,
    }),
  );
  const areaPath = join(root, "projects/shop/areas.json");
  const areas = JSON.parse(readFileSync(areaPath, "utf8"));
  areas.areas.core.mixpanelReportId = "987";
  writeFileSync(areaPath, JSON.stringify(areas));
  project = loadProject(root, "shop");
  output = [];
  errors = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(transport: TelemetryDeps["fetch"]): TelemetryDeps {
  return { env, fetch: transport, now };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

describe("project telemetry configuration", () => {
  it("exposes project credential fields and saved status without exposing their values", async () => {
    const session = "a".repeat(64);
    const server = createDashboardServer(root, templates, session);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = {
      Authorization: `Bearer ${session}`,
      "Content-Type": "application/json",
    };
    try {
      const saved = await fetch(`${url}/api/connections`, {
        method: "POST",
        headers,
        body: JSON.stringify({ values: env }),
      });
      expect(saved.status).toBe(200);
      const status = (await (
        await fetch(`${url}/api/status`, { headers })
      ).json()) as {
        connections: { name: string; configured: boolean; label: string }[];
      };
      for (const [name, value] of Object.entries(env)) {
        expect(status.connections).toContainEqual(
          expect.objectContaining({
            name,
            configured: true,
            project: "shop",
            group: "telemetry",
            label: expect.any(String),
          }),
        );
        expect(JSON.stringify(status)).not.toContain(value);
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it("keeps old configurations optional and restricts destinations and credential references", () => {
    expect(parseTelemetry(undefined)).toBeUndefined();
    expect(project.config.telemetry).toEqual(settings);
    for (const bad of [
      { sentry: { ...settings.sentry, project: "-1" } },
      { sentry: { ...settings.sentry, project: "*" } },
      { sentry: { ...settings.sentry, host: "evil.example" } },
      { sentry: { ...settings.sentry, tokenSecret: "actual-token" } },
      { datadog: { ...settings.datadog, environment: "prod OR *" } },
      { datadog: { ...settings.datadog, service: "" } },
      { datadog: { ...settings.datadog, site: "datadoghq.com.evil.example" } },
      { mixpanel: { ...settings.mixpanel, projectId: "-1" } },
      { mixpanel: { ...settings.mixpanel, usernameSecret: "NODE_OPTIONS" } },
      { mixpanel: { ...settings.mixpanel, region: "unknown" } },
    ])
      expect(() => parseTelemetry(bad)).toThrow();
  });
  it("refuses a report without a Mixpanel connection", () => {
    const path = join(root, "projects/shop/project.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.telemetry.mixpanel;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => loadProject(root, "shop")).toThrow(/mixpanelReportId/);
  });
  it("saves and loads per-project credentials without importing unrelated environment controls", () => {
    saveConnections(root, env);
    expect(readConnections(root)).toEqual(env);
    expect(() =>
      saveConnections(root, { NODE_OPTIONS: "--inspect" }),
    ).toThrow();
    const preflight = inspectSetup(
      root,
      { env, nodeVersion: "22.15.0", probe: () => ({ available: true }) },
      "shop",
    );
    expect(
      preflight.secrets.filter((secret) =>
        Object.keys(env).includes(secret.name),
      ),
    ).toHaveLength(5);
    expect(JSON.stringify(preflight)).not.toContain(env.SENTRY_AUTH_TOKEN_SHOP);
  });
});

describe("scoped log reads", () => {
  it("reads both Sentry datasets and exact Datadog service/environment, preserving sample provenance", async () => {
    const transport = vi.fn(async (raw: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url = new URL(raw);
      if (url.host === "de.sentry.io") {
        expect(url.pathname).toBe("/api/0/organizations/acme/events/");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          project: "checkout",
          environment: "production",
          start: "2026-10-03T12:00:00.000Z",
          end: "2026-10-04T12:00:00.000Z",
          per_page: "1",
        });
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${env.SENTRY_AUTH_TOKEN_SHOP}`,
        });
        return response({
          data:
            url.searchParams.get("dataset") === "logs"
              ? [
                  {
                    "sentry.item_id": "log-1",
                    timestamp: now().toISOString(),
                    severity: "error",
                    message: "Checkout timeout",
                  },
                ]
              : [
                  {
                    id: "error-1",
                    timestamp: now().toISOString(),
                    level: "error",
                    title: "TimeoutError",
                  },
                ],
        });
      }
      expect(url.href).toBe(
        "https://api.datadoghq.eu/api/v2/logs/events/search",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "DD-API-KEY": env.DD_API_KEY_SHOP,
        "DD-APPLICATION-KEY": env.DD_APP_KEY_SHOP,
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        filter: {
          query: 'service:"checkout-api" AND env:"production"',
          from: "2026-10-03T12:00:00.000Z",
        },
        page: { limit: 1 },
      });
      return response({
        data: [
          {
            id: "dd-1",
            attributes: {
              timestamp: now().toISOString(),
              status: "error",
              message: "Timeout",
              service: "checkout-api",
              attributes: { password: "do-not-output" },
            },
          },
        ],
        meta: { page: { after: "cursor" } },
      });
    });
    const signals = await readLogs(project.config, deps(transport), {
      limit: 1,
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(signals.map((signal) => signal.status)).toEqual(["ok", "ok", "ok"]);
    expect(signals.every((signal) => signal.limited)).toBe(true);
    expect(signals[0]?.scope.project).toBe("checkout");
    expect(JSON.stringify(signals)).not.toContain("do-not-output");
  });
  it("does not use another project's credentials or make requests for unconfigured providers", async () => {
    const transport = vi.fn();
    const result = await readLogs(project.config, {
      env: { SENTRY_AUTH_TOKEN_OTHER: "other" },
      fetch: transport,
      now,
    });
    expect(result.every((signal) => signal.status === "unavailable")).toBe(
      true,
    );
    expect(transport).not.toHaveBeenCalled();
    const unconfigured = await readLogs(
      { ...project.config, telemetry: undefined },
      deps(transport),
    );
    expect(
      unconfigured.every((signal) => signal.status === "not-configured"),
    ).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps successful empty reads separate from denied and rate-limited sources without leaking error bodies", async () => {
    const transport = vi.fn(async (url: string) =>
      url.includes("datadoghq")
        ? response({ data: [] })
        : response(
            { error: env.SENTRY_AUTH_TOKEN_SHOP },
            url.includes("dataset=errors") ? 429 : 403,
          ),
    );
    const signals = await readLogs(project.config, deps(transport));
    expect(signals.map((signal) => signal.status)).toEqual([
      "unavailable",
      "unavailable",
      "ok",
    ]);
    expect(signals[2]?.data).toEqual([]);
    expect(signals[0]?.detail).toContain("403");
    expect(signals[1]?.detail).toContain("429");
    expect(JSON.stringify(signals)).not.toContain(env.SENTRY_AUTH_TOKEN_SHOP);
  });
  it.each([{}, { data: [null] }, { data: [{ timestamp: "today" }] }])(
    "does not mistake malformed response %j for empty logs",
    async (body) => {
      const result = await readLogs(
        project.config,
        deps(async () => response(body)),
      );
      expect(result.every((signal) => signal.status === "unavailable")).toBe(
        true,
      );
    },
  );
  it("redacts credentials and common PII from messages and bounds long messages", async () => {
    const message = `token=oops ${env.DD_API_KEY_SHOP} person@example.com 10.2.3.4 Bearer abc ${"x".repeat(2500)}`;
    const signals = await readLogs(
      project.config,
      deps(async () =>
        response({
          data: [
            {
              id: "dd",
              attributes: {
                timestamp: now().toISOString(),
                message,
                status: "error",
              },
            },
          ],
        }),
      ),
      { provider: "datadog" },
    );
    const serialized = JSON.stringify(signals);
    for (const secret of [
      "oops",
      env.DD_API_KEY_SHOP,
      "person@example.com",
      "10.2.3.4",
      "Bearer abc",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect((signals[0]?.data as { message: string }[])[0]!.message.length).toBe(
      2000,
    );
  });
  it("returns unavailable for oversized or network failures", async () => {
    for (const transport of [
      async () => new Response("x".repeat(1_048_577)),
      async () => {
        throw new Error(env.DD_APP_KEY_SHOP);
      },
    ]) {
      const signals = await readLogs(project.config, deps(transport), {
        provider: "datadog",
      });
      expect(signals[0]?.status).toBe("unavailable");
      expect(JSON.stringify(signals)).not.toContain(env.DD_APP_KEY_SHOP);
    }
  });
  it("rejects broadening/invalid flags before making requests and allows useful partial output", async () => {
    const transport = vi.fn(async () => response({ data: [] }));
    for (const args of [
      ["--hours", "169"],
      ["--limit"],
      ["--limit", "101"],
      ["--query", "*"],
      ["--provider", "unknown"],
    ]) {
      expect(
        await runLogs(
          root,
          ["--project", "shop", ...args],
          io,
          deps(transport),
        ),
      ).toBe(1);
    }
    expect(transport).not.toHaveBeenCalled();
    expect(
      await runLogs(root, ["--project", "shop", "--provider", "sentry"], io, {
        ...deps(transport),
        env: {},
      }),
    ).toBe(0);
    expect(
      JSON.parse(output[0]!).sources.every(
        (source: { status: string }) => source.status === "unavailable",
      ),
    ).toBe(true);
  });
});

describe("Mixpanel analytics", () => {
  it("gives local PMs scoped evidence without placing telemetry credentials in the worker", async () => {
    writeFileSync(
      join(root, "hub.json"),
      JSON.stringify({ runners: { mode: "local" } }),
    );
    const projectPath = join(root, "projects/shop/project.json");
    const raw = JSON.parse(readFileSync(projectPath, "utf8"));
    raw.verified = "2026-10-04";
    writeFileSync(projectPath, JSON.stringify(raw));
    const areaPath = join(root, "projects/shop/areas.json");
    const areas = JSON.parse(readFileSync(areaPath, "utf8"));
    areas.areas.core.enabled = true;
    areas.areas.core.linearProjectId = "linear-core-test";
    areas.areas.core.mandate = "Review checkout telemetry and reproduce gaps.";
    writeFileSync(areaPath, JSON.stringify(areas));
    saveConnections(root, env);
    const preparation = createJobPreparation({
      root,
      now,
      env: {
        GITHUB_TOKEN: "github-test",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-test",
        LINEAR_API_KEY: "linear-test",
        VERCEL_TOKEN: "vercel-test",
        SENTRY_AUTH_TOKEN_OTHER: "other-project-secret",
      },
      preview: async () => "https://preview.example.com",
      linear: () => ({
        getTicket: async () => null,
        listTickets: async () => [],
        getProject: async () => ({
          id: "linear-core-test",
          name: "Core",
          url: "https://linear.app/test/project/core",
          teamIds: [],
        }),
      }),
      telemetryFetch: async (url) =>
        response(url.includes("mixpanel") ? report : { data: [] }),
    });
    const payload = await preparation.prepareJob({
      id: "job-1",
      runId: 1,
      type: "pm",
      project: "shop",
      area: "core",
      status: "queued",
      createdAt: now().toISOString(),
    });
    expect(payload.prompt).toContain("Project telemetry snapshot");
    expect(payload.prompt).toContain('"project":"checkout"');
    expect(payload.prompt).toContain('"Checkout complete"');
    for (const [key, value] of Object.entries(env)) {
      expect(payload.credentials).not.toHaveProperty(key);
      expect(JSON.stringify(payload)).not.toContain(value);
    }
    expect(JSON.stringify(payload)).not.toContain("other-project-secret");
  });
  it("keeps oversized analytics out of local prompts while retaining log evidence", async () => {
    const large = {
      ...report,
      series: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [
          `A long metric breakdown label ${i}`,
          i,
        ]),
      ),
    };
    const snapshot = await pmTelemetrySnapshot(
      project.config,
      project.areas[0]!,
      deps(async (url) =>
        response(url.includes("mixpanel") ? large : { data: [] }),
      ),
    );
    expect(snapshot).toContain("narrow the saved report");
    expect(snapshot).not.toContain("A long metric breakdown label");
    expect(snapshot).toContain('"status":"ok"');
  });
  it("uses the configured region, project, workspace and saved report; keeps dates and units", async () => {
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://eu.mixpanel.com/api/query/insights?project_id=123&bookmark_id=987&workspace_id=45",
      );
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${Buffer.from(`${env.MIXPANEL_USERNAME_SHOP}:${env.MIXPANEL_PASSWORD_SHOP}`).toString("base64")}`,
      });
      return response(report);
    });
    expect(
      await runMetric(
        root,
        ["--project", "shop", "--area", "core"],
        io,
        deps(transport),
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      provider: "mixpanel",
      status: "ok",
      scope: { projectId: "123", reportId: "987" },
      data: report,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not fall back to Vercel or invent zero activity on inaccessible or malformed reports", async () => {
    for (const body of [
      { error: "access denied" },
      { series: {} },
      { ...report, headers: [null] },
    ]) {
      const transport = vi.fn(async () => response(body));
      const signal = await readMixpanel(
        project.config,
        project.areas[0]!,
        deps(transport),
      );
      expect(signal.status).toBe("unavailable");
      expect(signal.data).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const transport = vi.fn();
    await runMetric(root, ["--project", "shop", "--area", "core"], io, {
      env: { VERCEL_TOKEN: "present" },
      fetch: transport,
    });
    expect(JSON.parse(output[0]!).status).toBe("unavailable");
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps the Vercel path for areas without a report", async () => {
    const path = join(root, "projects/shop/areas.json");
    const areas = JSON.parse(readFileSync(path, "utf8"));
    delete areas.areas.core.mixpanelReportId;
    writeFileSync(path, JSON.stringify(areas));
    await runMetric(root, ["--project", "shop", "--area", "core"], io, {
      env: {},
      fetch: vi.fn(),
    });
    expect(output).toEqual(["unavailable"]);
  });
  it("doctor checks configured telemetry and missing credentials as failures", async () => {
    const checks = await doctorChecks(project, {
      env: {},
      fetch: vi.fn(),
      today: () => "2026-10-04",
    });
    expect(
      checks.filter((check) => /sentry|datadog|Mixpanel/.test(check.name)),
    ).toHaveLength(4);
    expect(
      checks
        .filter((check) => /sentry|datadog|Mixpanel/.test(check.name))
        .every((check) => !check.ok),
    ).toBe(true);
  });
});
