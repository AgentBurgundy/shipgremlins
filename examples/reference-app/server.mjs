// Disposable local benchmark. All people, tenants and tasks are synthetic.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const clients = {
  alice: { tenant: "moon", role: "admin" },
  bob: { tenant: "moon", role: "viewer" },
  nova: { tenant: "mars", role: "admin" },
};
const seed = () => [
  { id: 1, tenant: "moon", title: "Inspect the airlock" },
  { id: 2, tenant: "mars", title: "Calibrate the rover" },
];
export function referenceApp({ seededBug = false } = {}) {
  let tasks = seed();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const send = (status, value) => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(path)) {
      res.setHeader(
        "Content-Type",
        path === "/"
          ? "text/html; charset=utf-8"
          : path.endsWith(".js")
            ? "text/javascript"
            : "text/css",
      );
      res.end(
        readFileSync(
          new URL(path === "/" ? "index.html" : `.${path}`, import.meta.url),
        ),
      );
      return;
    }
    const user = clients[req.headers["x-demo-user"]];
    if (!user) {
      send(401, { error: "Choose a synthetic demo account." });
      return;
    }
    if (path === "/api/tasks" && req.method === "GET") {
      send(200, {
        tasks: tasks.filter((t) => seededBug || t.tenant === user.tenant),
      });
      return;
    }
    if (path === "/api/import" && req.method === "POST") {
      if (user.role !== "admin") {
        send(403, { error: "Only admins can import tasks." });
        return;
      }
      let source = "";
      for await (const part of req) {
        source += part;
        if (Buffer.byteLength(source) > 8192) {
          send(413, { error: "CSV too large" });
          return;
        }
      }
      const rows = source
        .replace(/^\uFEFF/, "")
        .trim()
        .split(/\r?\n/);
      if (
        rows[0] !== "title" ||
        rows.length < 2 ||
        rows.length > 51 ||
        rows
          .slice(1)
          .some(
            (row) =>
              !row.trim() || row.length > 120 || /[<>,\x00-\x1f]/.test(row),
          )
      ) {
        send(400, { error: "Use a title column and 1–50 plain-text rows." });
        return;
      }
      const added = rows.slice(1).map((title, index) => ({
        id: tasks.length + 1 + index,
        tenant: user.tenant,
        title,
      }));
      tasks.push(...added);
      send(201, { added: added.length });
      return;
    }
    send(404, { error: "Not found" });
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = referenceApp({
    seededBug: process.argv.includes("--seed-tenant-bug"),
  });
  server.listen(Number(process.env.PORT || 4325), "127.0.0.1", () =>
    console.log(
      `Synthetic reference app: http://127.0.0.1:${server.address().port}`,
    ),
  );
}
