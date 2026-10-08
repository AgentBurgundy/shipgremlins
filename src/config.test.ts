import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  listProjectNames,
  loadAllProjects,
  loadHub,
  loadProject,
  matchesPrefix,
  codingPickupEnabled,
} from "./config.ts";

type Json = Record<string, unknown>;

const PROJECT: Json = {
  repo: "owner/game",
  branches: {
    production: "main",
    staging: "staging",
    integration: "pm-staging",
  },
  vercel: {
    projectId: "prj_1",
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
};

const AREAS: Json = {
  areas: {
    core: {
      name: "Core",
      paths: ["app/"],
      sharedTouchpoints: [],
      linearProjectId: "lin_core",
      label: "pm:core",
      wipLimit: 2,
      metric: "/play",
      schedule: "0 13 * * 1-5",
      enabled: true,
    },
  },
};

const TIERS: Json = {
  ownerOnlyPrefixes: ["app/api/auth"],
  hubOwnerOnly: [".github/"],
  alwaysFree: ["docs/"],
  guardTests: [],
  testFileMarkers: [".test."],
};

const HUB: Json = {
  hubRepo: "owner/pm-hub",
  runners: { mode: "self-hosted", label: "pm" },
  gce: { project: "", zone: "z", image: "img", machineType: "e2", spot: false },
};

let root: string;

function writeProject(
  name: string,
  files: { project?: unknown; areas?: unknown; tiers?: unknown } = {},
  raw: { project?: string } = {},
): void {
  const dir = join(root, "projects", name);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, value: unknown, text?: string): void =>
    writeFileSync(join(dir, file), text ?? JSON.stringify(value, null, 2));
  write("project.json", files.project ?? PROJECT, raw.project);
  write("areas.json", files.areas ?? AREAS);
  write("tiers.json", files.tiers ?? TIERS);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pm-hub-config-"));
  writeFileSync(join(root, "hub.json"), JSON.stringify(HUB));
});
it("loads each PM's optional promotion target and rejects invalid sizes", () => {
  const areas = structuredClone(AREAS) as {
    areas: { core: Record<string, unknown> };
  };
  areas.areas.core.promotionBatchSize = 4;
  writeProject("demo", { areas });
  expect(loadProject(root, "demo").areas[0]!.promotionBatchSize).toBe(4);
  for (const invalid of [0, 101, 1.5, "4"]) {
    areas.areas.core.promotionBatchSize = invalid;
    writeProject("demo", { areas });
    expect(() => loadProject(root, "demo")).toThrow(/promotionBatchSize/);
  }
});
it("loads explicit PM testing requirements without changing legacy defaults", () => {
  const areas = structuredClone(AREAS) as {
    areas: { core: Record<string, unknown> };
  };
  writeProject("demo", { areas });
  expect(
    loadProject(root, "demo").areas[0]!.verificationRequirement,
  ).toBeUndefined();
  for (const value of ["browser", "repository"]) {
    areas.areas.core.verificationRequirement = value;
    writeProject("demo", { areas });
    expect(loadProject(root, "demo").areas[0]!.verificationRequirement).toBe(
      value,
    );
  }
  for (const value of ["auto", "", true, null]) {
    areas.areas.core.verificationRequirement = value;
    writeProject("demo", { areas });
    expect(() => loadProject(root, "demo")).toThrow(/verificationRequirement/);
  }
});
it("binds recreated PM memory branches to a validated instance while retaining legacy branch names", () => {
  writeProject("demo");
  expect(loadProject(root, "demo").areas[0]!.memoryBranch).toBe("pm/demo/core");
  const areas = structuredClone(AREAS) as {
    areas: { core: Record<string, unknown> };
  };
  areas.areas.core.instanceId = "f47e5f74-a8ee-4561-a033-3be028c462dd";
  writeProject("demo", { areas });
  expect(loadProject(root, "demo").areas[0]!.memoryBranch).toBe(
    "pm/demo/core/f47e5f74-a8ee-4561-a033-3be028c462dd",
  );
  areas.areas.core.instanceId = "../../other";
  writeProject("demo", { areas });
  expect(() => loadProject(root, "demo")).toThrow(/instanceId/);
});
it("preserves legacy shared automation while honoring explicit independent coding pickup", () => {
  const areas = structuredClone(AREAS) as {
    areas: { core: Record<string, unknown> };
  };
  writeProject("demo", { areas });
  expect(codingPickupEnabled(loadProject(root, "demo").areas[0]!)).toBe(true);
  areas.areas.core.codingEnabled = false;
  writeProject("demo", { areas });
  expect(loadProject(root, "demo").areas[0]!.enabled).toBe(true);
  expect(codingPickupEnabled(loadProject(root, "demo").areas[0]!)).toBe(false);
  areas.areas.core.enabled = false;
  areas.areas.core.codingEnabled = true;
  writeProject("demo", { areas });
  expect(codingPickupEnabled(loadProject(root, "demo").areas[0]!)).toBe(true);
  areas.areas.core.codingEnabled = "yes";
  writeProject("demo", { areas });
  expect(() => loadProject(root, "demo")).toThrow(/codingEnabled/);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const errorOf = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected a ConfigError");
};

describe("loadHub", () => {
  it("loads hub.json", () => {
    const hub = loadHub(root);
    expect(hub.hubRepo).toBe("owner/pm-hub");
    expect(hub.runners).toEqual({ mode: "self-hosted", label: "pm" });
    expect(hub.gce.spot).toBe(false);
  });

  it("rejects an unknown runner mode", () => {
    writeFileSync(
      join(root, "hub.json"),
      JSON.stringify({ ...HUB, runners: { mode: "aws", label: "pm" } }),
    );
    const err = errorOf(() => loadHub(root));
    expect(err.message).toContain(
      '"mode" must be "local", "self-hosted" or "gce"',
    );
  });
});

describe("loadProject", () => {
  it("loads a repository-only project with one base branch and no hosting or database", () => {
    const project = structuredClone(PROJECT);
    delete project.vercel;
    delete project.branches;
    delete project.database;
    project.workflow = { kind: "pull-request", baseBranch: "develop" };
    project.verification = { mode: "repository" };
    writeProject("library", { project });
    const loaded = loadProject(root, "library").config;
    expect(loaded.vercel).toBeUndefined();
    expect(loaded.database).toBe("none");
    expect(loaded.branches).toEqual({
      production: "develop",
      staging: "develop",
      integration: "develop",
    });
  });
  it("loads a valid project with derived fields", () => {
    writeProject("game");
    const p = loadProject(root, "game");
    expect(p.config.name).toBe("game");
    expect(p.config.repo).toBe("owner/game");
    expect(p.config.branches.integration).toBe("pm-staging");
    expect(p.areas).toHaveLength(1);
    expect(p.areas[0]).toMatchObject({
      key: "core",
      label: "pm:core",
      memoryBranch: "pm/game/core",
      wipLimit: 2,
    });
    expect(p.tiers.hubOwnerOnly).toEqual([".github/"]);
    expect(p.dir).toBe(join(root, "projects", "game"));
  });

  it("raises ConfigError for a missing file", () => {
    const err = errorOf(() => loadProject(root, "nope"));
    expect(err.file).toContain(join("projects", "nope", "project.json"));
    expect(err.message).toMatch(/missing$/);
  });

  it("raises ConfigError for invalid JSON", () => {
    writeProject("game", {}, { project: "{ not json" });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain("invalid JSON");
  });

  it("raises ConfigError when an area label is not pm:<key>", () => {
    const areas = structuredClone(AREAS) as { areas: Record<string, Json> };
    areas.areas.core!.label = "pm:other";
    writeProject("game", { areas });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.file).toContain("areas.json");
    expect(err.message).toContain('label must be "pm:core"');
  });

  it("raises ConfigError when a secret VALUE is pasted instead of its name", () => {
    const project = structuredClone(PROJECT);
    project.slackWebhookSecret = "https://hooks.slack.com/services/T0/B0/x";
    writeProject("game", { project });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain(
      "must be a SECRET NAME like SLACK_WEBHOOK_GAME",
    );
  });

  it("raises ConfigError when a bypass secret VALUE is pasted", () => {
    const project = structuredClone(PROJECT) as { vercel: Json };
    project.vercel.bypassSecret = "abcd1234secret";
    writeProject("game", { project });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain('"bypassSecret" must be a SECRET NAME');
  });

  it("raises ConfigError when two branches are the same", () => {
    const project = structuredClone(PROJECT) as { branches: Json };
    project.branches.integration = "staging";
    writeProject("game", { project });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain("branches must differ");
  });

  it("raises ConfigError for a cron that is not 5 fields", () => {
    const areas = structuredClone(AREAS) as { areas: Record<string, Json> };
    areas.areas.core!.schedule = "0 13 * *";
    writeProject("game", { areas });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain('"schedule" must be a 5-field cron');
  });

  it("keeps a project valid after its last PM is removed", () => {
    writeProject("game", { areas: { areas: {} } });
    expect(loadProject(root, "game").areas).toEqual([]);
  });

  it("raises ConfigError for a repo that is not owner/name", () => {
    writeProject("game", { project: { ...PROJECT, repo: "just-a-name" } });
    const err = errorOf(() => loadProject(root, "game"));
    expect(err.message).toContain('"repo" must be "owner/name"');
  });
});

