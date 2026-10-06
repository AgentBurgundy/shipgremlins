import { writeFileSync } from "node:fs";
import { join } from "node:path";

const configured = new WeakSet();

/** Attach only to the admitted preview origin, before the first MCP navigation. */
export async function installBrowserAccess(page, input) {
  if (configured.has(page)) return;
  const origin = browserOrigin(input.url);
  if (typeof input.bypass !== "string" || /[\r\n\0]/.test(input.bypass))
    throw new Error("Invalid preview access credential.");
  if (
    input.restrictLogin !== undefined &&
    typeof input.restrictLogin !== "boolean"
  )
    throw new Error("Invalid test-account browser scope.");
  const privateAccess = Boolean(input.bypass || input.restrictLogin);
  const session = await page.context().newCDPSession(page);
  let mainFrame;
  try {
    const tree = await session.send("Page.getFrameTree");
    mainFrame = tree.frameTree.frame.id;
  } catch {
    await session.detach().catch(() => {});
    throw new Error("Private browser access could not be initialized.");
  }
  session.on("Fetch.requestPaused", async (event) => {
    try {
      const request = event.request;
      const sameOrigin = new URL(request.url).origin === origin;
      const navigation = event.resourceType === "Document";
      const navigationOrWrite =
        navigation || !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (privateAccess && !sameOrigin && navigationOrWrite) {
        input.onBlocked?.(request.url, navigation, event.frameId === mainFrame);
        await session.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        });
        return;
      }
      const headers = { ...request.headers };
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === "x-vercel-protection-bypass")
          delete headers[key];
      if (sameOrigin && input.bypass)
        headers["x-vercel-protection-bypass"] = input.bypass;
      // CDP pauses every redirect hop. These headers override only this request,
      // unlike browser routing APIs that skip interception after a redirect.
      await session.send("Fetch.continueRequest", {
        requestId: event.requestId,
        headers: Object.entries(headers).map(([name, value]) => ({
          name,
          value: String(value),
        })),
      });
    } catch {
      // Provider/request exceptions can contain headers. Keep them out of MCP output.
      await session
        .send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => {});
    }
  });
  try {
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  } catch {
    await session.detach().catch(() => {});
    throw new Error("Private browser access could not be initialized.");
  }
  configured.add(page);
}

export function browserOrigin(url) {
  try {
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error();
    return parsed.origin;
  } catch {
    throw new Error(
      "A valid selected browser environment is required for preview access.",
    );
  }
}

/** Private files are outside the repository and artifact directory; arguments contain paths only. */
export function prepareBrowserAccess(directory, { url, credentials = {} }) {
  const bypass = credentials.GREMLINS_PREVIEW_BYPASS || "";
  const secrets = Object.fromEntries(
    Object.entries(credentials).filter(
      ([key, value]) =>
        Boolean(value) &&
        (key === "GREMLINS_PREVIEW_BYPASS" ||
          /^GREMLINS_TEST_(USERNAME|PASSWORD)_[1-8]$/.test(key)),
    ),
  );
  const config = {
    secrets,
    browser: { isolated: true, contextOptions: { serviceWorkers: "block" } },
  };
  const restrictLogin = Object.keys(secrets).some((key) =>
    /^GREMLINS_TEST_(USERNAME|PASSWORD)_[1-8]$/.test(key),
  );
  if ((bypass || restrictLogin) && !url)
    throw new Error(
      "Private browser credentials have no selected browser environment. Update the controller and retry this job.",
    );
  if (bypass || restrictLogin) {
    const access = join(directory, "browser-access.json"),
      init = join(directory, "browser-init.mjs");
    writeFileSync(
      access,
      JSON.stringify({ url: browserOrigin(url), bypass, restrictLogin }),
      { mode: 0o600 },
    );
    writeFileSync(
      init,
      `import { readFileSync } from 'node:fs';\nimport { installBrowserAccess } from ${JSON.stringify(import.meta.url)};\nexport default async ({ page }) => installBrowserAccess(page, JSON.parse(readFileSync(${JSON.stringify(access)}, 'utf8')));\n`,
      { mode: 0o600 },
    );
    config.browser.initPage = [init];
  }
  const path = join(directory, "playwright.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return ["--config", path];
}
