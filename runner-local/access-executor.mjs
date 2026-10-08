import { browserOrigin, installBrowserAccess } from "./browser-access.mjs";
import { suggestLoginControlRepair } from "./access-repair.mjs";
import {
  parsePasswordRecipe,
  parseIdentityAssertions,
} from "./access-schema.mjs";

const messages = {
  invalid_access:
    "The saved test-access recipe is invalid. Review app access settings.",
  environment_unreachable:
    "The selected test app could not be opened from this runner.",
  external_redirect:
    "Sign-in left the selected app origin. This identity flow requires a supported SSO connection.",
  selector_unusable:
    "A saved sign-in step no longer matches one usable control. Review the login flow.",
  credentials_rejected:
    "The test app rejected the sign-in request. Check the test account and app origin settings.",
  authentication_unproven:
    "The saved signed-in confirmation did not prove access. Review the login flow.",
  public_confirmation:
    "The signed-in confirmation also appears while signed out. Choose a protected confirmation.",
  identity_mismatch:
    "The signed-in account or workspace did not match the saved identity assertions.",
  session_expired:
    "The prepared test session expired or signed out. Reconnect the test account and retry.",
  receiving_context_failed:
    "The PM browser did not receive the verified test session.",
  helper_unavailable:
    "The private test-access browser is unavailable. Retry on a healthy runner.",
};
export class AccessFailure extends Error {
  constructor(code) {
    super(messages[code] || messages.helper_unavailable);
    this.code = code in messages ? code : "helper_unavailable";
  }
}
export const accessFailure = (error) => ({
  code: error instanceof AccessFailure ? error.code : "helper_unavailable",
  message:
    error instanceof AccessFailure
      ? error.message
      : messages.helper_unavailable,
});

export function parsePrivateAccess(input) {
  try {
    if (!input || input.version !== 1) throw Error();
    const origin = browserOrigin(input.url);
    if (
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(input.token)
    )
      throw Error();
    if (
      input.controlToken !== undefined &&
      (typeof input.controlToken !== "string" ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(input.controlToken) ||
        input.controlToken === input.token)
    )
      throw Error();
    if (
      input.leaseTtlMs !== undefined &&
      (!input.controlToken ||
        !Number.isSafeInteger(input.leaseTtlMs) ||
        input.leaseTtlMs < 1000 ||
        input.leaseTtlMs > 120000)
    )
      throw Error();
    if (
      input.bypass !== undefined &&
      (typeof input.bypass !== "string" ||
        /[\r\n\0]/.test(input.bypass) ||
        input.bypass.length > 8192)
    )
      throw Error();
    if (input.access?.kind === "public" || !input.access)
      return { ...input, origin, access: undefined };
    if (input.access.kind !== "password" || input.access.accounts?.length !== 1)
      throw Error();
    const { kind, accounts, ...recipe } = input.access;
    const parsed = parsePasswordRecipe(recipe),
      account = accounts[0];
    for (const key of ["username", "password"])
      if (
        typeof account[key] !== "string" ||
        !account[key] ||
        account[key].length > (key === "username" ? 4096 : 16384) ||
        /[\r\n\0]/.test(account[key])
      )
        throw Error();
    if (
      typeof account.name !== "string" ||
      !account.name ||
      account.name.length > 200
    )
      throw Error();
    return {
      ...input,
      origin,
      access: {
        kind,
        ...parsed,
        accounts: [
          {
            ...account,
            assertions: parseIdentityAssertions(account.assertions),
          },
        ],
      },
    };
  } catch {
    throw new AccessFailure("invalid_access");
  }
}

export async function prepareAuthenticatedContext(browser, input) {
  let repair;
  try {
    return await prepareAttempt(browser, input, async (page) => {
      repair = await suggestLoginControlRepair(page, input.access).catch(
        () => undefined,
      );
    });
  } catch (error) {
    if (!repair || error.code !== "selector_unusable") throw error;
    // One retry, with a new cookie jar and unchanged proof/identity requirements.
    const prepared = await prepareAttempt(browser, {
      ...input,
      access: { ...input.access, ...repair.recipe },
    });
    prepared.repair = repair;
    prepared.checks.push({
      name: "Login controls adjusted and reverified",
      passed: true,
    });
    return prepared;
  }
}

