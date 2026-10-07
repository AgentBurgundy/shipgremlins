import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCommitIdentity } from "./runtime.mjs";
import { verifySyncRepairAncestry } from "./sync-repair.mjs";

/** A model-authored report is evidence to review, never an executable action. */
export function readImplementationReport(directory, redact = (text) => text) {
  const file = join(directory, "implementation-report.json");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024
  )
    throw new Error(
      "Write a regular implementation-report.json under 64 KiB before delivery.",
    );
  try {
    return JSON.parse(redact(readFileSync(file, "utf8")));
  } catch {
    throw new Error("The implementation report must contain valid JSON.");
  }
}

function implementationReport(value, criteria) {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  const text = (v, limit) =>
    typeof v === "string" &&
    !!v.trim() &&
    v.length <= limit &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  if (
    !object(value) ||
    value.schema !== 1 ||
    !text(value.summary, 2000) ||
    !Array.isArray(value.acceptance) ||
    value.acceptance.length !== criteria.length ||
    value.acceptance.some(
      (entry, index) =>
        !object(entry) ||
        entry.criterion !== index + 1 ||
        !["verified", "not-verified"].includes(entry.status) ||
        !text(entry.evidence, 1200),
    ) ||
    !object(value.ui) ||
    typeof value.ui.changed !== "boolean" ||
    !["candidate-browser", "repository-only", "not-verified"].includes(
      value.ui.verification,
    ) ||
    !text(value.ui.evidence, 1200) ||
    !object(value.integration) ||
    !["real", "mocked", "not-applicable", "not-verified"].includes(
      value.integration.status,
    ) ||
    !text(value.integration.evidence, 1200) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 20 ||
    value.limitations.some((entry) => !text(entry, 500))
  )
    throw new Error(
      "The implementation report must summarize every acceptance criterion, UI evidence, integration evidence, and limitations before a draft can be published.",
    );
  return value;
}
// Quote all ticket/model prose; HTML, Markdown links and mentions are not authority.
const quote = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/([\\`*_\[\]])/g, "\\$1")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

export function validateDelivery(delivery) {
  const branch = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !value.includes("..");
  if (
    !delivery ||
    typeof delivery !== "object" ||
    Array.isArray(delivery) ||
    Object.keys(delivery).some(
      (key) =>
        ![
          "ticket",
          "title",
          "base",
          "branch",
          "repo",
          "acceptanceCriteria",
        ].includes(key),
    ) ||
    typeof delivery.ticket !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(delivery.ticket) ||
    typeof delivery.title !== "string" ||
    !delivery.title.trim() ||
    delivery.title.startsWith("-") ||
    delivery.title.length > 250 ||
    /[\r\n\0]/.test(delivery.title) ||
    !branch(delivery.base) ||
    !branch(delivery.branch) ||
    !delivery.branch.startsWith("gremlins/") ||
    delivery.branch === delivery.base ||
    typeof delivery.repo !== "string" ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(delivery.repo) ||
    delivery.repo.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "Developer jobs require a ticket, title, repository, base branch, and unique gremlins delivery branch.",
    );
  if (
    !Array.isArray(delivery.acceptanceCriteria) ||
    delivery.acceptanceCriteria.length < 1 ||
    delivery.acceptanceCriteria.length > 50 ||
    delivery.acceptanceCriteria.some(
      (item) =>
        typeof item !== "string" ||
        !item.trim() ||
        item.length > 4000 ||
        /[\r\n\0]/.test(item),
    ) ||
    JSON.stringify(delivery.acceptanceCriteria).length > 22000
  )
    throw new Error(
      "Developer jobs require a finite acceptance criteria checklist before delivery.",
    );
}

/** Source publication is reached only after every configured check succeeds. */
export async function runCheckedDelivery({
  commands,
  delivery,
  baseSha,
  repoUrl,
  provider,
  commitIdentity,
  run,
  publish,
  writeBody,
  prepareRepository,
  onCheck = () => {},
  report,
  syncRepair,
}) {
  validateDelivery(delivery);
  validateCommitIdentity(commitIdentity, provider);
  const identity = commitIdentity ?? {
    name: "ShipGremlins",
    email: "gremlins@shipgremlins.ai",
  };
  const commitOptions = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
  ];
  if (!/^[a-f0-9]{40}$/.test(baseSha))
    throw new Error("The original checkout commit is required.");
  if (typeof commands?.test !== "string" || !commands.test.trim())
    throw new Error(
      "A configured test command is required before publication.",
    );
  const repository = new URL(repoUrl);
  if (
    repository.pathname.replace(/^\//, "").replace(/\.git$/, "") !==
    delivery.repo
  )
    throw new Error(
      "The delivery repository does not match the cloned repository.",
    );
  const checks = [];
  for (const key of ["install", "test", "lint", "typecheck", "build"])
    if (commands[key]) {
      onCheck(key, "running");
      try {
        await run("/bin/bash", ["-o", "pipefail", "-lc", commands[key]]);
        onCheck(key, "succeeded");
      } catch (error) {
        onCheck(key, "failed");
        throw error;
      }
      checks.push(key);
    }
  await prepareRepository();
  const active = (await run("git", ["branch", "--show-current"])).trim();
  if (active !== delivery.branch)
    throw new Error(
      "The agent changed delivery branches. No changes were published.",
    );
  const status = (await run("git", ["status", "--porcelain"])).trim();
  if (status) {
    await run("git", ["add", "--all"]);
    await run("git", [
      ...commitOptions,
      "commit",
      "-m",
      `${delivery.ticket}: ${delivery.title}`,
    ]);
  }
  const changed = (
    await run("git", ["diff", "--name-only", baseSha, "HEAD"])
  ).trim();
  // A merge can reconcile ancestry without changing the tree (for example when
  // staging independently contains the same fix). That merge must still ship.
  if (!changed && !syncRepair) return { checks, noChanges: true };
  const evidence = implementationReport(report, delivery.acceptanceCriteria);
  // A model may have committed everything already. Normalize the final commit's
  // identity without changing its tested tree; never publish an invented author.
  if (!status && commitIdentity)
    await run("git", [
      ...commitOptions,
      "commit",
      "--amend",
      "--no-edit",
      "--reset-author",
    ]);
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Could not identify the tested commit.");
  if (syncRepair)
    await verifySyncRepairAncestry({
      integrationSha: baseSha,
      stagingSha: syncRepair.stagingSha,
      run,
    });
  const uiChanged =
    evidence.ui.changed ||
    changed
      .split(/\r?\n/)
      .some((file) =>
        /\.(?:tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i.test(file),
      );
  const limitations = [...evidence.limitations];
  if (uiChanged && evidence.ui.verification !== "candidate-browser")
    limitations.push(
      "Candidate UI appearance and interactions have not been browser-verified. Repository checks do not prove visual correctness.",
    );
  if (evidence.integration.status === "mocked")
    limitations.push(
      "Only mocked integration evidence was reported. Real provider behavior is not verified and this draft is not a completed integration.",
    );
  if (evidence.integration.status === "not-verified")
    limitations.push("Integration behavior remains unverified.");
  if (evidence.acceptance.some((entry) => entry.status !== "verified"))
    limitations.push(
      "One or more acceptance criteria remain unverified; this draft is incomplete.",
    );
  const body = `Implements ${delivery.ticket}.\n\n## Change\n${quote(evidence.summary)}\n\n## Acceptance evidence\nDeveloper-reported observations for independent QA; these are not verified acceptance results.\n\n${delivery.acceptanceCriteria.map((criterion, index) => `### ${index + 1}. ${evidence.acceptance[index].status === "verified" ? "Reported verified" : "Not verified"}\n${quote(criterion)}\n\n${quote(evidence.acceptance[index].evidence)}`).join("\n\n")}\n\n## Checks rerun by the worker\n${checks.map((check) => `- ${check}: passed`).join("\n")}\n\nTested commit: ${commit}\n\n## UI and integration evidence\nUI: ${uiChanged ? evidence.ui.verification : "no UI change reported"}.\n${quote(evidence.ui.evidence)}\n\nIntegration: ${evidence.integration.status} (developer-reported).\n${quote(evidence.integration.evidence)}\n\n## Limitations\n${limitations.length ? limitations.map((item) => quote(item)).join("\n\n") : "No additional limitations reported; independent acceptance verification is still required."}\n\nRecorded artifacts and redacted execution logs are available in the job dashboard; only actually recorded artifacts count as evidence. This draft has not been merged or promoted.\n`;
  if (Buffer.byteLength(body) > 60 * 1024)
    throw new Error(
      "The implementation evidence is too large for a reviewable draft. Shorten the report without omitting acceptance criteria or limitations.",
    );
  await writeBody(body);
  // Do not trust origin or hooks that the application/model could have edited.
  await publish("git", [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "push",
    repoUrl,
    `HEAD:refs/heads/${delivery.branch}`,
  ]);
  const output =
    provider === "gitlab"
      ? await publish("glab", [
          "mr",
          "create",
          "--draft",
          "--yes",
          "--source-branch",
          delivery.branch,
          "--target-branch",
          delivery.base,
          "--title",
          delivery.title,
          "--description-file",
          "/work/pr-body.md",
          "--repo",
          delivery.repo,
        ])
      : await publish("gh", [
          "pr",
          "create",
          "--draft",
          "--head",
          delivery.branch,
          "--base",
          delivery.base,
          "--title",
          delivery.title,
          "--body-file",
          "/work/pr-body.md",
          "--repo",
          delivery.repo,
        ]);
  const candidates = output.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const prUrl = candidates.find((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        url.origin === repository.origin &&
        !url.search &&
        !url.hash &&
        (provider === "gitlab"
          ? url.pathname.startsWith("/" + delivery.repo + "/-/merge_requests/")
          : url.pathname.startsWith("/" + delivery.repo + "/pull/"))
      );
    } catch {
      return false;
    }
  });
  if (!prUrl)
    throw new Error(
      "The draft may have been created, but its URL could not be confirmed. Inspect the source provider before retrying.",
    );
  return { checks, prUrl, headSha: commit };
}
