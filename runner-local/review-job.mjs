import {
  readFileSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { runReviewReceipts, validateReviewPlan } from "./review-receipts.mjs";
import { enforceDeadline } from "./runtime.mjs";
import { startLeaseWatchdog } from "./lease.mjs";
const clearDeadline = enforceDeadline(
  () => process.exit(124),
  process.exit,
  10,
);
let clearLease = () => {};
const copy = (source, target, max) => {
  const info = lstatSync(source);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > max
  )
    throw new Error("Unsafe review input.");
  writeFileSync(target, readFileSync(source), { mode: 0o600, flag: "wx" });
};
try {
  while (!existsSync("/work/job.ready"))
    await new Promise((done) => setTimeout(done, 100));
  const input = JSON.parse(readFileSync("/work/job.json", "utf8"));
  unlinkSync("/work/job.json");
  validateReviewPlan(input.plan);
  if (input.remoteLease)
    clearLease = startLeaseWatchdog({ stop: () => process.exit(124) });
  if (
    input.bypass !== undefined &&
    (typeof input.bypass !== "string" ||
      input.bypass.length > 16384 ||
      /[\r\n\0]/.test(input.bypass))
  )
    throw new Error("Invalid review access.");
  // The original model container is stopped; its mount is read-only. No source code is executed here.
  if (existsSync("/input/pm-review-request.json"))
    copy(
      "/input/pm-review-request.json",
      "/output/pm-review-request.json",
      256 * 1024,
    );
  if (input.managedAccess) {
    const { endpoint, token } = input.managedAccess;
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      !/^gremlins-auth-[a-z0-9-]+$/.test(url.hostname) ||
      url.port !== "4719" ||
      !["/", "/mcp"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new Error("Invalid private review browser.");
    const requestFile = "/output/pm-review-request.json";
    const request = existsSync(requestFile)
      ? JSON.parse(readFileSync(requestFile, "utf8"))
      : {};
    if (existsSync(requestFile)) unlinkSync(requestFile);
    const response = await fetch(new URL("/review", endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        plan: input.plan,
        commitSha: input.plan.deployment.sha,
        request,
      }),
      signal: AbortSignal.timeout(9 * 60 * 1000),
    });
    const result = await response.json();
    if (
      !response.ok ||
      result.ok !== true ||
      !Array.isArray(result.files) ||
      result.files.length > 101 ||
      result.files.reduce(
        (size, file) =>
          size + (typeof file.base64 === "string" ? file.base64.length : 1e9),
        0,
      ) >
        32 * 1024 * 1024
    )
      throw new Error("Private review failed.");
    mkdirSync("/output/review-screenshots", { recursive: true });
    for (const file of result.files) {
      if (
        file.name !== "pm-review-proof.json" &&
        !/^review-screenshots\/[a-f0-9]{40}-(desktop|mobile)\.png$/.test(
          file.name,
        )
      )
        throw new Error("Invalid private review artifact.");
      writeFileSync(
        join("/output", file.name),
        Buffer.from(file.base64, "base64"),
        { mode: 0o600, flag: "wx" },
      );
    }
    if (!existsSync("/output/pm-review-proof.json"))
      throw new Error("Missing private review proof.");
  } else {
    mkdirSync("/work/review-sessions", { recursive: true, mode: 0o700 });
    const sessions = "/input/.review-sessions";
    if (existsSync(sessions)) {
      const info = lstatSync(sessions);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe private review sessions.");
      const files = readdirSync(sessions);
      if (files.length > 20)
        throw new Error("Too many private review sessions.");
      for (const file of files)
        if (/^[a-z][a-z0-9-]{0,39}\.json$/.test(file))
          copy(
            join(sessions, file),
            join("/work/review-sessions", file),
            128 * 1024,
          );
    }
    await runReviewReceipts({
      plan: input.plan,
      commitSha: input.plan.deployment.sha,
      outputDirectory: "/output",
      chromium,
      bypass: input.bypass,
    });
  }
  if (input.bypass) {
    const file = "/output/pm-review-proof.json";
    let proof = readFileSync(file, "utf8");
    for (const secret of new Set([
      input.bypass,
      encodeURIComponent(input.bypass),
      JSON.stringify(input.bypass).slice(1, -1),
    ]))
      proof = proof.split(secret).join("[REDACTED]");
    writeFileSync(file, proof, { mode: 0o600 });
  }
  writeFileSync(
    "/output/result.json",
    JSON.stringify({
      ok: true,
      kind: "pm",
      nonce: input.plan.jobId,
      commitSha: input.plan.deployment.sha,
    }),
    { mode: 0o600 },
  );
  writeFileSync("/output/.sanitized", "complete\n", { mode: 0o600 });
} catch {
  console.error(
    "Independent browser review could not complete; promotion remains blocked.",
  );
  process.exitCode = 1;
} finally {
  clearLease();
  clearDeadline();
}
