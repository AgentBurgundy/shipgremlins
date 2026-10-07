import { describe, expect, it } from "vitest";
import { inspectTestAccess, type TestAccess } from "./testAccess.ts";

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
