import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ENVIRONMENT_PROBE } from "./environmentProbe.ts";
import {
  environmentChecks,
  environmentDiagnosis,
} from "./environmentDiagnosis.ts";

async function probe(
  options: {
    access?: boolean;
    vercel?: boolean;
    status?: number;
    redirect?: string;
    network?: boolean;
    fetchFailure?: boolean;
    telemetry?: boolean;
    field?: string;
    count?: number;
    rejected?: boolean;
    invalidCredentials?: boolean;
    invalidOrigin?: boolean;
    rejectionMessage?: string;
    brandedWall?: boolean;
    passwordTransition?: "delayed" | "stuck" | "redirect";
    confirmationAfterClose?: "missing" | "hidden" | "ambiguous";
  } = {},
) {
  let output = "",
    currentUrl = "",
    submitted = false;
  let formClosed = false;
  const hiddenWaits: Array<{ state: string; timeout?: number }> = [];
  let onBlocked: (
    destination: string,
    navigation: boolean,
    mainFrame: boolean,
  ) => void;
  let onResponse: (response: unknown) => void;
  const requestLog: Array<{ url: string }> = [];
  const installBrowserAccess = vi.fn(
    async (_page: unknown, input: { onBlocked: typeof onBlocked }) => {
      onBlocked = input.onBlocked;
    },
  );
  async function request(url: string, method = "GET") {
    if (new URL(url).origin !== "https://app.test") {
      onBlocked(url, method === "GET", true);
      throw Error("blocked request");
    }
    requestLog.push({ url });
    const response = {
      status: () =>
        method === "POST" && options.rejected
          ? 401
          : options.redirect
            ? 307
            : (options.status ?? 200),
      headers: () => (options.redirect ? { location: options.redirect } : {}),
      request: () => ({ url: () => url, method: () => method }),
    };
    if (options.redirect) {
      onBlocked(options.redirect, true, true);
      throw Error("blocked redirect");
    }
    if (options.fetchFailure || options.network)
      throw Error("private password https://secret.test/?token=secret");
    onResponse(response);
    return response;
  }
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url: string) {
      currentUrl = url;
      const response = await request(url);
      if (options.telemetry)
        await request("https://analytics.test/collect", "POST").catch(() => {});
      return response;
    },
    on: (_event: string, handler: typeof onResponse) => {
      onResponse = handler;
    },
    url: () => currentUrl,
    locator(selector: string) {
      const fails = selector === options.field;
      return {
        waitFor: async (wait: { state: string; timeout?: number }) => {
          if (fails) throw Error("private selector");
          if (selector === "#password" && wait.state === "hidden") {
            hiddenWaits.push(wait);
            if (options.passwordTransition === "stuck")
              throw Error("private password form remained visible");
            if (options.passwordTransition === "redirect") {
              onBlocked("https://external.test/login", true, true);
              throw Error("private blocked destination");
            }
            formClosed = true;
          }
        },
        count: async () =>
          fails
            ? (options.count ?? 0)
            : selector === "#home" && formClosed
              ? options.confirmationAfterClose === "missing"
                ? 0
                : options.confirmationAfterClose === "ambiguous"
                  ? 2
                  : 1
              : 1,
        fill: async () => {},
        click: async () => {
          submitted = true;
          if (options.rejected) await request("https://app.test/auth", "POST");
        },
        isVisible: async () =>
          selector === "#home"
            ? !(formClosed && options.confirmationAfterClose === "hidden")
            : !submitted || (!!options.passwordTransition && !formClosed),
      };
    },
    evaluate: vi.fn(async (callback: (...args: never[]) => unknown) => {
      const code = callback.toString();
      if (code.includes("document.title")) return options.brandedWall === true;
      if (code.includes("aria-live"))
        return runInNewContext(`(${code})()`, {
          document: {
            querySelectorAll: () => [
              {
                getClientRects: () => [{}],
                textContent:
                  options.rejectionMessage ??
                  (options.invalidOrigin
                    ? "Invalid origin"
                    : options.invalidCredentials
                      ? "Invalid email or password."
                      : "Something went wrong: private-user"),
              },
            ],
          },
          getComputedStyle: () => ({ visibility: "visible" }),
        });
      return undefined;
    }),
    screenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  };
  const close = vi.fn(async () => {});
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {},
    }),
    close,
  };
  const input = {
    url: "https://app.test",
    bypass: "private-bypass",
    vercel: options.vercel,
    ...(options.access
      ? {
          access: {
            loginPath: "/login",
            usernameSelector: "#email",
            passwordSelector: "#password",
            submitSelector: "button",
            successSelector: "#home",
            accounts: [
              { username: "private-user", password: "private-password" },
            ],
          },
        }
      : {}),
  };
  const process = {
    stdin: (async function* () {
      yield JSON.stringify(input);
    })(),
    stdout: {
      write(value: string) {
        output += value;
      },
    },
    exitCode: 0,
  };
  await runInNewContext(ENVIRONMENT_PROBE, {
    require: (path: string) => {
      if (path === "/opt/gremlins/browser-access.mjs")
        return { installBrowserAccess };
      if (path === "/opt/gremlins/node_modules/playwright")
        return { chromium: { launch: async () => browser } };
      throw Error("Unexpected probe module");
    },
    process,
    URL,
    Buffer,
  });
  expect(close).toHaveBeenCalledOnce();
  expect(installBrowserAccess).toHaveBeenCalledWith(
    page,
    expect.objectContaining({
      url: "https://app.test",
      bypass: "private-bypass",
      restrictLogin: true,
      onBlocked: expect.any(Function),
    }),
  );
  expect(output).not.toContain("private-");
  expect(output).not.toContain("token=");
  return {
    result: JSON.parse(output),
    requestLog,
    exitCode: process.exitCode,
    hiddenWaits,
  };
}

