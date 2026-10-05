import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import {
  readConnections,
  saveConnections,
  projectConnections,
} from "./connections.ts";
import { parseGoogleServiceAccount } from "../hosting/credentials.ts";

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-connections-test-"),
  );
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("dashboard connection storage", () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const google = () => ({
    type: "service_account",
    project_id: "sample-project",
    client_email: "reader@sample-project.iam.gserviceaccount.com",
    private_key: key,
    token_uri: "https://oauth2.googleapis.com/token",
  });
  it("roundtrips pasted multiline Google JSON without turning PEM newlines into dotenv assignments", () => {
    const root = temporary();
    writeFileSync(
      join(root, ".env"),
      "# preserve me\nOTHER=value\nNODE_OPTIONS=never-import\n",
    );
    saveConnections(root, {
      GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(google(), null, 2),
      RAILWAY_TOKEN: "railway-account-token",
    });
    const saved = readConnections(root);
    expect(parseGoogleServiceAccount(saved.GCP_SERVICE_ACCOUNT_JSON!)).toEqual(
      google(),
    );
    expect(saved.RAILWAY_TOKEN).toBe("railway-account-token");
    expect(saved.NODE_OPTIONS).toBeUndefined();
    const source = readFileSync(join(root, ".env"), "utf8");
    expect(source).toContain("# preserve me\nOTHER=value");
    expect(
      source
        .split("\n")
        .filter((line) => line.startsWith("GCP_SERVICE_ACCOUNT_JSON=")),
    ).toHaveLength(1);
    saveConnections(root, {
      GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(google()),
      GITHUB_TOKEN: "new-token",
    });
    expect(JSON.parse(readConnections(root).GCP_SERVICE_ACCOUNT_JSON!)).toEqual(
      google(),
    );
  });
  it("supports named hosting credentials without a legacy Vercel block", () => {
    const root = temporary();
    const directory = join(root, "projects", "app");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "project.json"),
      JSON.stringify({
        repo: "owner/app",
        workflow: { kind: "pull-request", baseBranch: "main" },
        verification: { mode: "repository" },
        environments: {
          staging: {
            kind: "cloud-run",
            role: "staging",
            projectId: "sample-project",
            region: "us-central1",
            service: "app",
            credentialsSecret: "GCP_APP_READER",
          },
          preview: {
            kind: "railway",
            role: "preview",
            projectId: "project",
            environmentId: "env",
            serviceId: "service",
            tokenSecret: "RAILWAY_APP",
          },
        },
        database: "none",
        slackWebhookSecret: "SLACK_WEBHOOK_APP",
        runnerLabel: null,
        mergeMethod: "squash",
        commands: {
          install: "npm ci",
          test: "npm test",
          lint: null,
          typecheck: null,
        },
        verified: null,
      }),
    );
    writeFileSync(
      join(directory, "areas.json"),
      JSON.stringify({
        areas: {
          core: {
            name: "Core",
            paths: ["src/"],
            sharedTouchpoints: [],
            linearProjectId: "lin_core",
            label: "pm:core",
            wipLimit: 2,
            metric: "/",
            schedule: "0 13 * * 1-5",
            enabled: true,
          },
        },
      }),
    );
    writeFileSync(
      join(directory, "tiers.json"),
      JSON.stringify({
        ownerOnlyPrefixes: [],
        hubOwnerOnly: [],
        alwaysFree: [],
        guardTests: [],
        testFileMarkers: [],
      }),
    );
    expect(projectConnections(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "GCP_APP_READER", format: "json" }),
        expect.objectContaining({ name: "RAILWAY_APP" }),
      ]),
    );
    saveConnections(root, {
      GCP_APP_READER: JSON.stringify(google()),
      RAILWAY_APP: "specific-token",
    });
    expect(readConnections(root).RAILWAY_APP).toBe("specific-token");
    expect(JSON.parse(readConnections(root).GCP_APP_READER!)).toEqual(google());
  });
  it.each([
    {
      type: "external_account",
      credential_source: { executable: { command: "never-run" } },
    },
    { ...google(), token_uri: "https://attacker.example/token" },
    { ...google(), private_key: "never-disclose-this" },
  ])(
    "rejects unsafe Google credentials without changing the file or exposing values",
    (value) => {
      const root = temporary();
      writeFileSync(join(root, ".env"), "OTHER=keep\n");
      expect(() =>
        saveConnections(root, {
          GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(value),
        }),
      ).toThrow("Enter a valid Google service-account JSON");
      expect(readFileSync(join(root, ".env"), "utf8")).toBe("OTHER=keep\n");
    },
  );
  it("preserves unrelated dotenv content, comments and multiline values while replacing old tokens", () => {
    const root = temporary();
    const untouched =
      '# custom settings\r\nNODE_OPTIONS="--require ./example.cjs"\r\nPRIVATE_KEY="first\nGITHUB_TOKEN=not-a-real-assignment\nlast"\r\nOTHER=value # keep me\r\n';
    writeFileSync(
      join(root, ".env"),
      `${untouched}export GITHUB_TOKEN='old-token'\r\nGITHUB_TOKEN=duplicate\r\nLINEAR_API_KEY='keep-linear'\r\n`,
    );
    saveConnections(root, {
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "   ",
      VERCEL_TOKEN: "vercel#value",
    });
    const source = readFileSync(join(root, ".env"), "utf8");
    expect(source).toContain(untouched);
    expect(source).not.toContain("old-token");
    expect(source).not.toContain("duplicate");
    expect(parseEnv(source)).toMatchObject({
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "keep-linear",
      VERCEL_TOKEN: "vercel#value",
      NODE_OPTIONS: "--require ./example.cjs",
    });
    expect(readConnections(root)).toEqual({
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "keep-linear",
      VERCEL_TOKEN: "vercel#value",
    });
  });

  it("creates private configuration files and returns only allowlisted credentials", () => {
    const root = join(temporary(), "new-config");
    expect(readConnections(root)).toEqual({});
    saveConnections(root, {
      GITHUB_TOKEN: "ghp_example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test",
    });
    expect(readConnections(root)).toEqual({
      GITHUB_TOKEN: "ghp_example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test",
    });
    if (process.platform !== "win32")
      expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
  });

  it.each([
    { NODE_OPTIONS: "--require malware" },
    { GITHUB_TOKEN: "abc\nVERCEL_TOKEN=injected" },
    { GITHUB_TOKEN: "'quoted'" },
    { VERCEL_TOKEN: "a".repeat(8193) },
    { LINEAR_API_KEY: true },
  ])(
    "rejects unknown keys and unsafe values without modifying files",
    (values) => {
      const root = temporary();
      writeFileSync(join(root, ".env"), "OTHER=preserved\n");
      expect(() => saveConnections(root, values)).toThrow();
      expect(readFileSync(join(root, ".env"), "utf8")).toBe(
        "OTHER=preserved\n",
      );
    },
  );

  it("refuses junction destinations and preserves the external file", () => {
    const root = temporary();
    const external = temporary();
    writeFileSync(join(external, ".env"), "GITHUB_TOKEN=secret-external\n");
    symlinkSync(external, join(root, "linked"), "junction");
    expect(() => readConnections(join(root, "linked"))).toThrow(
      "Saved connections could not be read",
    );
    expect(() =>
      saveConnections(join(root, "linked"), { GITHUB_TOKEN: "new" }),
    ).toThrow("Connections could not be saved");
    expect(readFileSync(join(external, ".env"), "utf8")).toBe(
      "GITHUB_TOKEN=secret-external\n",
    );
  });

  it("returns sanitized file errors without exposing credential content", () => {
    const root = temporary();
    mkdirSync(join(root, ".env"));
    expect(() =>
      saveConnections(root, { GITHUB_TOKEN: "never-print-this" }),
    ).toThrow("Connections could not be saved");
    expect(() => readConnections(root)).toThrow(
      "Saved connections could not be read",
    );
  });

  it("refuses dangling symlink destinations without replacing the link", () => {
    const root = temporary();
    const missing = join(root, "missing-directory");
    // Junction creation works without elevated Windows symbolic-link privileges.
    symlinkSync(missing, join(root, "linked"), "junction");
    expect(() => readConnections(join(root, "linked"))).toThrow(
      "Saved connections could not be read",
    );
    expect(() =>
      saveConnections(join(root, "linked"), { GITHUB_TOKEN: "secret" }),
    ).toThrow("Connections could not be saved");
  });
});
