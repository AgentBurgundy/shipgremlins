import type { AreaConfig, ProjectConfig } from "../config.ts";
import { fetchWithRetry, HttpError } from "../http.ts";
import { MIXPANEL_HOSTS, telemetrySecrets } from "./config.ts";

export interface TelemetryDeps {
  env: NodeJS.ProcessEnv;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}
export interface SignalResult {
  provider: "sentry" | "datadog" | "mixpanel";
  kind: "logs" | "errors" | "analytics";
  status: "ok" | "unavailable" | "not-configured";
  scope: Record<string, string>;
  detail?: string;
  data?: unknown;
  /** A bounded sample, never a total error count or a clean bill of health. */
  limited?: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Remove known credentials and common credential/PII patterns from selected output fields.
 * This is a best effort; providers must scrub application data before ingestion. */
export function redact(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
    .replace(
      /(["']?(?:password|passwd|token|api[_-]?key|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .split("")
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : character,
    )
    .join("")
    .slice(0, 2000);
}

function credentials(project: ProjectConfig, deps: TelemetryDeps): string[] {
  const values = telemetrySecrets(project.telemetry).map(
    ({ name }) => deps.env[name] ?? "",
  );
  const mp = project.telemetry?.mixpanel;
  if (mp && deps.env[mp.usernameSecret] && deps.env[mp.passwordSecret])
    values.push(
      Buffer.from(
        `${deps.env[mp.usernameSecret]}:${deps.env[mp.passwordSecret]}`,
      ).toString("base64"),
    );
  return values;
}

async function request(
  url: string,
  init: RequestInit,
  deps: TelemetryDeps,
): Promise<{ body: unknown; more: boolean }> {
  const response = await fetchWithRetry(
    url,
    {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
    { fetch: deps.fetch, retries: 0 },
  );
  // Cap provider output before it can enter the agent's context.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("shape");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new Error("size");
    }
    chunks.push(value);
  }
  return {
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    more: /rel="next"[^,]*results="true"/.test(
      response.headers.get("link") ?? "",
    ),
  };
}

function failure(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403)
      return `Access denied (HTTP ${error.status}); check the configured read credentials and project permissions.`;
    if (error.status === 429) return "Rate limited (HTTP 429); retry later.";
    return `Provider request failed (HTTP ${error.status}); check the project scope and provider availability.`;
  }
  return "Provider unavailable, timed out, or returned unsupported/oversized data.";
}

export interface LogOptions {
  provider?: "all" | "sentry" | "datadog";
  hours?: number;
  limit?: number;
}

export async function readLogs(
  project: ProjectConfig,
  deps: TelemetryDeps,
  options: LogOptions = {},
): Promise<SignalResult[]> {
  const hours = options.hours ?? 24;
  const limit = options.limit ?? 25;
  const provider = options.provider ?? "all";
  if (
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 168 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !["all", "sentry", "datadog"].includes(provider)
  )
    throw new Error(
      "Use hours from 1 to 168, limit from 1 to 100, and provider all, sentry or datadog.",
    );
  const end = (deps.now?.() ?? new Date()).toISOString();
  const start = new Date(Date.parse(end) - hours * 3_600_000).toISOString();
  const secrets = credentials(project, deps);
  const clean = (value: unknown) =>
    typeof value === "string" ? redact(value, secrets) : "";
  const tasks: Promise<SignalResult>[] = [];
  if (provider !== "datadog") {
    const config = project.telemetry?.sentry;
    for (const kind of ["logs", "errors"] as const) {
      tasks.push(
        (async (): Promise<SignalResult> => {
          const base: Omit<SignalResult, "status"> = {
            provider: "sentry",
            kind,
            scope: config
              ? {
                  project: config.project,
                  organization: config.organization,
                  environment: config.environment,
                  start,
                  end,
                }
              : {},
          };
          if (!config) return { ...base, status: "not-configured" };
          const token = deps.env[config.tokenSecret];
          if (!token)
            return {
              ...base,
              status: "unavailable",
              detail: `Missing ${config.tokenSecret}.`,
            };
          const fields =
            kind === "logs"
              ? ["sentry.item_id", "timestamp", "severity", "message"]
              : ["id", "timestamp", "level", "title"];
          const params = new URLSearchParams({
            dataset: kind,
            project: config.project,
            environment: config.environment,
            start,
            end,
            per_page: String(limit),
            sort: "-timestamp",
          });
          for (const field of fields) params.append("field", field);
          try {
            const { body, more } = await request(
              `https://${config.host}/api/0/organizations/${encodeURIComponent(config.organization)}/events/?${params}`,
              {
                headers: {
                  authorization: `Bearer ${token}`,
                  accept: "application/json",
                },
              },
              deps,
            );
            const rows = object(body)?.data;
            if (
              !Array.isArray(rows) ||
              rows.some(
                (row) =>
                  !object(row) ||
                  typeof row.timestamp !== "string" ||
                  typeof row[kind === "logs" ? "message" : "title"] !==
                    "string",
              )
            )
              throw new Error("shape");
            return {
              ...base,
              status: "ok",
              limited: more || rows.length >= limit,
              data: rows.slice(0, limit).map((row) => ({
                id: clean(row[fields[0]!]),
                timestamp: clean(row.timestamp),
                level: clean(row[kind === "logs" ? "severity" : "level"]),
                message: clean(row[kind === "logs" ? "message" : "title"]),
              })),
            };
          } catch (error) {
            return { ...base, status: "unavailable", detail: failure(error) };
          }
        })(),
      );
    }
  }
  if (provider !== "sentry")
    tasks.push(
      (async (): Promise<SignalResult> => {
        const config = project.telemetry?.datadog;
        const base: Omit<SignalResult, "status"> = {
          provider: "datadog",
          kind: "logs",
          scope: config
            ? {
                service: config.service,
                environment: config.environment,
                start,
                end,
              }
            : {},
        };
        if (!config) return { ...base, status: "not-configured" };
        const apiKey = deps.env[config.apiKeySecret];
        const appKey = deps.env[config.appKeySecret];
        if (!apiKey || !appKey)
          return {
            ...base,
            status: "unavailable",
            detail: `Set ${config.apiKeySecret} and ${config.appKeySecret}.`,
          };
        try {
          const { body } = await request(
            `https://api.${config.site}/api/v2/logs/events/search`,
            {
              method: "POST",
              headers: {
                "DD-API-KEY": apiKey,
                "DD-APPLICATION-KEY": appKey,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                filter: {
                  query: `service:${JSON.stringify(config.service)} AND env:${JSON.stringify(config.environment)}`,
                  from: start,
                  to: end,
                },
                sort: "-timestamp",
                page: { limit },
              }),
            },
            deps,
          );
          const result = object(body);
          const rows = result?.data;
          if (
            !Array.isArray(rows) ||
            rows.some(
              (row) =>
                !object(row) ||
                !object(row.attributes) ||
                typeof row.attributes.timestamp !== "string" ||
                typeof row.attributes.message !== "string",
            )
          )
            throw new Error("shape");
          return {
            ...base,
            status: "ok",
            limited:
              !!object(object(result?.meta)?.page)?.after ||
              rows.length >= limit,
            data: rows.slice(0, limit).map((row) => ({
              id: clean(row.id),
              timestamp: clean(row.attributes.timestamp),
              level: clean(row.attributes.status),
              message: clean(row.attributes.message),
              service: clean(row.attributes.service),
            })),
          };
        } catch (error) {
          return { ...base, status: "unavailable", detail: failure(error) };
        }
      })(),
    );
  return Promise.all(tasks);
}