describe("environment browser probe", () => {
  it("executes every login stage and emits bounded, recognizable checks", async () => {
    const { result, requestLog } = await probe({ access: true });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check: { name: string }) => check.name)).toEqual([
      "Browser opens application",
      "Test account 1: login page opens",
      "Test account 1: username field",
      "Test account 1: password field",
      "Test account 1: submit control",
      "Test account 1: signed-in confirmation",
      "Test account 1 signs in",
    ]);
    expect(environmentChecks(result.checks)).toEqual(result.checks);
    expect(requestLog.map((request) => request.url)).toEqual([
      "https://app.test",
      "https://app.test/login",
    ]);
  });
  it("waits for a closing login form after the signed-in marker appears", async () => {
    const { result, hiddenWaits } = await probe({
      access: true,
      passwordTransition: "delayed",
    });
    expect(result.ok).toBe(true);
    expect(hiddenWaits).toEqual([{ state: "hidden", timeout: 15000 }]);
    expect(result.checks.at(-1)).toEqual({
      name: "Test account 1 signs in",
      passed: true,
    });
  });
  it("still rejects a form that never closes after the bounded wait", async () => {
    const { result, hiddenWaits } = await probe({
      access: true,
      passwordTransition: "stuck",
    });
    expect(result.ok).toBe(false);
    expect(hiddenWaits).toEqual([{ state: "hidden", timeout: 15000 }]);
    expect(result.diagnosis.code).toBe("login_incomplete");
    expect(result.checks.at(-1).passed).toBe(false);
  });
  it.each([
    ["missing", "success_not_found"],
    ["hidden", "success_not_visible"],
    ["ambiguous", "selector_ambiguous"],
  ] as const)(
    "does not accept a confirmation that becomes %s while the form closes",
    async (confirmationAfterClose, code) => {
      const { result } = await probe({
        access: true,
        passwordTransition: "delayed",
        confirmationAfterClose,
      });
      expect(result.ok).toBe(false);
      expect(result.diagnosis.code).toBe(code);
      expect(result.checks.at(-1).passed).toBe(false);
    },
  );
  it("preserves a blocked sign-in redirect diagnosis during the transition", async () => {
    const { result } = await probe({
      access: true,
      passwordTransition: "redirect",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnosis.code).toBe("login_external_redirect");
    expect(result.checks.at(-1).passed).toBe(false);
  });
  it.each([
    ["#email", 0, "selector_not_found", "usernameSelector", 2],
    ["#password", 3, "selector_ambiguous", "passwordSelector", 3],
    ["button", 1, "selector_unusable", "submitSelector", 4],
    ["#home", 0, "success_not_found", "successSelector", 5],
    ["#home", 1, "success_not_visible", "successSelector", 5],
  ])(
    "preserves completed checks when %s has %s matches",
    async (field, count, code, name, passed) => {
      const { result } = await probe({ access: true, field, count });
      expect(result.diagnosis).toEqual({
        code,
        field: name,
        matchCount: count,
      });
      expect(
        result.checks.filter((check: { passed: boolean }) => check.passed),
      ).toHaveLength(passed);
      expect(result.checks.at(-1).passed).toBe(false);
      expect(environmentDiagnosis(result.diagnosis)).toMatchObject({ code });
    },
  );
  it("does not label ordinary app authorization failures as Vercel protection", async () => {
    expect(
      (await probe({ status: 401, vercel: true })).result.diagnosis.code,
    ).toBe("application_http_error");
    expect(
      (await probe({ status: 403, vercel: false, brandedWall: true })).result
        .diagnosis.code,
    ).toBe("application_http_error");
    expect(
      (await probe({ status: 401, vercel: true, brandedWall: true })).result
        .diagnosis.code,
    ).toBe("vercel_protection");
  });
  it("recognizes a trusted protection redirect without following it or forwarding credentials", async () => {
    const { result, requestLog } = await probe({
      vercel: true,
      redirect: "https://vercel.com/sso-api?token=secret",
    });
    expect(result.diagnosis.code).toBe("vercel_protection");
    expect(requestLog.map((request) => request.url)).toEqual([
      "https://app.test",
    ]);
    expect(
      (
        await probe({
          vercel: true,
          redirect: "https://vercel.com.attacker.test/login",
        })
      ).result.diagnosis.code,
    ).toBe("external_redirect");
  });
  it("only identifies invalid credentials when the app rejection and explicit page evidence agree", async () => {
    expect(
      (
        await probe({
          access: true,
          field: "#home",
          rejected: true,
          invalidCredentials: true,
        })
      ).result.diagnosis.code,
    ).toBe("login_credentials_rejected");
    expect(
      (await probe({ access: true, field: "#home", rejected: true })).result
        .diagnosis.code,
    ).toBe("login_rejected");
    expect(
      (await probe({ access: true, field: "#home", invalidCredentials: true }))
        .result.diagnosis.code,
    ).toBe("success_not_found");
  });
  it("identifies a rejected preview origin separately from incorrect credentials", async () => {
    const { result } = await probe({
      access: true,
      field: "#home",
      rejected: true,
      invalidOrigin: true,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnosis).toEqual({
      code: "login_origin_rejected",
      origin: "https://app.test",
    });
    expect(environmentDiagnosis(result.diagnosis)).toMatchObject({
      action: "edit_login",
      origin: "https://app.test",
    });
    expect(
      (await probe({ access: true, field: "#home", invalidOrigin: true }))
        .result.diagnosis.code,
    ).toBe("success_not_found");
    expect(
      (
        await probe({
          access: true,
          field: "#home",
          rejected: true,
          rejectionMessage: "Invalid origin: private-user token=secret",
        })
      ).result.diagnosis.code,
    ).toBe("login_rejected");
  });
  it("returns a fixed network diagnosis without raw exception details", async () => {
    const { result, exitCode } = await probe({ network: true });
    expect(result.diagnosis.code).toBe("environment_unreachable");
    expect(result.checks).toEqual([
      { name: "Browser opens application", passed: false },
    ]);
    expect(exitCode).toBe(1);
    const routed = await probe({ fetchFailure: true });
    expect(routed.result.diagnosis.code).toBe("environment_unreachable");
    expect(routed.result.checks).toEqual([
      { name: "Browser opens application", passed: false },
    ]);
  });
  it("blocks external telemetry writes without misdiagnosing a healthy app as a redirect", async () => {
    const { result, requestLog } = await probe({ telemetry: true });
    expect(result.ok).toBe(true);
    expect(requestLog.map((request) => request.url)).toEqual([
      "https://app.test",
    ]);
    expect(result.diagnosis).toBeUndefined();
  });
});

