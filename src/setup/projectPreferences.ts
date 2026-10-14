import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectConfig } from "../config.ts";
import {
  readPrivateJson,
  writePrivateJson,
} from "../improvements/observations.ts";
import { assertNoSymlinks } from "./files.ts";

/** UI identity does not migrate legacy execution identities or detach retained jobs. */
export function projectPreferenceId(
  root: string,
  project: Pick<ProjectConfig, "name" | "instanceId">,
): string {
  const file = join(
    root,
    ".run",
    "dashboard-identities",
    createHash("sha256").update(project.name).digest("hex") + ".json",
  );
  assertNoSymlinks(file);
  const identity = project.instanceId ?? null;
  const read = () => {
    const saved = readPrivateJson(file) as {
      name: string;
      instanceId: string | null;
      id: string;
    };
    if (
      saved.name !== project.name ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(saved.id)
    )
      throw new Error("Project display identity needs repair.");
    return saved;
  };
  if (existsSync(file)) {
    const saved = read();
    if (saved.instanceId === identity) return saved.id;
  }
  const value = { name: project.name, instanceId: identity, id: randomUUID() };
  if (existsSync(file)) {
    writePrivateJson(file, value);
    return value.id;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return projectPreferenceId(root, project);
  }
  return value.id;
}
