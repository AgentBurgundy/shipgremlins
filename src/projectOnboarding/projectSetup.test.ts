import { describe, expect, it } from "vitest";
import { validateProjectSetup } from "./projectSetup.ts";
import type { RepositorySnapshot } from "./repository.ts";

const content =
  '<form id="login"><input id="email"><input id="password" type="password"><button id="submit">Sign in</button></form>\nconst path = "/login";\nif (user) render(<nav data-testid="account-menu" />);';
const evidence = [{ path: "src/login.tsx", quote: content }];
const snapshot: RepositorySnapshot = {
  repository: {
    provider: "github",
    repo: "org/app",
    branch: "pm-staging",
    sha: "a".repeat(40),
    filesRead: ["src/login.tsx"],
    truncated: false,
  },
  paths: ["src/login.tsx"],
  files: [{ path: "src/login.tsx", content }],
};
const firstPm = {
  name: "Journey",
  mandate: "Investigate sign-in and improve the account journey with evidence.",
  evidence,
};
const password = {
  loginPath: "/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "#submit",
  successSelector: '[data-testid="account-menu"]',
};
const proposal = () => ({
  commands: {},
  firstPm,
  suggestedPms: [
    firstPm,
    {
      ...firstPm,
      name: "Security",
      mandate:
        "Investigate account isolation and propose finite security improvements.",
    },
  ],
  appAccess: {
    kind: "password",
    summary: "The source defines a password form and signed-in account menu.",
    evidence,
    password,
  },
});

describe("source-grounded crew and login suggestions", () => {
  it("retains multiple distinct PM responsibilities and complete login hints without inventing test accounts", () => {
    const result = validateProjectSetup(proposal(), snapshot);
    expect(result.suggestedPms).toHaveLength(2);
    expect(result.appAccess?.password).toEqual(password);
    expect(result.appAccess).not.toHaveProperty("accounts");
  });
  it("accepts old single-PM reports and honest uncertainty without a login recipe", () => {
    expect(validateProjectSetup({ commands: {}, firstPm }, snapshot)).toEqual({
      commands: {},
      firstPm,
    });
    const value = {
      ...proposal(),
      appAccess: {
        kind: "unknown",
        summary: "Auth entrypoints were not included in this inspection.",
        evidence: [],
      },
    };
    expect(validateProjectSetup(value, snapshot).appAccess).not.toHaveProperty(
      "password",
    );
  });
  it.each(["email-code", "sso", "public"])(
    "keeps %s observations distinct from a password recipe",
    (kind) => {
      expect(
        validateProjectSetup(
          {
            ...proposal(),
            appAccess: {
              kind,
              summary:
                "Observed source behavior; still needs browser verification.",
              evidence,
            },
          },
          snapshot,
        ).appAccess?.kind,
      ).toBe(kind);
      expect(() =>
        validateProjectSetup(
          {
            ...proposal(),
            appAccess: { kind, summary: "Observed", evidence, password },
          },
          snapshot,
        ),
      ).toThrow();
    },
  );
  it.each([
    "https://evil.test/login",
    "//evil.test/login",
    "/login?token=secret",
    "/login#secret",
  ])("rejects off-app or credential-bearing login route %s", (loginPath) => {
    const value = proposal();
    value.appAccess.password = { ...password, loginPath };
    expect(() => validateProjectSetup(value, snapshot)).toThrow();
  });
  it("rejects ungrounded claims, duplicate crew names and generic success markers", () => {
    const value = proposal();
    value.suggestedPms[1] = { ...firstPm };
    expect(() => validateProjectSetup(value, snapshot)).toThrow();
    expect(() =>
      validateProjectSetup(
        { ...proposal(), appAccess: { ...proposal().appAccess, evidence: [] } },
        snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateProjectSetup(
        {
          ...proposal(),
          appAccess: {
            ...proposal().appAccess,
            evidence: [
              { path: "src/login.tsx", quote: "invented auth behavior" },
            ],
          },
        },
        snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateProjectSetup(
        {
          ...proposal(),
          appAccess: {
            ...proposal().appAccess,
            password: { ...password, successSelector: "body" },
          },
        },
        snapshot,
      ),
    ).toThrow();
  });
});
