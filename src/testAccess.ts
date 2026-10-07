/** Declarative browser login for isolated test accounts. Values are secret references. */
export type TestAccess =
  | { kind: "public" }
  | {
      kind: "password";
      loginPath: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      successSelector: string;
      accounts: Array<{
        name: string;
        usernameSecret: string;
        passwordSecret: string;
      }>;
    };

const forbidden =
  /^(?:SHIPGREMLINS_|NODE_|LD_|DYLD_|GREMLINS_|PATH$|HOME$|APP_PRIVATE_KEY$|GITHUB_TOKEN$|GITLAB_TOKEN$|LINEAR_API_KEY$|VERCEL_TOKEN$|RAILWAY_TOKEN$|GCP_SERVICE_ACCOUNT_JSON$|CLAUDE_CODE_OAUTH_TOKEN$|ANTHROPIC_API_KEY$)/;
export function validTestSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(value) &&
    !forbidden.test(value)
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
export function parseTestAccess(value: unknown): TestAccess | undefined {
  if (value === undefined) return undefined;
  const invalid = () =>
    new Error(
      "Test access needs a public app or a password login recipe with named test-account secret references.",
    );
  if (!object(value)) throw invalid();
  if (value.kind === "public" && Object.keys(value).length === 1)
    return { kind: "public" };
  if (
    value.kind !== "password" ||
    Object.keys(value).some(
      (key) =>
        ![
          "kind",
          "loginPath",
          "usernameSelector",
          "passwordSelector",
          "submitSelector",
          "successSelector",
          "accounts",
        ].includes(key),
    )
  )
    throw invalid();
  if (
    !text(value.loginPath, 500) ||
    !value.loginPath.startsWith("/") ||
    value.loginPath.startsWith("//") ||
    /[\\?#]/.test(value.loginPath)
  )
    throw invalid();
  const selectors = [
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successSelector",
  ] as const;
  for (const key of selectors) if (!text(value[key], 500)) throw invalid();
  if (
    !Array.isArray(value.accounts) ||
    !value.accounts.length ||
    value.accounts.length > 8
  )
    throw invalid();
  const names = new Set<string>();
  const accounts = value.accounts.map((item) => {
    if (
      !object(item) ||
      Object.keys(item).some(
        (key) => !["name", "usernameSecret", "passwordSecret"].includes(key),
      ) ||
      !text(item.name, 80) ||
      !validTestSecret(item.usernameSecret) ||
      !validTestSecret(item.passwordSecret) ||
      item.usernameSecret === item.passwordSecret ||
      names.has(item.name.toLowerCase())
    )
      throw invalid();
    names.add(item.name.toLowerCase());
    return {
      name: item.name,
      usernameSecret: item.usernameSecret,
      passwordSecret: item.passwordSecret,
    };
  });
  return {
    kind: "password",
    loginPath: value.loginPath,
    usernameSelector: value.usernameSelector as string,
    passwordSelector: value.passwordSelector as string,
    submitSelector: value.submitSelector as string,
    successSelector: value.successSelector as string,
    accounts,
  };
}
export function testAccessSecretNames(
  access: TestAccess | undefined,
): string[] {
  return access?.kind === "password"
    ? [
        ...new Set(
          access.accounts.flatMap((account) => [
            account.usernameSecret,
            account.passwordSecret,
          ]),
        ),
      ]
    : [];
}

export function resolveTestAccess(
  access: TestAccess | undefined,
  saved: Record<string, string | undefined>,
) {
  if (!access || access.kind === "public") return undefined;
  return {
    ...access,
    accounts: access.accounts.map((account) => {
      const username = saved[account.usernameSecret],
        password = saved[account.passwordSecret];
      if (
        !username ||
        !password ||
        username.length > 4096 ||
        password.length > 16384 ||
        /[\0\r\n]/.test(username + password)
      )
        throw new Error(
          "Save the selected test-account username and password in Connections, then retry.",
        );
      return { name: account.name, username, password };
    }),
  };
}

/** A saved hosting connection does not establish how to sign in to the app. */
export function inspectTestAccess(
  access: TestAccess | undefined,
  saved: Record<string, string | undefined>,
  legacyDatabaseSecret?: string,
): { ready: boolean; message: string } {
  if (access?.kind === "public")
    return {
      ready: true,
      message:
        "Public-only testing is selected. Signed-in journeys will remain untested.",
    };
  if (access?.kind === "password") {
    try {
      resolveTestAccess(access, saved);
      return {
        ready: true,
        message:
          "Test-account credentials are saved. Test access checks whether sign-in actually works.",
      };
    } catch {
      return {
        ready: false,
        message:
          "Finish Test login in Environment: save the selected test-account username and password in Connections, then test sign-in before running a browser PM.",
      };
    }
  }
  if (legacyDatabaseSecret)
    return saved[legacyDatabaseSecret]?.trim()
      ? {
          ready: true,
          message: "The existing sign-in recipe and its credential are saved.",
        }
      : {
          ready: false,
          message:
            "Finish Test login in Environment: restore the saved credential for this app's existing sign-in recipe in Connections, then test access.",
        };
  return {
    ready: false,
    message:
      "Choose Test login in Environment before running a browser PM: add a dedicated test account, or explicitly choose public-only testing. Connecting hosting opens the preview but does not sign in to your app.",
  };
}
