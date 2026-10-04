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
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listProjectNames, loadHub, loadProject } from "../config.ts";
import {
  CONNECTIONS,
  readConnections,
  saveConnections,
} from "../setup/connections.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { detectHubRepository } from "../setup/location.ts";
import { parseFlags, type Io } from "./crons.ts";
import { runSetup } from "./setup.ts";

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
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new RequestError(415, "Use application/json.");
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY)
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
      if (size > MAX_BODY) {
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

export function createDashboardServer(
  root: string,
  packageRoot: string,
  session: string,
): Server {
  if (!/^[a-f0-9]{64}$/.test(session))
    throw new Error("Invalid dashboard session.");
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
      const host = `127.0.0.1:${address?.port}`;
      const origin = `http://${host}`;
      if (
        req.headers.host !== host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(
          403,
          "Dashboard requests must come from this local session.",
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
        if (url.pathname === "/api/status") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for status.");
          assertNoSymlinks(root);
          assertNoSymlinks(join(root, "hub.json"));
          const saved = readConnections(root);
          const hubRepo = existsSync(join(root, "hub.json"))
            ? loadHub(root).hubRepo
            : null;
          const projects = listProjectNames(root).map((name) => {
            assertNoSymlinks(join(root, "projects", name));
            for (const file of ["project.json", "areas.json", "tiers.json"])
              assertNoSymlinks(join(root, "projects", name, file));
            return { name, repo: loadProject(root, name).config.repo };
          });
          json(res, 200, {
            configDirectory: resolve(root),
            hubRepo,
            projects,
            connections: CONNECTIONS.map((connection) => ({
              ...connection,
              configured: Boolean(saved[connection.name]),
            })),
            runtime: { agents: "github-actions", dashboard: "local" },
          });
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
              "Project setup could not finish. Check the project ID, automation repository, and existing configuration with shipgremlins setup init --help.",
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
      "The browser could not open automatically. Open the dashboard link above in a browser on this computer.",
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

/** Run a browser dashboard accessible only on this computer. */
export async function runDashboard(
  root: string,
  packageRoot: string,
  args: string[],
  io: Io,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (
    positionals.length ||
    Object.keys(values).some((key) => !["no-open", "port"].includes(key)) ||
    (values["no-open"] !== undefined && values["no-open"] !== true) ||
    values.port === true ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    io.error("Usage: shipgremlins dashboard [--no-open] [--port 4311]");
    return 1;
  }
  const session = randomBytes(32).toString("hex");
  const server = createDashboardServer(root, packageRoot, session);
  return new Promise<number>((done) => {
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
        "Dashboard could not start. Choose another port with --port 4311, or omit --port for an available port.",
      );
      done(1);
    });
    server.once("close", cleanup);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/#session=${session}`;
      io.log(`Your gremlins are waiting: ${url}`);
      io.log(
        `Connections stay on this computer in ${join(resolve(root), ".env")}. Keep this session link private. Press Ctrl+C to stop.`,
      );
      if (!values["no-open"]) openDashboardBrowser(url, io);
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
