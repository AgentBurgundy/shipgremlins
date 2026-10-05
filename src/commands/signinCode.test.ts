import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  accountOwner,
  hashOtp,
  runSigninCode,
  type Sql,
} from "./signinCode.ts";

function hub(signIn: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-signin-")));
  const dir = join(root, "projects", "game");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      repo: "owner/game",
      branches: {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      },
      vercel: {
        projectId: "prj_x",
        teamId: null,
        bypassSecret: "VERCEL_BYPASS_GAME",
      },
      database: "neon-vercel-integration",
      slackWebhookSecret: "SLACK_WEBHOOK_GAME",
      runnerLabel: null,
      mergeMethod: "squash",
      commands: {
        install: "npm ci",
        test: "npm test",
        lint: null,
        typecheck: null,
      },
      verified: null,
      ...(signIn === undefined ? {} : { signIn }),
    }),
  );
  writeFileSync(
    join(dir, "areas.json"),
    JSON.stringify({
      areas: {
        core: {
          name: "Core",
          paths: ["src/"],
          sharedTouchpoints: [],
          linearProjectId: "p",
          label: "pm:core",
          wipLimit: 1,
          metric: "/",
          schedule: "0 13 * * 1-5",
          enabled: true,
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "tiers.json"),
    JSON.stringify({
      ownerOnlyPrefixes: [],
      hubOwnerOnly: [],
      alwaysFree: [],
      guardTests: [],
      testFileMarkers: [],
    }),
  );
  return root;
}

const SIGN_IN = {
  kind: "neon-auth-otp",
  email: "pm-agent@example.com",
  path: "/sign-in",
  databaseUrlSecret: "PM_DATABASE_URL_GAME",
};

function recorder(rows: unknown[] = []) {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql: Sql = async (query, params) => {
    calls.push({ query, params });
    return /SELECT id/.test(query) ? rows : [];
  };
  return { sql, calls };
}

describe("hashOtp / accountOwner", () => {
  it("matches Better Auth's stored form and the target's owner hash", () => {
    expect(hashOtp("684219")).toBe(
      createHash("sha256").update("684219").digest("base64url") + ":0",
    );
    expect(accountOwner("u1")).toBe(
      createHash("sha256").update("account:u1").digest("hex"),
    );
  });
});

describe("runSigninCode", () => {
  it("refuses a cross-project hosting credential alias before database or browser access", async () => {
    const root = hub(SIGN_IN);
    const file = join(root, "projects", "game", "project.json");
    const project = JSON.parse(readFileSync(file, "utf8"));
    const other = {
      ...project,
      signIn: null,
      verification: { mode: "repository" },
      environments: {
        preview: {
          role: "preview",
          kind: "railway",
          projectId: "p",
          serviceId: "s",
          environmentId: "e",
          tokenSecret: "OTHER_ACCOUNT",
        },
      },
    };
    mkdirSync(join(root, "projects", "other"));
    for (const name of ["areas.json", "tiers.json"])
      writeFileSync(
        join(root, "projects", "other", name),
        readFileSync(join(root, "projects", "game", name)),
      );
    writeFileSync(
      join(root, "projects", "other", "project.json"),
      JSON.stringify(other),
    );
    project.vercel.bypassSecret = "OTHER_ACCOUNT";
    writeFileSync(file, JSON.stringify(project));
    const connect = vi.fn(),
      fetchImpl = vi.fn(),
      errors: string[] = [];
    expect(
      await runSigninCode(
        root,
        [
          "--project",
          "game",
          "--bootstrap",
          "--preview-url",
          "https://test.example",
        ],
        {
          OTHER_ACCOUNT: "private-hosting",
          PM_DATABASE_URL_GAME: "postgres://preview",
        },
        { log: () => {}, error: (value) => errors.push(value) },
        { connect, fetchImpl },
      ),
    ).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.join(" ")).not.toContain("private-hosting");
  });
  it("seeds a hashed code for the project's test account and prints email + code", async () => {
    const { sql, calls } = recorder();
    const out: string[] = [];
    const code = await runSigninCode(
      hub(SIGN_IN),
      ["--project", "game"],
      { PM_DATABASE_URL_GAME: "postgres://preview" },
      { log: (l) => out.push(l), error: () => {} },
      { connect: () => sql, otp: () => "123456" },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      email: "pm-agent@example.com",
      code: "123456",
      path: "/sign-in",
      expiresInMinutes: 10,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toMatch(/DELETE FROM neon_auth\.verification/);
    expect(calls[1]!.query).toMatch(/INSERT INTO neon_auth\.verification/);
    expect(calls[1]!.params.slice(1)).toEqual([
      "sign-in-otp-pm-agent@example.com",
      hashOtp("123456"),
    ]);
    // the raw code never goes to the database
    expect(JSON.stringify(calls)).not.toContain('"123456"');
  });

  it("refuses when the project has no recipe or the secret is unset, naming it", async () => {
    const errors: string[] = [];
    const io = { log: () => {}, error: (l: string) => errors.push(l) };
    const { sql } = recorder();
    expect(
      await runSigninCode(hub(undefined), ["--project", "game"], {}, io, {
        connect: () => sql,
      }),
    ).toBe(1);
    expect(errors[0]).toMatch(/no signIn recipe/);
    expect(
      await runSigninCode(hub(SIGN_IN), ["--project", "game"], {}, io, {
        connect: () => sql,
      }),
    ).toBe(1);
    expect(errors[1]).toMatch(/PM_DATABASE_URL_GAME is not set/);
  });

  it("--bootstrap signs in on the preview with the bypass header and prints the owner hash", async () => {
    const { sql } = recorder([{ id: "user-9" }]);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const out: string[] = [];
    const code = await runSigninCode(
      hub(SIGN_IN),
      [
        "--project",
        "game",
        "--bootstrap",
        "--preview-url",
        "https://p.vercel.app/",
      ],
      { PM_DATABASE_URL_GAME: "postgres://preview", VERCEL_BYPASS_GAME: "byp" },
      { log: (l) => out.push(l), error: () => {} },
      {
        connect: () => sql,
        otp: () => "654321",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://p.vercel.app/api/auth/sign-in/email-otp");
    expect(init.headers).toMatchObject({
      origin: "https://p.vercel.app",
      "x-vercel-protection-bypass": "byp",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      email: "pm-agent@example.com",
      otp: "654321",
    });
    expect(JSON.parse(out[0]!)).toEqual({
      email: "pm-agent@example.com",
      owner: accountOwner("user-9"),
    });
  });

  it("--bootstrap fails loudly when the preview refuses the sign-in", async () => {
    const { sql } = recorder();
    const errors: string[] = [];
    const code = await runSigninCode(
      hub(SIGN_IN),
      [
        "--project",
        "game",
        "--bootstrap",
        "--preview-url",
        "https://p.vercel.app",
      ],
      { PM_DATABASE_URL_GAME: "postgres://preview" },
      { log: () => {}, error: (l) => errors.push(l) },
      {
        connect: () => sql,
        fetchImpl: (async () =>
          new Response("nope", { status: 403 })) as unknown as typeof fetch,
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/answered 403/);
  });
});

describe("extractDatabaseUrl", () => {
  it("finds the URL in a bare string, a psql snippet, an env line and a piped value with BOM/newline", async () => {
    const { extractDatabaseUrl } = await import("./signinCode.ts");
    const url =
      "postgresql://u:p@ep-x-pooler.c-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    expect(extractDatabaseUrl(url)).toBe(url);
    expect(extractDatabaseUrl(`psql '${url}'`)).toBe(url);
    expect(extractDatabaseUrl(`DATABASE_URL="${url}"\r\n`)).toBe(url);
    expect(extractDatabaseUrl(`${String.fromCharCode(0xfeff)}${url}\r\n`)).toBe(
      url,
    );
    expect(extractDatabaseUrl("aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY")).toBeNull();
  });
});
