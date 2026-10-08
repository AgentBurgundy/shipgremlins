import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { listProjectNames, loadProject } from "../config.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { managedTestScope, testAccessSecretNames } from "../testAccess.ts";

const reference =
  /^TEST_ACCESS_([A-F0-9]{24})_([A-F0-9]{32})_(USERNAME|PASSWORD)$/;
const fileFor = (root: string, scope: string, generation: string) =>
  safeOAuthPath(
    join(root, ".run", "test-accounts", scope, `${generation}.json`),
  );

/** Immutable private generation; project config is its atomic activation pointer. */
export function stageTestCredentials(
  root: string,
  project: { name: string; instanceId?: string },
  values: { username?: string; password?: string },
) {
  const scope = managedTestScope(project),
    generation = randomBytes(16).toString("hex").toUpperCase();
  const references = {
    username: `TEST_ACCESS_${scope}_${generation}_USERNAME`,
    password: `TEST_ACCESS_${scope}_${generation}_PASSWORD`,
  };
  const stored = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        references[key as keyof typeof references],
        value,
      ]),
  );
  const file = fileFor(root, scope, generation);
  writePrivate(
    file,
    JSON.stringify({ schema: 1, scope, generation, values: stored }),
  );
  return {
    references,
    discard: () => {
      try {
        unlinkSync(file);
      } catch {
        /* Inactive private generation is never resolved. */
      }
    },
  };
}

/** Read only active references from their owning project's private namespace. */
export function readManagedTestCredentials(
  root: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of listProjectNames(root)) {
    let project;
    try {
      project = loadProject(root, name).config;
    } catch {
      continue;
    }
    const scope = managedTestScope(project),
      verification = effectiveVerification(project);
    const targets = [
      ...Object.values(project.environments ?? {}),
      ...(verification.mode === "browser" ? [verification.target] : []),
    ];
    for (const ref of new Set(
      targets.flatMap((target) => testAccessSecretNames(target.access)),
    )) {
      const match = reference.exec(ref);
      if (!match || match[1] !== scope) continue;
      const file = fileFor(root, scope, match[2]!);
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
        throw new Error("Test-account private storage is unavailable.");
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (
        data.schema !== 1 ||
        data.scope !== scope ||
        data.generation !== match[2]
      )
        throw new Error("Test-account private storage is unavailable.");
      const value = data.values?.[ref];
      if (
        typeof value === "string" &&
        value.length &&
        value.length <= 16384 &&
        !/[\0\r\n]/.test(value)
      )
        result[ref] = value;
    }
  }
  return result;
}
