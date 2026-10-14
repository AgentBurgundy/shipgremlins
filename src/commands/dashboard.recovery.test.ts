import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cpSync,
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
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { makeCtx, makeProject } from "../services/fakes.ts";
import {
  createDispatchReservation,
  reservationBinding,
  reservationBody,
} from "../dispatcher/reservations.ts";
import { DISPATCH_RESERVED_PREFIX, LABELS } from "../dispatcher/notes.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64),
  headers = {
    Authorization: `Bearer ${session}`,
    "Content-Type": "application/json",
  };
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(options: { unavailableProject?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-recovery-http-"));
  roots.push(root);
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const actual = loadProject(root, "app");
  const project = makeProject({
    config: {
      name: "app",
      repo: "owner/app",
      instanceId: actual.config.instanceId,
    },
  });
  project.dir = actual.dir;
  const ctx = makeCtx({ project });
  const ticket = ctx.linear.seedTicket({
    projectId: "lin_core",
    identifier: "APP-7",
    labels: [LABELS.approved, LABELS.dispatched],
  });
  const reservation = await createDispatchReservation(
    ctx,
    ticket,
    { project: "app", ticket: ticket.identifier, kind: "build", attempt: 1 },
    "dispatch",
  );
  await ctx.linear.addComment(
    ticket.id,
    reservationBody(
      `${DISPATCH_RESERVED_PREFIX} ${reservation.id}`,
      reservation,
    ),
  );
  const run = ctx.forge.seedRun({ id: 99, status: "in_progress" });
  const evidence = {
    run,
    repository: ctx.hub.hubRepo,
    workflowFile: "developer.yml",
    ref: "main",
    event: "workflow_dispatch" as const,
    inputs: { ...reservation.inputs },
    projectRepository: project.config.repo,
    projectIntegrationBranch: project.config.branches.integration,
    ...(project.config.instanceId
      ? { projectInstanceId: project.config.instanceId }
      : {}),
  };
  ctx.forge.seedWorkflowEvidence(99, evidence);
  if (options.unavailableProject) {
    const path = join(root, "projects", "unavailable");
    cpSync(actual.dir, path, { recursive: true });
    const file = join(path, "project.json"),
      raw = JSON.parse(readFileSync(file, "utf8"));
    raw.name = "unavailable";
    writeFileSync(file, JSON.stringify(raw));
  }
  const recoveryContext = vi.fn(
    async (target: { config: { name: string } }) => {
      if (target.config.name === "unavailable")
        throw new Error("private credential details");
      return ctx;
    },
  );
  const server = createDashboardServer(root, packageRoot, session, [], {
    recoveryContext,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(`${base}/api/recovery/bind`, {
      method: "POST",
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify(body),
    });
  return {
    base,
    ctx,
    ticket,
    reservation,
    evidence,
    recoveryContext,
    post,
    input: { reservationId: reservation.id, runId: 99 },
  };
}
describe("authenticated operator recovery HTTP contract", () => {
  it("requires authentication and returns only controller-scoped unresolved reservations", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/api/recovery/reservations`)).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${f.base}/api/recovery/bind`, {
          method: "POST",
          body: JSON.stringify(f.input),
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${f.base}/api/recovery/reservations`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reservations: [
        {
          id: f.reservation.id,
          project: "app",
          ticket: "APP-7",
          kind: "build",
          supported: true,
        },
      ],
      unavailableProjects: [],
    });
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("rejects foreign origins, query parameters, wrong methods and browser-provided evidence fields", async () => {
    const f = await fixture();
    expect(
      (await f.post(f.input, { Origin: "https://untrusted.example" })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${f.base}/api/recovery/reservations?project=app`, {
          headers,
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${f.base}/api/recovery/bind`, { headers })).status,
    ).toBe(405);
    for (const input of [
      { ...f.input, inputs: f.evidence.inputs },
      { ...f.input, runId: "99" },
      { ...f.input, runId: 0 },
      { ...f.input, runId: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect((await f.post(input)).status).toBe(400);
    expect(f.ctx.linear.commentsOf(f.ticket.id)).toHaveLength(1);
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("repairs the existing receipt and returns already-reconciled when its HTTP acknowledgment is replayed", async () => {
    const f = await fixture();
    const first = await f.post(f.input);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "reconciled",
      reservationId: f.reservation.id,
      runId: 99,
    });
    const second = await f.post(f.input);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "already-reconciled" });
    expect(
      f.ctx.linear
        .commentsOf(f.ticket.id)
        .map(reservationBinding)
        .filter(Boolean),
    ).toHaveLength(1);
    const remaining = await fetch(`${f.base}/api/recovery/reservations`, {
      headers,
    });
    expect(await remaining.json()).toMatchObject({ reservations: [] });
    expect(f.ctx.forge.dispatched).toEqual([]);
    expect(f.ctx.forge.reruns).toEqual([]);
  });
  it("rejects mismatched provider scope without changing the existing ticket or receipts", async () => {
    const f = await fixture();
    f.evidence.inputs.ticket = "OTHER-1";
    const response = await f.post(f.input);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Provider evidence does not match");
    expect(f.ctx.linear.commentsOf(f.ticket.id)).toHaveLength(1);
    expect(f.ticket.stateType).toBe("backlog");
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("reports one unavailable project while preserving reservations from the available project", async () => {
    const f = await fixture({ unavailableProject: true });
    const response = await fetch(`${f.base}/api/recovery/reservations`, {
      headers,
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      reservations: [{ id: f.reservation.id }],
      unavailableProjects: ["unavailable"],
    });
    expect(JSON.stringify(data)).not.toContain("private credential details");
  });
});
