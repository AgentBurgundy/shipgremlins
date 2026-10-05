import type { VercelConnection } from "../vercelConnection/index.ts";
import {
  validBranch,
  validConnectionId,
  validEnvironmentUrl,
  validProjectSecretName,
  type EnvironmentTarget,
} from "../projectCapabilities.ts";
import {
  parseGoogleServiceAccount,
  type GoogleServiceAccount,
} from "./credentials.ts";

export interface ResolvedEnvironment {
  url: string;
  provider: "url" | "vercel" | "railway" | "cloud-run";
  deploymentId?: string;
  commitSha?: string;
  branch?: string;
}
export interface HostingOptions {
  env: Record<string, string | undefined>;
  branch: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  vercelConnection?: Pick<VercelConnection, "resolveCredential">;
  vercelConnectionFor?: (
    connectionId?: string,
  ) => Pick<VercelConnection, "resolveCredential">;
  /** Dependency injection for tests/embedded controllers; never dashboard input. */
  googleAccessToken?: (
    credentials: GoogleServiceAccount | undefined,
    signal: AbortSignal,
  ) => Promise<string>;
  timeoutMs?: number;
}
export class HostingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid"
      | "credentials"
      | "forbidden"
      | "not_ready"
      | "unavailable" = "unavailable",
  ) {
    super(message);
    this.name = "HostingError";
  }
}
type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.map(record) : [];
const resource = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
const sha = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value)
    ? value
    : undefined;
function webUrl(value: unknown, provider: string): string {
  if (!validEnvironmentUrl(value))
    throw new HostingError(
      `${provider} did not return a valid app URL.`,
      "not_ready",
    );
  return value;
}
const domainName = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    value,
  );
