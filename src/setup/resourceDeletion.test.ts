import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeSetup } from "./files.ts";
import { loadProject } from "../config.ts";
import {
  assertResourceAvailable,
  preparePmRecreation,
  completePmRecreation,
  createResourceDeletion,
} from "./resourceDeletion.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-deletion-")));
  roots.push(root);
  initializeSetup(root, resolve("."), { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects", "app", "project.json"),
    areasFile = join(root, "projects", "app", "areas.json"),
    project = JSON.parse(readFileSync(projectFile, "utf8")),
    areas = JSON.parse(readFileSync(areasFile, "utf8"));
  project.verified = "2026-10-05T10:00:00Z";
  areas.areas.core.enabled = true;
  writeFileSync(projectFile, JSON.stringify(project));
  writeFileSync(areasFile, JSON.stringify(areas));
  writeFileSync(join(root, ".env"), "SECRET=private-value\n");
  mkdirSync(join(root, ".run", "pm-knowledge", "app"), { recursive: true });
  writeFileSync(
    join(root, ".run", "pm-knowledge", "app", "retained.json"),
    "history",
  );
  const create = (
    extra: Partial<Parameters<typeof createResourceDeletion>[0]> = {},
  ) =>
    createResourceDeletion({
      root,
      withConfigurationMutation: async (_target, operation) => operation(),
      ...extra,
    });
  return { root, create, service: create(), projectFile, areasFile };
}
async function replacedPmFixture() {
  const f = fixture();
  const old = await f.service.remove(
    await f.service.preview({ project: "app", area: "core" }),
  );
  const instanceId = preparePmRecreation(f.root, "app", "core")!;
  const original = JSON.parse(
    readFileSync(join(old.recoveryPath, "areas.before.json"), "utf8"),
  ).areas.core;
  const document = readEditableConfig(f.root, "projects/app/areas.json");
  saveEditableConfig(f.root, {
    ...document,
    content: JSON.stringify({
      areas: {
        core: {
          ...original,
          name: "Replacement PM",
          enabled: false,
          instanceId,
        },
      },
    }),
  });
  completePmRecreation(f.root, "app", "core", instanceId);
  return {
    ...f,
    old,
    instanceId,
    marker: join(f.root, ".run/deleted/reservations/areas/app/core.json"),
    deleteReplacement: () =>
      f.service
        .preview({ project: "app", area: "core" })
        .then(f.service.remove),
  };
}
describe("reversible project and PM deletion", () => {
  it("restores an explicitly selected older PM generation only after the replacement is deleted", async () => {
    const f = await replacedPmFixture();
    const originalBackup = readFileSync(
      join(f.old.recoveryPath, "areas.before.json"),
    );
    const before = readFileSync(f.areasFile);
    const occupied = await f.service.previewRestore(f.old.recoveryId);
    expect(occupied.blockers.join(" ")).toContain("already occupies");
    await expect(f.service.restore(occupied)).rejects.toMatchObject({
      status: 409,
    });
    expect(readFileSync(f.areasFile)).toEqual(before);
    const latest = await f.deleteReplacement();
    const replacementBackup = readFileSync(
      join(latest.recoveryPath, "areas.before.json"),
    );
    const plan = await f.service.previewRestore(f.old.recoveryId);
    expect(plan.blockers).toEqual([]);
    await f.service.restore(plan);
    expect(loadProject(f.root, "app").areas[0]).toMatchObject({
      key: "core",
      enabled: false,
    });
    expect(loadProject(f.root, "app").areas[0]?.instanceId).toBeUndefined();
    expect(loadProject(f.root, "app").config.verified).toBeNull();
    expect(readFileSync(join(f.old.recoveryPath, "areas.before.json"))).toEqual(
      originalBackup,
    );
    expect(
      readFileSync(join(latest.recoveryPath, "areas.before.json")),
    ).toEqual(replacementBackup);
    expect(f.service.listRecoveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.old.recoveryId, status: "restored" }),
        expect.objectContaining({ id: latest.recoveryId, status: "deleted" }),
      ]),
    );
    expect(existsSync(f.marker)).toBe(false);
  });
  it("resumes a selected older generation after interruption immediately following reservation transfer", async () => {
    const f = await replacedPmFixture();
    const latest = await f.deleteReplacement();
    const before = readFileSync(f.areasFile);
    const latestJournal = readFileSync(
      join(latest.recoveryPath, "recovery.json"),
    );
    const interrupted = f.create({
      write: (file, content) => {
        if (file !== f.marker)
          throw new Error("Unexpected write before reservation transfer");
        writeFileSync(file, content);
        throw new Error("synthetic crash after reservation transfer");
      },
    });
    await expect(
      interrupted.restore(await interrupted.previewRestore(f.old.recoveryId)),
    ).rejects.toThrow("synthetic crash after reservation transfer");
    expect(JSON.parse(readFileSync(f.marker, "utf8")).id).toBe(
      f.old.recoveryId,
    );
    expect(readFileSync(f.areasFile)).toEqual(before);
    expect(readFileSync(join(latest.recoveryPath, "recovery.json"))).toEqual(
      latestJournal,
    );
    const retry = await f.create().previewRestore(f.old.recoveryId);
    expect(retry.blockers).toEqual([]);
    await f.create().restore(retry);
    expect(loadProject(f.root, "app").areas[0]?.instanceId).toBeUndefined();
    expect(existsSync(f.marker)).toBe(false);
  });
  it.each([
    "pending-deletion",
    "pending-recreation",
    "wrong-owner",
    "malformed-marker",
  ])(
    "blocks older-generation restoration for %s without changing either history",
    async (condition) => {
      const f = await replacedPmFixture();
      const latest = await f.deleteReplacement();
      const journalFile = join(latest.recoveryPath, "recovery.json");
      if (condition === "pending-recreation")
        preparePmRecreation(f.root, "app", "core");
      else if (condition === "malformed-marker") writeFileSync(f.marker, "{}");
      else {
        const journal = JSON.parse(readFileSync(journalFile, "utf8"));
        if (condition === "pending-deletion") journal.status = "preparing";
        else journal.area = "another";
        writeFileSync(journalFile, JSON.stringify(journal));
      }
      const files = [
        f.areasFile,
        f.marker,
        journalFile,
        join(f.old.recoveryPath, "recovery.json"),
      ];
      const before = files.map((file) => readFileSync(file));
      const plan = await f.service.previewRestore(f.old.recoveryId);
      expect(plan.blockers.length).toBeGreaterThan(0);
      await expect(f.service.restore(plan)).rejects.toMatchObject({
        status: 409,
      });
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    },
  );
  it("invalidates an old restore preview when the reservation changes", async () => {
    const f = await replacedPmFixture();
    await f.deleteReplacement();
    const plan = await f.service.previewRestore(f.old.recoveryId);
    writeFileSync(
      f.marker,
      JSON.stringify({ id: f.old.recoveryId, project: "app", area: "core" }),
    );
    await expect(f.service.restore(plan)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(loadProject(f.root, "app").areas).toEqual([]);
  });
  it("reserves one fresh identity across an interrupted recreation and preserves the old recovery", async () => {
    const f = fixture(),
      original = JSON.parse(readFileSync(f.areasFile, "utf8")).areas.core;
    const deleted = await f.service.remove(
      await f.service.preview({ project: "app", area: "core" }),
    );
    const oldBackup = readFileSync(
      join(deleted.recoveryPath, "areas.before.json"),
    );
    const instanceId = preparePmRecreation(f.root, "app", "core")!;
    expect(instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(preparePmRecreation(f.root, "app", "core")).toBe(instanceId);
    expect(() => assertResourceAvailable(f.root, "app", "core")).toThrow(
      /deleted resource/,
    );
    const document = readEditableConfig(f.root, "projects/app/areas.json"),
      next = JSON.parse(document.content);
    next.areas.core = { ...original, instanceId, enabled: false };
    saveEditableConfig(f.root, { ...document, content: JSON.stringify(next) });
    // A crash here must not leave the committed replacement unusable.
    expect(() => assertResourceAvailable(f.root, "app", "core")).not.toThrow();
    expect(
      (await f.service.previewRestore(deleted.recoveryId)).blockers,
    ).toContain(
      "A PM already occupies this identifier. Recovery will not overwrite it.",
    );
    completePmRecreation(f.root, "app", "core", instanceId);
    completePmRecreation(f.root, "app", "core", instanceId);
    expect(
      readFileSync(join(deleted.recoveryPath, "areas.before.json")),
    ).toEqual(oldBackup);
    expect(f.service.listRecoveries()).toContainEqual(
      expect.objectContaining({ id: deleted.recoveryId, status: "deleted" }),
    );
    const current = readEditableConfig(f.root, document.path),
      altered = JSON.parse(current.content);
    delete altered.areas.core.instanceId;
    expect(() =>
      saveEditableConfig(f.root, {
        ...current,
        content: JSON.stringify(altered),
      }),
    ).toThrow(/identity cannot be changed/);
    const second = await f.service.remove(
      await f.service.preview({ project: "app", area: "core" }),
    );
    const nextId = preparePmRecreation(f.root, "app", "core");
    expect(nextId).not.toBe(instanceId);
    expect(f.service.listRecoveries()).toHaveLength(2);
    expect(second.recoveryId).not.toBe(deleted.recoveryId);
  });
  it("keeps incomplete deletion and unexpected old documents blocked during recreation", async () => {
    const f = fixture(),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app", area: "core" }),
      );
    const journalFile = join(deleted.recoveryPath, "recovery.json"),
      journal = JSON.parse(readFileSync(journalFile, "utf8"));
    journal.status = "preparing";
    writeFileSync(journalFile, JSON.stringify(journal));
    expect(() => preparePmRecreation(f.root, "app", "core")).toThrow(
      /interrupted deletion/,
    );
    journal.status = "deleted";
    writeFileSync(journalFile, JSON.stringify(journal));
    mkdirSync(join(f.root, "projects", "app", "core"));
    writeFileSync(
      join(f.root, "projects", "app", "core", "memory.md"),
      "old notes",
    );
    expect(() => preparePmRecreation(f.root, "app", "core")).toThrow(
      /document directory/,
    );
    expect(() => assertResourceAvailable(f.root, "app", "core")).toThrow(
      /deleted resource/,
    );
  });
  it("retains readable bounded journals after restoring a large valid configuration tree", async () => {
    const f = fixture();
    for (let i = 0; i < 1800; i++)
      writeFileSync(
        join(
          f.root,
          "projects",
          "app",
          `${String(i).padStart(4, "0")}-${"x".repeat(175)}.md`,
        ),
        "note",
      );
    const removed = await f.service.remove(
      await f.service.preview({ project: "app" }),
    );
    await f
      .create()
      .restore(await f.create().previewRestore(removed.recoveryId));
    expect(
      readFileSync(join(removed.recoveryPath, "recovery.json")).length,
    ).toBeGreaterThan(1024 * 1024);
    expect(f.create().listRecoveries()).toContainEqual(
      expect.objectContaining({ id: removed.recoveryId, status: "restored" }),
    );
    expect(loadProject(f.root, "app").config.verified).toBeNull();
  }, 120000);
  it("rejects paths outside its own journal format before moving any files", async () => {
    const f = fixture(),
      deep = join(
        f.root,
        "projects",
        "app",
        // macOS rejects >1,024-byte absolute paths in mkdir itself. Exercise
        // another non-portable journal path there using a legal APFS filename.
        ...Array.from({ length: process.platform === "darwin" ? 0 : 6 }, () =>
          "x".repeat(175),
        ),
      );
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(deep, process.platform === "darwin" ? "note:private.md" : "note.md"),
      "private note",
    );
    await expect(f.service.preview({ project: "app" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(existsSync(f.projectFile)).toBe(true);
    expect(existsSync(join(f.root, ".run", "deleted"))).toBe(false);
  });
  it("recovers confirmed dead provisioning locks for deletion and restoration", async () => {
    const f = fixture(),
      lock = join(f.root, ".run", "linear", "provisioning", "app.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    writeFileSync(lock, "2147483646");
    const plan = await f.service.preview({ project: "app" });
    expect(plan.blockers).toEqual([]);
    expect(existsSync(lock)).toBe(false);
    const removed = await f.service.remove(plan);
    writeFileSync(lock, "2147483646");
    const restore = await f.create().previewRestore(removed.recoveryId);
    expect(restore.blockers).toEqual([]);
    expect(existsSync(lock)).toBe(false);
    await f.create().restore(restore);
    expect(loadProject(f.root, "app").config.verified).toBeNull();
  });
  it.each(["live", "malformed", "empty", "oversized", "denied"])(
    "preserves %s provisioning locks",
    async (kind) => {
      const f = fixture(),
        lock = join(f.root, ".run", "linear", "provisioning", "app.lock");
      mkdirSync(join(lock, ".."), { recursive: true });
      const content =
        kind === "malformed"
          ? "not-a-pid"
          : kind === "empty"
            ? ""
            : kind === "oversized"
              ? "2".repeat(100)
              : "2147483646";
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        if (kind === "denied")
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        return true;
      });
      writeFileSync(lock, content);
      const plan = await f.service.preview({ project: "app" });
      expect(plan.blockers.length).toBeGreaterThan(0);
      await expect(f.service.remove(plan)).rejects.toMatchObject({
        status: 409,
      });
      expect(readFileSync(lock, "utf8")).toBe(content);
      if (["malformed", "empty", "oversized"].includes(kind))
        expect(kill).not.toHaveBeenCalled();
    },
  );
  it("preserves a replacement lock written while its old PID is being probed", async () => {
    const f = fixture(),
      lock = join(f.root, ".run", "linear", "provisioning", "app.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, "2147483646");
    vi.spyOn(process, "kill").mockImplementation(() => {
      writeFileSync(lock, String(process.pid));
      throw Object.assign(new Error("old owner died"), { code: "ESRCH" });
    });
    expect(
      (await f.service.preview({ project: "app" })).blockers.length,
    ).toBeGreaterThan(0);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
  it("holds the shared provisioning lock across the filesystem mutation", async () => {
    const f = fixture(),
      lock = join(f.root, ".run", "linear", "provisioning", "app.lock");
    let checked = false;
    const service = f.create({
      move: (from, to) => {
        expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
        checked = true;
        renameSync(from, to);
      },
    });
    await service.remove(await service.preview({ project: "app" }));
    expect(checked).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
  it("archives a project, reserves identity, preserves credentials/history, and restores paused/unverified", async () => {
    const f = fixture(),
      before = readFileSync(
        join(f.root, "projects", "app", "core", "mandate.md"),
      ),
      plan = await f.service.preview({ project: "app" });
    const result = await f.service.remove({ ...plan });
    expect(existsSync(join(f.root, "projects", "app"))).toBe(false);
    expect(
      readFileSync(join(result.recoveryPath, "project", "core", "mandate.md")),
    ).toEqual(before);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
      "private-value",
    );
    expect(
      readFileSync(
        join(f.root, ".run", "pm-knowledge", "app", "retained.json"),
        "utf8",
      ),
    ).toBe("history");
    expect(() => assertResourceAvailable(f.root, "app")).toThrow(
      "deleted resource",
    );
    expect(() =>
      initializeSetup(f.root, resolve("."), {
        project: "app",
        repo: "owner/new",
      }),
    ).toThrow("deleted resource");
    const restore = await f.service.previewRestore(result.recoveryId);
    expect(restore.blockers).toEqual([]);
    await f.service.restore(restore);
    const project = loadProject(f.root, "app");
    expect(project.config.verified).toBeNull();
    expect(project.areas[0]!.enabled).toBe(false);
    expect(() => assertResourceAvailable(f.root, "app")).not.toThrow();
    expect(
      existsSync(join(result.recoveryPath, "project", "project.json")),
    ).toBe(true);
    expect(f.service.listRecoveries()[0]!.status).toBe("restored");
  });
  it("removes the last PM without removing project settings and blocks raw-editor identity reuse", async () => {
    const f = fixture(),
      original = readFileSync(f.projectFile),
      before = readEditableConfig(f.root, "projects/app/areas.json"),
      plan = await f.service.preview({ project: "app", area: "core" });
    const removed = await f.service.remove(plan);
    expect(loadProject(f.root, "app").areas).toEqual([]);
    expect(readFileSync(f.projectFile)).toEqual(original);
    expect(existsSync(join(f.root, "projects", "app", "core"))).toBe(false);
    const current = readEditableConfig(f.root, before.path);
    expect(() =>
      saveEditableConfig(f.root, { ...current, content: before.content }),
    ).toThrow("deleted resource");
    await f.service.restore(await f.service.previewRestore(removed.recoveryId));
    expect(loadProject(f.root, "app").areas[0]!.enabled).toBe(false);
  });
  it("rejects stale revisions, mistyped confirmation and provisioning locks before writing", async () => {
    const f = fixture(),
      plan = await f.service.preview({ project: "app" });
    await expect(
      f.service.remove({ ...plan, confirmation: "APP" }),
    ).rejects.toMatchObject({ code: "confirmation" });
    writeFileSync(
      join(f.root, "projects", "app", "core", "memory.md"),
      "owner update",
    );
    await expect(f.service.remove(plan)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    const lock = join(f.root, ".run", "linear", "provisioning", "app.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const locked = await f.service.preview({ project: "app" });
    expect(locked.blockers[0]).toContain("Linear setup");
    await expect(f.service.remove(locked)).rejects.toMatchObject({
      code: "blocked",
    });
    expect(existsSync(f.projectFile)).toBe(true);
  });
  it("can archive broken project JSON without contacting providers", async () => {
    const f = fixture();
    writeFileSync(f.projectFile, "broken config");
    const deleted = await f.service.remove(
      await f.service.preview({ project: "app" }),
    );
    expect(
      readFileSync(
        join(deleted.recoveryPath, "project", "project.json"),
        "utf8",
      ),
    ).toBe("broken config");
  });
  it("rejects traversal, directory links, dangling links and hard-linked files", async () => {
    const f = fixture();
    await expect(
      f.service.preview({ project: "../app" }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    const link = join(f.root, "projects", "app", "foreign"),
      outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, link, "junction");
    await expect(f.service.preview({ project: "app" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    rmSync(link);
    symlinkSync(join(f.root, "missing"), link, "junction");
    await expect(f.service.preview({ project: "app" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    rmSync(link);
    linkSync(f.projectFile, join(f.root, "projects", "app", "linked.json"));
    await expect(f.service.preview({ project: "app" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });
  it("rolls back a failed filesystem move without changing live configuration", async () => {
    const f = fixture(),
      before = readFileSync(f.areasFile),
      service = f.create({
        move: () => {
          throw new Error("synthetic filesystem failure");
        },
      });
    await expect(
      service.remove(await service.preview({ project: "app", area: "core" })),
    ).rejects.toMatchObject({ code: "io_error" });
    expect(readFileSync(f.areasFile)).toEqual(before);
    expect(
      existsSync(join(f.root, "projects", "app", "core", "mandate.md")),
    ).toBe(true);
    expect(() => assertResourceAvailable(f.root, "app", "core")).not.toThrow();
  });
  it("restores PM documents when the following areas write fails", async () => {
    const f = fixture(),
      original = readFileSync(f.areasFile);
    let failed = false;
    const service = f.create({
      write: (file, content) => {
        if (file === f.areasFile && !failed) {
          failed = true;
          throw new Error("synthetic write failure");
        }
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, content);
      },
    });
    await expect(
      service.remove(await service.preview({ project: "app", area: "core" })),
    ).rejects.toMatchObject({ code: "io_error" });
    expect(readFileSync(f.areasFile)).toEqual(original);
    expect(
      existsSync(join(f.root, "projects", "app", "core", "mandate.md")),
    ).toBe(true);
    expect(() => assertResourceAvailable(f.root, "app", "core")).not.toThrow();
  });
  it("recovers a crash after moving PM docs but before removing the PM row", async () => {
    const f = fixture(),
      original = readFileSync(f.areasFile),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app", area: "core" }),
      );
    writeFileSync(f.areasFile, original);
    const journalFile = join(deleted.recoveryPath, "recovery.json"),
      journal = JSON.parse(readFileSync(journalFile, "utf8"));
    journal.status = "preparing";
    writeFileSync(journalFile, JSON.stringify(journal));
    const plan = await f.create().previewRestore(deleted.recoveryId);
    expect(plan.blockers).toEqual([]);
    await f.create().restore(plan);
    expect(loadProject(f.root, "app").areas[0]!.enabled).toBe(false);
    expect(
      existsSync(join(f.root, "projects", "app", "core", "mandate.md")),
    ).toBe(true);
  });
  it("finishes restoration after a crash following the live-directory move without overwriting files", async () => {
    const f = fixture(),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app" }),
      );
    const service = f.create({
      move: (from, to) => {
        renameSync(from, to);
        throw new Error("synthetic crash after rename");
      },
    });
    await expect(
      service.restore(await service.previewRestore(deleted.recoveryId)),
    ).rejects.toThrow("synthetic crash");
    expect(() => assertResourceAvailable(f.root, "app")).toThrow();
    const retry = await f.create().previewRestore(deleted.recoveryId);
    expect(retry.blockers).toEqual([]);
    const prior = readFileSync(f.projectFile);
    await f.create().restore(retry);
    expect(readFileSync(f.projectFile)).toEqual(prior);
    expect(() => assertResourceAvailable(f.root, "app")).not.toThrow();
  });
  it("resumes a PM restore between its areas and project writes and rejects unknown intervening edits", async () => {
    const f = fixture(),
      projectBefore = readFileSync(f.projectFile),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app", area: "core" }),
      );
    await f.service.restore(await f.service.previewRestore(deleted.recoveryId));
    const path = join(deleted.recoveryPath, "recovery.json"),
      journal = JSON.parse(readFileSync(path, "utf8"));
    journal.status = "restoring";
    writeFileSync(path, JSON.stringify(journal));
    const marker = join(
      f.root,
      ".run",
      "deleted",
      "reservations",
      "areas",
      "app",
      "core.json",
    );
    writeFileSync(
      marker,
      JSON.stringify({ id: deleted.recoveryId, project: "app", area: "core" }),
    );
    writeFileSync(f.projectFile, projectBefore);
    const plan = await f.create().previewRestore(deleted.recoveryId);
    expect(plan.blockers).toEqual([]);
    const changed = JSON.parse(projectBefore.toString("utf8"));
    changed.repo = "owner/changed";
    writeFileSync(f.projectFile, JSON.stringify(changed));
    expect(
      (await f.create().previewRestore(deleted.recoveryId)).blockers.length,
    ).toBeGreaterThan(0);
    await expect(f.create().restore(plan)).rejects.toMatchObject({
      status: 409,
    });
    expect(JSON.parse(readFileSync(f.projectFile, "utf8")).repo).toBe(
      "owner/changed",
    );
    writeFileSync(f.projectFile, projectBefore);
    await f
      .create()
      .restore(await f.create().previewRestore(deleted.recoveryId));
    expect(loadProject(f.root, "app").config.verified).toBeNull();
    expect(loadProject(f.root, "app").areas[0]!.enabled).toBe(false);
  });
  it("recovers a project deletion interrupted before its directory move", async () => {
    const f = fixture(),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app" }),
      );
    renameSync(
      join(deleted.recoveryPath, "project"),
      join(f.root, "projects", "app"),
    );
    const path = join(deleted.recoveryPath, "recovery.json"),
      journal = JSON.parse(readFileSync(path, "utf8"));
    journal.status = "preparing";
    writeFileSync(path, JSON.stringify(journal));
    const plan = await f.create().previewRestore(deleted.recoveryId);
    expect(plan.blockers).toEqual([]);
    await f.create().restore(plan);
    expect(loadProject(f.root, "app").config.verified).toBeNull();
    expect(
      existsSync(join(deleted.recoveryPath, "project", "core", "mandate.md")),
    ).toBe(true);
  });
  it("rejects unknown journal fields rather than returning arbitrary saved values", async () => {
    const f = fixture(),
      deleted = await f.service.remove(
        await f.service.preview({ project: "app" }),
      );
    const path = join(deleted.recoveryPath, "recovery.json"),
      journal = JSON.parse(readFileSync(path, "utf8"));
    journal.credentials = "never returned";
    writeFileSync(path, JSON.stringify(journal));
    expect(() => f.service.listRecoveries()).toThrow("Recovery metadata");
  });
});
