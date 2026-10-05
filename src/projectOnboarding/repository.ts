import type { Project } from "../config.ts";
import { inspectionBranch } from "../projectCapabilities.ts";
import type { SourceCredential } from "../sourceControl/types.ts";
import { ProjectOnboardingError, type OnboardingReport } from "./types.ts";
import {
  SOURCE_LIMITS,
  seedPriority,
  sourceReferences,
  sourceExcerpt,
} from "./investigation.ts";

export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function sourceApi(project: Project) {
  const { repo, provider = "github" } = project.config;
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..")
  )
    throw new ProjectOnboardingError("Repository identity is invalid.");
  if (provider === "github") return `https://api.github.com/repos/${repo}`;
  const origin = new URL(project.config.serverUrl ?? "https://gitlab.com");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new ProjectOnboardingError(
      "GitLab requires a configured HTTPS origin.",
    );
  return `${origin.origin}/api/v4/projects/${encodeURIComponent(repo)}`;
}
export async function sourceRequest(
  fetcher: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
  allowMissing = false,
) {
  const response = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    redirect: "error",
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 && allowMissing) {
    await response.body?.cancel();
    return { value: null, headers: response.headers };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ProjectOnboardingError(
      "Repository request failed. Check the selected repository, source permissions, and provider availability.",
      [401, 403, 404].includes(response.status) ? response.status : 502,
      "repository_access",
    );
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw new ProjectOnboardingError(
          "Repository response exceeds setup's bounded read limit.",
          422,
        );
      chunks.push(chunk.value);
    }
    return {
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      headers: response.headers,
    };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function resolveRepositoryHead({
  project,
  credential,
  fetch: fetcher = fetch,
  signal = AbortSignal.timeout(15000),
  branch = inspectionBranch(project.config),
}: {
  project: Project;
  credential: Pick<SourceCredential, "token">;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  branch?: string;
}) {
  const provider = project.config.provider ?? "github";
  const api = sourceApi(project);
  const { value } = await sourceRequest(
    fetcher,
    `${api}/${provider === "github" ? "commits" : "repository/commits"}/${encodeURIComponent(branch)}`,
    credential.token,
    signal,
  );
  const sha = object(value)
    ? value[provider === "github" ? "sha" : "id"]
    : null;
  if (typeof sha !== "string" || !SHA.test(sha))
    throw new ProjectOnboardingError(
      "The repository did not return a full commit SHA.",
      422,
    );
  return {
    sha,
    branch,
    repoUrl: `${project.config.serverUrl ?? (provider === "github" ? "https://github.com" : "https://gitlab.com")}/${project.config.repo}.git`,
  };
}
export function safeSourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/[\\:*?<>|]/.test(value) &&
    value.split("/").every((p) => p && p !== "." && p !== "..") &&
    !value.startsWith("-")
  );
}
function readable(path: string) {
  if (
    !safeSourcePath(path) ||
    /(^|\/)(?:\.env(?:\.|$)|\.git\/|node_modules\/|vendor\/|dist\/|build\/|coverage\/)|(?:credential|secret|private[-_]?key|id_rsa|\.pem$|\.p12$|\.pfx$|\.key$|lock\.[a-z]+$|package-lock\.json$)/i.test(
      path,
    )
  )
    return false;
  return /(?:\.(?:json|md|txt|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sql|sh|html?|css|vue|svelte|php)|(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|Procfile|Gemfile|go\.mod|requirements\.txt|Makefile|\.dockerignore))$/i.test(
    path,
  );
}
export function containsSecret(text: string, secrets: string[]) {
  return (
    secrets.some(
      (secret) =>
        secret.length >= 8 &&
        [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ].some((value) => text.includes(value)),
    ) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-ant-|gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{12,}|\b(?:postgres(?:ql)?|redis):\/\/[^\s"']+:[^\s"']+@/i.test(
      text,
    )
  );
}
export interface RepositorySnapshot {
  repository: OnboardingReport["repository"];
  files: { path: string; content: string }[];
  paths: string[];
  usedDefaultBranch?: boolean;
}
export async function readRepository(
  project: Project,
  token: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  secrets: string[],
): Promise<RepositorySnapshot> {
  const provider = project.config.provider ?? "github",
    api = sourceApi(project);
  let head: Awaited<ReturnType<typeof resolveRepositoryHead>>;
  let usedDefault = false;
  try {
    head = await resolveRepositoryHead({
      project,
      credential: { token },
      fetch: fetcher,
      signal,
    });
  } catch (error) {
    if (!(error instanceof ProjectOnboardingError) || error.status !== 404)
      throw error;
    const { value } = await sourceRequest(fetcher, api, token, signal);
    if (
      !object(value) ||
      typeof value.default_branch !== "string" ||
      !value.default_branch ||
      value.default_branch.length > 200
    )
      throw error;
    head = await resolveRepositoryHead({
      project,
      credential: { token },
      fetch: fetcher,
      signal,
      branch: value.default_branch,
    });
    usedDefault = true;
  }
  const { sha, branch } = head;
  const entries: { path: string; sha: string; size?: number }[] = [];
  let truncated = false;
  if (provider === "github") {
    const { value } = await sourceRequest(
      fetcher,
      `${api}/git/trees/${sha}?recursive=1`,
      token,
      signal,
    );
    if (!object(value) || !Array.isArray(value.tree))
      throw new ProjectOnboardingError(
        "Repository tree was not readable.",
        422,
      );
    truncated = value.truncated === true;
    for (const entry of value.tree)
      if (
        object(entry) &&
        entry.type === "blob" &&
        ["100644", "100755"].includes(String(entry.mode)) &&
        safeSourcePath(entry.path) &&
        typeof entry.sha === "string" &&
        SHA.test(entry.sha)
      )
        entries.push({
          path: entry.path,
          sha: entry.sha,
          size: typeof entry.size === "number" ? entry.size : undefined,
        });
  } else {
    for (let page = 1; page <= 20; page++) {
      const { value, headers } = await sourceRequest(
        fetcher,
        `${api}/repository/tree?ref=${sha}&recursive=true&per_page=100&page=${page}`,
        token,
        signal,
      );
      if (!Array.isArray(value))
        throw new ProjectOnboardingError(
          "Repository tree was not readable.",
          422,
        );
      for (const entry of value)
        if (
          object(entry) &&
          entry.type === "blob" &&
          ["100644", "100755"].includes(String(entry.mode)) &&
          safeSourcePath(entry.path) &&
          typeof entry.id === "string" &&
          SHA.test(entry.id)
        )
          entries.push({ path: entry.path, sha: entry.id });
      if (!headers.get("x-next-page")) break;
      if (page === 20) truncated = true;
    }
  }
  const treeTruncated = truncated;
  const available = new Map(
    entries
      .filter(
        (entry) => readable(entry.path) && !containsSecret(entry.path, secrets),
      )
      .map((entry) => [entry.path, entry]),
  );
  const paths = new Set(available.keys());
  type Candidate = {
    path: string;
    priority: number;
    depth: number;
    reason: string;
  };
  const queue = new Map<string, Candidate>();
  const visited = new Set<string>();
  const unresolved = new Set<string>(),
    criticalMissing = new Set<string>();
  const missing = (candidate: Candidate) => {
    unresolved.add(candidate.path);
    if (candidate.priority <= 5) criticalMissing.add(candidate.path);
    truncated = true;
  };
  const enqueue = (candidate: Candidate) => {
    if (visited.has(candidate.path)) return;
    if (candidate.depth > SOURCE_LIMITS.depth) {
      missing(candidate);
      return;
    }
    const prior = queue.get(candidate.path);
    if (!prior || candidate.priority < prior.priority)
      queue.set(candidate.path, candidate);
  };
  for (const path of paths) {
    const priority = seedPriority(path);
    if (priority !== undefined)
      enqueue({
        path,
        priority,
        depth: 0,
        reason:
          priority === 3
            ? "runnable example or test fixture"
            : "manifest, application entrypoint, or deployment configuration",
      });
  }
  // Unsupported stacks still get a small, explicit source sample instead of no analysis.
  if (!queue.size)
    for (const path of [...paths].sort().slice(0, 8))
      enqueue({
        path,
        priority: 50,
        depth: 0,
        reason: "fallback source sample; no recognized entrypoint",
      });
  const files: RepositorySnapshot["files"] = [];
  const inspected: NonNullable<
    OnboardingReport["repository"]["inspection"]
  >["files"] = [];
  let total = 0,
    fetchedBytes = 0,
    requests = 0;
  while (queue.size && requests < SOURCE_LIMITS.files) {
    const candidate = [...queue.values()].sort(
      (a, b) =>
        a.priority - b.priority ||
        a.depth - b.depth ||
        a.path.localeCompare(b.path),
    )[0]!;
    queue.delete(candidate.path);
    visited.add(candidate.path);
    const entry = available.get(candidate.path)!;
    if (
      (entry.size ?? 0) > SOURCE_LIMITS.fileBytes ||
      fetchedBytes + (entry.size ?? SOURCE_LIMITS.fileBytes) >
        SOURCE_LIMITS.fetchedBytes
    ) {
      missing(candidate);
      continue;
    }
    requests++;
    const { value } = await sourceRequest(
      fetcher,
      provider === "github"
        ? `${api}/git/blobs/${entry.sha}`
        : `${api}/repository/files/${encodeURIComponent(entry.path)}?ref=${sha}`,
      token,
      signal,
    );
    if (
      !object(value) ||
      value.encoding !== "base64" ||
      typeof value.content !== "string"
    ) {
      missing(candidate);
      continue;
    }
    // The response is already bounded. Check encoded size before allocating decoded source.
    if (
      value.content.length >
      Math.ceil(SOURCE_LIMITS.fileBytes / 3) * 4 + 32768
    ) {
      missing(candidate);
      continue;
    }
    const content = Buffer.from(value.content, "base64").toString("utf8");
    const bytes = Buffer.byteLength(content);
    fetchedBytes += bytes;
    if (
      bytes > SOURCE_LIMITS.fileBytes ||
      fetchedBytes > SOURCE_LIMITS.fetchedBytes ||
      [...content].some(
        (c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)),
      ) ||
      content.includes("\ufffd") ||
      containsSecret(content, secrets) ||
      /(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i.test(
        content,
      )
    ) {
      missing(candidate);
      continue;
    }
    const excerpt = sourceExcerpt(
      content,
      Math.min(16 * 1024, SOURCE_LIMITS.sourceBytes - total),
    );
    if (!excerpt.content) {
      missing(candidate);
      continue;
    }
    files.push({ path: entry.path, content: excerpt.content });
    inspected.push({
      path: entry.path,
      reason: candidate.reason,
      excerpt: !!excerpt.ranges,
      ...(excerpt.ranges ? { ranges: excerpt.ranges } : {}),
    });
    total += Buffer.byteLength(excerpt.content);
    if (excerpt.ranges) truncated = true;
    // Traverse full safe source, not just the excerpt, so late lazy imports still expose routes.
    for (const reference of sourceReferences(entry.path, content, paths))
      enqueue({ ...reference, depth: candidate.depth + 1 });
    if (
      fetchedBytes >= SOURCE_LIMITS.fetchedBytes ||
      total >= SOURCE_LIMITS.sourceBytes
    )
      break;
  }
  for (const candidate of queue.values()) missing(candidate);
  if (!files.length)
    throw new ProjectOnboardingError(
      "No safe source files were available for setup analysis. Check the branch and repository contents.",
      422,
    );
  const snapshot: RepositorySnapshot = {
    repository: {
      provider,
      repo: project.config.repo,
      branch,
      sha,
      filesRead: files.map((file) => file.path),
      truncated: truncated || entries.length > files.length,
      inspection: {
        strategy: "entrypoints-and-dependencies",
        totalFiles: entries.length,
        treeTruncated,
        requests,
        sourceBytes: total,
        fetchedBytes,
        limits: { ...SOURCE_LIMITS },
        files: inspected,
        unresolved: [...unresolved].slice(0, 40),
        criticalMissing: [...criticalMissing].slice(0, 40),
      },
    },
    files,
    paths: [...paths]
      .sort(
        (a, b) =>
          (seedPriority(a) ?? 50) - (seedPriority(b) ?? 50) ||
          a.localeCompare(b),
      )
      .slice(0, 2000),
    ...(usedDefault ? { usedDefaultBranch: true } : {}),
  };
  // Count serialized text, including escaping, before the planner's own JSON envelope.
  // Setup alone opts into a 2 MiB planner envelope. Keep inner JSON below 768 KiB;
  // escaping this text a second time plus system/schema still fits that bound.
  let pathBytes = 0;
  snapshot.paths = snapshot.paths.filter((path) => {
    pathBytes += Buffer.byteLength(JSON.stringify(path)) + 1;
    if (pathBytes > 48 * 1024) {
      snapshot.repository.truncated = true;
      return false;
    }
    return true;
  });
  while (
    Buffer.byteLength(JSON.stringify(snapshot)) > 768 * 1024 &&
    snapshot.files.length > 1
  ) {
    const omitted = snapshot.files.pop()!;
    const metadata = inspected.pop()!;
    snapshot.repository.inspection!.sourceBytes -= Buffer.byteLength(
      omitted.content,
    );
    snapshot.repository.inspection!.unresolved = [
      ...new Set([...snapshot.repository.inspection!.unresolved, omitted.path]),
    ].slice(0, 40);
    if (/entrypoint|fixture/.test(metadata.reason))
      snapshot.repository.inspection!.criticalMissing = [
        ...new Set([
          ...snapshot.repository.inspection!.criticalMissing,
          omitted.path,
        ]),
      ].slice(0, 40);
    snapshot.repository.filesRead = snapshot.files.map((file) => file.path);
    snapshot.repository.truncated = true;
  }
  return snapshot;
}