function token(value: unknown, provider: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 16_384 ||
    /[\s\p{Cc}]/u.test(value)
  )
    throw new HostingError(
      `Configure a valid ${provider} connection in Connections.`,
      "credentials",
    );
  return value;
}
function secretName(value: string | undefined, fallback: string): string {
  if (value !== undefined && !validProjectSecretName(value))
    throw new HostingError(
      "Hosting credential reference must be a safe secret name.",
      "invalid",
    );
  return value ?? fallback;
}
async function json(
  url: string | URL,
  options: HostingOptions,
  provider: string,
  init: RequestInit = {},
): Promise<Data> {
  try {
    const response = await (options.fetch ?? fetch)(String(url), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new HostingError(
          `${provider} denied access. Check the saved connection and permissions for the selected resource.`,
          "forbidden",
        );
      if (response.status === 404)
        throw new HostingError(
          `${provider} could not find the selected resource. Check its identifiers and connection.`,
          "not_ready",
        );
      throw new HostingError(
        `${provider} is unavailable. Try verification again later.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1_048_576) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof HostingError) throw error;
    throw new HostingError(
      `${provider} could not be checked. Verify connectivity and try again.`,
    );
  }
}

async function vercel(
  target: Extract<EnvironmentTarget, { kind: "vercel" }>,
  options: HostingOptions,
): Promise<ResolvedEnvironment> {
  const branch = target.branch ?? options.branch;
  let accessToken: string;
  let teamId = target.teamId;
  try {
    const connection =
      options.vercelConnectionFor?.(target.connectionId) ??
      (!target.connectionId || target.connectionId === "default"
        ? options.vercelConnection
        : undefined);
    if (target.connectionId && target.connectionId !== "default" && !connection)
      throw new HostingError(
        "The selected Vercel account is unavailable. Reconnect that account.",
        "credentials",
      );
    if (connection) {
      const credential = await connection.resolveCredential({
        projectId: target.projectId,
        teamId: target.teamId,
      });
      accessToken = token(credential.token, "Vercel");
      teamId ??= credential.teamId;
    } else accessToken = token(options.env.VERCEL_TOKEN, "Vercel");
  } catch {
    throw new HostingError(
      "Vercel connection could not authorize this project. Reconnect or check project access.",
      "credentials",
    );
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", target.projectId);
  url.searchParams.set("branch", branch);
  if (!target.customEnvironmentId) url.searchParams.set("target", "preview");
  url.searchParams.set("limit", "100");
  if (teamId) url.searchParams.set("teamId", teamId);
  const data = await json(url, options, "Vercel", { headers });
  const deployments = list(data.deployments)
    .filter((entry) => {
      const meta = record(entry.meta);
      return (
        (meta.githubCommitRef ??
          meta.gitlabCommitRef ??
          record(entry.gitSource).ref) === branch &&
        entry.target !== "production" &&
        (record(entry.customEnvironment).id ?? entry.customEnvironmentId) ===
          target.customEnvironmentId
      );
    })
    .sort(
      (a, b) =>
        Number(b.createdAt ?? b.created ?? 0) -
        Number(a.createdAt ?? a.created ?? 0),
    );
  const deployment = deployments[0];
  if (
    !deployment ||
    (deployment.readyState ?? deployment.state) !== "READY" ||
    !resource(deployment.uid ?? deployment.id)
  )
    throw new HostingError(
      "Vercel has no ready preview deployment for the selected branch. Wait for its latest deployment to finish.",
      "not_ready",
    );
  const deploymentId = String(deployment.uid ?? deployment.id);
  const detailUrl = new URL(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`,
  );
  if (teamId) detailUrl.searchParams.set("teamId", teamId);
  const detail = await json(detailUrl, options, "Vercel", { headers });
  if (
    (detail.readyState ?? detail.state) !== "READY" ||
    detail.target === "production" ||
    detail.projectId !== target.projectId ||
    (detail.id ?? detail.uid) !== deploymentId ||
    (record(detail.customEnvironment).id ?? detail.customEnvironmentId) !==
      target.customEnvironmentId ||
    (record(detail.meta).githubCommitRef ??
      record(detail.meta).gitlabCommitRef ??
      record(detail.gitSource).ref) !== branch
  )
    throw new HostingError(
      "Vercel preview is no longer ready for this project.",
      "not_ready",
    );
  const meta = record(detail.meta ?? deployment.meta);
  if (!domainName(detail.url))
    throw new HostingError(
      "Vercel did not return a valid preview domain.",
      "not_ready",
    );
  return {
    provider: "vercel",
    deploymentId,
    branch,
    url: webUrl(`https://${detail.url}`, "Vercel"),
    commitSha: sha(
      meta.githubCommitSha ??
        meta.gitlabCommitSha ??
        record(detail.gitSource).sha,
    ),
  };
}

async function railway(
  target: Extract<EnvironmentTarget, { kind: "railway" }>,
  options: HostingOptions,
): Promise<ResolvedEnvironment> {
  const value = token(
    options.env[secretName(target.tokenSecret, "RAILWAY_TOKEN")],
    "Railway",
  );
  const projectToken = target.tokenType === "project";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(projectToken
      ? { "Project-Access-Token": value }
      : { Authorization: `Bearer ${value}` }),
  };
  const query = `query GremlinsEnvironment($projectId: String!, $environmentId: String!, $serviceId: String!) {
    ${projectToken ? "projectToken { projectId environmentId }" : "environments(projectId: $projectId) { edges { node { id } } }"}
    service(id: $serviceId) { id projectId }
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { latestDeployment { id status meta } }
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
      serviceDomains { domain }
      customDomains { domain status { certificateStatus dnsRecords { status } } }
    }
  }`;
  const result = await json(
    "https://backboard.railway.com/graphql/v2",
    options,
    "Railway",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        variables: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          serviceId: target.serviceId,
        },
      }),
    },
  );
  if (Array.isArray(result.errors) && result.errors.length)
    throw new HostingError(
      "Railway could not authorize or resolve this environment. Check the token type, permissions, and resource identifiers.",
      "forbidden",
    );
  const data = record(result.data),
    service = record(data.service),
    scope = record(data.projectToken);
  const scoped = projectToken
    ? scope.projectId === target.projectId &&
      scope.environmentId === target.environmentId
    : list(record(data.environments).edges).some(
        (entry) => record(entry.node).id === target.environmentId,
      );
  if (
    !scoped ||
    service.id !== target.serviceId ||
    service.projectId !== target.projectId
  )
    throw new HostingError(
      "Railway service and environment do not belong to the selected project or token scope.",
      "forbidden",
    );
  const deployment = record(record(data.serviceInstance).latestDeployment);
  if (deployment.status !== "SUCCESS" || !resource(deployment.id))
    throw new HostingError(
      "Railway's latest deployment is not running successfully. Wait for deployment readiness before verification.",
      "not_ready",
    );
  const meta = record(deployment.meta);
  if (
    typeof meta.branch === "string" &&
    meta.branch !== (target.branch ?? options.branch)
  )
    throw new HostingError(
      "Railway deployed a different branch than the configured verification branch.",
      "not_ready",
    );
  const domains = record(data.domains);
  const names = [
    ...list(domains.serviceDomains),
    ...list(domains.customDomains).filter((entry) => {
      const status = record(entry.status),
        records = list(status.dnsRecords);
      return (
        status.certificateStatus === "ISSUED" &&
        records.length > 0 &&
        records.every((record) => record.status === "VALID")
      );
    }),
  ];
  const domain = names.find((entry) => domainName(entry.domain))?.domain;
  if (!domain)
    throw new HostingError(
      "Railway needs a public service domain or a verified custom domain before browser verification.",
      "not_ready",
    );
  return {
    provider: "railway",
    url: `https://${domain}`,
    deploymentId: deployment.id,
    commitSha: sha(meta.commitHash ?? meta.commitSha),
    ...(typeof meta.branch === "string" ? { branch: meta.branch } : {}),
  };
}

