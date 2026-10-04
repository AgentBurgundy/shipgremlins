import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStaticServer } from "./serve.ts";

let root: string;
let server: Server;
let externalRoot: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (root) rmSync(root, { recursive: true, force: true });
  if (externalRoot) rmSync(externalRoot, { recursive: true, force: true });
  externalRoot = undefined;
});
async function start() {
  root = mkdtempSync(join(tmpdir(), "sg-site-test-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public", "index.html"), "<h1>ShipGremlins</h1>");
  writeFileSync(join(root, "secret.html"), "private");
  writeFileSync(join(root, "public", "config.json"), '{"token":"test"}');
  server = createStaticServer(join(root, "public"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("static site boundary", () => {
  it("rejects symlinked private HTML, including cross-drive Windows targets", async () => {
    const url = await start();
    externalRoot = mkdtempSync(join(process.cwd(), ".sg-site-external-"));
    writeFileSync(join(externalRoot, "secret.html"), "private");
    symlinkSync(externalRoot, join(root, "public", "external"), "junction");
    expect((await fetch(`${url}/external/secret.html`)).status).toBe(404);
  });
  it("serves public HTML and health with security headers and correct HEAD", async () => {
    const url = await start();
    const page = await fetch(url);
    expect(await page.text()).toContain("ShipGremlins");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const head = await fetch(url, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(
      page.headers.get("content-length"),
    );
    expect(await head.text()).toBe("");
    expect(await (await fetch(`${url}/healthz`)).json()).toMatchObject({
      status: "ok",
    });
  });
  it("rejects mutations, configuration files, malformed paths and traversal", async () => {
    const url = await start();
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    for (const path of [
      "/config.json",
      "/%2e%2e%2fsecret.html",
      "/%2e%2e%5csecret.html",
      "/%00",
      "/%zz",
      "/missing.html",
    ])
      expect((await fetch(url + path)).status).toBe(404);
  });
});
