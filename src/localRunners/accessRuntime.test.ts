import { describe, expect, it, vi, afterEach } from "vitest";
import {
  AccessFailure,
  accessFailure,
  parsePrivateAccess,
} from "../../runner-local/access-executor.mjs";
import {
  validateManagedAccess,
  managedAccessRequest,
} from "../../runner-local/managed-access.mjs";
import { suggestLoginControlRepair } from "../../runner-local/access-repair.mjs";
import type { LoginStep } from "../../runner-local/access-schema.mjs";

const token = "a".repeat(64);
const input = () => ({
  version: 1,
  url: "https://preview.example.test",
  token,
  access: {
    kind: "password",
    loginPath: "/login",
    usernameSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: "#account",
    accounts: [
      {
        name: "Test account",
        username: "fixture@example.test",
        password: "fixture-private-password",
      },
    ],
  },
});
const connection = () => ({
  version: 1 as const,
  endpoint: "http://gremlins-auth-job-test:4719/mcp",
  token,
});
afterEach(() => vi.unstubAllGlobals());
describe("private browser runtime contract", () => {
  it("keeps the saved proof and non-auth steps when proposing one data-only control repair", async () => {
    const value = input();
    const steps: LoginStep[] = [
      { kind: "click", selector: "#open-login" },
      { kind: "fill", selector: "#email", credential: "username" },
      { kind: "fill", selector: "#password", credential: "password" },
      { kind: "click", selector: "#submit" },
      { kind: "wait", selector: "#account", state: "visible" },
    ];
    const access = { ...value.access, authenticatedPath: "/workspace", steps };
    const observed = {
      usernameSelector: "form input:nth-of-type(1)",
      passwordSelector: "form input:nth-of-type(2)",
      submitSelector: "form button",
    };
    const repaired = await suggestLoginControlRepair(
      { evaluate: async () => observed },
      access,
    );
    expect(repaired?.recipe.successSelector).toBe("#account");
    expect(repaired?.recipe.authenticatedPath).toBe("/workspace");
    expect(repaired?.recipe.steps?.[0]).toEqual(steps[0]);
    expect(repaired?.recipe.steps?.[4]).toEqual(steps[4]);
    expect(repaired?.recipe.steps?.[1]).toMatchObject({
      selector: observed.usernameSelector,
    });
    expect(repaired?.recipe.steps?.[3]).toMatchObject({
      selector: observed.submitSelector,
    });
    expect(access.usernameSelector).toBe("#email");
    expect(JSON.stringify(repaired)).not.toMatch(
      /fixture@example|fixture-private/,
    );
    expect(
      await suggestLoginControlRepair({ evaluate: async () => null }, access),
    ).toBeUndefined();
  });
  it("keeps public access explicit and accepts exactly one resolved password identity", () => {
    expect(parsePrivateAccess(input()).access?.accounts).toHaveLength(1);
    expect(
      parsePrivateAccess({ ...input(), access: undefined }).access,
    ).toBeUndefined();
    expect(
      parsePrivateAccess({ ...input(), access: { kind: "public" } }).access,
    ).toBeUndefined();
    const value = input();
    value.access.accounts.push(value.access.accounts[0]!);
    expect(() => parsePrivateAccess(value)).toThrow(AccessFailure);
  });
  it("does not accept code, off-origin navigation or unresolved credentials in a recipe", () => {
    for (const change of [
      { loginPath: "//other.example.test/login" },
      { steps: [{ kind: "evaluate", code: "process.env" }] },
      { steps: [{ kind: "navigate", path: "/\\other.example.test" }] },
    ]) {
      const value = input();
      Object.assign(value.access, change);
      expect(() => parsePrivateAccess(value)).toThrow(AccessFailure);
    }
    const value = input();
    Object.assign(value.access.accounts[0]!, {
      password: undefined,
      passwordSecret: "PASSWORD_REFERENCE",
    });
    expect(() => parsePrivateAccess(value)).toThrow(AccessFailure);
  });
  it("preserves supported credential lengths and rejects malformed input without echoing it", () => {
    const value = input();
    value.access.accounts[0]!.password = "p".repeat(16384);
    expect(
      parsePrivateAccess(value).access?.accounts[0]?.password,
    ).toHaveLength(16384);
    value.access.accounts[0]!.password += "p";
    expect(() => parsePrivateAccess(value)).toThrow("saved test-access recipe");
    const failure = accessFailure(
      new Error("PRIVATE_PASSWORD cookie=session_value"),
    );
    expect(failure.code).toBe("helper_unavailable");
    expect(JSON.stringify(failure)).not.toMatch(
      /PRIVATE_PASSWORD|session_value/,
    );
  });
  it("binds the agent to a private sibling gateway and no arbitrary endpoint", () => {
    expect(validateManagedAccess(connection()).endpoint).toContain(
      "gremlins-auth-job-test",
    );
    for (const endpoint of [
      "https://example.test/mcp",
      "http://127.0.0.1:4719/mcp",
      "http://gremlins-auth-job-test:9222/json",
      "http://gremlins-auth-job-test:4719/secret",
      "http://x:y@gremlins-auth-job-test:4719/mcp",
    ])
      expect(() =>
        validateManagedAccess({ ...connection(), endpoint }),
      ).toThrow(AccessFailure);
  });
  it("turns session expiry and transport exceptions into typed, redacted failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          failure: { code: "session_expired", message: "PRIVATE_SESSION" },
        }),
      }),
    );
    await expect(
      managedAccessRequest(connection(), "/verify"),
    ).rejects.toMatchObject({ code: "session_expired" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("PRIVATE_TOKEN")),
    );
    await expect(managedAccessRequest(connection())).rejects.toMatchObject({
      code: "helper_unavailable",
      message:
        "The private test-access browser is unavailable. Retry on a healthy runner.",
    });
  });
});
