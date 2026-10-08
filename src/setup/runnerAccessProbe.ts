import type { Project } from "../config.ts";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";
import { ManagedAccessError } from "../localRunners/managedAccess.ts";
import { TestEnvironmentError } from "../testEnvironments/index.ts";
import {
  createTestIdentityLeases,
  testIdentityKey,
} from "../testAccess/leases.ts";
import {
  resolveTestAccess,
  testIdentityMetadata,
  type TestAccess,
} from "../testAccess.ts";
import { environmentChecks } from "./environmentDiagnosis.ts";

export interface AccessProbeRunner {
  id: string;
  name: string;
  remoteId?: string;
  release?: () => Promise<void>;
}
export class RunnerProbeError extends Error {
  constructor(public readonly code: string) {
    super("The assigned agent service could not verify app access.");
  }
}
/** One identity per private browser job. The caller owns the worker reservation. */
export async function runAccessProbe(options: {
  root: string;
  project: Project;
  runner: AccessProbeRunner;
  docker: DockerRunners;
  jobId: string;
  access: TestAccess | undefined;
  values: Record<string, string | undefined>;
  payload: Omit<DockerJobPayload, "kind" | "nonce" | "testAccess">;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const { project, runner, docker } = options,
    leases = createTestIdentityLeases(options.root);
  const resolved = resolveTestAccess(options.access, options.values);
  let png: Buffer | undefined;
  const checks: Array<{ name: string; passed: boolean }> = [];
  for (let index = 0; index < (resolved?.accounts.length ?? 1); index++) {
    const job = options.jobId;
    const account = resolved?.accounts[index];
    let acquired = false,
      launched = false,
      accepted = false,
      cleaned = false;
    const credentials = { ...options.payload.credentials };
    let metadata;
    try {
      if (account && options.access?.kind === "password") {
        const lease = leases.acquire(
          testIdentityKey(project.config, account.username),
          job,
        );
        acquired = true;
        const identity = testIdentityMetadata(options.access, index),
          savedAccount = options.access.accounts[index]!;
        credentials.GREMLINS_TEST_USERNAME_1 = account.username;
        credentials.GREMLINS_TEST_PASSWORD_1 = account.password;
        metadata = {
          version: 1 as const,
          identityId: identity.id,
          generation: identity.generation,
          leaseGeneration: lease.generation,
          access: { ...options.access, accounts: [savedAccount] },
        };
      } else
        metadata = {
          version: 1 as const,
          identityId: "public",
          generation: "public",
          leaseGeneration: job,
          access: { kind: "public" as const },
        };
      await docker.prepareWorker?.(runner.id, runner.remoteId);
      launched = true;
      await docker.startJob({
        id: job,
        workerId: runner.id,
        payload: {
          ...options.payload,
          kind: "verify",
          nonce: job,
          project: project.config.name,
          accessProbe: true,
          testAccess: metadata,
          credentials,
          maxRuntimeMinutes: 15,
        },
      });
      accepted = true;
      const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
      let inspection = await docker.inspectJob(job);
      while (inspection.exists && inspection.running && Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.pollMs ?? 1000),
        );
        inspection = await docker.inspectJob(job);
      }
      if (
        !inspection.exists ||
        inspection.running ||
        inspection.workerId !== runner.id
      )
        throw new RunnerProbeError("browser_unavailable");
      const { result } = await docker.artifacts(job);
      if (runner.remoteId && result?.cleanupConfirmed !== true)
        throw new RunnerProbeError("cleanup_pending");
      if (
        result?.ok !== true ||
        result.kind !== "verify" ||
        result.nonce !== job ||
        inspection.exitCode !== 0
      ) {
        const failure = result?.accessFailure;
        throw new RunnerProbeError(
          failure &&
            typeof failure === "object" &&
            "code" in failure &&
            typeof failure.code === "string"
            ? failure.code
            : "invalid_evidence",
        );
      }
      const receipt = result.accessReceipt as
          Record<string, unknown> | undefined,
        proof = receipt?.proof as Record<string, unknown> | undefined;
      if (
        receipt?.version !== 1 ||
        receipt.identityId !== metadata.identityId ||
        receipt.generation !== metadata.generation ||
        receipt.leaseGeneration !== metadata.leaseGeneration ||
        !proof ||
        proof.receivingContext !== true ||
        (account
          ? proof.signedOut !== true ||
            proof.signedIn !== true ||
            proof.protectedRoute !== true
          : proof.public !== true)
      )
        throw new RunnerProbeError("invalid_evidence");
      if (
        options.payload.browserTarget &&
        receipt.origin !== new URL(options.payload.browserTarget).origin
      )
        throw new RunnerProbeError("invalid_evidence");
      const checked = environmentChecks(result.checks);
      if (!checked?.length || checked.some((check) => !check.passed))
        throw new RunnerProbeError("invalid_evidence");
      checks.push(
        ...checked.map((check) => ({
          ...check,
          name: account
            ? `Test account ${index + 1}: ${check.name}`
            : check.name,
        })),
      );
      const image = await docker.readArtifact(job, "access-screenshot.png");
      if (
        image.length > 2 * 1024 * 1024 ||
        !image
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new RunnerProbeError("invalid_evidence");
      png = image;
    } catch (error) {
      if (
        error instanceof ManagedAccessError ||
        error instanceof TestEnvironmentError
      )
        throw new RunnerProbeError(error.code);
      throw error;
    } finally {
      if (launched) {
        try {
          await docker.stopJob(job);
          if (runner.remoteId) {
            const inspection = await docker.inspectJob(job);
            if (accepted || inspection.exists) {
              const result = (await docker.artifacts(job)).result;
              if (result?.cleanupConfirmed !== true) {
                // Caught below; an ambiguous remote helper retains its lease.
                // eslint-disable-next-line no-unsafe-finally
                throw new Error();
              }
            }
          }
          await docker.cleanupEnvironment?.(job);
          await docker.removeJob(job);
          cleaned = true;
        } catch {
          /* A live or ambiguous browser retains its identity lease. */
        }
      } else cleaned = true;
      if (acquired && cleaned) leases.release(job);
      if (!cleaned) {
        // eslint-disable-next-line no-unsafe-finally
        throw new RunnerProbeError("cleanup_pending");
      }
    }
  }
  if (!png) throw new RunnerProbeError("invalid_evidence");
  return { checks, png, runnerId: runner.id, runnerName: runner.name };
}
