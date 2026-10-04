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
      (key) => !["ticket", "title", "base", "branch", "repo"].includes(key),
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
}

/** Source publication is reached only after every configured check succeeds. */
export async function runCheckedDelivery({
  commands,
  delivery,
  baseSha,
  repoUrl,
  provider,
  run,
  publish,
  writeBody,
  prepareRepository,
  onCheck = () => {},
}) {
  validateDelivery(delivery);
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
        await run("/bin/bash", ["-lc", commands[key]]);
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
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=ShipGremlins",
      "-c",
      "user.email=gremlins@shipgremlins.ai",
      "commit",
      "-m",
      `${delivery.ticket}: ${delivery.title}`,
    ]);
  }
  const changed = (
    await run("git", ["diff", "--name-only", baseSha, "HEAD"])
  ).trim();
  if (!changed) return { checks, noChanges: true };
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Could not identify the tested commit.");
  const body = `Implements ${delivery.ticket}.\n\nThis draft was opened by a local ShipGremlins worker after these checks passed:\n${checks.map((check) => `- ${check}`).join("\n")}\n\nTested commit: ${commit}\n\nBrowser screenshots and redacted execution logs are available in the local job dashboard. This draft requires review; it has not been merged or promoted.\n`;
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
  return { checks, prUrl };
}
