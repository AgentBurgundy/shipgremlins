import { describe, expect, it } from "vitest";
import {
  inspectTestAccess,
  parseTestAccess,
  parsePasswordRecipe,
  parseIdentityAssertions,
  type TestAccess,
} from "./testAccess.ts";

const password: TestAccess = {
  kind: "password",
  loginPath: "/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "button[type=submit]",
  successSelector: "[data-testid=account-menu]",
  accounts: [
    {
      name: "Member",
      usernameSecret: "TEST_EMAIL",
      passwordSecret: "TEST_PASSWORD",
    },
  ],
};

describe("explicit browser test access", () => {
  it("requires a choice even when hosting and unrelated credentials are saved", () => {
    expect(
      inspectTestAccess(undefined, {
        VERCEL_TOKEN: "hosting-secret",
        TEST_PASSWORD: "unselected-secret",
      }),
    ).toMatchObject({ ready: false });
    expect(inspectTestAccess(undefined, {}).message).toContain(
      "Connecting hosting opens the preview but does not sign in",
    );
  });

  it("permits consciously selected public coverage and states its limits", () => {
    expect(inspectTestAccess({ kind: "public" }, {})).toEqual({
      ready: true,
      message:
        "Public-only testing is selected. Signed-in journeys will remain untested.",
    });
  });

  it.each([
    {},
    { TEST_EMAIL: "private-user" },
    { TEST_PASSWORD: "private-password" },
    { TEST_EMAIL: "private-user", TEST_PASSWORD: "invalid\npassword" },
  ])("requires usable saved values for every named account: %j", (saved) => {
    const result = inspectTestAccess(password, saved);
    expect(result.ready).toBe(false);
    expect(result.message).toContain("Connections");
    expect(result.message).not.toContain("private-user");
    expect(result.message).not.toContain("private-password");
  });

  it("distinguishes configured credentials from verified sign-in", () => {
    expect(
      inspectTestAccess(password, {
        TEST_EMAIL: "private-user",
        TEST_PASSWORD: "private-password",
      }),
    ).toEqual({
      ready: true,
      message:
        "Test-account credentials are saved. Test access checks whether sign-in actually works.",
    });
  });

  it("preserves an existing OTP recipe while requiring its referenced secret", () => {
    expect(inspectTestAccess(undefined, {}, "TEST_DATABASE").ready).toBe(false);
    expect(
      inspectTestAccess(
        undefined,
        { TEST_DATABASE: "private-database-url" },
        "TEST_DATABASE",
      ),
    ).toEqual({
      ready: true,
      message: "The existing sign-in recipe and its credential are saved.",
    });
  });
});

describe("bounded login recipes", () => {
  const recipe = {
    loginPath: "/",
    usernameSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: "#account",
    authenticatedPath: "/account",
  };
  const steps = [
    { kind: "click", selector: "#open-login" },
    { kind: "fill", selector: "#email", credential: "username" },
    { kind: "click", selector: "#next" },
    { kind: "fill", selector: "#password", credential: "password" },
    { kind: "click", selector: "#submit" },
  ];
  it("preserves a modal and two-step recipe, stable identity and protected assertions", () => {
    const account = {
      id: "f3077381-1dca-4bc6-9949-c5c3a900959b",
      name: "Member",
      usernameSecret: "TEST_USER",
      passwordSecret: "TEST_PASS",
      assertions: [
        { kind: "principal", selector: "#user-email" },
        { kind: "tenant", selector: "#tenant", equals: "Sandbox" },
      ],
    };
    expect(
      parseTestAccess({
        kind: "password",
        ...recipe,
        steps,
        accounts: [account],
      }),
    ).toEqual({ kind: "password", ...recipe, steps, accounts: [account] });
  });
  it.each(
    [
      [{ kind: "navigate", path: "https://external.invalid/" }, ...steps],
      [...steps, { kind: "navigate", path: "/other" }],
      steps.slice(0, -1),
      [...steps, { kind: "fill", selector: "#again", credential: "password" }],
      [...steps, { kind: "evaluate", script: "not allowed" }],
      [...steps, { kind: "wait", selector: "#account", state: "attached" }],
    ].map((invalidSteps) => ({ invalidSteps })),
  )(
    "rejects unsupported, ambiguous or unbounded actions",
    ({ invalidSteps }) => {
      expect(() =>
        parsePasswordRecipe({ ...recipe, steps: invalidSteps }),
      ).toThrow();
    },
  );
  it.each([
    "//external.invalid/",
    "/%2fexternal.invalid/",
    "/%5cexternal.invalid/",
    "/login?next=external",
    "/login#fragment",
  ])("rejects unsafe same-origin path %s", (loginPath) => {
    expect(() => parsePasswordRecipe({ ...recipe, loginPath })).toThrow();
  });
  it("does not accept arbitrary code or weakening principal comparisons", () => {
    expect(() =>
      parseIdentityAssertions([
        { kind: "principal", selector: "#user", equals: "anyone" },
      ]),
    ).toThrow();
    expect(() =>
      parseIdentityAssertions([
        { kind: "tenant", selector: "#tenant", equals: "" },
      ]),
    ).toThrow();
  });
});
