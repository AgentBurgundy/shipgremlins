import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { loadProject } from "../config.ts";

export interface ResourceTarget {
  project: string;
  area?: string;
}
export interface DeletionPreview extends ResourceTarget {
  kind: "project" | "pm";
  name: string;
  revision: string;
  confirmation: string;
  effects: string[];
  retained: string[];
  blockers: string[];
}
export interface ResourceRecovery extends ResourceTarget {
  id: string;
  kind: "project" | "pm";
  name: string;
  status: "preparing" | "deleted" | "restoring" | "restored" | "failed";
  deletedAt: string;
}
interface Journal extends ResourceRecovery {
  projectInstanceId?: string;
  schema: 1;
  revision: string;
  files: Entry[];
  restoredTree?: Entry[];
  restoreBeforeTree?: Entry[];
  restoreStage?: string;
}
interface Entry {
  path: string;
  sha256: string;
  bytes: number;
  directory?: boolean;
}
export class ResourceDeletionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ResourceDeletionError";
  }
}
export type ConfigurationMutation = <T>(
  target: { project?: string; area?: string },
  operation: () => T | Promise<T>,
) => Promise<T>;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Three bounded trees, each up to 2,000 paths of 1,000 UTF-16 code units,
// plus hashes/JSON overhead. Reader and writer share the same ceiling.
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function fail(code: string, message: string, status = 400): never {
  throw new ResourceDeletionError(code, message, status);
}
function target(input: ResourceTarget) {
  if (
    !input ||
    !NAME.test(input.project) ||
    RESERVED.test(input.project) ||
    (input.area !== undefined &&
      (!NAME.test(input.area) || RESERVED.test(input.area)))
  )
    fail("invalid_target", "Choose a valid project and PM identifier.");
}
function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function safe(path: string) {
  let current = resolve(path);
  for (;;) {
    if (stat(current)?.isSymbolicLink())
      fail(
        "unsafe_path",
        "Deletion and recovery refuse symbolic links or junctions.",
      );
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}
function bytes(path: string, max = 64 * 1024): Buffer {
  safe(path);
  const info = stat(path);
  if (!info)
    fail(
      "not_found",
      "This resource no longer exists. Refresh the project list.",
      404,
    );
  if (!info.isFile() || info.nlink !== 1 || info.size > max)
    fail(
      "unsafe_path",
      "Recovery requires bounded regular files without hard links.",
    );
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(fd),
      current = lstatSync(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      fail(
        "conflict",
        "Resource changed while opening. Refresh and try again.",
        409,
      );
    const value = readFileSync(fd);
    if (value.length > max)
      fail("too_large", "Resource is too large for safe dashboard recovery.");
    return value;
  } finally {
    closeSync(fd);
  }
}
function objectFile(path: string, max = 64 * 1024): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes(path, max).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ResourceDeletionError) throw error;
    return fail(
      "invalid_config",
      "This configuration must contain a JSON object before this operation.",
    );
  }
}
let ownerSid: string | undefined;
function protect(directory: string, reset = false) {
  safe(directory);
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
    return;
  }
  try {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    ownerSid ??= execFileSync(
      join(system, "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    ).match(/S-1-[0-9-]+/)?.[0];
    if (!ownerSid) throw new Error();
    if (reset)
      execFileSync(
        join(system, "icacls.exe"),
        [directory, "/reset", "/T", "/Q"],
        { stdio: "ignore", windowsHide: true, timeout: 20000 },
      );
    execFileSync(
      join(system, "icacls.exe"),
      [directory, "/inheritance:r", "/grant:r", `*${ownerSid}:(OI)(CI)F`],
      { stdio: "ignore", windowsHide: true, timeout: 10000 },
    );
  } catch {
    fail(
      "privacy",
      "Windows could not restrict the recovery directory to your account. Check configuration-folder permissions.",
      500,
    );
  }
}
function validEntries(value: unknown): value is Entry[] {
  return (
    Array.isArray(value) &&
    value.length <= 2000 &&
    new Set(value.map((e) => e?.path)).size === value.length &&
    value.every(
      (e) =>
        e &&
        typeof e === "object" &&
        Object.keys(e).every((k) =>
          ["path", "sha256", "bytes", "directory"].includes(k),
        ) &&
        typeof e.path === "string" &&
        e.path.length <= 1000 &&
        !/[\\:]/.test(e.path) &&
        (e.path as string)
          .split("")
          .every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ) &&
        e.path
          .split("/")
          .every((p: string) => p !== "" && p !== "." && p !== "..") &&
        Number.isSafeInteger(e.bytes) &&
        e.bytes >= 0 &&
        e.bytes <= 16 * 1024 * 1024 &&
        (e.directory === true
          ? e.bytes === 0 && e.sha256 === ""
          : e.directory === undefined &&
            typeof e.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(e.sha256)),
    )
  );
}
function atomic(path: string, content: string | Buffer) {
  safe(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.resource-${randomUUID()}.tmp`),
    fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  safe(path);
  renameSync(temporary, path);
}
function tree(directory: string): Entry[] {
  safe(directory);
  const info = stat(directory);
  if (!info) return [];
  if (!info.isDirectory())
    fail(
      "unsafe_path",
      "Project and PM locations must be regular directories.",
    );
  const result: Entry[] = [];
  let total = 0;
  function visit(folder: string, prefix: string) {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name),
        relative = prefix ? `${prefix}/${name}` : name;
      safe(file);
      const item = lstatSync(file);
      if (item.isDirectory()) {
        result.push({ path: relative, sha256: "", bytes: 0, directory: true });
        visit(file, relative);
      } else {
        const data = bytes(file, 16 * 1024 * 1024);
        total += data.length;
        result.push({
          path: relative,
          sha256: digest(data),
          bytes: data.length,
        });
      }
      if (result.length > 2000 || total > 64 * 1024 * 1024)
        fail(
          "too_large",
          "This configuration tree exceeds the dashboard recovery limit. Preserve it and manage it manually.",
        );
    }
  }
  visit(directory, "");
  if (!validEntries(result))
    fail(
      "unsafe_path",
      "Configuration paths exceed the portable recovery format. No live configuration was changed.",
    );
  return result;
}
function copyTree(from: string, to: string) {
  const entries = tree(from);
  safe(to);
  if (stat(to))
    fail(
      "conflict",
      "Recovery staging already exists. Refresh recovery details.",
      409,
    );
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const destination = join(to, ...entry.path.split("/"));
    if (entry.directory)
      mkdirSync(destination, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(
        destination,
        bytes(join(from, ...entry.path.split("/")), 16 * 1024 * 1024),
        { flag: "wx", mode: 0o600 },
      );
    }
  }
}
function reservation(root: string, input: ResourceTarget) {
  target(input);
  return input.area
    ? join(
        root,
        ".run",
        "deleted",
        "reservations",
        "areas",
        `${input.project}${liveProjectInstance(root, input.project) ? `~${liveProjectInstance(root, input.project)}` : ""}`,
        `${input.area}.json`,
      )
    : join(
        root,
        ".run",
        "deleted",
        "reservations",
        "projects",
        `${input.project}.json`,
      );
}
interface PmReservation {
  id: string;
  project: string;
  area: string;
  replacementInstanceId?: string;
}
function projectReservation(root: string, project: string) {
  const file = reservation(root, { project });
  safe(file);
  if (!stat(file)) return null;
  const value = objectFile(file);
  if (
    Object.keys(value).some(
      (key) => !["id", "project", "replacementInstanceId"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    value.project !== project ||
    (value.replacementInstanceId !== undefined &&
      (typeof value.replacementInstanceId !== "string" ||
        !ID.test(value.replacementInstanceId)))
  )
    fail(
      "invalid_recovery",
      "The deleted project's identity record needs inspection; its backup was preserved.",
      409,
    );
  return {
    file,
    value: value as {
      id: string;
      project: string;
      replacementInstanceId?: string;
    },
  };
}
function liveProjectInstance(
  root: string,
  project: string,
): string | undefined {
  const file = join(root, "projects", project, "project.json");
  safe(file);
  if (!stat(file)) return undefined;
  const value = objectFile(file);
  return typeof value.instanceId === "string" && ID.test(value.instanceId)
    ? value.instanceId
    : undefined;
}
/** Reserve a new incarnation without deleting the old recovery copy or runtime evidence. */
export function prepareProjectRecreation(
  root: string,
  project: string,
): string | undefined {
  const marker = projectReservation(root, project);
  if (!marker) return undefined;
  const journal = objectFile(
    join(root, ".run", "deleted", marker.value.id, "recovery.json"),
    MAX_JOURNAL_BYTES,
  );
  if (
    journal.schema !== 1 ||
    journal.id !== marker.value.id ||
    journal.kind !== "project" ||
    journal.project !== project ||
    journal.status !== "deleted" ||
    !validEntries(journal.files)
  )
    fail(
      "recovery_required",
      "Finish the interrupted deletion or restoration in Settings → Recently deleted before reusing this project name.",
      409,
    );
  const live = join(root, "projects", project);
  safe(live);
  if (stat(live)) {
    if (
      marker.value.replacementInstanceId &&
      liveProjectInstance(root, project) === marker.value.replacementInstanceId
    )
      return marker.value.replacementInstanceId;
    fail(
      "conflict",
      "A project already occupies this identifier. Its configuration will not be overwritten.",
      409,
    );
  }
  const instanceId = marker.value.replacementInstanceId ?? randomUUID();
  if (!marker.value.replacementInstanceId)
    atomic(
      marker.file,
      json({ ...marker.value, replacementInstanceId: instanceId }),
    );
  return instanceId;
}
export function completeProjectRecreation(
  root: string,
  project: string,
  instanceId: string,
): void {
  const marker = projectReservation(root, project);
  if (!marker) return;
  if (
    marker.value.replacementInstanceId !== instanceId ||
    liveProjectInstance(root, project) !== instanceId
  )
    fail(
      "conflict",
      "Project recreation changed before it could finish. Configuration and recovery copies were preserved.",
      409,
    );
  unlinkSync(marker.file);
}
function pmReservation(root: string, project: string, area: string) {
  const file = reservation(root, { project, area });
  safe(file);
  if (!stat(file)) return null;
  const value = objectFile(file);
  if (
    Object.keys(value).some(
      (key) =>
        !["id", "project", "area", "replacementInstanceId"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    value.project !== project ||
    value.area !== area ||
    (value.replacementInstanceId !== undefined &&
      (typeof value.replacementInstanceId !== "string" ||
        !ID.test(value.replacementInstanceId)))
  )
    fail(
      "invalid_recovery",
      "The deleted PM's identity record needs inspection; its backup was preserved.",
      409,
    );
  return { file, value: value as unknown as PmReservation };
}
function livePmInstance(root: string, project: string, area: string) {
  const value = objectFile(join(root, "projects", project, "areas.json"));
  if (
    !value.areas ||
    typeof value.areas !== "object" ||
    Array.isArray(value.areas)
  )
    fail(
      "invalid_config",
      "PM configuration must be repaired before reusing an identifier.",
    );
  const row = (value.areas as Record<string, unknown>)[area];
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>).instanceId
    : undefined;
}
/** Called under the provisioning/admission locks, before committing a replacement PM. */
export function preparePmRecreation(
  root: string,
  project: string,
  area: string,
): string | undefined {
  assertResourceAvailable(root, project);
  const marker = pmReservation(root, project, area);
  if (!marker) return undefined;
  const journal = objectFile(
    join(root, ".run", "deleted", marker.value.id, "recovery.json"),
    MAX_JOURNAL_BYTES,
  );
  if (
    journal.schema !== 1 ||
    journal.id !== marker.value.id ||
    journal.kind !== "pm" ||
    journal.project !== project ||
    journal.area !== area ||
    journal.status !== "deleted" ||
    !validEntries(journal.files)
  )
    fail(
      "recovery_required",
      "Finish restoring or recovering the interrupted deletion in Settings → Recently deleted before creating this PM again.",
      409,
    );
  const areas = objectFile(join(root, "projects", project, "areas.json"));
  if (
    !areas.areas ||
    typeof areas.areas !== "object" ||
    Array.isArray(areas.areas) ||
    Object.hasOwn(areas.areas, area)
  )
    fail(
      "conflict",
      "A PM already occupies this identifier. Refresh before creating it again.",
      409,
    );
  const docs = join(root, "projects", project, area);
  safe(docs);
  if (stat(docs))
    fail(
      "conflict",
      "The former PM document directory still exists. Preserve it and finish recovery before creating a fresh PM.",
      409,
    );
  const instanceId = marker.value.replacementInstanceId ?? randomUUID();
  if (!marker.value.replacementInstanceId)
    atomic(
      marker.file,
      json({ ...marker.value, replacementInstanceId: instanceId }),
    );
  return instanceId;
}
/** Safe to retry after the areas.json commit. The original recovery copy remains intact. */
export function completePmRecreation(
  root: string,
  project: string,
  area: string,
  instanceId: string,
): void {
  const marker = pmReservation(root, project, area);
  if (!marker) return;
  if (
    marker.value.replacementInstanceId !== instanceId ||
    livePmInstance(root, project, area) !== instanceId
  )
    fail(
      "conflict",
      "PM recreation changed before it could finish. Saved configuration and recovery files were preserved.",
      409,
    );
  unlinkSync(marker.file);
}
/** Reservation checks are local-only and must run inside the queue's admission lock. */
export function assertResourceAvailable(
  root: string,
  project: string,
  area?: string,
  candidateInstanceId?: string,
): void {
  for (const input of [{ project }, ...(area ? [{ project, area }] : [])]) {
    const file = reservation(root, input);
    safe(file);
    if (stat(file)) {
      if (!input.area) {
        const marker = projectReservation(root, project);
        if (
          marker?.value.replacementInstanceId &&
          liveProjectInstance(root, project) ===
            marker.value.replacementInstanceId
        )
          continue;
      }
      if (input.area) {
        const marker = pmReservation(root, project, input.area);
        if (
          marker?.value.replacementInstanceId &&
          marker.value.replacementInstanceId ===
            (candidateInstanceId ?? livePmInstance(root, project, input.area))
        )
          continue;
      }
      fail(
        "reserved",
        "This identifier belongs to a deleted resource. Restore it from Settings → Recently deleted or choose a new identifier; its history has been preserved.",
        409,
      );
    }
  }
}
function provisioningBusy(lock: string): boolean {
  safe(lock);
  const original = stat(lock);
  if (!original) return false;
  if (
    !original.isFile() ||
    original.nlink !== 1 ||
    original.size < 1 ||
    original.size > 64
  )
    return true;
  try {
    const content = bytes(lock, 64),
      text = content.toString("utf8");
    if (!/^[1-9][0-9]{0,9}$/.test(text)) return true;
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
    }
    // Never clear a replacement owner or a lock changed while probing its PID.
    safe(lock);
    const current = stat(lock);
    if (!current) return false;
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs ||
      current.ctimeMs !== original.ctimeMs ||
      !bytes(lock, 64).equals(content)
    )
      return true;
    unlinkSync(lock);
    return false;
  } catch {
    return true;
  }
}
export function withProjectLifecycleLock<T>(
  root: string,
  input: ResourceTarget,
  operation: () => T,
): T {
  target(input);
  const lock = join(
    root,
    ".run",
    "linear",
    "provisioning",
    `${input.project}.lock`,
  );
  safe(lock);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  if (provisioningBusy(lock))
    fail(
      "blocked",
      "Linear setup or mapping repair holds this project. Wait for it to finish before deletion/restoration.",
      409,
    );
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    fail(
      "blocked",
      "Linear setup started while this operation was being reviewed. Wait for it to finish and retry.",
      409,
    );
  }
  try {
    writeFileSync(fd, String(process.pid));
    return operation();
  } finally {
    const owned = fstatSync(fd),
      current = stat(lock);
    closeSync(fd);
    if (current?.ino === owned.ino && current?.dev === owned.dev)
      unlinkSync(lock);
  }
}
const retained = [
  "External Git repositories, Linear teams/projects/tickets and hosting resources.",
  "Shared connections and credentials, worker registrations and historical runs.",
  "A private local recovery copy. Deleted names can be reused for fresh projects or PMs without inheriting their previous configuration or learned history.",
];
export function createResourceDeletion(options: {
  root: string;
  withConfigurationMutation: ConfigurationMutation;
  blockers?: (target: ResourceTarget) => Promise<string[]> | string[];
  now?: () => Date;
  move?: typeof renameSync;
  write?: typeof atomic;
}) {
  const root = resolve(options.root),
    base = join(root, ".run", "deleted"),
    move = options.move ?? renameSync,
    write = options.write ?? atomic;
  function writeJournal(directory: string, journal: Journal) {
    const content = json(journal);
    if (Buffer.byteLength(content, "utf8") > MAX_JOURNAL_BYTES)
      fail(
        "too_large",
        "Recovery metadata exceeds its bounded format. Live configuration was preserved.",
      );
    write(join(directory, "recovery.json"), content);
  }
  const projectDir = (input: ResourceTarget) =>
    join(root, "projects", input.project);
  const confirmation = (input: ResourceTarget) =>
    input.area ? `${input.project}/${input.area}` : input.project;
  const folder = (id: string) => {
    if (!ID.test(id))
      fail("invalid_recovery", "Choose a saved recovery record.");
    const result = join(base, id);
    safe(result);
    return result;
  };
  function readJournal(id: string): Journal {
    const value = objectFile(
      join(folder(id), "recovery.json"),
      MAX_JOURNAL_BYTES,
    ) as unknown as Journal;
    target(value);
    if (
      Object.keys(value).some(
        (k) =>
          ![
            "schema",
            "id",
            "kind",
            "project",
            "area",
            "name",
            "status",
            "deletedAt",
            "revision",
            "files",
            "restoredTree",
            "restoreBeforeTree",
            "restoreStage",
            "projectInstanceId",
          ].includes(k),
      ) ||
      value.schema !== 1 ||
      value.id !== id ||
      value.kind !== (value.area ? "pm" : "project") ||
      (value.projectInstanceId !== undefined &&
        !ID.test(value.projectInstanceId)) ||
      !["preparing", "deleted", "restoring", "restored", "failed"].includes(
        value.status,
      ) ||
      typeof value.name !== "string" ||
      value.name.length > 100 ||
      typeof value.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(value.deletedAt)) ||
      !/^[a-f0-9]{64}$/.test(value.revision) ||
      !validEntries(value.files) ||
      (value.restoredTree !== undefined && !validEntries(value.restoredTree)) ||
      (value.restoreBeforeTree !== undefined &&
        !validEntries(value.restoreBeforeTree)) ||
      (value.restoreStage !== undefined &&
        (typeof value.restoreStage !== "string" ||
          !/^validate-[a-f0-9-]{36}$/.test(value.restoreStage)))
    )
      fail(
        "invalid_recovery",
        "Recovery metadata needs inspection; saved files were preserved.",
      );
    return value;
  }
  function snapshot(input: ResourceTarget) {
    target(input);
    safe(projectDir(input));
    if (!stat(projectDir(input)))
      fail("not_found", "This project no longer exists.", 404);
    const all = tree(projectDir(input));
    if (!input.area)
      return { entries: all, revision: digest(json(all)), name: input.project };
    const areas = objectFile(join(projectDir(input), "areas.json"));
    if (
      !areas.areas ||
      typeof areas.areas !== "object" ||
      Array.isArray(areas.areas) ||
      !Object.hasOwn(areas.areas, input.area)
    )
      fail("not_found", "This PM no longer exists. Refresh the project.", 404);
    const row = (areas.areas as Record<string, Record<string, unknown>>)[
      input.area
    ]!;
    const entries = all.filter(
      (entry) =>
        ["project.json", "areas.json", "tiers.json"].includes(entry.path) ||
        entry.path === input.area ||
        entry.path.startsWith(`${input.area}/`),
    );
    return {
      entries,
      revision: digest(json(entries)),
      name: typeof row.name === "string" ? row.name.slice(0, 100) : input.area,
    };
  }
  async function blockers(input: ResourceTarget) {
    const values = [...((await options.blockers?.(input)) ?? [])];
    const lock = join(
      root,
      ".run",
      "linear",
      "provisioning",
      `${input.project}.lock`,
    );
    if (provisioningBusy(lock))
      values.push(
        "Linear setup or mapping repair holds this project. Wait for it to finish, or recover its existing lock before deletion/restoration.",
      );
    return values;
  }
  async function preview(input: ResourceTarget): Promise<DeletionPreview> {
    const current = snapshot(input);
    return {
      project: input.project,
      ...(input.area ? { area: input.area } : {}),
      kind: input.area ? "pm" : "project",
      name: current.name,
      revision: current.revision,
      confirmation: confirmation(input),
      effects: input.area
        ? [
            "Remove this PM from the project's automation and archive its local mandate/docs.",
            "Other PMs and project settings remain unchanged.",
          ]
        : [
            "Remove this project and all its PMs from local configuration and automation.",
            "Archive the complete local project configuration directory.",
          ],
      retained: [...retained],
      blockers: await blockers(input),
    };
  }
  async function remove(
    input: ResourceTarget & { revision: string; confirmation: string },
  ) {
    return options.withConfigurationMutation(input, async () => {
      const plan = await preview(input);
      if (plan.blockers.length) fail("blocked", plan.blockers.join(" "), 409);
      if (input.confirmation !== plan.confirmation)
        fail(
          "confirmation",
          "Type the exact project/PM identifier shown in the deletion preview.",
        );
      if (
        input.revision !== plan.revision ||
        snapshot(input).revision !== plan.revision
      )
        fail(
          "conflict",
          "Configuration changed after the preview. Review deletion again.",
          409,
        );
      assertResourceAvailable(root, input.project, input.area);
      return withProjectLifecycleLock(root, input, () => {
        const id = randomUUID(),
          destination = folder(id),
          marker = reservation(root, input),
          source = input.area
            ? join(projectDir(input), input.area)
            : projectDir(input);
        const journal: Journal = {
          schema: 1,
          id,
          kind: plan.kind,
          project: input.project,
          ...(input.area && liveProjectInstance(root, input.project)
            ? { projectInstanceId: liveProjectInstance(root, input.project) }
            : {}),
          ...(input.area ? { area: input.area } : {}),
          name: plan.name,
          status: "preparing",
          deletedAt: (options.now?.() ?? new Date()).toISOString(),
          revision: plan.revision,
          files: snapshot(input).entries,
        };
        safe(base);
        mkdirSync(base, { recursive: true, mode: 0o700 });
        protect(base);
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        let originalAreas: Buffer | undefined,
          moved = false,
          changed = false;
        if (input.area) {
          originalAreas = bytes(join(projectDir(input), "areas.json"));
          writeFileSync(join(destination, "areas.before.json"), originalAreas, {
            flag: "wx",
            mode: 0o600,
          });
        }
        writeJournal(destination, journal);
        write(marker, json({ id, project: input.project, area: input.area }));
        try {
          if (snapshot(input).revision !== plan.revision)
            fail(
              "conflict",
              "Configuration changed before deletion. Refresh and review it again.",
              409,
            );
          if (stat(source)) {
            safe(source);
            move(source, join(destination, input.area ? "pm" : "project"));
            moved = true;
            protect(join(destination, input.area ? "pm" : "project"), true);
          }
          if (input.area) {
            const areas = JSON.parse(originalAreas!.toString("utf8"));
            delete areas.areas[input.area];
            write(join(projectDir(input), "areas.json"), json(areas));
            changed = true;
          }
          journal.status = "deleted";
          writeJournal(destination, journal);
        } catch (error) {
          try {
            if (changed)
              write(join(projectDir(input), "areas.json"), originalAreas!);
            if (moved)
              renameSync(
                join(destination, input.area ? "pm" : "project"),
                source,
              );
            journal.status = "failed";
            writeJournal(destination, journal);
            unlinkSync(marker);
          } catch {
            fail(
              "recovery_required",
              "Deletion was interrupted. Use Settings → Recently deleted to recover the private backup before retrying.",
              409,
            );
          }
          if (error instanceof ResourceDeletionError) throw error;
          fail(
            "io_error",
            "Deletion could not complete. Original configuration was restored and the private backup was retained.",
            500,
          );
        }
        return {
          deleted: true as const,
          recoveryId: id,
          recoveryPath: destination,
        };
      });
    });
  }
  function listRecoveries(): ResourceRecovery[] {
    safe(base);
    if (!stat(base)) return [];
    return readdirSync(base)
      .filter((id) => ID.test(id))
      .map((id) => {
        const value = readJournal(id);
        return {
          id: value.id,
          kind: value.kind,
          project: value.project,
          ...(value.area ? { area: value.area } : {}),
          name: value.name,
          status: value.status,
          deletedAt: value.deletedAt,
        };
      })
      .filter((value) => value.status !== "failed")
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  function restoreSnapshot(journal: Journal) {
    const directory = folder(journal.id),
      archived = join(directory, journal.area ? "pm" : "project"),
      marker = reservation(root, journal);
    const live = stat(projectDir(journal)) ? tree(projectDir(journal)) : [];
    return digest(
      json({
        journal,
        archive: tree(archived),
        areasBefore: journal.area
          ? digest(bytes(join(directory, "areas.before.json")))
          : null,
        reservation: stat(marker) ? digest(bytes(marker)) : null,
        live,
      }),
    );
  }
  function restorationComplete(journal: Journal) {
    return (
      !!journal.restoredTree &&
      ["restoring", "restored"].includes(journal.status) &&
      digest(json(tree(projectDir(journal)))) ===
        digest(json(journal.restoredTree))
    );
  }
  function restorationResumable(journal: Journal) {
    if (
      journal.status !== "restoring" ||
      !journal.restoreBeforeTree ||
      !journal.restoredTree ||
      !journal.restoreStage ||
      !stat(projectDir(journal))
    )
      return false;
    const staged = join(
      folder(journal.id),
      journal.restoreStage,
      "projects",
      journal.project,
    );
    if (digest(json(tree(staged))) !== digest(json(journal.restoredTree)))
      return false;
    const before = new Map(
        journal.restoreBeforeTree.map((e) => [e.path, JSON.stringify(e)]),
      ),
      after = new Map(
        journal.restoredTree.map((e) => [e.path, JSON.stringify(e)]),
      ),
      current = tree(projectDir(journal));
    if (
      current.some(
        (e) =>
          JSON.stringify(e) !== before.get(e.path) &&
          JSON.stringify(e) !== after.get(e.path),
      )
    )
      return false;
    return journal.restoreBeforeTree.every((e) =>
      current.some((c) => c.path === e.path),
    );
  }
  function untouchedPreparingProject(journal: Journal) {
    return (
      !journal.area &&
      journal.status === "preparing" &&
      !stat(join(folder(journal.id), "project")) &&
      digest(json(tree(projectDir(journal)))) === digest(json(journal.files))
    );
  }
  function originalAreaPresent(journal: Journal) {
    if (
      !journal.area ||
      journal.status !== "preparing" ||
      !stat(projectDir(journal))
    )
      return false;
    const before = objectFile(join(folder(journal.id), "areas.before.json")),
      current = objectFile(join(projectDir(journal), "areas.json"));
    return (
      JSON.stringify(
        (before.areas as Record<string, unknown>)?.[journal.area],
      ) ===
      JSON.stringify((current.areas as Record<string, unknown>)?.[journal.area])
    );
  }
  function originalDocsPresent(journal: Journal) {
    if (!journal.area || journal.status !== "preparing") return false;
    const prefix = `${journal.area}/`,
      expected = journal.files
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    return (
      digest(json(tree(join(projectDir(journal), journal.area)))) ===
      digest(json(expected))
    );
  }
  function restoreReservation(journal: Journal) {
    const file = reservation(root, journal);
    safe(file);
    if (!journal.area) {
      const marker = projectReservation(root, journal.project);
      if (!marker)
        fail(
          "conflict",
          "A replacement project occupies this name, or its deletion has not completed. Recovery will not overwrite it.",
          409,
        );
      if (marker.value.id === journal.id) return { file, transfer: false };
      const owner = readJournal(marker.value.id);
      if (
        journal.status !== "deleted" ||
        owner.status !== "deleted" ||
        owner.kind !== "project" ||
        owner.project !== journal.project ||
        marker.value.replacementInstanceId ||
        stat(projectDir(journal))
      )
        fail(
          "conflict",
          "Another project deletion, recreation or restoration is unfinished. Resolve it before restoring this archive.",
          409,
        );
      return { file, transfer: true };
    }
    if (
      stat(projectDir(journal)) &&
      liveProjectInstance(root, journal.project) !== journal.projectInstanceId
    )
      fail(
        "conflict",
        "This PM belongs to a different project incarnation. Restore its original parent project before restoring the PM.",
        409,
      );
    const marker = pmReservation(root, journal.project, journal.area);
    if (!marker)
      fail(
        "conflict",
        "This PM has no active deletion reservation. Resolve its current configuration before restoring it.",
        409,
      );
    if (marker.value.id === journal.id) return { file, transfer: false };
    // Choosing an older PM generation is explicit in the recovery preview. Only
    // a completed deletion can release the same vacant identity to that choice.
    const owner = readJournal(marker.value.id);
    if (
      journal.status !== "deleted" ||
      owner.status !== "deleted" ||
      owner.kind !== "pm" ||
      owner.project !== journal.project ||
      owner.area !== journal.area ||
      marker.value.replacementInstanceId !== undefined
    )
      fail(
        "conflict",
        "Another PM deletion, recreation or recovery is unfinished. Resolve it before restoring this archived PM.",
        409,
      );
    const live = projectDir(journal);
    if (!stat(live))
      fail(
        "conflict",
        "Restore the parent project before restoring this PM.",
        409,
      );
    const rows = objectFile(join(live, "areas.json")).areas;
    if (
      !rows ||
      typeof rows !== "object" ||
      Array.isArray(rows) ||
      Object.hasOwn(rows, journal.area) ||
      stat(join(live, journal.area))
    )
      fail(
        "conflict",
        "A PM or its document directory already occupies this identifier. Recovery will not overwrite it.",
        409,
      );
    return { file, transfer: true };
  }
  async function previewRestore(
    id: string,
  ): Promise<DeletionPreview & { id: string }> {
    const journal = readJournal(id);
    const blocked = await blockers(journal),
      finished = restorationComplete(journal),
      resumable = restorationResumable(journal);
    try {
      restoreReservation(journal);
    } catch (error) {
      if (error instanceof ResourceDeletionError) blocked.push(error.message);
      else throw error;
    }
    if (
      !["deleted", "preparing", "restoring"].includes(journal.status) &&
      !(
        journal.status === "restored" &&
        stat(reservation(root, journal)) &&
        finished
      )
    )
      blocked.push(
        "This recovery record has already been restored or its deletion was rolled back.",
      );
    const live = projectDir(journal);
    if (
      !journal.area &&
      stat(live) &&
      !finished &&
      !resumable &&
      !untouchedPreparingProject(journal)
    )
      blocked.push(
        "A project already occupies this identifier. Recovery will not overwrite it.",
      );
    if (journal.area && !finished && !resumable) {
      if (!stat(live))
        blocked.push("Restore the parent project before restoring this PM.");
      else {
        const rows = objectFile(join(live, "areas.json")).areas as
          Record<string, unknown> | undefined;
        if (
          rows &&
          Object.hasOwn(rows, journal.area) &&
          !originalAreaPresent(journal)
        )
          blocked.push(
            "A PM already occupies this identifier. Recovery will not overwrite it.",
          );
        if (stat(join(live, journal.area)) && !originalDocsPresent(journal))
          blocked.push(
            "The PM document directory already exists. Recovery will not overwrite it.",
          );
      }
    }
    return {
      id,
      kind: journal.kind,
      project: journal.project,
      ...(journal.area ? { area: journal.area } : {}),
      name: journal.name,
      confirmation: confirmation(journal),
      revision: restoreSnapshot(journal),
      effects: [
        "Restore local configuration from its private recovery copy.",
        "Restored PMs remain paused and the project must be verified again before automation runs.",
      ],
      retained: [
        "The original recovery copy and all historical records remain available.",
        "No external provider resources or shared credentials change.",
      ],
      blockers: blocked,
    };
  }
  async function restore(input: {
    id: string;
    revision: string;
    confirmation: string;
  }) {
    const journal = readJournal(input.id);
    return options.withConfigurationMutation(journal, async () => {
      const plan = await previewRestore(input.id);
      if (plan.blockers.length) fail("blocked", plan.blockers.join(" "), 409);
      if (input.confirmation !== plan.confirmation)
        fail(
          "confirmation",
          "Type the exact identifier shown in the restore preview.",
        );
      if (
        input.revision !== plan.revision ||
        restoreSnapshot(journal) !== plan.revision
      )
        fail(
          "conflict",
          "Recovery or current configuration changed. Review restoration again.",
          409,
        );
      return withProjectLifecycleLock(root, journal, () => {
        const directory = folder(input.id),
          staged = join(directory, `restore-${randomUUID()}`),
          live = projectDir(journal),
          marker = reservation(root, journal);
        const claim = restoreReservation(journal);
        if (claim.transfer)
          write(
            claim.file,
            json({
              id: journal.id,
              project: journal.project,
              area: journal.area,
            }),
          );
        // If interrupted after transfer, the selected archive owns a valid
        // reservation and the same restore can resume without losing either copy.
        const claimedRevision = restoreSnapshot(journal);
        if (restorationComplete(journal)) {
          journal.status = "restored";
          writeJournal(directory, journal);
          unlinkSync(marker);
          return {
            restored: true as const,
            project: journal.project,
            ...(journal.area ? { area: journal.area } : {}),
            recoveryId: input.id,
            verificationRequired: true as const,
          };
        }
        protect(base);
        if (restorationResumable(journal)) {
          const source = join(
            directory,
            journal.restoreStage!,
            "projects",
            journal.project,
          );
          for (const entry of journal.restoredTree!) {
            const destination = join(live, ...entry.path.split("/"));
            if (stat(destination)) continue;
            if (entry.directory)
              mkdirSync(destination, { recursive: true, mode: 0o700 });
            else {
              mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
              writeFileSync(
                destination,
                bytes(join(source, ...entry.path.split("/")), 16 * 1024 * 1024),
                { flag: "wx", mode: 0o600 },
              );
            }
          }
          write(join(live, "areas.json"), bytes(join(source, "areas.json")));
          write(
            join(live, "project.json"),
            bytes(join(source, "project.json")),
          );
          if (!restorationComplete(journal))
            fail(
              "recovery_required",
              "Restoration is still incomplete. Preserve the backup and refresh recovery details.",
              409,
            );
          journal.status = "restored";
          writeJournal(directory, journal);
          unlinkSync(marker);
          return {
            restored: true as const,
            project: journal.project,
            ...(journal.area ? { area: journal.area } : {}),
            recoveryId: input.id,
            verificationRequired: true as const,
          };
        }
        if (!journal.area) {
          const inPlace = untouchedPreparingProject(journal);
          if (inPlace) copyTree(live, join(directory, "project"));
          copyTree(join(directory, "project"), staged);
          const project = objectFile(join(staged, "project.json")),
            areas = objectFile(join(staged, "areas.json"));
          project.verified = null;
          for (const row of Object.values(
            areas.areas as Record<string, Record<string, unknown>>,
          )) {
            row.enabled = false;
            if (row.codingEnabled !== undefined) row.codingEnabled = false;
          }
          write(join(staged, "project.json"), json(project));
          write(join(staged, "areas.json"), json(areas));
          // Validate at its real project name without exposing staged settings to the live scheduler.
          const validation = join(directory, `validate-${randomUUID()}`);
          mkdirSync(join(validation, "projects"), {
            recursive: true,
            mode: 0o700,
          });
          copyTree(staged, join(validation, "projects", journal.project));
          loadProject(validation, journal.project);
          if (!inPlace && restoreSnapshot(journal) !== claimedRevision)
            fail(
              "conflict",
              "Configuration changed before restoration. Refresh and retry.",
              409,
            );
          journal.restoredTree = tree(staged);
          journal.restoreBeforeTree = tree(live);
          journal.restoreStage = basename(validation);
          journal.status = "restoring";
          writeJournal(directory, journal);
          if (inPlace) {
            write(join(live, "areas.json"), bytes(join(staged, "areas.json")));
            write(
              join(live, "project.json"),
              bytes(join(staged, "project.json")),
            );
          } else move(staged, live);
        } else {
          const projectFile = join(live, "project.json"),
            areasFile = join(live, "areas.json"),
            oldProject = bytes(projectFile),
            oldAreas = bytes(areasFile),
            project = JSON.parse(oldProject.toString("utf8")),
            areas = JSON.parse(oldAreas.toString("utf8")),
            archivedAreas = objectFile(join(directory, "areas.before.json"));
          const original = (
            archivedAreas.areas as Record<string, Record<string, unknown>>
          )?.[journal.area];
          if (!original)
            fail(
              "invalid_recovery",
              "The archived PM configuration is missing.",
            );
          areas.areas[journal.area] = {
            ...original,
            enabled: false,
            ...(original.codingEnabled === undefined
              ? {}
              : { codingEnabled: false }),
          };
          project.verified = null;
          const validation = join(directory, `validate-${randomUUID()}`);
          copyTree(live, join(validation, "projects", journal.project));
          write(
            join(validation, "projects", journal.project, "project.json"),
            json(project),
          );
          write(
            join(validation, "projects", journal.project, "areas.json"),
            json(areas),
          );
          loadProject(validation, journal.project);
          const archived = join(directory, "pm");
          if (stat(archived) && !stat(join(live, journal.area)))
            copyTree(archived, staged);
          if (restoreSnapshot(journal) !== claimedRevision)
            fail(
              "conflict",
              "Configuration changed before restoration. Refresh and retry.",
              409,
            );
          if (
            stat(archived) &&
            !stat(join(validation, "projects", journal.project, journal.area))
          )
            copyTree(
              archived,
              join(validation, "projects", journal.project, journal.area),
            );
          journal.restoredTree = tree(
            join(validation, "projects", journal.project),
          );
          journal.restoreBeforeTree = tree(live);
          journal.restoreStage = basename(validation);
          journal.status = "restoring";
          writeJournal(directory, journal);
          let moved = false;
          try {
            if (stat(staged)) {
              move(staged, join(live, journal.area));
              moved = true;
            }
            write(areasFile, json(areas));
            write(projectFile, json(project));
          } catch {
            write(areasFile, oldAreas);
            write(projectFile, oldProject);
            if (moved) renameSync(join(live, journal.area), staged);
            journal.status = "deleted";
            delete journal.restoredTree;
            writeJournal(directory, journal);
            fail(
              "io_error",
              "Restoration failed. Existing configuration and the private recovery copy were preserved.",
              500,
            );
          }
        }
        journal.status = "restored";
        writeJournal(directory, journal);
        unlinkSync(marker);
        return {
          restored: true as const,
          project: journal.project,
          ...(journal.area ? { area: journal.area } : {}),
          recoveryId: input.id,
          verificationRequired: true as const,
        };
      });
    });
  }
  return { preview, remove, listRecoveries, previewRestore, restore };
}
