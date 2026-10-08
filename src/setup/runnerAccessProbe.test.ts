import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeSetup } from "./files.ts";
import { loadProject } from "../config.ts";
import { runAccessProbe } from "./runnerAccessProbe.ts";
import {
  createTestIdentityLeases,
  testIdentityKey,
} from "../testAccess/leases.ts";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";
import type { TestAccess } from "../testAccess.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(remote = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-worker-probe-")),
  );
  roots.push(root);
  const access: TestAccess = {
    kind: "password",
    loginPath: "/login",
    usernameSelector: "#user",
    passwordSelector: "#pass",
    submitSelector: "#submit",
    successSelector: "#account",
    accounts: [
      {
        name: "Member",
        usernameSecret: "TEST_USER",
        passwordSecret: "TEST_PASS",
      },
    ],
  };
  initializeSetup(root, process.cwd(), {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "browser", environment: "test" },
      environments: {
        test: {
          kind: "url",
          url: "https://test.invalid/",
          role: "staging",
          access,
        },
      },
    },
  });
  const project = loadProject(root, "app"),
    runner = {
      id: "worker-one",
      name: "Home runner",
      ...(remote ? { remoteId: "remote-one" } : {}),
    };
  let payload: DockerJobPayload | undefined,
    id = "";
  let result: Record<string, unknown> | undefined;
  const docker = {
    prepareWorker: vi.fn(async () => {}),
    startJob: vi.fn(async (input) => {
      payload = input.payload;
      id = input.id;
      return { id, name: id, image: "synthetic" };
    }),
    inspectJob: vi.fn(async () => ({
      exists: true,
      running: false,
      status: "exited",
      exitCode: 0,
      workerId: runner.id,
    })),
    artifacts: vi.fn(async () => ({
      files: [],
      result: result ?? {
        ok: true,
        kind: "verify",
        nonce: id,
        cleanupConfirmed: true,
        accessReceipt: {
          version: 1,
          identityId: payload!.testAccess!.identityId,
          generation: payload!.testAccess!.generation,
          leaseGeneration: payload!.testAccess!.leaseGeneration,
          origin: "https://test.invalid",
          proof: {
            signedOut: true,
            signedIn: true,
            protectedRoute: true,
            receivingContext: true,
          },
        },
        checks: [
          "Browser opens application",
          "Login page opens",
          "Sign-in step 1",
          "Signed-out context cannot see the protected confirmation",
          "Protected route opens with the expected test identity",
          "PM browser receives the verified context",
        ].map((name) => ({ name, passed: true })),
      },
    })),
    readArtifact: vi.fn(async () =>
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ),
    stopJob: vi.fn(async () => {}),
    cleanupEnvironment: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
  } as unknown as DockerRunners;
  return {
    root,
    project,
    runner,
    access,
    docker,
    jobId: "job-probe",
    values: { TEST_USER: "private-member", TEST_PASS: "private-password" },
    payload: { browserTarget: "https://test.invalid/" },
    setResult: (value: Record<string, unknown>) => {
      result = value;
    },
  };
}
describe("access verification on the selected agent service", () => {
  it("uses isolated runner job metadata, private credentials and releases only after cleanup", async () => {
    const f = fixture(true),
      value = await runAccessProbe(f);
    expect(value).toMatchObject({
      runnerId: "worker-one",
      runnerName: "Home runner",
    });
    const sent = vi.mocked(f.docker.startJob).mock.calls[0]![0];
    expect(sent.payload).toMatchObject({
      kind: "verify",
      accessProbe: true,
      project: "app",
      credentials: {
        GREMLINS_TEST_USERNAME_1: "private-member",
        GREMLINS_TEST_PASSWORD_1: "private-password",
      },
    });
    expect(sent.payload.testAccess!.access).toEqual(f.access);
    expect(JSON.stringify(value)).not.toContain("private-password");
    expect(
      createTestIdentityLeases(f.root).blocker(
        testIdentityKey(f.project.config, "private-member"),
        "another-job",
      ),
    ).toBeUndefined();
    expect(f.docker.cleanupEnvironment).toHaveBeenCalledOnce();
  });
  it("does not launch while another patrol owns the identity", async () => {
    const f = fixture();
    createTestIdentityLeases(f.root).acquire(
      testIdentityKey(f.project.config, "private-member"),
      "job-patrol",
    );
    await expect(runAccessProbe(f)).rejects.toThrow(/Waiting for/);
    expect(f.docker.startJob).not.toHaveBeenCalled();
  });
  it("quarantines the identity when the remote worker has not confirmed cleanup", async () => {
    const f = fixture(true);
    f.setResult({
      ok: false,
      kind: "verify",
      accessFailure: { code: "credentials_rejected" },
    });
    await expect(runAccessProbe(f)).rejects.toMatchObject({
      code: "cleanup_pending",
    });
    expect(
      createTestIdentityLeases(f.root).blocker(
        testIdentityKey(f.project.config, "private-member"),
        "another-job",
      ),
    ).toContain("Waiting");
  });
  it("preserves the failure reason and releases the account after confirmed cleanup", async () => {
    const f = fixture(true);
    f.setResult({
      ok: false,
      kind: "verify",
      cleanupConfirmed: true,
      accessFailure: { code: "identity_mismatch" },
    });
    await expect(runAccessProbe(f)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(
      createTestIdentityLeases(f.root).blocker(
        testIdentityKey(f.project.config, "private-member"),
        "another-job",
      ),
    ).toBeUndefined();
  });
  it("rejects a successful receipt for another identity", async () => {
    const f = fixture();
    f.setResult({
      ok: true,
      kind: "verify",
      nonce: "other-job",
      accessReceipt: {},
      checks: [{ name: "Check", passed: true }],
    });
    await expect(runAccessProbe(f)).rejects.toMatchObject({
      code: "invalid_evidence",
    });
  });
  it("retains the identity when local helper cleanup fails", async () => {
    const f = fixture();
    vi.mocked(f.docker.cleanupEnvironment!).mockRejectedValue(
      new Error("cleanup unavailable"),
    );
    await expect(runAccessProbe(f)).rejects.toMatchObject({
      code: "cleanup_pending",
    });
    expect(
      createTestIdentityLeases(f.root).blocker(
        testIdentityKey(f.project.config, "private-member"),
        "another-job",
      ),
    ).toContain("Waiting");
  });
});