export async function readMixpanel(
  project: ProjectConfig,
  area: AreaConfig,
  deps: TelemetryDeps,
): Promise<SignalResult> {
  const config = project.telemetry?.mixpanel;
  const base: Omit<SignalResult, "status"> = {
    provider: "mixpanel",
    kind: "analytics",
    scope: config
      ? {
          projectId: config.projectId,
          reportId: area.mixpanelReportId ?? "",
          area: area.key,
        }
      : {},
  };
  if (!config || !area.mixpanelReportId)
    return {
      ...base,
      status: "not-configured",
      detail: "Configure telemetry.mixpanel and this area's mixpanelReportId.",
    };
  const username = deps.env[config.usernameSecret];
  const password = deps.env[config.passwordSecret];
  if (!username || !password)
    return {
      ...base,
      status: "unavailable",
      detail: `Set ${config.usernameSecret} and ${config.passwordSecret}.`,
    };
  const params = new URLSearchParams({
    project_id: config.projectId,
    bookmark_id: area.mixpanelReportId,
  });
  if (config.workspaceId) params.set("workspace_id", config.workspaceId);
  try {
    const { body } = await request(
      `https://${MIXPANEL_HOSTS[config.region]}/api/query/insights?${params}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          accept: "application/json",
        },
      },
      deps,
    );
    const result = object(body);
    const dates = object(result?.date_range);
    if (
      !result ||
      typeof result.computed_at !== "string" ||
      !dates ||
      typeof dates.from_date !== "string" ||
      typeof dates.to_date !== "string" ||
      !Array.isArray(result.headers) ||
      result.headers.some((header) => typeof header !== "string") ||
      !object(result.series)
    )
      throw new Error("shape");
    // Preserve saved-report semantics, dates, units and breakdowns; never guess a total.
    const secrets = credentials(project, deps);
    let nodes = 0;
    const sanitize = (value: unknown, depth = 0): unknown => {
      if (++nodes > 10_000 || depth > 15) throw new Error("size");
      if (typeof value === "string") return redact(value, secrets);
      if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return value;
      if (Array.isArray(value))
        return value.map((entry) => sanitize(entry, depth + 1));
      const obj = object(value);
      if (obj)
        return Object.fromEntries(
          Object.entries(obj).map(([key, entry]) => [
            redact(key, secrets),
            sanitize(entry, depth + 1),
          ]),
        );
      throw new Error("shape");
    };
    return {
      ...base,
      status: "ok",
      data: sanitize({
        computed_at: result.computed_at,
        date_range: result.date_range,
        headers: result.headers,
        series: result.series,
      }),
    };
  } catch (error) {
    return { ...base, status: "unavailable", detail: failure(error) };
  }
}
