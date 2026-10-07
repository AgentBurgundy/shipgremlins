import type { Project } from "../config.ts";
import {
  effectiveVerification,
  inspectionBranch,
} from "../projectCapabilities.ts";
import { containsSecret } from "./repository.ts";

/** Compare source identity separately from editable setup and Linear mappings. */
export function crewSourceIdentity(project: Project) {
  return {
    provider: project.config.provider ?? "github",
    repo: project.config.repo,
    serverUrl: project.config.serverUrl ?? null,
    branch: inspectionBranch(project.config),
  };
}

/** Selected configuration only: no URLs, resource IDs, secret references or values. */
export function crewAnalysisContext(project: Project, secrets: string[]) {
  const verification = effectiveVerification(project.config);
  const access =
    verification.mode === "browser" ? verification.target.access : undefined;
  const configuredTesting = {
    mode: verification.mode,
    ...(verification.mode === "browser"
      ? {
          environment: verification.environment,
          provider: verification.target.kind,
          role: verification.target.role,
          access: {
            kind:
              access?.kind ??
              (project.config.signIn ? "email-code" : "unconfigured"),
            testAccountCount:
              access?.kind === "password" ? access.accounts.length : 0,
          },
        }
      : {}),
    browserPerformed: false,
    note: "Saved configuration only. This source investigation does not open the app, test sign-in, or verify a customer journey.",
  };
  const existingPms: {
    key: string;
    name: string;
    mandate?: string;
    charter?: Project["areas"][number]["charter"];
    paths: string[];
    sharedTouchpoints: string[];
  }[] = [];
  let existingPmsTruncated = false;
  for (const area of project.areas) {
    const entry = {
      key: area.key,
      name: area.name,
      mandate: area.mandate,
      charter: area.charter,
      paths: area.paths,
      sharedTouchpoints: area.sharedTouchpoints,
    };
    // Keep an owner's limits together: never truncate a charter mid-sentence.
    if (
      existingPms.length >= 32 ||
      Buffer.byteLength(JSON.stringify([...existingPms, entry])) > 24000 ||
      containsSecret(JSON.stringify(entry), secrets)
    ) {
      existingPmsTruncated = true;
      continue;
    }
    existingPms.push(entry);
  }
  return {
    configuredTesting,
    existingPmCount: project.areas.length,
    existingPms,
    existingPmsTruncated,
  };
}
