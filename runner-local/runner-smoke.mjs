import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

export async function browserSmoke(output, nonce) {
  if (typeof nonce !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(nonce))
    throw new Error("Invalid verification nonce.");
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 720 },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><title>Gremlins worker proof</title><style>body{margin:0;background:#101613;color:#edf2e9;font:24px system-ui;padding:80px}h1{font-size:68px;color:#c3f66b}.mark{font:100px monospace;color:#c3f66b}code{font:18px monospace}small{color:#a5b4a7}</style></head><body><div class="mark">{g}</div><h1>This gremlin can see.</h1><p>Chromium rendered this page inside your local Docker worker.</p><small>Verification nonce</small><p><code>${nonce}</code></p></body></html>`,
    );
    await page.screenshot({
      path: join(directory, "screenshot.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
  const bytes = await readFile(join(directory, "screenshot.png"));
  const result = {
    ok: true,
    kind: "verify",
    type: "verify",
    nonce,
    screenshot: "screenshot.png",
    browser: "chromium",
    artifactpath: "screenshot.png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(
    join(directory, "proof.json"),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === "/opt/gremlins/runner-smoke.mjs"
) {
  const args = process.argv.slice(2);
  const output = args[args.indexOf("--output") + 1];
  const nonce = args[args.indexOf("--nonce") + 1];
  try {
    if (!args.includes("--output") || !args.includes("--nonce"))
      throw new Error();
    await browserSmoke(output, nonce);
    console.log("Chromium screenshot verified.");
  } catch {
    console.error("Browser verification failed.");
    process.exitCode = 1;
  }
}
