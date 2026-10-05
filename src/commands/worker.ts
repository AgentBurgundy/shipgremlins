import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createDockerRunners } from "../localRunners/docker.ts";
import {
  createRemoteWorker,
  controllerUrl,
  lockWorkerDirectory,
} from "../remoteWorkers/worker.ts";
import { RemoteWorkerError } from "../remoteWorkers/storage.ts";

export async function runWorker(
  packageRoot: string,
  args: string[],
  io: { out: (message: string) => void; err: (message: string) => void },
): Promise<number> {
  let unlock: (() => void) | undefined;
  try {
    const values: Record<string, string> = {};
    let allowInsecureLan = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--allow-insecure-lan") {
        allowInsecureLan = true;
        continue;
      }
      if (
        !["--controller", "--enrollment-code", "--worker-home"].includes(arg) ||
        !args[index + 1] ||
        args[index + 1]!.startsWith("--")
      )
        throw new RemoteWorkerError(
          "Use gremlins worker --controller HTTPS_ORIGIN --enrollment-code ONE_TIME_CODE [--worker-home DIRECTORY].",
        );
      values[arg] = args[++index]!;
    }
    const origin = controllerUrl(
      values["--controller"] ?? "",
      allowInsecureLan,
    );
    if (
      origin.startsWith("http:") &&
      !/^http:\/\/(localhost|127\.|\[::1\])/.test(origin)
    )
      io.err(
        "This worker uses unencrypted private-network HTTP. Use HTTPS or a trusted encrypted network such as Tailscale.",
      );
    const workerHome =
      values["--worker-home"] ?? join(homedir(), ".shipgremlins", "worker");
    const docker = createDockerRunners({
      packageRoot,
      environmentNamespace: workerHome,
    });
    unlock = lockWorkerDirectory(workerHome);
    const preflight = await docker.preflight();
    if (!preflight.available) throw new RemoteWorkerError(preflight.message);
    io.out(
      "Preparing the isolated Docker worker image. This can take a few minutes on first start.",
    );
    await docker.ensureImage((message) => io.out(message));
    const worker = createRemoteWorker({
      root: workerHome,
      controller: origin,
      allowInsecureLan,
      docker,
    });
    if (values["--enrollment-code"])
      await worker.enroll(values["--enrollment-code"]);
    io.out(
      "Remote Docker worker connected. Keep this command running; use a service manager for unattended startup.",
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      while (!controller.signal.aborted) {
        try {
          await worker.step();
        } catch (error) {
          io.err(
            error instanceof RemoteWorkerError
              ? error.message
              : "Remote worker operation failed. The expiring job lease prevents unattended execution.",
          );
          if (error instanceof RemoteWorkerError && error.status === 401)
            return 1;
        }
        await delay(15000, undefined, { signal: controller.signal }).catch(
          () => {},
        );
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await worker.stop().catch(() => {});
    }
    return 0;
  } catch (error) {
    io.err(
      error instanceof RemoteWorkerError
        ? error.message
        : "The remote worker could not start. Check Docker, connectivity, and the worker directory.",
    );
    return 1;
  } finally {
    unlock?.();
  }
}
