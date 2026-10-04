import { createServer, type Server } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags, type Io } from "./crons.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** Serve only the public site directory. No project configuration or secrets. */
export function createStaticServer(directory: string): Server {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            req.method === "HEAD"
              ? undefined
              : '{"status":"ok","service":"shipgremlins-site"}',
          );
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\\") || pathname.includes("\0"))
        throw new Error("Invalid path");
      const root = await realpath(directory);
      const candidate = await realpath(
        join(root, pathname === "/" ? "index.html" : pathname.slice(1)),
      );
      const rel = relative(root, candidate);
      if (
        isAbsolute(rel) ||
        rel.startsWith(`..${sep}`) ||
        rel === ".." ||
        resolve(root, rel) !== candidate ||
        !TYPES[extname(candidate)] ||
        !(await stat(candidate)).isFile()
      )
        throw new Error("Not public");
      const body = await readFile(candidate);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(candidate)]!,
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res
        .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        .end(req.method === "HEAD" ? undefined : "Not found");
    }
  });
}

export async function runServe(
  packageRoot: string,
  args: string[],
  io: Io,
): Promise<number> {
  const { values } = parseFlags(args);
  const port = Number(values.port ?? 4310);
  const host = typeof values.host === "string" ? values.host : "127.0.0.1";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !host ||
    /[\s/]/.test(host)
  ) {
    io.error("usage: gremlins serve [--host 127.0.0.1] [--port 4310]");
    return 1;
  }
  const server = createStaticServer(join(packageRoot, "site", "dist"));
  return new Promise<number>((done) => {
    server.once("error", (error) => {
      io.error(`Site could not start: ${error.message}`);
      done(1);
    });
    server.listen(port, host, () =>
      io.log(
        `ShipGremlins: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
      ),
    );
    const stop = () => server.close(() => done(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("close", () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  runServe(root, process.argv.slice(2), {
    log: console.log,
    error: console.error,
  }).then((code) => {
    process.exitCode = code;
  });
}
