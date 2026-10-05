import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (v, max) =>
  typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0");
export function validateReviewPlan(plan) {
  if (
    !plan ||
    plan.schema !== 1 ||
    !text(plan.id, 100) ||
    !text(plan.jobId, 100) ||
    !text(plan.project, 100) ||
    !text(plan.area, 100) ||
    !sha.test(plan.deployment?.sha ?? "") ||
    plan.deployment?.state !== "READY" ||
    !text(plan.deployment?.id, 200) ||
    !Array.isArray(plan.deliveries) ||
    !plan.deliveries.length ||
    plan.deliveries.length > 50 ||
    Buffer.byteLength(JSON.stringify(plan)) > 256 * 1024
  )
    throw new Error("Invalid controller PM review plan.");
  const url = new URL(plan.deployment.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid controller PM review deployment.");
  const ids = new Set();
  for (const item of plan.deliveries) {
    if (
      !text(item.id, 100) ||
      ids.has(item.id) ||
      !Array.isArray(item.criteria) ||
      !item.criteria.length ||
      item.criteria.length > 50 ||
      item.criteria.some((c) => !text(c, 4000)) ||
      new Set(item.criteria).size !== item.criteria.length
    )
      throw new Error(
        "Review plan requires unique deliveries and finite approved criteria.",
      );
    ids.add(item.id);
  }
  return plan;
}
function safeFile(file) {
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Review artifact path is unsafe.");
  }
}
/** The model proposes checks; this parent-worker phase executes them after the model exits. */
export async function runReviewReceipts({
  plan,
  commitSha,
  outputDirectory,
  chromium,
  bypass,
  sessionDirectory = "/work/review-sessions",
  now = () => new Date(),
}) {
  validateReviewPlan(plan);
  if (commitSha !== plan.deployment.sha)
    throw new Error(
      "PM checkout differs from its exact review deployment. Queue a new patrol.",
    );
  const requestFile = join(outputDirectory, "pm-review-request.json");
  let request;
  try {
    safeFile(requestFile);
    if (lstatSync(requestFile).size <= 256 * 1024)
      request = JSON.parse(readFileSync(requestFile, "utf8"));
  } catch {
    /* Missing or malformed model proposals are blocked, never a pass. */
  } finally {
    // Recipes may contain test-account input values; retain only bounded receipts, never the recipe.
    try {
      safeFile(requestFile);
      if (existsSync(requestFile)) unlinkSync(requestFile);
    } catch {
      /* Unsafe model paths do not become evidence. */
    }
  }
  if (
    !request ||
    request.schema !== 1 ||
    request.planId !== plan.id ||
    !Array.isArray(request.deliveries)
  )
    request = { deliveries: [] };
  const receipts = [];
  const manifest = {
    schema: 1,
    planId: plan.id,
    jobId: plan.jobId,
    project: plan.project,
    area: plan.area,
    testedSha: commitSha,
    deploymentId: plan.deployment.id,
    deliveries: [],
  };
  const target = new URL(plan.deployment.url);
  const screenshotDirectory = join(outputDirectory, "review-screenshots");
  if (
    existsSync(screenshotDirectory) &&
    (!lstatSync(screenshotDirectory).isDirectory() ||
      lstatSync(screenshotDirectory).isSymbolicLink())
  )
    throw new Error("Review screenshot directory is unsafe.");
  mkdirSync(screenshotDirectory, { recursive: true });
  let browser;
  const privateSessions = new Set();
  function storageState(session) {
    if (session === undefined) return undefined;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(session))
      throw new Error("Invalid private review session.");
    const file = join(sessionDirectory, `${session}.json`);
    if (
      !existsSync(sessionDirectory) ||
      lstatSync(sessionDirectory).isSymbolicLink()
    )
      throw new Error("Private review session is unavailable.");
    safeFile(file);
    if (lstatSync(file).size > 128 * 1024)
      throw new Error("Private review session is too large.");
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (
      !Array.isArray(state.cookies) ||
      state.cookies.length > 100 ||
      !Array.isArray(state.origins) ||
      state.origins.length > 1 ||
      state.cookies.some(
        (c) =>
          !c ||
          typeof c.domain !== "string" ||
          c.domain.replace(/^\./, "") !== target.hostname ||
          !text(c.name, 200) ||
          typeof c.value !== "string" ||
          c.value.length > 16_384,
      ) ||
      state.origins.some(
        (o) =>
          o?.origin !== target.origin ||
          !Array.isArray(o.localStorage) ||
          o.localStorage.length > 100 ||
          o.localStorage.some(
            (v) =>
              !text(v.name, 200) ||
              typeof v.value !== "string" ||
              v.value.length > 16_384,
          ),
      )
    )
      throw new Error(
        "Private review session must be confined to this deployment origin.",
      );
    privateSessions.add(file);
    return state;
  }
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    for (const delivery of plan.deliveries) {
      const drafts = request.deliveries.filter(
        (row) => row?.id === delivery.id,
      );
      const draft = drafts.length === 1 ? drafts[0] : undefined;
      const row = {
        id: delivery.id,
        status: "passed",
        assertions: [],
        screenshots: [],
      };
      for (const criterion of delivery.criteria) {
        const checks = Array.isArray(draft?.checks)
          ? draft.checks.filter((c) => c?.criterion === criterion)
          : [];
        const check = checks.length === 1 ? checks[0] : undefined;
        const valid =
          check &&
          text(check.path, 1000) &&
          /^\/(?!\/)/.test(check.path) &&
          !/[?#\\]/.test(check.path) &&
          [
            "text-visible",
            "text-absent",
            "selector-visible",
            "selector-absent",
            "url-path",
          ].includes(check.kind) &&
          (check.kind.startsWith("text-")
            ? text(check.text, 500)
            : check.kind.startsWith("selector-")
              ? text(check.selector, 500)
              : text(check.expected, 1000));
        const receipt = {
          id: randomBytes(20).toString("hex"),
          jobId: plan.jobId,
          planId: plan.id,
          deliveryId: delivery.id,
          criterion,
          deploymentId: plan.deployment.id,
          testedSha: commitSha,
          url: target.href,
          status: "blocked",
          at: now().toISOString(),
        };
        if (valid) {
          let context;
          try {
            const state = storageState(check.session ?? draft.session);
            context = await browser.newContext(
              state ? { storageState: state } : {},
            );
            // Block cross-origin document redirects. Never send bypass headers to another origin.
            await context.route("**/*", async (route) => {
              const url = new URL(route.request().url());
              if (
                route.request().isNavigationRequest() &&
                url.origin !== target.origin
              )
                return route.abort();
              const headers = { ...route.request().headers() };
              delete headers["x-vercel-protection-bypass"];
              if (
                url.origin === target.origin &&
                (bypass || route.request().isNavigationRequest())
              ) {
                if (bypass) headers["x-vercel-protection-bypass"] = bypass;
                // Playwright continue header overrides survive redirects. Fetch exactly one hop instead.
                const response = await route.fetch({
                  headers,
                  maxRedirects: 0,
                  timeout: 15_000,
                });
                const location = response.headers().location;
                if (
                  location &&
                  new URL(location, url).origin !== target.origin
                ) {
                  await response.dispose();
                  return route.abort();
                }
                await route.fulfill({ response });
                await response.dispose();
                return;
              }
              return route.continue({ headers });
            });
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            const response = await page.goto(new URL(check.path, target).href, {
              waitUntil: "domcontentloaded",
              timeout: 15_000,
            });
            if (
              !response ||
              response.status() >= 400 ||
              new URL(page.url()).origin !== target.origin
            )
              throw new Error("Target unavailable.");
            const steps = check.steps ?? [];
            if (!Array.isArray(steps) || steps.length > 12)
              throw new Error("Review recipe is too large.");
            for (const step of steps) {
              if (
                !step ||
                !text(step.selector, 500) ||
                !["click", "fill", "select", "check", "uncheck"].includes(
                  step.action,
                )
              )
                throw new Error("Unsupported review action.");
              const locator = page.locator(step.selector);
              if ((await locator.count()) !== 1)
                throw new Error("Review action target is ambiguous.");
              if (step.action === "fill" || step.action === "select") {
                if (typeof step.value !== "string" || step.value.length > 4000)
                  throw new Error("Invalid review action value.");
                if (step.action === "fill") await locator.fill(step.value);
                else await locator.selectOption(step.value);
              } else if (step.action === "click") await locator.click();
              else if (step.action === "check") await locator.check();
              else await locator.uncheck();
              if (new URL(page.url()).origin !== target.origin)
                throw new Error("Review action left its admitted deployment.");
            }
            let passed = false;
            if (check.kind === "url-path")
              passed = new URL(page.url()).pathname === check.expected;
            else {
              const locator = check.kind.startsWith("text-")
                ? page.getByText(check.text, { exact: true })
                : page.locator(check.selector);
              if (check.kind.endsWith("-absent"))
                passed = (await locator.count()) === 0;
              else
                passed =
                  (await locator.count()) === 1 && (await locator.isVisible());
            }
            receipt.status = passed ? "passed" : "failed";
            receipt.url = page.url();
            receipt.check = {
              kind: check.kind,
              path: check.path,
              ...(check.text ? { text: check.text } : {}),
              ...(check.selector ? { selector: check.selector } : {}),
              ...(check.expected ? { expected: check.expected } : {}),
            };
            const screenshotName = `review-screenshots/${receipt.id}.png`;
            const bytes = await page.screenshot({
              fullPage: true,
              timeout: 15_000,
            });
            if (
              bytes.length > 10 * 1024 * 1024 ||
              !bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            )
              throw new Error("Invalid screenshot.");
            writeFileSync(join(outputDirectory, screenshotName), bytes, {
              flag: "wx",
              mode: 0o600,
            });
            receipt.screenshot = {
              name: screenshotName,
              sha256: digest(bytes),
            };
            row.screenshots.push(receipt.screenshot);
          } catch {
            receipt.status = "blocked";
          } finally {
            await context?.close();
          }
        }
        row.assertions.push({
          criterion,
          status: receipt.status,
          receiptId: receipt.id,
        });
        if (receipt.status !== "passed")
          row.status =
            receipt.status === "failed" || row.status === "failed"
              ? "failed"
              : "blocked";
        receipts.push(receipt);
      }
      manifest.deliveries.push(row);
    }
  } finally {
    await browser?.close();
    for (const file of privateSessions) {
      try {
        safeFile(file);
        unlinkSync(file);
      } catch {
        /* Private sessions never become public artifacts. */
      }
    }
  }
  const bundle = {
    schema: 1,
    jobId: plan.jobId,
    planId: plan.id,
    commitSha,
    receipts,
  };
  const serialized = JSON.stringify({ manifest, receipts: bundle });
  const file = join(outputDirectory, "pm-review-proof.json");
  safeFile(file);
  writeFileSync(file, serialized, { mode: 0o600 });
  return {
    reviewProof: {
      file: "pm-review-proof.json",
      sha256: digest(serialized),
      planId: plan.id,
    },
  };
}
