import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createDockerRunners,
  validatePayload,
  type DockerRun,
  type DockerRunOptions,
  type DockerJobPayload,
} from "./docker.ts";
import {
  ManagedAccessError,
  validateManagedTestAccess,
  validateManagedBrowserConnection,
} from "./managedAccess.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const testAccess = {
  version: 1 as const,
  identityId: "identity-one",
  generation: "generation-one",
  leaseGeneration: "lease-one",
  access: {
    kind: "password" as const,
    loginPath: "/login",
    usernameSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: "#account",
    accounts: [
      {
        name: "Member",
        usernameSecret: "TEST_USER",
        passwordSecret: "TEST_PASS",
      },
    ],
  },
};
const payload: DockerJobPayload = {
  kind: "pm",
  nonce: "job-browser",
  project: "demo",
  provider: "github",
  repoUrl: "https://github.com/example/demo.git",
  branch: "pm-staging",
  prompt: "Walk the test journey",
  browserVerification: true,
  browserTarget: "https://app.example.test",
  testAccess,
  credentials: {
    GREMLINS_TEST_USERNAME_1: "private-user",
    GREMLINS_TEST_PASSWORD_1: "private-password",
    GREMLINS_PREVIEW_BYPASS: "private-bypass",
    CLAUDE_CODE_OAUTH_TOKEN: "private-model-token",
  },
};

function fixture(mode: "ready" | "rejected" | "wrong-receipt" = "ready") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sg-managed-browser-")));
  roots.push(root);
  const calls: Array<{ args: string[]; options?: DockerRunOptions }> = [];
  type Container = {
    Name: string;
    Config: { Image: string; Labels: Record<string, string> };
    State: { Running: boolean; Status: string; ExitCode?: number };
    NetworkSettings: { Networks: Record<string, object> };
  };
  const containers = new Map<string, Container>(),
    networks = new Map<string, Record<string, string>>(),
    volumes = new Map<
      string,
      { Name: string; Labels: Record<string, string> }
    >();
  let helperInput:
      | {
          access: { accounts: Array<{ username: string; password: string }> };
          bypass: string;
          controlToken: string;
          token: string;
        }
      | undefined,
    finishHelper: (() => void) | undefined;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const labels = (args: string[]) =>
    Object.fromEntries(
      args.flatMap((value, i) =>
        value === "--label" ? [args[i + 1]!.split("=")] : [],
      ),
    );
  const run: DockerRun = async (args, options) => {
    calls.push({ args, options });
    const missing = (kind: string) => ({
      code: 1,
      stdout: "",
      stderr: `No such ${kind}`,
    });
    if (args[0] === "image")
      return args.at(-1)?.startsWith("shipgremlins-app:")
        ? missing("image")
        : ok("[{}]");
    if (args[0] === "inspect")
      return containers.has(args.at(-1)!)
        ? ok(JSON.stringify(containers.get(args.at(-1)!)))
        : missing("object");
    if (args[0] === "network") {
      const name = args.at(-1)!;
      if (args[1] === "inspect")
        return networks.has(name)
          ? ok(JSON.stringify(networks.get(name)))
          : missing("network");
      if (args[1] === "create") {
        networks.set(name, labels(args));
        return ok(name);
      }
      if (args[1] === "rm") {
        networks.delete(name);
        return ok();
      }
      if (args[1] === "connect") {
        containers.get(name)!.NetworkSettings.Networks[args[2]!] = {};
        return ok();
      }
      if (args[1] === "disconnect") {
        delete containers.get(name)!.NetworkSettings.Networks[args[2]!];
        return ok();
      }
    }
    if (args[0] === "volume") {
      const name = args.at(-1)!;
      if (args[1] === "inspect")
        return volumes.has(name)
          ? ok(JSON.stringify(volumes.get(name)))
          : missing("volume");
      if (args[1] === "create") {
        volumes.set(name, { Name: name, Labels: labels(args) });
        return ok(name);
      }
      if (args[1] === "rm") {
        volumes.delete(name);
        return ok();
      }
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      containers.set(name, {
        Name: `/${name}`,
        Config: {
          Image: "shipgremlins-local:0123456789abcdef",
          Labels: labels(args),
        },
        State: { Running: false, Status: "created" },
        NetworkSettings: { Networks: {} },
      });
      return ok(name);
    }
    if (args[0] === "start") {
      const name = args.at(-1)!;
      containers.get(name)!.State = { Running: true, Status: "running" };
      if (name.startsWith("gremlins-auth-")) {
        helperInput = JSON.parse(options!.stdin!);
        await new Promise<void>((resolve) => {
          finishHelper = resolve;
        });
      }
      return ok();
    }
    if (
      args[0] === "exec" &&
      args.includes("/opt/gremlins/access-status.mjs")
    ) {
      if (mode === "rejected")
        return ok(
          JSON.stringify({
            ok: false,
            status: "failed",
            failure: { code: "credentials_rejected" },
          }),
        );
      return ok(
        JSON.stringify({
          ok: true,
          status: "ready",
          receipt: {
            version: 1,
            identityId:
              mode === "wrong-receipt" ? "someone-else" : testAccess.identityId,
            generation: testAccess.generation,
            leaseGeneration: testAccess.leaseGeneration,
            origin: new URL(payload.browserTarget!).origin,
            proof: {
              signedOut: true,
              signedIn: true,
              protectedRoute: true,
              receivingContext: true,
            },
          },
        }),
      );
    }
    if (args[0] === "exec") return ok('{"accepted":true}');
    if (args[0] === "stop") {
      containers.get(args.at(-1)!)!.State = {
        Running: false,
        Status: "exited",
        ExitCode: 0,
      };
      return ok();
    }
    if (args[0] === "rm") {
      const name = args.at(-1)!;
      containers.delete(name);
      if (name.startsWith("gremlins-auth-")) finishHelper?.();
      return ok();
    }
    if (args[0] === "ps") return ok();
    throw new Error(`Unexpected command ${args.slice(0, 2).join(" ")}`);
  };
  const api = createDockerRunners({
    packageRoot: fileURLToPath(new URL("../..", import.meta.url)),
    environmentNamespace: root,
    run,
  });
  return {
    root,
    api,
    calls,
    containers,
    networks,
    helperInput: () => helperInput!,
  };
}