describe("safe environment diagnostics", () => {
  it("reconstructs explanation text and rejects unbounded or unknown evidence", () => {
    expect(
      environmentDiagnosis({
        code: "selector_ambiguous",
        field: "passwordSelector",
        matchCount: 2,
        title: "secret",
        detail: "secret",
        action: "retry",
      }),
    ).toMatchObject({ action: "edit_login", matchCount: 2 });
    expect(
      JSON.stringify(
        environmentDiagnosis({
          code: "environment_unreachable",
          detail: "secret",
        }),
      ),
    ).not.toContain("secret");
    for (const diagnosis of [
      { code: "secret" },
      { code: "selector_ambiguous", field: "passwordSelector", matchCount: 1 },
      { code: "selector_not_found", field: "secret", matchCount: 0 },
      {
        code: "selector_ambiguous",
        field: "passwordSelector",
        matchCount: 10001,
      },
      { code: "vercel_protection", matchCount: 1 },
      { code: "login_origin_rejected", origin: "https://user:secret@app.test" },
      {
        code: "login_origin_rejected",
        origin: "https://app.test?token=secret",
      },
      { code: "login_origin_rejected", origin: "https://app.test/path" },
      { code: "login_origin_rejected", origin: "javascript:secret" },
      { code: "login_rejected", origin: "https://app.test" },
    ])
      expect(environmentDiagnosis(diagnosis)).toBeUndefined();
    expect(
      environmentChecks([{ name: "secret", passed: false }]),
    ).toBeUndefined();
    expect(
      environmentChecks(
        Array.from({ length: 65 }, () => ({
          name: "Browser opens application",
          passed: true,
        })),
      ),
    ).toBeUndefined();
  });
});
