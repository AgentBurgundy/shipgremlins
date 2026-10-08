import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSetup } from "./files.ts";
import {
  connectTestAccount,
  testAccountSetupState,
} from "./testAccountSetup.ts";
import { readEditableConfig } from "./configEditor.ts";
import { readConnections, saveConnections } from "./connections.ts";
import { loadProject } from "../config.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { testIdentityMetadata } from "../testAccess.ts";
import type { OnboardingState } from "../projectOnboarding/types.ts";

let root: string;
const path = "projects/app/project.json";
const recipe = {
  loginPath: "/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "#submit",
  successSelector: "#account",
};
const state = {
  revision: "a".repeat(64),
  recommendationsReviewable: true,
  stale: true,
  report: {
    projectSetup: {
      appAccess: {
        kind: "password",
        summary: "Source login",
        password: recipe,
      },
    },
  },
} as OnboardingState;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-test-account-")));
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
          role: "staging",
          url: "https://test.example.com/",
          access: { kind: "public" },
        },
      },
    },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = (account: unknown, extra: Record<string, unknown> = {}) => ({
  configurationRevision: readEditableConfig(root, path).revision,
  sourceRevision: state.revision,
  account,
  ...extra,
});
function access() {
  const target = effectiveVerification(loadProject(root, "app").config);
  if (target.mode !== "browser" || target.target.access?.kind !== "password")
    throw new Error("No access");
  return target.target.access;
}
function storedFiles() {
  try {
    return readdirSync(join(root, ".run/test-accounts"), {
      recursive: true,
    }).filter((file) => String(file).endsWith(".json"));
  } catch {
    return [];
  }
}
describe("managed test account setup", () => {
  it("activates private credentials with config, source hint survives unrelated staleness, response contains presence only", () => {
    connectTestAccount(
      root,
      "app",
      input({
        name: "Member",
        username: "member@example.test",
        password: ` private'"\`password `,
      }),
      state,
    );
    const account = access().accounts[0]!;
    expect(account.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(readConnections(root)[account.passwordSecret]).toBe(
      ` private'"\`password `,
    );
    expect(readFileSync(join(root, path), "utf8")).not.toContain("private'");
    const status = testAccountSetupState(root, "app", state);
    expect(status.testAccounts).toEqual([
      {
        id: account.id,
        index: 0,
        name: "Member",
        usernameSaved: true,
        passwordSaved: true,
      },
    ]);
    expect(status.testAccountSuggestion?.recipe).toEqual(recipe);
    expect(JSON.stringify(status)).not.toContain("member@example.test");
    expect(JSON.stringify(status)).not.toContain("private'");
  });
  it("rotates one credential atomically without reviving the old generation or replacing another identity", () => {
    connectTestAccount(
      root,
      "app",
      input({ name: "Member", username: "member", password: "original" }),
      state,
    );
    connectTestAccount(
      root,
      "app",
      input({ name: "Admin", username: "admin", password: "separate" }),
      state,
    );
    const before = access(),
      member = before.accounts[0]!,
      other = before.accounts[1]!;
    connectTestAccount(
      root,
      "app",
      input({
        id: member.id,
        name: "Member",
        username: "",
        password: "replacement",
      }),
      state,
    );
    const after = access();
    expect(after.accounts[0]?.id).toBe(member.id);
    expect(after.accounts[0]?.usernameSecret).toBe(member.usernameSecret);
    expect(after.accounts[1]).toEqual(other);
    expect(testIdentityMetadata(after, 0).generation).not.toBe(
      testIdentityMetadata(before, 0).generation,
    );
    const saved = readConnections(root);
    expect(saved[member.passwordSecret]).toBeUndefined();
    expect(saved[after.accounts[0]!.passwordSecret]).toBe("replacement");
    expect(saved[other.passwordSecret]).toBe("separate");
  });
  it("preserves legacy references and password when upgrading account metadata", () => {
    const raw = JSON.parse(readFileSync(join(root, path), "utf8"));
    raw.environments.test.access = {
      kind: "password",
      ...recipe,
      accounts: [
        {
          name: "Member",
          usernameSecret: "TEST_USER",
          passwordSecret: "TEST_PASS",
        },
      ],
    };
    writeFileSync(join(root, path), JSON.stringify(raw));
    saveConnections(root, {
      TEST_USER: "legacy",
      TEST_PASS: "legacy-password",
    });
    connectTestAccount(
      root,
      "app",
      input({ index: 0, name: "Member", username: "", password: "" }),
      state,
    );
    expect(access().accounts[0]).toMatchObject({
      usernameSecret: "TEST_USER",
      passwordSecret: "TEST_PASS",
    });
    expect(storedFiles()).toHaveLength(0);
  });
  it("rejects stale save and repeat submission before writing credentials", () => {
    const request = input({
      name: "Member",
      username: "user",
      password: "password",
    });
    connectTestAccount(root, "app", request, state);
    const count = storedFiles().length;
    expect(() => connectTestAccount(root, "app", request, state)).toThrow(
      /changed/,
    );
    expect(storedFiles()).toHaveLength(count);
  });
  it.each([
    { recipe: { ...recipe, loginPath: "//outside.test/login" } },
    { recipe: { ...recipe, loginPath: "/%2foutside.test" } },
    { recipe: { ...recipe, successSelector: "body" } },
    { recipe: { ...recipe, steps: [{ kind: "script", code: "invalid" }] } },
    { sourceRevision: "b".repeat(64) },
  ])(
    "rejects unsafe/invalid recipes without writing credentials: %j",
    (extra) => {
      expect(() =>
        connectTestAccount(
          root,
          "app",
          input(
            { name: "Member", username: "user", password: "password" },
            extra,
          ),
          state,
        ),
      ).toThrow();
      expect(storedFiles()).toHaveLength(0);
    },
  );
  it("removes only its staged generation if new metadata fails validation", () => {
    connectTestAccount(
      root,
      "app",
      input({ name: "Member", username: "user", password: "password" }),
      state,
    );
    const original = access(),
      count = storedFiles().length;
    expect(() =>
      connectTestAccount(
        root,
        "app",
        input({ name: "Member", username: "another", password: "another" }),
        state,
      ),
    ).toThrow(/distinct/);
    expect(storedFiles()).toHaveLength(count);
    expect(access()).toEqual(original);
  });
  it("does not expose stale source hints or activate them when the repo identity changes", () => {
    const changed = { ...state, recommendationsReviewable: false };
    expect(
      testAccountSetupState(root, "app", changed).testAccountSuggestion,
    ).toBeUndefined();
    expect(() =>
      connectTestAccount(
        root,
        "app",
        input({ name: "Member", username: "user", password: "password" }),
        changed,
      ),
    ).toThrow(/Investigate/);
  });
  it("rejects managed credentials copied into an unrelated project's configuration", () => {
    connectTestAccount(
      root,
      "app",
      input({ name: "Member", username: "user", password: "password" }),
      state,
    );
    initializeSetup(root, process.cwd(), {
      project: "other",
      repo: "owner/other",
      createInitialPm: false,
    });
    const otherPath = join(root, "projects/other/project.json"),
      other = JSON.parse(readFileSync(otherPath, "utf8"));
    other.environments = {
      test: {
        kind: "url",
        role: "staging",
        url: "https://test.example.com/",
        access: access(),
      },
    };
    other.verification = { mode: "browser", environment: "test" };
    writeFileSync(otherPath, JSON.stringify(other));
    expect(() => loadProject(root, "other")).toThrow(/different project/);
  });
  it("rejects mutating immutable managed values through global Connections", () => {
    connectTestAccount(
      root,
      "app",
      input({ name: "Member", username: "user", password: "password" }),
      state,
    );
    const ref = access().accounts[0]!.passwordSecret;
    expect(() => saveConnections(root, { [ref]: "bypass-rotation" })).toThrow(
      /Manage this account/,
    );
    expect(readConnections(root)[ref]).toBe("password");
  });
});