async function googleToken(
  credentials: GoogleServiceAccount | undefined,
  signal: AbortSignal,
): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    clientOptions: {
      transporterOptions: { timeout: 15_000, retry: false, signal },
    },
  });
  const value = await auth.getAccessToken();
  return token(value, "Google Cloud");
}
async function cloudRun(
  target: Extract<EnvironmentTarget, { kind: "cloud-run" }>,
  options: HostingOptions,
): Promise<ResolvedEnvironment> {
  const name = secretName(target.credentialsSecret, "GCP_SERVICE_ACCOUNT_JSON");
  const source = options.env[name];
  if (target.credentialsSecret && !source)
    throw new HostingError(
      "Configure the Cloud Run target's named Google credentials in Connections.",
      "credentials",
    );
  let accessToken: string;
  try {
    const credentials = source ? parseGoogleServiceAccount(source) : undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      accessToken = await Promise.race([
        (options.googleAccessToken ?? googleToken)(
          credentials,
          controller.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error());
          }, options.timeoutMs ?? 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    accessToken = token(accessToken, "Google Cloud");
  } catch {
    throw new HostingError(
      "Google Cloud authentication failed. Save a valid service-account JSON key or configure Application Default Credentials on the controller.",
      "credentials",
    );
  }
  const resourceName = `projects/${target.projectId}/locations/${target.region}/services/${target.service}`;
  const data = await json(
    `https://run.googleapis.com/v2/${resourceName}`,
    options,
    "Cloud Run",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  // Google may canonicalize the project ID to its numeric project number in name.
  const returnedName =
    typeof data.name === "string" ? data.name.split("/") : [];
  if (
    returnedName.length !== 6 ||
    returnedName[0] !== "projects" ||
    returnedName[2] !== "locations" ||
    returnedName[3] !== target.region ||
    returnedName[4] !== "services" ||
    returnedName[5] !== target.service ||
    (returnedName[1] !== target.projectId &&
      !/^\d+$/.test(returnedName[1] ?? ""))
  )
    throw new HostingError(
      "Cloud Run returned a different service than requested.",
      "forbidden",
    );
  if (
    data.reconciling === true ||
    record(data.terminalCondition).state !== "CONDITION_SUCCEEDED" ||
    data.generation === undefined ||
    data.observedGeneration !== data.generation ||
    !data.latestReadyRevision ||
    data.latestReadyRevision !== data.latestCreatedRevision ||
    data.deleteTime
  )
    throw new HostingError(
      "Cloud Run is not ready at its current generation. Wait for the service deployment to finish.",
      "not_ready",
    );
  if (
    data.defaultUriDisabled === true ||
    data.iapEnabled === true ||
    (data.ingress !== undefined && data.ingress !== "INGRESS_TRAFFIC_ALL")
  )
    throw new HostingError(
      "Cloud Run browser verification requires a publicly reachable service URL. Private ingress and IAP browser sign-in are not configured.",
      "not_ready",
    );
  const url = webUrl(data.uri, "Cloud Run");
  if (
    new URL(url).protocol !== "https:" ||
    !new URL(url).hostname.endsWith(".run.app")
  )
    throw new HostingError(
      "Cloud Run did not return its official HTTPS service URL.",
      "not_ready",
    );
  const traffic = list(data.trafficStatuses).filter(
    (entry) => Number(entry.percent) > 0,
  );
  const revision =
    traffic.length === 1 && Number(traffic[0]?.percent) === 100
      ? traffic[0]?.revision
      : undefined;
  // Split traffic cannot identify a single deployment; do not manufacture commit evidence.
  return {
    provider: "cloud-run",
    url,
    ...(typeof revision === "string" ? { deploymentId: revision } : {}),
  };
}

/** Read-only control-plane resolution. Tokens never leave this module in results. */
export async function resolveEnvironment(
  target: EnvironmentTarget,
  options: HostingOptions,
): Promise<ResolvedEnvironment> {
  if (!["preview", "staging"].includes(target.role))
    throw new HostingError(
      "Browser verification requires a preview or staging environment, never production.",
      "invalid",
    );
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 60_000)
  )
    throw new HostingError("Invalid hosting request timeout.", "invalid");
  if (target.kind === "url")
    return {
      provider: "url",
      url: webUrl(target.url, "Configured environment"),
    };
  if (target.kind === "docker")
    throw new HostingError(
      "Managed Docker apps start on the assigned worker. Use the Docker environment verifier, not a hosted deployment lookup.",
      "invalid",
    );
  if (!resource(target.projectId))
    throw new HostingError("Invalid hosting project identifier.", "invalid");
  switch (target.kind) {
    case "vercel":
      if (
        target.connectionId !== undefined &&
        !validConnectionId(target.connectionId)
      )
        throw new HostingError("Invalid Vercel account identifier.", "invalid");
      if (target.teamId != null && !resource(target.teamId))
        throw new HostingError("Invalid Vercel team identifier.", "invalid");
      if (!validBranch(target.branch ?? options.branch))
        throw new HostingError("Invalid Vercel preview branch.", "invalid");
      return vercel(target, options);
    case "railway":
      if (
        !resource(target.environmentId) ||
        !resource(target.serviceId) ||
        (target.tokenType !== undefined &&
          !["account", "project"].includes(target.tokenType))
      )
        throw new HostingError(
          "Invalid Railway resource identifiers or token type.",
          "invalid",
        );
      if (!validBranch(target.branch ?? options.branch))
        throw new HostingError("Invalid Railway preview branch.", "invalid");
      return railway(target, options);
    case "cloud-run":
      if (
        !/^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(target.service) ||
        !/^[a-z]+(?:-[a-z0-9]+)+$/.test(target.region) ||
        !/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|\d+)$/.test(target.projectId)
      )
        throw new HostingError(
          "Invalid Cloud Run project, region, or service identifier.",
          "invalid",
        );
      return cloudRun(target, options);
    default:
      throw new HostingError("Unsupported hosting provider.", "invalid");
  }
}