describe("listProjectNames / loadAllProjects", () => {
  it("lists project directories, skipping _templates, sorted", () => {
    writeProject("zeta");
    writeProject("alpha");
    mkdirSync(join(root, "projects", "_templates"));
    expect(listProjectNames(root)).toEqual(["alpha", "zeta"]);
    expect(loadAllProjects(root).map((p) => p.config.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("returns [] when projects/ does not exist", () => {
    expect(listProjectNames(join(root, "elsewhere"))).toEqual([]);
  });
});

describe("matchesPrefix", () => {
  it("matches a plain prefix", () => {
    expect(matchesPrefix("app/api/auth/route.ts", ["app/api/auth"])).toBe(true);
    expect(matchesPrefix("app/api/other.ts", ["app/api/auth"])).toBe(false);
  });

  it("matches a * fragment anywhere in the path", () => {
    expect(matchesPrefix("lib/billing/invoice.ts", ["*billing*"])).toBe(true);
    expect(matchesPrefix("app/stripe-webhook.ts", ["*stripe*"])).toBe(true);
    expect(matchesPrefix("app/page.tsx", ["*billing*", "*stripe*"])).toBe(
      false,
    );
  });

  it("escapes regex characters in a * pattern", () => {
    expect(matchesPrefix("middleware.ts", ["*.ts"])).toBe(true);
    expect(matchesPrefix("middlewarexts", ["*.ts"])).toBe(false);
  });

  it("is false with no prefixes", () => {
    expect(matchesPrefix("anything", [])).toBe(false);
  });
});
