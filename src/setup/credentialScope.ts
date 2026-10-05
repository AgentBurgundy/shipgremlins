import { join } from "node:path";
import {
  listProjectNames,
  loadProject,
  type ProjectConfig,
} from "../config.ts";
import {
  effectiveVerification,
  hostingSecretNames,
  validateWorkerSecretReferences,
} from "../projectCapabilities.ts";
import { telemetrySecrets } from "../telemetry/config.ts";
import { assertNoSymlinks } from "./files.ts";

function configuredControllerNames(config: ProjectConfig): string[] {
  return [
    ...hostingSecretNames(config),
    ...telemetrySecrets(config.telemetry).map((secret) => secret.name),
  ];
}

/** Classify references only; credential values are never loaded or returned. */
export function controllerCredentialNames(root: string): Set<string> {
  const names = new Set([
    "VERCEL_TOKEN",
    "RAILWAY_TOKEN",
    "GCP_SERVICE_ACCOUNT_JSON",
  ]);
  try {
    assertNoSymlinks(join(root, "projects"));
    for (const name of listProjectNames(root)) {
      for (const file of ["project.json", "areas.json", "tiers.json"])
        assertNoSymlinks(join(root, "projects", name, file));
      for (const secret of configuredControllerNames(
        loadProject(root, name).config,
      ))
        names.add(secret);
    }
  } catch {
    throw new Error(
      "Check every project's configuration before browser access; controller credentials could not be classified safely.",
    );
  }
  return names;
}

/** Call before any browser probe, sign-in operation, or worker credential handoff. */
export function assertBrowserSecretSafety(
  config: ProjectConfig,
  root?: string,
): void {
  validateWorkerSecretReferences(config);
  const verification = effectiveVerification(config);
  if (verification.mode !== "browser") return;
  const names = [
    verification.target.kind === "vercel"
      ? verification.target.bypassSecret
      : undefined,
    config.signIn?.databaseUrlSecret,
  ].filter((name): name is string => !!name);
  if (!names.length) return;
  const controllerNames = root
    ? controllerCredentialNames(root)
    : new Set<string>();
  for (const name of configuredControllerNames(config))
    controllerNames.add(name);
  if (names.some((name) => controllerNames.has(name)))
    throw new Error(
      "A preview or sign-in secret aliases a controller hosting credential or telemetry connection in this workspace. Use a separate browser credential.",
    );
}
