import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProject, listProjectNames } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  ProjectOnboardingError,
  type OnboardingReport,
  type SetupPull,
} from "./types.ts";

export interface StoredOnboarding {
  schema: 1;
  project: string;
  configurationRevision: string;
  status:
    "idle" | "analyzing" | "analyzed" | "publishing" | "failed" | "interrupted";
  stage: string;
  message: string;
  updatedAt: string;
  operation?: { id: string; pid: number };
  report?: OnboardingReport;
  setupPull?: SetupPull;
  appliedProfile?: "hosted" | "docker";
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validProject(value: string) {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)
  )
    throw new ProjectOnboardingError("Choose an existing project.");
}
export function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function safe(file: string, max = 256 * 1024) {
  for (let path = resolve(file); ; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error();
    if (dirname(path) === path) break;
  }
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > max))
    throw new Error();
  return stat;
}
export function readPrivate(file: string, max = 256 * 1024) {
  const before = safe(file, max);
  if (!before) return undefined;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.nlink !== 1 ||
      after.size > max
    )
      throw new Error();
    const data = readFileSync(fd);
    if (data.length > max) throw new Error();
    return data.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
let sid: string | undefined;
function protect(file: string) {
  if (process.platform !== "win32") return;
  sid ??= execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  }).match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error();
  execFileSync(
    "icacls.exe",
    [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    { windowsHide: true, timeout: 5000, stdio: "ignore" },
  );
}
export function createOnboardingStore(root: string) {
  const directory = join(resolve(root), ".run", "project-onboarding");
  function file(project: string) {
    validProject(project);
    return join(
      directory,
      `${projectRuntimeKey(loadProject(root, project).config)}.json`,
    );
  }
  function read(project: string): StoredOnboarding | undefined {
    try {
      if (
        !lstatSync(join(root, "projects", project, "project.json"), {
          throwIfNoEntry: false,
        })
      )
        return undefined;
      const data = readPrivate(file(project));
      if (data === undefined) return undefined;
      const value = JSON.parse(data) as StoredOnboarding;
      if (
        value?.schema !== 1 ||
        value.project !== project ||
        !/^[a-f0-9]{64}$/.test(value.configurationRevision) ||
        ![
          "idle",
          "analyzing",
          "analyzed",
          "publishing",
          "failed",
          "interrupted",
        ].includes(value.status) ||
        typeof value.stage !== "string" ||
        typeof value.message !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        (value.operation &&
          (!Number.isSafeInteger(value.operation.pid) ||
            value.operation.pid < 1 ||
            !/^[a-f0-9]{32}$/.test(value.operation.id)))
      )
        throw new Error();
      return value;
    } catch (error) {
      if (error instanceof ProjectOnboardingError) throw error;
      throw new ProjectOnboardingError(
        "Setup history cannot be read safely. Preserve its files and check configuration-directory permissions.",
        503,
      );
    }
  }
  async function change<T>(
    project: string,
    action: (state: StoredOnboarding | undefined) => {
      state: StoredOnboarding;
      result: T;
    },
  ): Promise<T> {
    const target = file(project),
      lock = target + ".lock",
      token = randomBytes(16).toString("hex"),
      temporary = target + `.${token}.tmp`;
    let fd: number | undefined;
    let identity: { ino: number; dev: number } | undefined;
    try {
      // Validate every ancestor before creating the private directory.
      safe(target);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          fd = openSync(lock, "wx", 0o600);
          break;
        } catch (error) {
          if (
            !["EEXIST", "EPERM", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
          const previous = readPrivate(lock, 1024);
          if (previous) {
            const owner = JSON.parse(previous);
            if (
              !Number.isSafeInteger(owner.pid) ||
              owner.pid < 1 ||
              typeof owner.token !== "string"
            )
              throw new Error();
            if (dead(owner.pid) && readPrivate(lock, 1024) === previous)
              unlinkSync(lock);
          }
          if (attempt === 14)
            throw new ProjectOnboardingError(
              "Project setup is busy. Retry shortly.",
              409,
              "busy",
            );
          await new Promise((done) => setTimeout(done, 30));
        }
      }
      if (fd === undefined) throw new Error();
      identity = fstatSync(fd);
      protect(lock);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fsyncSync(fd);
      const { state, result } = action(read(project));
      const encoded = JSON.stringify(state) + "\n";
      if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error();
      const out = openSync(temporary, "wx", 0o600);
      try {
        protect(temporary);
        writeFileSync(out, encoded);
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
      safe(target);
      renameSync(temporary, target);
      if (process.platform !== "win32") {
        const parent = openSync(directory, "r");
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ProjectOnboardingError) throw error;
      throw new ProjectOnboardingError(
        "Project setup state could not be saved safely. Check configuration-directory permissions; previous data was preserved.",
        503,
      );
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        try {
          const stat = safe(lock, 1024);
          if (
            stat?.ino === identity?.ino &&
            stat?.dev === identity?.dev &&
            readPrivate(lock, 1024) ===
              JSON.stringify({ pid: process.pid, token })
          )
            unlinkSync(lock);
        } catch {
          /* Never remove an unsafe replacement. */
        }
      }
      try {
        if (safe(temporary)) unlinkSync(temporary);
      } catch {
        /* Preserve unsafe replacement. */
      }
    }
  }
  function list() {
    safe(join(directory, ".probe"));
    if (!lstatSync(directory, { throwIfNoEntry: false })) return [];
    const names = listProjectNames(root);
    if (names.length > 200)
      throw new ProjectOnboardingError(
        "Setup history exceeds its project limit.",
        503,
      );
    return names.map((name) => read(name)!).filter(Boolean);
  }
  return { read, change, list };
}
