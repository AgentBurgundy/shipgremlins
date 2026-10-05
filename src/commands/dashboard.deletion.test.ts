import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "./dashboard.ts";
import { createLocalRunners } from "../localRunners/engine.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import {
  createConnectionProfile,
  listConnectionIds,
} from "../oauthConnection/profiles.ts";
import { createOAuthStore } from "../oauthConnection/storage.ts";
import { createAutomaticPromotions } from "../delivery/automatic.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { DeletionPreview } from "../setup/resourceDeletion.ts";

const roots: string[] = [],
  servers: Server[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const headers = {
  Authorization: `Bearer ${"a".repeat(64)}`,
  "Content-Type": "application/json",
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-deletion-api-")),
  );
  roots.push(root);
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects/app/project.json"),
    areasFile = join(root, "projects/app/areas.json");
  const config = JSON.parse(readFileSync(projectFile, "utf8"));
  config.verified = "2026-10-05T10:00:00Z";
  writeFileSync(projectFile, JSON.stringify(config));
  const areas = JSON.parse(readFileSync(areasFile, "utf8"));
  areas.areas.core.enabled = true;
  writeFileSync(areasFile, JSON.stringify(areas));
  const runners = createLocalRunners({ root, packageRoot });
  // Use the real persistent queue and mutation lock, without starting job execution.
  vi.spyOn(runners, "start").mockImplementation(() => {});
  const server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    runners,
    sourceControl: { status: async () => [] } as unknown as SourceControl,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path: string,
    method = "GET",
    input?: unknown,
    authenticated = true,
  ) =>
    fetch(url + path, {
      method,
      headers: authenticated ? headers : { "Content-Type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const preview = async (path: string) => {
    const response = await call(path + "/deletion");
    expect(response.status).toBe(200);
    return (await response.json()) as DeletionPreview;
  };
  return { root, url, server, runners, projectFile, areasFile, call, preview };
}
const confirmation = (plan: DeletionPreview) => ({
  revision: plan.revision,
  confirm: plan.confirmation,
});
interface Deleted {
  deleted: true;
  recoveryId: string;
  recoveryPath: string;
}
interface ConnectionMetadata {
  name: string;
  configured: boolean;
  saved: boolean;
  inherited: boolean;
}
async function connectionMetadata(
  call: Awaited<ReturnType<typeof fixture>>["call"],
) {
  const response = await call("/api/status");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(/synthetic-(?:saved|exported|private)-token/);
  return (JSON.parse(text) as { connections: ConnectionMetadata[] })
    .connections;
}

describe("authenticated resource lifecycle HTTP routes", () => {
  it("recreates a deleted project name as a fresh incarnation through the authenticated creation route", async () => {
    const f = await fixture();
    const original = loadProject(f.root, "app");
    expect(
      (await f.call("/api/projects/app/delivery/advance", "POST", {})).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      const oldDelivery = (await (
        await f.call("/api/projects/app/delivery")
      ).json()) as { operation: { phase: string; message: string } };
      expect(oldDelivery.operation.phase).toBe("idle");
      expect(oldDelivery.operation.message).not.toBe("");
    });
    const removed = await f.call(
      "/api/projects/app",
      "DELETE",
      confirmation(await f.preview("/api/projects/app")),
    );
    const archive = (await removed.json()) as Deleted;
    expect(removed.status).toBe(200);
    const created = await f.call("/api/projects", "POST", {
      project: "app",
      repo: "owner/new-app",
      linearMode: "later",
      onboarding: true,
    });
    const creation = await created.text();
    expect(created.status, creation).toBe(200);
    const project = loadProject(f.root, "app");
    expect(project.config.repo).toBe("owner/new-app");
    expect(project.config.instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(project.config.verified).toBeNull();
    expect(project.config.linear).toBeUndefined();
    expect(project.config.slackWebhookSecret).not.toBe(
      original.config.slackWebhookSecret,
    );
    expect(project.areas).toEqual([]);
    const freshDelivery = (await (
      await f.call("/api/projects/app/delivery")
    ).json()) as { operation: unknown; productionReports: unknown[] };
    expect(freshDelivery.operation).toEqual({ phase: "idle", message: "" });
    expect(freshDelivery.productionReports).toEqual([]);
    const status = (await (await f.call("/api/status")).json()) as {
      projects: Array<{ name: string; instanceId?: string }>;
    };
    expect(status.projects).toContainEqual(
      expect.objectContaining({
        name: "app",
        instanceId: project.config.instanceId,
      }),
    );
    const recovery = `/api/deleted/${archive.recoveryId}`;
    const preview = (await (await f.call(recovery)).json()) as DeletionPreview;
    expect(preview.blockers.join(" ")).toMatch(/replacement|occupies/);
    expect(
      (await f.call(recovery + "/restore", "POST", confirmation(preview)))
        .status,
    ).toBe(409);
    expect(loadProject(f.root, "app").config.repo).toBe("owner/new-app");
    expect(existsSync(join(archive.recoveryPath, "project/project.json"))).toBe(
      true,
    );
  });
  it("requires authentication, exact confirmation and current revision, and retains private connections/history through project recovery", async () => {
    const f = await fixture(),
      endpoint = "/api/projects/app";
    writeFileSync(
      join(f.root, ".env"),
      "GITHUB_TOKEN=synthetic-private-token\n",
    );
    const history = join(f.root, ".run/pm-knowledge/app/history.json");
    mkdirSync(join(history, ".."), { recursive: true });
    writeFileSync(history, "synthetic retained run evidence");
    expect(
      (await f.call(endpoint + "/deletion", "GET", undefined, false)).status,
    ).toBe(401);
    expect((await f.call(endpoint, "DELETE", {}, false)).status).toBe(401);
    const original = await f.preview(endpoint);
    expect(
      (
        await f.call(endpoint, "DELETE", {
          ...confirmation(original),
          confirm: "APP",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call(endpoint, "DELETE", {
          ...confirmation(original),
          force: true,
        })
      ).status,
    ).toBe(400);
    writeFileSync(
      join(f.root, "projects/app/core/memory.md"),
      "new owner observation",
    );
    expect(
      (await f.call(endpoint, "DELETE", confirmation(original))).status,
    ).toBe(409);
    const plan = await f.preview(endpoint);
    const response = await f.call(endpoint, "DELETE", confirmation(plan));
    expect(response.status).toBe(200);
    const deleted = (await response.json()) as Deleted;
    expect(existsSync(join(f.root, "projects/app"))).toBe(false);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
      "synthetic-private-token",
    );
    expect(readFileSync(history, "utf8")).toBe(
      "synthetic retained run evidence",
    );
    const recovery = `/api/deleted/${deleted.recoveryId}`;
    expect((await f.call(recovery, "GET", undefined, false)).status).toBe(401);
    const listed = (await (await f.call("/api/deleted")).json()) as {
      recoveries: Array<{ id: string; status: string }>;
    };
    expect(listed.recoveries).toContainEqual(
      expect.objectContaining({ id: deleted.recoveryId, status: "deleted" }),
    );
    const previewResponse = await f.call(recovery);
    const previewText = await previewResponse.text();
    expect(previewResponse.status, previewText).toBe(200);
    const restore = JSON.parse(previewText) as DeletionPreview;
    expect(
      (
        await f.call(recovery + "/restore", "POST", {
          ...confirmation(restore),
          revision: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.call(recovery + "/restore", "POST", confirmation(restore)))
        .status,
    ).toBe(200);
    const restored = loadProject(f.root, "app");
    expect(restored.config.verified).toBeNull();
    expect(restored.areas.every((area) => !area.enabled)).toBe(true);
    expect(readFileSync(history, "utf8")).toBe(
      "synthetic retained run evidence",
    );
    expect(existsSync(join(deleted.recoveryPath, "project/project.json"))).toBe(
      true,
    );
  });

  it("removes the final PM while keeping a usable empty project and restores only that PM paused", async () => {
    const f = await fixture(),
      endpoint = "/api/projects/app/pms/core";
    const original = readFileSync(f.projectFile);
    expect(
      (await f.call(endpoint + "/deletion", "GET", undefined, false)).status,
    ).toBe(401);
    const plan = await f.preview(endpoint);
    expect(plan.confirmation).toBe("app/core");
    expect(
      (
        await f.call(endpoint, "DELETE", {
          ...confirmation(plan),
          confirm: "core",
        })
      ).status,
    ).toBe(400);
    const response = await f.call(endpoint, "DELETE", confirmation(plan));
    expect(response.status).toBe(200);
    const removed = (await response.json()) as Deleted;
    expect(loadProject(f.root, "app").areas).toEqual([]);
    expect(readFileSync(f.projectFile)).toEqual(original);
    expect((await f.call("/api/status")).status).toBe(200);
    const recovery = `/api/deleted/${removed.recoveryId}`;
    const previewResponse = await f.call(recovery);
    const previewText = await previewResponse.text();
    expect(previewResponse.status, previewText).toBe(200);
    const restore = JSON.parse(previewText) as DeletionPreview;
    expect(
      (await f.call(recovery + "/restore", "POST", confirmation(restore)))
        .status,
    ).toBe(200);
    expect(
      loadProject(f.root, "app").areas.map((area) => ({
        key: area.key,
        enabled: area.enabled,
      })),
    ).toEqual([{ key: "core", enabled: false }]);
    expect(loadProject(f.root, "app").config.verified).toBeNull();
  });

  it("blocks project removal, token clearing and profile deletion while real queued work exists", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, ".env"), "GITHUB_TOKEN=synthetic-saved-token\n");
    await createConnectionProfile(f.root, {
      provider: "linear",
      id: "unused",
      label: "Unused",
    });
    const job = await f.runners.enqueue({
      type: "pm",
      project: "app",
      area: "core",
    });
    const plan = await f.preview("/api/projects/app");
    expect(plan.blockers.join(" ")).toMatch(/queued/);
    expect(
      (await f.call("/api/projects/app", "DELETE", confirmation(plan))).status,
    ).toBe(409);
    expect(
      (
        await f.call("/api/connections/clear", "POST", {
          names: ["GITHUB_TOKEN"],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call("/api/service-connections", "DELETE", {
          provider: "linear",
          id: "unused",
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
      "synthetic-saved-token",
    );
    expect(await listConnectionIds(f.root, "linear")).toContain("unused");
    await f.runners.cancel(job.id);
    expect(
      (
        await f.call("/api/connections/clear", "POST", {
          names: ["GITHUB_TOKEN"],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call("/api/service-connections", "DELETE", {
          provider: "linear",
          id: "unused",
        })
      ).status,
    ).toBe(200);
    expect((await f.runners.job(job.id))?.status).toBe("canceled");
  });

  it("clears only saved values and reports inherited configuration without returning either token", async () => {
    const f = await fixture(),
      previous = process.env.VERCEL_TOKEN;
    try {
      process.env.VERCEL_TOKEN = "synthetic-exported-token";
      writeFileSync(
        join(f.root, ".env"),
        "VERCEL_TOKEN=synthetic-saved-token\nOTHER=preserved\n",
      );
      expect(
        (await connectionMetadata(f.call)).find(
          (row) => row.name === "VERCEL_TOKEN",
        ),
      ).toMatchObject({ configured: true, saved: true, inherited: true });
      expect(
        (
          await f.call(
            "/api/connections/clear",
            "POST",
            { names: ["VERCEL_TOKEN"] },
            false,
          )
        ).status,
      ).toBe(401);
      expect(
        (await f.call("/api/connections/clear", "POST", { names: ["OTHER"] }))
          .status,
      ).toBe(400);
      expect(
        (
          await f.call("/api/connections/clear", "POST", {
            names: ["VERCEL_TOKEN"],
          })
        ).status,
      ).toBe(200);
      expect(readFileSync(join(f.root, ".env"), "utf8")).toBe(
        "OTHER=preserved\n",
      );
      expect(
        (await connectionMetadata(f.call)).find(
          (row) => row.name === "VERCEL_TOKEN",
        ),
      ).toMatchObject({ configured: true, saved: false, inherited: true });
      expect(process.env.VERCEL_TOKEN).toBe("synthetic-exported-token");
    } finally {
      if (previous === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = previous;
    }
  });

  it("removes only unreferenced named profiles and rejects active leases and default deletion", async () => {
    const f = await fixture(),
      input = { provider: "linear" as const, id: "client" };
    await createConnectionProfile(f.root, {
      ...input,
      label: "Client account",
    });
    expect(
      (await f.call("/api/service-connections", "DELETE", input, false)).status,
    ).toBe(401);
    const config = JSON.parse(readFileSync(f.projectFile, "utf8"));
    writeFileSync(
      f.projectFile,
      JSON.stringify({ ...config, linear: { connectionId: "client" } }),
    );
    expect(
      (await f.call("/api/service-connections", "DELETE", input)).status,
    ).toBe(409);
    writeFileSync(f.projectFile, JSON.stringify(config));
    const store = createOAuthStore(f.root, "linear", "client");
    await store.locked(async (state, save) => {
      state.connection = {
        accessToken: "synthetic-private-token",
        account: { id: "user", name: "User" },
        workspace: { id: "workspace", name: "Workspace" },
        leases: [{ jobId: "job-lease", expiresAt: Date.now() + 60000 }],
      };
      await save(state);
    });
    expect(
      (await f.call("/api/service-connections", "DELETE", input)).status,
    ).toBe(409);
    await store.locked(async (state, save) => {
      state.connection!.leases = [];
      await save(state);
    });
    const deleted = await f.call("/api/service-connections", "DELETE", input);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, ...input });
    expect(await listConnectionIds(f.root, "linear")).toEqual(["default"]);
    expect(await store.read()).toEqual({ schema: 1, deleted: true });
    expect(
      (
        await f.call("/api/service-connections", "DELETE", {
          ...input,
          id: "default",
        })
      ).status,
    ).toBe(409);
  });

  it("blocks competing mutations while an asynchronous configuration change owns the guard", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, ".env"), "GITHUB_TOKEN=synthetic-saved-token\n");
    const original = f.runners.withConfigurationMutation.bind(f.runners);
    let release!: () => void, signal!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const entered = new Promise<void>((done) => (signal = done));
    vi.spyOn(f.runners, "withConfigurationMutation").mockImplementationOnce(
      (target, operation) =>
        original(target, async () => {
          signal();
          await gate;
          return operation();
        }),
    );
    const clearing = f.call("/api/connections/clear", "POST", {
      names: ["GITHUB_TOKEN"],
    });
    await entered;
    try {
      expect(
        (
          await f.call("/api/connections", "POST", {
            values: { LINEAR_API_KEY: "synthetic-private-token" },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.call("/api/connections/clear", "POST", {
            names: ["GITHUB_TOKEN"],
          })
        ).status,
      ).toBe(409);
      expect((await f.call("/api/status")).status).toBe(200);
      expect(readFileSync(join(f.root, ".env"), "utf8")).toContain(
        "synthetic-saved-token",
      );
    } finally {
      release();
    }
    expect((await clearing).status).toBe(200);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toBe("");
  });

  it("surfaces durable promotion and provisioning blockers before deleting configuration", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, ".env"), "GITHUB_TOKEN=synthetic-saved-token\n");
    await createConnectionProfile(f.root, {
      provider: "linear",
      id: "unused",
      label: "Unused account",
    });
    createAutomaticPromotions({ root: f.root }).enqueue(
      "app",
      "core",
      "b".repeat(64),
    );
    const plan = await f.preview("/api/projects/app/pms/core");
    expect(plan.blockers.join(" ")).toMatch(/promotion/i);
    expect(
      (
        await f.call("/api/connections/clear", "POST", {
          names: ["GITHUB_TOKEN"],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call("/api/service-connections", "DELETE", {
          provider: "linear",
          id: "unused",
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.call("/api/projects/app/pms/core", "DELETE", confirmation(plan)))
        .status,
    ).toBe(409);
    const lock = join(f.root, ".run/linear/provisioning/app.lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const project = await f.preview("/api/projects/app");
    expect(project.blockers.join(" ")).toMatch(/Linear setup/);
    expect(existsSync(f.projectFile)).toBe(true);
  });
});
