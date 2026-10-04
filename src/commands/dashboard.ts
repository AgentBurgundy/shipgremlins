import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIPv4, type AddressInfo } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listProjectNames, loadHub, loadProject } from "../config.ts";
import {
  CONNECTIONS,
  readConnections,
  saveConnections,
} from "../setup/connections.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { detectHubRepository } from "../setup/location.ts";
import {
  ConfigEditorError,
  listEditableConfigs,
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import { canOpenFolders, openDashboardFolder } from "../setup/openFolder.ts";
import { parseFlags, type Io } from "./crons.ts";
import { runSetup } from "./setup.ts";
import { createUpdater, type Updater } from "../update/index.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const MAX_BODY = 32 * 1024;

/** Advertise private LAN/Tailscale IPv4 interfaces, never public or loopback addresses. */
export function lanAddresses(
  interfaces: Record<
    string,
    NetworkInterfaceInfo[] | undefined
  > = networkInterfaces(),
): string[] {
  return [
    ...new Set(
      Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter(
          (entry) =>
            !entry.internal && entry.family === "IPv4" && isIPv4(entry.address),
        )
        .map((entry) => entry.address)
        .filter((address) => {
          const [first, second] = address.split(".").map(Number);
          return (
            first === 10 ||
            (first === 172 && second! >= 16 && second! <= 31) ||
            (first === 192 && second === 168) ||
            (first === 100 && second! >= 64 && second! <= 127)
          );
        }),
    ),
  ].sort();
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function body(
  req: IncomingMessage,
  limit = MAX_BODY,
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new RequestError(415, "Use application/json.");
  if (Number(req.headers["content-length"] ?? 0) > limit)
    throw new RequestError(413, "Request is too large.");
  const chunks = await new Promise<Buffer[]>((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const onError = () => {
      cleanup();
      reject(new RequestError(400, "Request could not be read."));
    };
    const onEnd = () => {
      cleanup();
      accept(chunks);
    };
    const onData = (bytes: Buffer) => {
      size += bytes.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new RequestError(413, "Request is too large."));
      } else chunks.push(bytes);
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value)) throw new Error();
    return value;
  } catch {
    throw new RequestError(400, "Expected a JSON object.");
  }
}

export interface DashboardOptions {
  updater?: Updater;
  restart?: () => void;
}

