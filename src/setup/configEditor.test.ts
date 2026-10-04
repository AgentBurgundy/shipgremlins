import { afterEach, describe, expect, it } from "vitest";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigEditorError,
  MAX_CONFIG_BYTES,
  listEditableConfigs,
  readEditableConfig,
  saveEditableConfig,
} from "./configEditor.ts";

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-config-editor-test-"),
  );
  roots.push(root);
  return root;
}

function fixture(): string {
  const root = temporary();
  mkdirSync(join(root, "projects", "demo"), { recursive: true });
  const configs = {
    "hub.json": {
      hubRepo: "example/hub",
      runners: { mode: "self-hosted", label: "pm" },
      gce: {
        project: "",
        zone: "us-central1-a",
        image: "pm-runner",
        machineType: "e2-standard-4",
        spot: false,
      },
    },
    "projects/demo/project.json": {
      repo: "example/app",
      branches: {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      },
      vercel: {
        projectId: "prj_demo",
        teamId: null,
        bypassSecret: "VERCEL_BYPASS_DEMO",
      },
      database: "none",
      slackWebhookSecret: "SLACK_WEBHOOK_DEMO",
      runnerLabel: null,
      mergeMethod: "squash",
      commands: {
        install: "npm ci",
        test: "npm test",
        lint: null,
        typecheck: null,
      },
      verified: null,
    },
    "projects/demo/areas.json": {
      areas: {
        core: {
          name: "Core",
          paths: ["src/"],
          sharedTouchpoints: [],
          linearProjectId: "linear-project",
          label: "pm:core",
          wipLimit: 3,
          metric: "/",
          schedule: "0 13 * * 1-5",
          enabled: false,
        },
      },
    },
    "projects/demo/tiers.json": {
      ownerOnlyPrefixes: ["auth/"],
      hubOwnerOnly: [".github/"],
      alwaysFree: ["docs/"],
      guardTests: [],
      testFileMarkers: [".test."],
    },
  };
  for (const [path, value] of Object.entries(configs))
    writeFileSync(join(root, path), JSON.stringify(value, null, 2) + "\r\n");
  writeFileSync(join(root, ".env"), "GITHUB_TOKEN=private-token\n");
  return root;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    [...listEditableConfigs(root).map((file) => file.path), ".env"].map(
      (path) => [path, readFileSync(join(root, path), "utf8")],
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("dashboard configuration editor", () => {
  it("lists only editable existing configuration files, excluding templates and secrets", () => {
    const root = fixture();
    mkdirSync(join(root, "projects", "_templates"));
    writeFileSync(join(root, "projects", "_templates", "project.json"), "{}");
    writeFileSync(join(root, "projects", "demo", ".env"), "hidden");
    writeFileSync(join(root, "extra.json"), "{}");
    expect(listEditableConfigs(root).map((file) => file.path)).toEqual([
      "hub.json",
      "projects/demo/project.json",
      "projects/demo/areas.json",
      "projects/demo/tiers.json",
    ]);
    expect(listEditableConfigs(join(root, "not-created"))).toEqual([]);
  });

  it("returns exact bytes as text and a stable content revision", () => {
    const root = fixture();
    const document = readEditableConfig(root, "hub.json");
    expect(document.content).toBe(readFileSync(join(root, "hub.json"), "utf8"));
    expect(document.content).toMatch(/\r\n$/);
    expect(document.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(readEditableConfig(root, "hub.json").revision).toBe(
      document.revision,
    );
  });

  it.each([
    ["hub.json", '"label": "pm"', '"label": "homelab"'],
    [
      "projects/demo/project.json",
      '"projectId": "prj_demo"',
      '"projectId": "prj_updated"',
    ],
    ["projects/demo/areas.json", '"enabled": false', '"enabled": true'],
    [
      "projects/demo/tiers.json",
      '"guardTests": []',
      '"guardTests": ["security.test.ts"]',
    ],
  ] as const)(
    "validates and saves %s without touching other files",
    (path, from, to) => {
      const root = fixture();
      const before = snapshot(root);
      const original = readEditableConfig(root, path);
      const value = JSON.parse(original.content.replace(from, to));
      const content = JSON.stringify(value, null, 4) + "\n";
      const saved = saveEditableConfig(root, {
        path,
        content,
        revision: original.revision,
      });
      expect(saved.revision).toBe(readEditableConfig(root, path).revision);
      expect(saved.revision).not.toBe(original.revision);
      expect(snapshot(root)).toEqual({ ...before, [path]: content });
      expect(
        readdirSync(
          join(root, path === "hub.json" ? "" : "projects/demo"),
        ).some((file) => file.endsWith(".tmp")),
      ).toBe(false);
      if (process.platform !== "win32")
        expect(statSync(join(root, path)).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects stale saves with HTTP 409 and preserves the first writer's content", () => {
    const root = fixture();
    const original = readEditableConfig(root, "hub.json");
    const first = original.content.replace('"pm"', '"homelab"');
    saveEditableConfig(root, { ...original, content: first });
    let failure: unknown;
    try {
      saveEditableConfig(root, {
        ...original,
        content: original.content.replace('"pm"', '"cloud"'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ConfigEditorError",
      code: "conflict",
      status: 409,
    });
    expect(readEditableConfig(root, "hub.json").content).toBe(first);
    expect(() =>
      saveEditableConfig(root, { ...original, revision: "" }),
    ).toThrow(ConfigEditorError);
  });

  it.each([
    ["hub.json", '{"hubRepo":"private-secret-value",'],
    ["hub.json", "null"],
    ["hub.json", "{}"],
    [
      "projects/demo/areas.json",
      '{"areas":{"secret-DO-NOT-ECHO":{"enabled":true}}}',
    ],
    ["projects/demo/areas.json", '{"areas":{"secret-do-not-echo":null}}'],
    ["projects/demo/tiers.json", '{"ownerOnlyPrefixes":"not-an-array"}'],
  ])(
    "rejects invalid JSON/schema in %s without changing any file or echoing values",
    (path, content) => {
      const root = fixture();
      const before = snapshot(root);
      const original = readEditableConfig(root, path);
      let failure: unknown;
      try {
        saveEditableConfig(root, { ...original, content });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConfigEditorError);
      expect(failure).toMatchObject({ code: "invalid_config", status: 400 });
      expect((failure as Error).message).not.toMatch(
        /private-secret-value|secret-DO-NOT-ECHO|secret-do-not-echo/,
      );
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.each(["bypassSecret", "slackWebhookSecret", "databaseUrlSecret"])(
    "rejects credential values in %s without returning them",
    (field) => {
      const root = fixture();
      const before = snapshot(root);
      const original = readEditableConfig(root, "projects/demo/project.json");
      const value = JSON.parse(original.content);
      const secret = "https://secret.example/private-value";
      if (field === "bypassSecret") value.vercel.bypassSecret = secret;
      else if (field === "slackWebhookSecret")
        value.slackWebhookSecret = secret;
      else
        value.signIn = {
          kind: "neon-auth-otp",
          email: "pm@example.com",
          path: "/login",
          databaseUrlSecret: secret,
        };
      let failure: unknown;
      try {
        saveEditableConfig(root, {
          ...original,
          content: JSON.stringify(value),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_config" });
      expect((failure as Error).message).not.toContain(secret);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it("rejects a project name inconsistent with its folder", () => {
    const root = fixture();
    const original = readEditableConfig(root, "projects/demo/project.json");
    const value = {
      ...JSON.parse(original.content),
      name: "different-project",
    };
    expect(() =>
      saveEditableConfig(root, { ...original, content: JSON.stringify(value) }),
    ).toThrow('"name" must match');
    expect(readEditableConfig(root, original.path)).toEqual(original);
  });

  it.each([
    ".env",
    "projects/demo/.env",
    "projects/_templates/project.json",
    "../hub.json",
    "/hub.json",
    "hub.json/../.env",
    "projects/demo/../../.env",
    "projects\\demo\\project.json",
    "projects/demo/project.json\0",
    "projects/con/project.json",
    "projects/Demo/project.json",
    "projects/demo/project.json:secret",
    "%2e%2e/.env",
    "C:/hub.json",
    "extra.json",
  ])("rejects an unapproved path: %s", (path) => {
    const root = fixture();
    const before = snapshot(root);
    expect(() => readEditableConfig(root, path)).toThrow(ConfigEditorError);
    expect(() =>
      saveEditableConfig(root, {
        path,
        content: "{}",
        revision: "a".repeat(64),
      }),
    ).toThrow(ConfigEditorError);
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses to create new files through the editor", () => {
    const root = fixture();
    expect(() =>
      readEditableConfig(root, "projects/missing/project.json"),
    ).toThrow("no longer exists");
    expect(() =>
      saveEditableConfig(root, {
        path: "projects/missing/project.json",
        content: "{}",
        revision: "a".repeat(64),
      }),
    ).toThrow("no longer exists");
  });

  it("caps read and write size at 64 KB measured as UTF-8 bytes", () => {
    const root = fixture();
    const original = readEditableConfig(root, "hub.json");
    expect(() =>
      saveEditableConfig(root, {
        ...original,
        content: "é".repeat(MAX_CONFIG_BYTES / 2 + 1),
      }),
    ).toThrow("64 KB");
    expect(readEditableConfig(root, "hub.json")).toEqual(original);
    writeFileSync(join(root, "hub.json"), "x".repeat(MAX_CONFIG_BYTES + 1));
    expect(() => readEditableConfig(root, "hub.json")).toThrow("64 KB");
  });

  it("rejects root and project-directory junctions, including dangling junctions", () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, "linked-root"), "junction");
    symlinkSync(
      join(outside, "projects/demo"),
      join(root, "projects", "linked"),
      "junction",
    );
    symlinkSync(
      join(root, "missing"),
      join(root, "projects", "dangling"),
      "junction",
    );
    const outsideBefore = snapshot(outside);
    expect(() => listEditableConfigs(join(root, "linked-root"))).toThrow(
      "symbolic links",
    );
    expect(() =>
      readEditableConfig(join(root, "linked-root"), "hub.json"),
    ).toThrow("symbolic links");
    for (const project of ["linked", "dangling"]) {
      const path = `projects/${project}/project.json`;
      expect(() => readEditableConfig(root, path)).toThrow("symbolic links");
      expect(() =>
        saveEditableConfig(root, {
          path,
          content: "{}",
          revision: "a".repeat(64),
        }),
      ).toThrow("symbolic links");
    }
    expect(
      listEditableConfigs(root).some((file) =>
        /linked|dangling/.test(file.path),
      ),
    ).toBe(false);
    expect(snapshot(outside)).toEqual(outsideBefore);
  });

  it("refuses a projects-directory junction", () => {
    const root = temporary();
    const outside = fixture();
    symlinkSync(join(outside, "projects"), join(root, "projects"), "junction");
    expect(listEditableConfigs(root)).toEqual([]);
    expect(() =>
      readEditableConfig(root, "projects/demo/project.json"),
    ).toThrow("symbolic links");
  });

  it("refuses files that are hard links to another location", () => {
    const root = temporary();
    const outside = fixture();
    linkSync(join(outside, "hub.json"), join(root, "hub.json"));
    expect(() => readEditableConfig(root, "hub.json")).toThrow("without links");
    expect(listEditableConfigs(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses file symlinks and dangling file symlinks without following or replacing them",
    () => {
      const outside = fixture();
      for (const destination of [
        join(outside, "hub.json"),
        join(outside, "missing.json"),
      ]) {
        const root = temporary();
        symlinkSync(destination, join(root, "hub.json"));
        expect(() => readEditableConfig(root, "hub.json")).toThrow(
          "symbolic links",
        );
        expect(() =>
          saveEditableConfig(root, {
            path: "hub.json",
            content: "{}",
            revision: "a".repeat(64),
          }),
        ).toThrow("symbolic links");
        expect(lstatSync(join(root, "hub.json")).isSymbolicLink()).toBe(true);
      }
    },
  );
});
