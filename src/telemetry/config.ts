export const SENTRY_HOSTS = [
  "sentry.io",
  "us.sentry.io",
  "de.sentry.io",
] as const;
export const DATADOG_SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
] as const;
export const MIXPANEL_HOSTS = {
  us: "mixpanel.com",
  eu: "eu.mixpanel.com",
  in: "in.mixpanel.com",
} as const;

export interface TelemetryConfig {
  sentry?: {
    host: (typeof SENTRY_HOSTS)[number];
    organization: string;
    project: string;
    environment: string;
    tokenSecret: string;
  };
  datadog?: {
    site: (typeof DATADOG_SITES)[number];
    service: string;
    environment: string;
    apiKeySecret: string;
    appKeySecret: string;
  };
  mixpanel?: {
    region: keyof typeof MIXPANEL_HOSTS;
    projectId: string;
    workspaceId?: string;
    usernameSecret: string;
    passwordSecret: string;
  };
}

export const TELEMETRY_SECRET_RE =
  /^(?:SENTRY_AUTH_TOKEN|DD_API_KEY|DD_APP_KEY|MIXPANEL_USERNAME|MIXPANEL_PASSWORD)_[A-Z][A-Z0-9_]*$/;
export const ID_RE = /^[1-9][0-9]*$/;
const SCOPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;

export function parseTelemetry(raw: unknown): TelemetryConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
  };
  const source = object(raw, "telemetry");
  for (const key of Object.keys(source)) {
    if (!["sentry", "datadog", "mixpanel"].includes(key))
      throw new Error(`unknown telemetry provider: ${key}`);
  }
  const result: TelemetryConfig = {};
  for (const provider of ["sentry", "datadog", "mixpanel"] as const) {
    if (source[provider] === undefined || source[provider] === null) continue;
    const item = object(source[provider], `telemetry.${provider}`);
    const text = (
      key: string,
      pattern: RegExp,
      description: string,
    ): string => {
      const value = item[key];
      if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`telemetry.${provider}.${key} must be ${description}`);
      return value;
    };
    const secret = (key: string, prefix: string) =>
      text(
        key,
        new RegExp(`^${prefix}_[A-Z][A-Z0-9_]*$`),
        `a secret NAME such as ${prefix}_MY_APP, never a value`,
      );
    const scope = (key: string) =>
      text(
        key,
        SCOPE_RE,
        "one explicit scope using letters, numbers, dots, underscores or hyphens (no wildcards)",
      );
    const choice = <T extends string>(
      key: string,
      choices: readonly T[],
      fallback: T,
    ): T => {
      const value = item[key] ?? fallback;
      if (!choices.includes(value as T))
        throw new Error(
          `telemetry.${provider}.${key} must be one of ${choices.join(", ")}`,
        );
      return value as T;
    };
    if (provider === "sentry") {
      result.sentry = {
        host: choice("host", SENTRY_HOSTS, "sentry.io"),
        organization: scope("organization"),
        project: scope("project"),
        environment: scope("environment"),
        tokenSecret: secret("tokenSecret", "SENTRY_AUTH_TOKEN"),
      };
    } else if (provider === "datadog") {
      result.datadog = {
        site: choice("site", DATADOG_SITES, "datadoghq.com"),
        service: scope("service"),
        environment: scope("environment"),
        apiKeySecret: secret("apiKeySecret", "DD_API_KEY"),
        appKeySecret: secret("appKeySecret", "DD_APP_KEY"),
      };
    } else {
      result.mixpanel = {
        region: choice("region", ["us", "eu", "in"], "us"),
        projectId: text(
          "projectId",
          ID_RE,
          "a positive numeric project ID string",
        ),
        ...(item.workspaceId === undefined
          ? {}
          : {
              workspaceId: text(
                "workspaceId",
                ID_RE,
                "a positive numeric workspace ID string",
              ),
            }),
        usernameSecret: secret("usernameSecret", "MIXPANEL_USERNAME"),
        passwordSecret: secret("passwordSecret", "MIXPANEL_PASSWORD"),
      };
    }
  }
  return result;
}

export function telemetrySecrets(
  config?: TelemetryConfig,
): { name: string; label: string; description: string }[] {
  return [
    ...(config?.sentry
      ? [{ name: config.sentry.tokenSecret, label: "Sentry token" }]
      : []),
    ...(config?.datadog
      ? [
          { name: config.datadog.apiKeySecret, label: "Datadog API key" },
          {
            name: config.datadog.appKeySecret,
            label: "Datadog application key",
          },
        ]
      : []),
    ...(config?.mixpanel
      ? [
          {
            name: config.mixpanel.usernameSecret,
            label: "Mixpanel service account username",
          },
          {
            name: config.mixpanel.passwordSecret,
            label: "Mixpanel service account secret",
          },
        ]
      : []),
  ].map((entry) => ({
    ...entry,
    description: "Read access to this project's logs or analytics.",
  }));
}
