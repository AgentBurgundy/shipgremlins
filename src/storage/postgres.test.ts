import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPostgres,
  POSTGRES_IMAGE,
  type StorageDocker,
} from "./postgres.ts";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-storage-test-"),
  );
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});
function docker() {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let container: Record<string, unknown> | null = null,
    volume: Record<string, unknown> | null = null;
  const run: StorageDocker = async (args, options) => {
    calls.push({ args, stdin: options?.stdin });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const labels = () =>
      Object.fromEntries(
        args.flatMap((arg, i) =>
          arg === "--label" ? [args[i + 1]!.split("=")] : [],
        ),
      );
    if (args[0] === "inspect")
      return container
        ? ok(JSON.stringify(container))
        : { code: 1, stdout: "", stderr: "No such object" };
    if (args[0] === "volume" && args[1] === "inspect")
      return volume
        ? ok(JSON.stringify(volume))
        : { code: 1, stdout: "", stderr: "No such volume" };
    if (args[0] === "volume" && args[1] === "create") {
      volume = { Name: args.at(-1), Labels: labels() };
      return ok();
    }
    if (args[0] === "pull") return ok();
    if (args[0] === "create") {
      container = {
        Name: "/" + args[args.indexOf("--name") + 1],
        Config: { Labels: labels() },
        HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1" }] } },
        State: { Running: false },
        NetworkSettings: {
          Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] },
        },
      };
      return ok();
    }
    if (args[0] === "start") {
      container!.State = { Running: true };
      return ok();
    }
    if (args[0] === "exec") return ok();
    throw new Error("Unexpected test command");
  };
  return {
    run,
    calls,
    dropContainer: () => {
      container = null;
    },
    changeOwner: () => {
      (container!.Config as { Labels: Record<string, string> }).Labels[
        "io.shipgremlins.storage"
      ] = "someone-else";
    },
  };
}

describe("managed PostgreSQL lifecycle", () => {
  it("refuses a symlink or junction before writing database credentials", async () => {
    const directory = root(),
      outside = root(),
      fake = docker();
    symlinkSync(
      outside,
      join(directory, ".run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      createPostgres({ root: directory, run: fake.run }).ensure(),
    ).rejects.toThrow("symbolic links");
    expect(existsSync(join(outside, "storage", "postgres.json"))).toBe(false);
    expect(fake.calls).toEqual([]);
  });
  it("stays lazy and ignores ambient application DATABASE_URL", () => {
    const directory = root(),
      fake = docker();
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://unrelated:secret@prod/app";
    try {
      const db = createPostgres({ root: directory, run: fake.run });
      expect(db.status()).toMatchObject({
        configured: false,
        mode: "unconfigured",
      });
      expect(fake.calls).toEqual([]);
      expect(existsSync(join(directory, ".run"))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });

  it("provisions once with pinned image, owned volume, loopback port, and stdin-only password", async () => {
    const directory = root(),
      fake = docker(),
      db = createPostgres({ root: directory, run: fake.run });
    const [first, second] = await Promise.all([db.ensure(), db.ensure()]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      host: "127.0.0.1",
      port: 54321,
      user: "gremlins",
      database: "gremlins",
    });
    const password = String(first.password);
    expect(password).toMatch(/^[a-f0-9]{64}$/);
    const args = fake.calls.flatMap((call) => call.args);
    expect(args).not.toContain(password);
    expect(args).toContain(POSTGRES_IMAGE);
    expect(args).toContain("127.0.0.1::5432");
    expect(args).toContain("unless-stopped");
    expect(args).not.toContain("--privileged");
    expect(fake.calls.find((call) => call.stdin)?.stdin).toBe(password);
    const file = join(directory, ".run", "storage", "postgres.json");
    expect(JSON.parse(readFileSync(file, "utf8")).password).toBe(password);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fake.calls.filter((call) => call.args[0] === "create")).toHaveLength(
      1,
    );
  });

  it("recovers a missing container using the existing volume and password without deleting data", async () => {
    const directory = root(),
      fake = docker();
    const initial = await createPostgres({
      root: directory,
      run: fake.run,
    }).ensure();
    fake.dropContainer();
    const recovered = await createPostgres({
      root: directory,
      run: fake.run,
    }).ensure();
    expect(recovered.password).toBe(initial.password);
    expect(
      fake.calls.filter(
        (call) => call.args[0] === "volume" && call.args[1] === "create",
      ),
    ).toHaveLength(1);
    expect(fake.calls.flatMap((call) => call.args)).not.toContain("rm");
  });

  it("refuses another owner's container and keeps saved credentials intact", async () => {
    const directory = root(),
      fake = docker();
    await createPostgres({ root: directory, run: fake.run }).ensure();
    fake.changeOwner();
    await expect(
      createPostgres({ root: directory, run: fake.run }).ensure(),
    ).rejects.toThrow("another application");
    expect(
      existsSync(join(directory, ".run", "storage", "postgres.json")),
    ).toBe(true);
  });

  it("reports corrupt configuration without echoing credential values", async () => {
    const directory = root(),
      fake = docker();
    await createPostgres({ root: directory, run: fake.run }).ensure();
    writeFileSync(
      join(directory, ".run", "storage", "postgres.json"),
      "this is broken private-password",
    );
    await expect(
      createPostgres({ root: directory, run: fake.run }).ensure(),
    ).rejects.toThrow("Restore .run/storage/postgres.json");
  });

  it("uses external PostgreSQL only when explicitly configured", async () => {
    const directory = root(),
      fake = docker();
    const url =
      "postgresql://operator:private-value@db.example.test/gremlins?sslmode=require";
    const db = createPostgres({
      root: directory,
      externalDatabaseUrl: url,
      run: fake.run,
    });
    expect(await db.ensure()).toMatchObject({ connectionString: url });
    expect(fake.calls).toEqual([]);
    expect(db.status()).toMatchObject({ mode: "external", configured: true });
    expect(
      await createPostgres({ root: directory, run: fake.run }).ensure(),
    ).toMatchObject({ connectionString: url });
    await expect(
      createPostgres({
        root: directory,
        externalDatabaseUrl: "https://db.example",
        run: fake.run,
      }).ensure(),
    ).rejects.toThrow("PostgreSQL connection");
  });
});