async function prepareAttempt(browser, input, onUnusableLoginControl) {
  const checks = [],
    secrets = new Set(
      [
        input.bypass,
        input.access?.accounts[0].username,
        input.access?.accounts[0].password,
      ].filter(Boolean),
    );
  let blocked = false,
    rejected = false;
  const newContext = async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    return context;
  };
  const context = await newContext();
  try {
    const page = await context.newPage();
    const attach = async (target) => {
      target.setDefaultTimeout(12000);
      target.setDefaultNavigationTimeout(30000);
      await installBrowserAccess(target, {
        url: input.url,
        bypass: input.bypass || "",
        // Public fixtures share the same admitted navigation boundary. Their
        // synthetic session is not authority to explore another application.
        restrictLogin: true,
        onBlocked: (_url, navigation) => {
          if (navigation) blocked = true;
        },
      });
    };
    await attach(page);
    // An app-created popup must never acquire an unguarded page in this private context.
    // First-slice recipes deliberately support only same-tab, same-origin authentication.
    context.on("page", (opened) => {
      if (opened !== page) void opened.close().catch(() => {});
    });
    const checked = (name) => checks.push({ name, passed: true });
    const open = async (target, url, allowDenied = false) => {
      blocked = false;
      try {
        const response = await target.goto(url, {
          waitUntil: "domcontentloaded",
        });
        if (blocked || new URL(target.url()).origin !== input.origin)
          throw new AccessFailure("external_redirect");
        if (
          !response ||
          (response.status() >= 400 &&
            !(allowDenied && [401, 403].includes(response.status())))
        )
          throw new AccessFailure("environment_unreachable");
      } catch (error) {
        throw blocked
          ? new AccessFailure("external_redirect")
          : error instanceof AccessFailure
            ? error
            : new AccessFailure("environment_unreachable");
      }
    };
    const unique = async (target, selector) => {
      try {
        const locator = target.locator(selector);
        await locator.waitFor({ state: "visible" });
        if ((await locator.count()) !== 1) throw Error();
        return locator;
      } catch {
        throw new AccessFailure(
          blocked ? "external_redirect" : "selector_unusable",
        );
      }
    };
    const refreshSecrets = async () => {
      const collect = (value, depth = 0) => {
        if (typeof value !== "string" || !value) return;
        if (value.length > 65536 || secrets.size > 512)
          throw new AccessFailure("helper_unavailable");
        secrets.add(value);
        if (depth >= 6) return;
        try {
          const parsed = JSON.parse(value);
          const walk = (item, level) => {
            if (level > 6) return;
            if (typeof item === "string") collect(item, level);
            else if (item && typeof item === "object")
              for (const nested of Object.values(item)) walk(nested, level + 1);
          };
          if (parsed !== value) walk(parsed, depth + 1);
        } catch (error) {
          if (error instanceof AccessFailure) throw error;
        }
      };
      const state = await context.storageState();
      for (const cookie of state.cookies) collect(cookie.value);
      for (const origin of state.origins)
        for (const entry of origin.localStorage) collect(entry.value);
      // Session storage is never exported to the agent either.
      const entries = await page
        .evaluate(() => Object.values(sessionStorage))
        .catch(() => []);
      for (const value of entries) collect(value);
    };
    const assertIdentity = async () => {
      if (!input.access) return;
      try {
        await unique(page, input.access.successSelector);
        for (const assertion of input.access.accounts[0].assertions || []) {
          const locator = await unique(page, assertion.selector);
          if (
            (await locator.innerText()).trim() !==
            (assertion.kind === "principal"
              ? input.access.accounts[0].username
              : assertion.equals)
          )
            throw new AccessFailure("identity_mismatch");
        }
      } catch (error) {
        throw error.code === "identity_mismatch"
          ? error
          : new AccessFailure("authentication_unproven");
      }
    };
    await open(page, input.url);
    checked("Browser opens application");
    let protectedUrl = input.url;
    if (input.access) {
      const access = input.access,
        account = access.accounts[0];
      await open(page, new URL(access.loginPath, input.url).href);
      checked("Login page opens");
      let submitted = false,
        credentialsFilled = false;
      page.on("request", (request) => {
        // Treat credential-triggered background submissions conservatively too:
        // no fresh-context retry once a credential-bearing interaction may have
        // reached the app, even if it has not returned a rejection yet.
        if (
          credentialsFilled &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method())
        )
          submitted = true;
      });
      page.on("response", (response) => {
        const request = response.request();
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
          [400, 401, 403].includes(response.status())
        )
          rejected = true;
      });
      const steps = access.steps || [
        {
          kind: "fill",
          selector: access.usernameSelector,
          credential: "username",
        },
        {
          kind: "fill",
          selector: access.passwordSelector,
          credential: "password",
        },
        { kind: "click", selector: access.submitSelector },
      ];
      const passwordIndex = steps.findIndex(
        (step) => step.kind === "fill" && step.credential === "password",
      );
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        try {
          if (step.kind === "navigate")
            await open(page, new URL(step.path, input.url).href);
          else if (step.kind === "wait")
            await page.locator(step.selector).waitFor({ state: step.state });
          else {
            const locator = await unique(page, step.selector);
            if (step.kind === "fill") {
              credentialsFilled = true;
              await locator.fill(account[step.credential]);
            }
            if (step.kind === "click") {
              if (index > passwordIndex) submitted = true;
              await locator.click();
            }
            if (step.kind === "select") await locator.selectOption(step.value);
          }
          if (blocked) throw new AccessFailure("external_redirect");
        } catch (error) {
          if (
            !blocked &&
            !rejected &&
            !submitted &&
            (step.kind === "fill" ||
              (step.kind === "click" &&
                index > passwordIndex &&
                step.selector === access.submitSelector)) &&
            (!(error instanceof AccessFailure) ||
              error.code === "selector_unusable")
          )
            await onUnusableLoginControl?.(page);
          throw error instanceof AccessFailure
            ? error
            : new AccessFailure(
                blocked ? "external_redirect" : "selector_unusable",
              );
        }
        checked(`Sign-in step ${index + 1}`);
      }
      try {
        await assertIdentity();
      } catch (error) {
        throw rejected ? new AccessFailure("credentials_rejected") : error;
      }
      protectedUrl = access.authenticatedPath
        ? new URL(access.authenticatedPath, input.url).href
        : page.url();
      if (new URL(protectedUrl).origin !== input.origin)
        throw new AccessFailure("external_redirect");
      // Repeat the protected route in a genuinely signed-out context. A public marker
      // cannot certify authentication, even if it became visible after clicking Submit.
      const negative = await newContext();
      try {
        const signedOut = await negative.newPage();
        await attach(signedOut);
        await open(signedOut, protectedUrl, true);
        const marker = signedOut.locator(access.successSelector);
        // Observe hydration for the same bounded wait used to find a signed-in marker.
        if (
          await marker.waitFor({ state: "visible", timeout: 12000 }).then(
            () => true,
            () => false,
          )
        )
          throw new AccessFailure("public_confirmation");
        checked("Signed-out context cannot see the protected confirmation");
      } finally {
        await negative.close();
      }
      await open(page, protectedUrl);
      await assertIdentity();
      checked("Protected route opens with the expected test identity");
    }
    await refreshSecrets();
    const redact = (value) => {
      let text = String(value);
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        for (const variant of new Set([
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]))
          if (variant) {
            if (variant.length < 8) {
              const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              text = text.replace(
                new RegExp(
                  `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
                  "gu",
                ),
                "[private]",
              );
            } else text = text.split(variant).join("[private]");
          }
      }
      return text;
    };
    const screenshot = async ({ fullPage = false } = {}) => {
      await refreshSecrets();
      const mask = [page.locator("input,textarea,[contenteditable=true]")];
      for (const secret of secrets)
        mask.push(page.getByText(secret, { exact: secret.length < 8 }));
      return (
        await page.screenshot({
          type: "png",
          mask,
          animations: "disabled",
          fullPage,
        })
      ).toString("base64");
    };
    const verifyProtected = async () => {
      await open(page, protectedUrl);
      await assertIdentity();
    };
    return {
      context,
      page,
      checks,
      redact,
      refreshSecrets,
      screenshot,
      assertIdentity,
      verifyProtected,
      input,
      proof: {
        signedOut: Boolean(input.access),
        signedIn: Boolean(input.access),
        protectedRoute: Boolean(input.access),
        principal: Boolean(
          input.access?.accounts[0].assertions?.some(
            (item) => item.kind === "principal",
          ),
        ),
        tenant: Boolean(
          input.access?.accounts[0].assertions?.some(
            (item) => item.kind === "tenant",
          ),
        ),
        public: !input.access,
        receivingContext: false,
      },
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