it("hands one verified browser to the agent without its credentials, protection bypass or controller token", async () => {
  const f = fixture();
  await f.api.startJob({ id: "job-browser", workerId: "worker-test", payload });
  const delivered = JSON.parse(
    f.calls.find((call) => call.args.includes("/opt/gremlins/receive-job.mjs"))!
      .options!.stdin!,
  );
  expect(delivered.testAccess).toBeUndefined();
  expect(delivered.credentials).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: "private-model-token",
  });
  expect(delivered.managedAccess.receipt.proof.receivingContext).toBe(true);
  const helper = f.helperInput();
  expect(helper.access.accounts[0]).toMatchObject({
    username: "private-user",
    password: "private-password",
  });
  expect(helper.bypass).toBe("private-bypass");
  expect(helper.controlToken).not.toBe(helper.token);
  expect(JSON.stringify(delivered)).not.toContain(helper.controlToken);
  expect(JSON.stringify(f.calls.map((call) => call.args))).not.toContain(
    "private-password",
  );
  expect(
    JSON.stringify(
      f.calls
        .filter((call) => call.args[0] === "create")
        .map((call) => call.args),
    ),
  ).not.toMatch(/--publish|docker\.sock|type=bind/);
  const manifest = JSON.parse(
    readFileSync(
      join(f.root, ".run", "managed-browsers", "job-browser.json"),
      "utf8",
    ),
  );
  expect(manifest.controlToken).toBe(helper.controlToken);
  await expect(f.api.cleanupEnvironment!("job-browser")).rejects.toThrow(
    /remains reserved/,
  );
  await f.api.stopJob("job-browser");
  expect(f.containers.has("gremlins-auth-job-browser")).toBe(false);
  expect(f.networks.size).toBe(0);
});

it.each(["rejected", "wrong-receipt"] as const)(
  "does not start an agent when private access returns %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(
      f.api.startJob({ id: "job-browser", workerId: "worker-test", payload }),
    ).rejects.toBeInstanceOf(ManagedAccessError);
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
    expect(
      f.calls.some((call) =>
        call.args.includes("/opt/gremlins/receive-job.mjs"),
      ),
    ).toBe(false);
  },
);

it("keeps internal access probes out of ordinary verification and rejects leaked managed credentials", () => {
  const probe = {
    kind: "verify" as const,
    nonce: "probe",
    accessProbe: true as const,
    project: "demo",
    browserTarget: payload.browserTarget,
    testAccess,
    credentials: {
      GREMLINS_TEST_USERNAME_1: "user",
      GREMLINS_TEST_PASSWORD_1: "password",
    },
  };
  expect(() => validatePayload(probe)).not.toThrow();
  expect(() =>
    validatePayload({
      ...probe,
      browserTarget: undefined,
      testEnvironment: {
        target: {
          kind: "docker",
          role: "staging",
          recipe: { kind: "image", image: "test/app:1" },
          port: 3000,
        },
      },
    }),
  ).not.toThrow();
  expect(() => validatePayload({ ...probe, accessProbe: undefined })).toThrow();
  expect(() =>
    validatePayload({
      ...probe,
      credentials: { ANTHROPIC_API_KEY: "not-needed" },
    }),
  ).toThrow();
  expect(() => validatePayload({ ...probe, prompt: "run AI" })).toThrow();
  expect(() =>
    validateManagedTestAccess({
      ...testAccess,
      access: {
        ...testAccess.access,
        accounts: [
          ...testAccess.access.accounts,
          { ...testAccess.access.accounts[0], name: "Other" },
        ],
      },
    }),
  ).toThrow(/one allocated/);
  expect(() =>
    validateManagedBrowserConnection({
      version: 1,
      endpoint: "http://external.test:4719/mcp",
      token: "a".repeat(64),
      receipt: {},
    }),
  ).toThrow();
});
