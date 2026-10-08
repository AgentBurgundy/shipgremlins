import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../config.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";

const keyPattern = /^[a-f0-9]{64}$/;
const jobPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;
export interface TestIdentityLease {
  version: 1;
  key: string;
  jobId: string;
  generation: string;
  createdAt: string;
}
export class TestIdentityBusyError extends Error {
  constructor() {
    super(
      "Waiting for the test account's current run to finish and clean up. Each run uses its own browser; account data cannot be shared concurrently.",
    );
    this.name = "TestIdentityBusyError";
  }
}

/** Compare identities without persisting the username. Different passwords do not make a new identity. */
export function testIdentityKey(
  config: ProjectConfig,
  username: string,
): string {
  const verification = effectiveVerification(config);
  if (verification.mode !== "browser")
    throw new Error("A browser environment is required.");
  const target = verification.target;
  const app =
    target.kind === "url"
      ? [target.kind, new URL(target.url).origin]
      : target.kind === "vercel"
        ? [target.kind, target.teamId, target.projectId]
        : target.kind === "railway"
          ? [target.kind, target.projectId, target.serviceId]
          : target.kind === "cloud-run"
            ? [target.kind, target.projectId, target.region, target.service]
            : [target.kind, config.provider, config.serverUrl, config.repo];
  return createHash("sha256")
    .update(JSON.stringify([app, username.trim().toLowerCase()]))
    .digest("hex");
}

/** No time-based stealing: only confirmed browser cleanup releases an identity. */
export function createTestIdentityLeases(root: string) {
  const directory = safeOAuthPath(join(root, ".run", "test-identity-leases"));
  function location(key: string) {
    if (!keyPattern.test(key)) throw new Error("Invalid test identity.");
    return safeOAuthPath(join(directory, key));
  }
  function read(key: string): TestIdentityLease | undefined {
    const path = location(key);
    if (!existsSync(path)) return undefined;
    const file = safeOAuthPath(join(path, "owner.json"));
    try {
      const bytes = readFileSync(file);
      if (bytes.length > 2048) throw new Error();
      const value = JSON.parse(bytes.toString()) as TestIdentityLease;
      if (
        value.version !== 1 ||
        value.key !== key ||
        !jobPattern.test(value.jobId) ||
        !/^[a-f0-9-]{36}$/.test(value.generation) ||
        !Number.isFinite(Date.parse(value.createdAt))
      )
        throw new Error();
      return value;
    } catch {
      throw new Error(
        "Test account ownership could not be verified. Reconcile the interrupted run before reusing the account.",
      );
    }
  }
  return {
    blocker(key: string, jobId: string): string | undefined {
      const lease = read(key);
      return lease && lease.jobId !== jobId
        ? new TestIdentityBusyError().message
        : undefined;
    },
    acquire(key: string, jobId: string): TestIdentityLease {
      if (!jobPattern.test(jobId))
        throw new Error("Invalid test identity job.");
      const prior = read(key);
      if (prior) {
        if (prior.jobId !== jobId) throw new TestIdentityBusyError();
        return prior;
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = location(key);
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new TestIdentityBusyError();
        throw error;
      }
      const lease: TestIdentityLease = {
        version: 1,
        key,
        jobId,
        generation: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      // An interrupted write leaves an unreadable reservation quarantined, never available to another run.
      writePrivate(
        safeOAuthPath(join(path, "owner.json")),
        JSON.stringify(lease),
      );
      return lease;
    },
    release(jobId: string) {
      if (!jobPattern.test(jobId))
        throw new Error("Invalid test identity job.");
      if (!existsSync(directory)) return;
      for (const key of readdirSync(directory)) {
        if (!keyPattern.test(key)) continue;
        let lease: TestIdentityLease | undefined;
        try {
          lease = read(key);
        } catch {
          continue;
        } // Quarantine corrupt reservations independently.
        if (lease?.jobId !== jobId) continue;
        const path = location(key);
        unlinkSync(safeOAuthPath(join(path, "owner.json")));
        rmdirSync(path);
      }
    },
  };
}
