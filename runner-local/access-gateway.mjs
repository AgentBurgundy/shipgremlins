import { createConnection } from "@playwright/mcp";
import { AccessFailure } from "./access-executor.mjs";

// This is the security boundary, not the MCP package's convenience secrets filter.
// Never pass through evaluator, raw code, storage, network, console, filesystem,
// browser configuration, new-context, upload, download or page-defined tools.
export const MANAGED_BROWSER_TOOLS = new Set([
  "browser_snapshot",
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_resize",
  "browser_take_screenshot",
  "browser_handle_dialog",
]);
const failResult = (message) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export async function createManagedGateway(prepared, outputDir) {
  const { context, page, input } = prepared;
  const server = await createConnection(
    {
      browser: { isolated: false },
      webmcp: false,
      saveSession: false,
      outputDir,
      outputMaxSize: 5 * 1024 * 1024,
      codegen: "none",
      console: { level: "error" },
      snapshot: { mode: "full" },
      timeouts: { action: 12000, navigation: 30000, idle: 0 },
    },
    async () => context,
  );
  let sequence = 0;
  const pending = new Map();
  const transport = {
    async start() {},
    async send(message) {
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (item) {
          pending.delete(message.id);
          clearTimeout(item.timer);
          message.error
            ? item.reject(new AccessFailure("helper_unavailable"))
            : item.resolve(message.result);
        }
      }
    },
    async close() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new AccessFailure("helper_unavailable"));
      }
      pending.clear();
      this.onclose?.();
    },
  };
  await server.connect(transport);
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AccessFailure("helper_unavailable"));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      transport.onmessage({ jsonrpc: "2.0", id, method, params });
    });
  const initialized = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "shipgremlins-private-browser", version: "1" },
  });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  const allTools = (await call("tools/list")).tools;
  const tools = allTools
    .filter((tool) => MANAGED_BROWSER_TOOLS.has(tool.name))
    .map((tool) => {
      if (tool.name === "browser_take_screenshot")
        return {
          name: tool.name,
          description:
            "Take a masked PNG screenshot of the prepared test browser. Inputs and private identity/session values are hidden.",
          inputSchema: {
            type: "object",
            properties: {
              fullPage: {
                type: "boolean",
                description: "Capture the full scrollable page.",
              },
            },
            additionalProperties: false,
          },
        };
      const properties = { ...tool.inputSchema.properties };
      // Screenshots are always generated/masked by trusted code; no helper path is accepted.
      delete properties.filename;
      if (tool.name === "browser_snapshot") delete properties.filename;
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties,
          additionalProperties: false,
        },
      };
    });
  if (!tools.some((tool) => tool.name === "browser_snapshot"))
    throw new AccessFailure("receiving_context_failed");
  const received = await call("tools/call", {
    name: "browser_snapshot",
    arguments: {},
  });
  if (
    received.isError ||
    context.pages().length !== 1 ||
    context.pages()[0] !== page
  )
    throw new AccessFailure("receiving_context_failed");
  await prepared.assertIdentity();
  prepared.proof.receivingContext = true;
  prepared.checks.push({
    name: "PM browser receives the verified context",
    passed: true,
  });
  const sanitize = async (result, includeSnapshot = false) => {
    if (
      includeSnapshot ||
      (result.content || []).some(
        (item) => item.type === "text" && /\[Snapshot\]\(/.test(item.text),
      )
    ) {
      // Action responses in the pinned package write their snapshot to a helper
      // file. Request its explicit inline form instead of exposing a file reader.
      const inline = await call("tools/call", {
        name: "browser_snapshot",
        arguments: {},
      });
      result = {
        ...result,
        content: [
          ...(result.content || [])
            .filter((item) => item.type === "text")
            .map((item) => ({
              type: "text",
              text: item.text.replace(/### Snapshot[\s\S]*?(?=\n### |$)/g, ""),
            })),
          ...(inline.content || []),
        ],
      };
    }
    await prepared.refreshSecrets();
    // Only text and explicitly generated, masked screenshots cross the boundary.
    // MCP resource/file links are not forwarded as readable helper resources.
    return {
      ...(result.isError ? { isError: true } : {}),
      content: (result.content || [])
        .filter((item) => item.type === "text")
        .map((item) => ({
          type: "text",
          text: prepared
            .redact(item.text)
            .replace(/### New console messages[\s\S]*?(?=\n### |$)/g, "")
            .replace(/### Events[\s\S]*?(?=\n### |$)/g, "")
            .slice(0, 120000),
        })),
    };
  };
  const request = async (message) => {
    if (
      !message ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    )
      throw new AccessFailure("invalid_access");
    if (message.method.startsWith("notifications/")) return undefined;
    if (message.method === "initialize")
      return {
        ...initialized,
        capabilities: { tools: {} },
        serverInfo: { name: "ShipGremlins managed browser", version: "1" },
      };
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools };
    if (message.method !== "tools/call")
      return failResult(
        "This operation is unavailable in the managed browser.",
      );
    const name = message.params?.name,
      args = message.params?.arguments || {};
    const tool = tools.find((item) => item.name === name);
    if (
      !tool ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some(
        (key) => !Object.hasOwn(tool.inputSchema.properties || {}, key),
      )
    )
      return failResult(
        "This browser tool or argument is unavailable in the managed browser.",
      );
    if (name === "browser_navigate") {
      try {
        const url = new URL(args.url);
        if (url.origin !== input.origin || url.username || url.password)
          throw Error();
      } catch {
        return failResult("Open a page on the selected test app origin.");
      }
    }
    if (
      name === "browser_wait_for" &&
      args.time !== undefined &&
      (!Number.isFinite(args.time) || args.time < 0 || args.time > 10)
    )
      return failResult("Wait at most 10 seconds per browser call.");
    if (
      name === "browser_resize" &&
      [args.width, args.height].some(
        (value) => !Number.isSafeInteger(value) || value < 240 || value > 2560,
      )
    )
      return failResult("Use a viewport between 240 and 2560 pixels.");
    if (name === "browser_take_screenshot")
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: await prepared.screenshot({
              fullPage: args.fullPage === true,
            }),
          },
          {
            type: "text",
            text: "Masked screenshot from the prepared test browser.",
          },
        ],
      };
    const result = await call("tools/call", { name, arguments: args });
    if (page.isClosed()) throw new AccessFailure("session_expired");
    if (input.access) {
      // An actual return to the login controls invalidates the session. Do not
      // misclassify public pages which simply omit the account-menu selector.
      const signedIn = await page
        .locator(input.access.successSelector)
        .isVisible()
        .catch(() => false);
      const loginVisible = await page
        .locator(input.access.passwordSelector)
        .isVisible()
        .catch(() => false);
      if (!signedIn && loginVisible) throw new AccessFailure("session_expired");
    }
    return sanitize(result, name !== "browser_snapshot");
  };
  return {
    request,
    close: () => server.close(),
    verify: async () => {
      if (page.isClosed()) throw new AccessFailure("session_expired");
      // Finish on the same protected route and recheck in the receiving browser.
      // This runs only at final verification, never during ordinary status polling.
      if (input.access) {
        try {
          await prepared.verifyProtected();
        } catch {
          throw new AccessFailure("session_expired");
        }
      }
      return true;
    },
  };
}