export function createDashboardServer(
  root: string,
  packageRoot: string,
  session: string,
  networkHosts: readonly string[] = [],
  options: DashboardOptions = {},
): Server {
  if (!/^[a-f0-9]{64}$/.test(session))
    throw new Error("Invalid dashboard session.");
  if (networkHosts.some((host) => !isIPv4(host)))
    throw new Error("Dashboard network hosts must be IPv4 addresses.");
  const hosts = new Set(["127.0.0.1", ...networkHosts]);
  // Update checks are explicit; opening the static page never makes a network request.
  let updater = options.updater;
  const updates = () =>
    (updater ??= createUpdater({ configurationRoot: root, packageRoot }));
  let updateRunning = false;
  let updateFailure = "";
  const updateStatus = () => ({
    ...updates().status(),
    ...(updateFailure
      ? { phase: "error" as const, message: updateFailure }
      : {}),
    canRestart: Boolean(options.restart),
  });
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const address = server.address() as AddressInfo | null;
      const host = req.headers.host ?? "";
      const origin = `http://${host}`;
      if (
        ![...hosts].some((allowed) => host === `${allowed}:${address?.port}`) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(
          403,
          "Use a dashboard address printed by the CLI and its matching browser session.",
        );
      const url = new URL(req.url ?? "/", origin);
      if (url.origin !== origin)
        throw new RequestError(403, "Invalid request origin.");
      if (url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${session}`);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new RequestError(
            401,
            "Open the dashboard link printed by your CLI.",
          );
        if (url.pathname === "/api/updates") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for update status.");
          json(res, 200, updateStatus());
          return;
        }
        if (url.pathname.startsWith("/api/updates/")) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST for update actions.");
          const action = url.pathname.slice("/api/updates/".length);
          if (!["check", "apply", "rollback", "restart"].includes(action))
            throw new RequestError(404, "Unknown update action.");
          if (Object.keys(await body(req)).length)
            throw new RequestError(
              400,
              "Update actions take an empty JSON object.",
            );
          if (updateRunning)
            throw new RequestError(
              409,
              "Another update is running. Wait for it to finish.",
            );
          if (action === "restart") {
            if (!options.restart)
              throw new RequestError(
                400,
                "Stop this dashboard and start it with gremlins setup to use the new runtime.",
              );
            if (!updates().status().restartRequired)
              throw new RequestError(
                409,
                "The dashboard is already using the selected runtime.",
              );
            updateRunning = true;
            res.once("finish", options.restart);
            json(res, 202, { ok: true, restarting: true });
            return;
          }
          updateFailure = "";
          updateRunning = true;
          // Installation can take minutes. Keep the dashboard and its status polling responsive.
          const operation = updates()[action as "check" | "apply" | "rollback"];
          void operation()
            .catch(() => {
              updateFailure =
                "Another update may be running. Wait for it to finish, then check again.";
            })
            .finally(() => {
              updateRunning = false;
            });
          json(res, 202, updateStatus());
          return;
        }
        if (url.pathname === "/api/status") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for status.");
          assertNoSymlinks(root);
          assertNoSymlinks(join(root, "hub.json"));
          const saved = readConnections(root);
          const configWarnings: string[] = [];
          let hubRepo: string | null = null;
          if (existsSync(join(root, "hub.json"))) {
            try {
              hubRepo = loadHub(root).hubRepo;
            } catch {
              configWarnings.push(
                "hub.json needs repair. Open it in Configuration.",
              );
            }
          }
          assertNoSymlinks(join(root, "projects"));
          const projects = listProjectNames(root).map((name) => {
            assertNoSymlinks(join(root, "projects", name));
            for (const file of ["project.json", "areas.json", "tiers.json"])
              assertNoSymlinks(join(root, "projects", name, file));
            try {
              return { name, repo: loadProject(root, name).config.repo };
            } catch {
              configWarnings.push(
                `Project ${name} needs repair. Open its files in Configuration.`,
              );
              return { name, repo: "Configuration needs repair" };
            }
          });
          json(res, 200, {
            configDirectory: resolve(root),
            installationDirectory: resolve(packageRoot),
            hubRepo,
            configWarnings,
            projects,
            connections: CONNECTIONS.map((connection) => ({
              ...connection,
              configured: Boolean(saved[connection.name]),
            })),
            runtime: {
              agents: "github-actions",
              dashboard: "local",
              access: networkHosts.length ? "lan" : "loopback",
              canOpenFolders: canOpenFolders(networkHosts.length > 0),
            },
          });
          return;
        }
        if (url.pathname === "/api/config") {
          try {
            if (req.method === "GET") {
              const path = url.searchParams.get("path");
              json(
                res,
                200,
                path === null
                  ? { files: listEditableConfigs(root) }
                  : readEditableConfig(root, path),
              );
            } else if (req.method === "PUT") {
              const input = await body(req, 128 * 1024);
              if (
                Object.keys(input).some(
                  (key) => !["path", "content", "revision"].includes(key),
                ) ||
                typeof input.path !== "string" ||
                typeof input.content !== "string" ||
                typeof input.revision !== "string"
              )
                throw new RequestError(
                  400,
                  "Expected a configuration path, JSON content, and revision.",
                );
              json(res, 200, {
                ok: true,
                ...saveEditableConfig(root, {
                  path: input.path,
                  content: input.content,
                  revision: input.revision,
                }),
              });
            } else
              throw new RequestError(405, "Use GET or PUT for configuration.");
          } catch (error) {
            if (error instanceof ConfigEditorError)
              throw new RequestError(error.status, error.message);
            throw error;
          }
          return;
        }
        if (url.pathname === "/api/open-folder") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to open a folder.");
          const input = await body(req);
          if (
            Object.keys(input).length !== 1 ||
            typeof input.target !== "string" ||
            !["configuration", "installation"].includes(input.target)
          )
            throw new RequestError(
              400,
              "Choose the configuration or installation folder.",
            );
          if (!canOpenFolders(networkHosts.length > 0))
            throw new RequestError(
              400,
              "This folder lives on the server. Copy its path or use the configuration editor in your browser.",
            );
          try {
            await openDashboardFolder(root, packageRoot, input.target);
          } catch {
            throw new RequestError(
              400,
              "The server could not open its file manager. Copy the folder path instead.",
            );
          }
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/connections") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to save connections.");
          const input = await body(req);
          if (
            Object.keys(input).length !== 1 ||
            !Object.hasOwn(input, "values")
          )
            throw new RequestError(400, "Expected a values object.");
          try {
            saveConnections(root, input.values);
          } catch {
            throw new RequestError(
              400,
              "Connections were not saved. Use supported single-line tokens and check .env permissions and formatting.",
            );
          }
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/projects") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to add a project.");
          const input = await body(req);
          if (
            Object.keys(input).some(
              (key) => !["project", "repo", "hubRepo"].includes(key),
            ) ||
            typeof input.project !== "string" ||
            typeof input.repo !== "string" ||
            (input.hubRepo !== undefined && typeof input.hubRepo !== "string")
          )
            throw new RequestError(
              400,
              "Expected a project name, repository, and optional automation repository.",
            );
          if (
            !/^[a-z][a-z0-9-]{0,62}$/.test(input.project) ||
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) ||
            (typeof input.hubRepo === "string" &&
              !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.hubRepo))
          )
            throw new RequestError(
              400,
              "Use a lowercase project ID and owner/repository names.",
            );
          if (
            input.hubRepo === undefined &&
            !existsSync(join(root, "hub.json")) &&
            !detectHubRepository(root)
          )
            throw new RequestError(
              400,
              "Choose the repository that will store PM configuration and run GitHub Actions, or launch the dashboard from your configured hub checkout.",
            );
          const args = [
            "init",
            "--project",
            input.project,
            "--repo",
            input.repo,
            "--json",
          ];
          if (typeof input.hubRepo === "string")
            args.push("--hub-repo", input.hubRepo);
          const output: string[] = [];
          const code = await runSetup(
            root,
            args,
            { log: (line) => output.push(line), error: () => {} },
            { env: {}, templatesRoot: packageRoot },
          );
          if (code !== 0)
            throw new RequestError(
              400,
              "Project setup could not finish. Check the project ID, automation repository, and existing configuration with gremlins setup init --help.",
            );
          json(res, 200, { ok: true, result: JSON.parse(output.join("\n")) });
          return;
        }
        throw new RequestError(404, "Unknown dashboard endpoint.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new RequestError(405, "Use GET or HEAD.");
      try {
        const pathname = decodeURIComponent(url.pathname);
        if (pathname.includes("\\") || pathname.includes("\0"))
          throw new Error();
        const directory = await realpath(join(packageRoot, "dashboard"));
        const file = await realpath(
          join(directory, pathname === "/" ? "index.html" : pathname.slice(1)),
        );
        const rel = relative(directory, file);
        if (
          isAbsolute(rel) ||
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          !TYPES[extname(file)] ||
          !(await stat(file)).isFile()
        )
          throw new Error();
        const content = await readFile(file);
        res.writeHead(200, {
          "Content-Type": TYPES[extname(file)]!,
          "Content-Length": content.length,
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        throw new RequestError(404, "Not found.");
      }
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message =
        error instanceof RequestError
          ? error.message
          : "Dashboard request failed. Check your local configuration files and permissions.";
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export function openDashboardBrowser(
  url: string,
  io: Io,
  platform: NodeJS.Platform = process.platform,
  launch: typeof spawn = spawn,
): void {
  const command =
    platform === "win32"
      ? "rundll32.exe"
      : platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  let reported = false;
  const fallback = () => {
    if (reported) return;
    reported = true;
    io.log(
      "No browser opened. On another device, restart with gremlins setup --lan, or use an SSH tunnel to the loopback address above.",
    );
  };
  try {
    const child = launch(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", fallback);
    child.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    child.unref();
  } catch {
    fallback();
  }
}

/** Default to loopback; LAN access requires an explicit flag and keeps session authentication. */
export async function runDashboard(
  root: string,
  packageRoot: string,
  args: string[],
  io: Io,
  getLanAddresses: () => string[] = lanAddresses,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  const usage =
    "Usage: gremlins dashboard [--lan] [--no-open] [--port PORT]\n  --lan: open on your private IPv4 network (default port 4311); prints links for other devices.\n  Default: loopback only, with an available port and automatic browser opening.";
  if (values.help === true || args.includes("-h")) {
    io.log(usage);
    return 0;
  }
  const lan = values.lan === true;
  const port =
    values.port === undefined ? (lan ? 4311 : 0) : Number(values.port);
  if (
    positionals.length ||
    Object.keys(values).some(
      (key) => !["no-open", "port", "lan"].includes(key),
    ) ||
    (values["no-open"] !== undefined && values["no-open"] !== true) ||
    (values.lan !== undefined && values.lan !== true) ||
    values.port === true ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    io.error(usage);
    return 1;
  }
  const addresses = lan ? getLanAddresses() : [];
  if (lan && !addresses.length) {
    io.error(
      "No private LAN IPv4 address was found. Connect this server to your LAN, or use the default loopback dashboard through an SSH tunnel.",
    );
    return 1;
  }
  const supervised =
    process.env.SHIPGREMLINS_MANAGED_LAUNCH === "1" && Boolean(process.send);
  const restoredSession = process.env.SHIPGREMLINS_DASHBOARD_SESSION;
  const session =
    supervised && restoredSession && /^[a-f0-9]{64}$/.test(restoredSession)
      ? restoredSession
      : randomBytes(32).toString("hex");
  let restartDashboard: (() => void) | undefined;
  const server = createDashboardServer(root, packageRoot, session, addresses, {
    ...(supervised ? { restart: () => restartDashboard?.() } : {}),
  });
  return new Promise<number>((done) => {
    restartDashboard = () => {
      const address = server.address() as AddressInfo | null;
      if (!address || !process.send) return;
      process.send(
        {
          type: "shipgremlins:restart-dashboard",
          port: address.port,
          session,
          configurationRoot: resolve(root),
          lan,
        },
        (error) => {
          if (error) {
            io.error(
              "Automatic restart failed. Stop the dashboard and run gremlins setup again.",
            );
            return;
          }
          server.close(() => done(75));
          server.closeAllConnections();
        },
      );
    };
    const stop = () => {
      server.close(() => done(0));
      // An unfinished browser request must not keep Ctrl+C waiting for its body.
      server.closeAllConnections();
    };
    const cleanup = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    };
    server.once("error", () => {
      cleanup();
      io.error(
        "Dashboard could not start. Choose another port with --port 4312, or use --port 0 for an available port.",
      );
      done(1);
    });
    server.once("close", cleanup);
    server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/#session=${session}`;
      if (lan) {
        io.log("Open a LAN link on another device:");
        for (const host of addresses)
          io.log(`  http://${host}:${address.port}/#session=${session}`);
        io.log(
          `LAN mode uses HTTP. Use a trusted network; allow TCP ${address.port} through your server firewall only for that network.`,
        );
      } else io.log(`Your gremlins are waiting: ${url}`);
      io.log(
        `Connections stay on this server in ${join(resolve(root), ".env")}. Keep the session link private. Press Ctrl+C to stop.`,
      );
      if (!lan && !values["no-open"]) openDashboardBrowser(url, io);
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
