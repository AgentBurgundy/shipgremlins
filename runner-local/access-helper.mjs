import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  AccessFailure,
  accessFailure,
  parsePrivateAccess,
  prepareAuthenticatedContext,
} from "./access-executor.mjs";
import { createManagedGateway } from "./access-gateway.mjs";
import { runReviewReceipts, validateReviewPlan } from "./review-receipts.mjs";

export async function startAccessHelper(rawInput, options = {}) {
  const input = parsePrivateAccess(rawInput);
  let browser,
    prepared,
    gateway,
    directory,
    receipt,
    closed = false,
    leaseTimer;
  let status = "starting",
    failure,
    chain = Promise.resolve();
  const authenticated = (req) => {
    const privateControl = ["/review", "/lease"].includes(req.url);
    const token = privateControl ? input.controlToken : input.token;
    if (typeof token !== "string" || token.length < 32) return false;
    const presented = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from(`Bearer ${token}`);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  };
  const snapshot = () => ({
    ok: status === "ready",
    status,
    ...(receipt ? { receipt } : {}),
    ...(prepared ? { checks: prepared.checks } : {}),
    ...(failure ? { failure } : {}),
  });
  const stop = async () => {
    if (closed) return;
    closed = true;
    status = "failed";
    clearTimeout(deadline);
    clearTimeout(leaseTimer);
    server.close();
    server.closeAllConnections();
    await gateway?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  const renew = (ttlMs) => {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120000)
      throw new AccessFailure("invalid_access");
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => void stop(), ttlMs);
  };
  const server = createServer(async (req, res) => {
    const reply = (value, code = 200) => {
      if (!res.destroyed) {
        res.writeHead(code, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(value));
      }
    };
    if (!authenticated(req)) return reply({ ok: false }, 401);
    try {
      if (req.method === "GET" && ["/ready", "/status"].includes(req.url))
        return reply(snapshot());
      if (req.method === "GET" && req.url === "/screenshot") {
        if (status !== "ready") return reply(snapshot(), 409);
        return reply({ ok: true, screenshot: await prepared.screenshot() });
      }
      if (req.method === "POST" && req.url === "/close") {
        reply({ ok: true });
        setImmediate(() => void stop());
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > (req.url === "/review" ? 512 * 1024 : 65536))
          return reply({ ok: false }, 413);
      }
      if (req.method === "POST" && req.url === "/lease") {
        renew(JSON.parse(body).ttlMs);
        return reply({ ok: true });
      }
      if (req.method === "POST" && req.url === "/review") {
        if (status !== "ready") return reply(snapshot(), 409);
        const review = JSON.parse(body);
        validateReviewPlan(review.plan);
        if (
          new URL(review.plan.deployment.url).origin !== input.origin ||
          review.commitSha !== review.plan.deployment.sha
        )
          throw new AccessFailure("invalid_access");
        const directory = await mkdtemp(join(tmpdir(), "gremlins-review-"));
        try {
          await writeFile(
            join(directory, "pm-review-request.json"),
            JSON.stringify(review.request || {}),
            { mode: 0o600 },
          );
          await (chain = chain
            .catch(() => {})
            .then(() =>
              runReviewReceipts({
                plan: review.plan,
                commitSha: review.commitSha,
                outputDirectory: directory,
                contextFactory: async (viewport) => {
                  const fresh = await prepareAuthenticatedContext(
                    browser,
                    input,
                  );
                  await fresh.page.setViewportSize(viewport);
                  return fresh;
                },
              }),
            ));
          const files = [
            {
              name: "pm-review-proof.json",
              base64: (
                await readFile(join(directory, "pm-review-proof.json"))
              ).toString("base64"),
            },
          ];
          for (const filename of await readdir(
            join(directory, "review-screenshots"),
          ))
            files.push({
              name: `review-screenshots/${filename}`,
              base64: (
                await readFile(join(directory, "review-screenshots", filename))
              ).toString("base64"),
            });
          if (
            files.reduce((size, file) => size + file.base64.length, 0) >
            32 * 1024 * 1024
          )
            throw new AccessFailure("helper_unavailable");
          return reply({ ok: true, files });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      if (req.method === "POST" && req.url === "/verify") {
        if (status !== "ready") return reply(snapshot(), 409);
        await (chain = chain.catch(() => {}).then(() => gateway.verify()));
        return reply(snapshot());
      }
      if (req.method !== "POST" || req.url !== "/mcp")
        return reply({ ok: false }, 404);
      const message = JSON.parse(body);
      if (status !== "ready")
        return reply({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: -32000,
            message: failure?.message || "Test access is not ready.",
          },
        });
      const result = await (chain = chain
        .catch(() => {})
        .then(() => gateway.request(message)));
      if (result === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      return reply({ jsonrpc: "2.0", id: message.id ?? null, result });
    } catch (error) {
      if (error instanceof AccessFailure && error.code !== "invalid_access") {
        failure = accessFailure(error);
        status = "failed";
      }
      reply({ ok: false, status, failure: accessFailure(error) }, 400);
    }
  });
  server.requestTimeout = 50000;
  server.headersTimeout = 10000;
  const runtime = Math.min(
    Math.max(
      Number.isSafeInteger(input.maxRuntimeMs) ? input.maxRuntimeMs : 2700000,
      1000,
    ),
    2700000,
  );
  const deadline = setTimeout(() => void stop(), runtime);
  if (input.leaseTtlMs !== undefined) renew(input.leaseTtlMs);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4719, options.host ?? "0.0.0.0", resolve);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  const ready = (async () => {
    try {
      directory = await mkdtemp(join(tmpdir(), "gremlins-browser-"));
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox"],
      });
      if (closed) {
        await browser.close();
        return;
      }
      prepared = await prepareAuthenticatedContext(browser, input);
      gateway = await createManagedGateway(prepared, directory);
      if (closed) {
        await gateway.close();
        await browser.close();
        return;
      }
      receipt = {
        version: 1,
        identityId: input.identityId,
        generation: input.generation,
        leaseGeneration: input.leaseGeneration,
        verifiedAt: new Date().toISOString(),
        origin: input.origin,
        accountName: input.access?.accounts[0].name,
        proof: prepared.proof,
        ...(prepared.repair ? { repair: prepared.repair } : {}),
      };
      status = "ready";
    } catch (error) {
      failure = accessFailure(error);
      status = "failed";
      await browser?.close().catch(() => {});
    } finally {
      if (closed && directory)
        await rm(directory, { recursive: true, force: true });
    }
    return snapshot();
  })();
  return { ready, stop, snapshot, address: server.address() };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let helper;
  try {
    let body = "";
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 196608) throw new AccessFailure("invalid_access");
    }
    const input = JSON.parse(body);
    body = "";
    helper = await startAccessHelper(input);
    process.once("SIGTERM", () => void helper.stop());
    process.once("SIGINT", () => void helper.stop());
    // No private input, browser errors, cookies or MCP output is written to logs.
    await helper.ready;
  } catch {
    await helper?.stop();
    process.exitCode = 1;
  }
}
