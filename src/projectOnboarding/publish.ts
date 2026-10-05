import type { Project } from "../config.ts";
import { digest } from "./store.ts";
import { object, SHA, sourceApi, sourceRequest } from "./repository.ts";
import {
  ProjectOnboardingError,
  type OnboardingReport,
  type SetupPull,
} from "./types.ts";

/** Only a draft on our deterministic branch is created; existing app files are never overwritten. */
export async function publishSetupDraft(
  project: Project,
  report: OnboardingReport,
  token: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<SetupPull> {
  const api = sourceApi(project),
    github = report.repository.provider === "github";
  const base = report.repository.sha,
    branch = `gremlins/setup-${base.slice(0, 12)}-${digest(JSON.stringify(report.proposedFiles)).slice(0, 12)}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ) =>
    sourceRequest(
      fetcher,
      api + path,
      token,
      signal,
      method,
      body,
      missing,
    ).then((r) => r.value);
  const conflict = () =>
    new ProjectOnboardingError(
      "The setup branch already contains unexpected changes. Review it in your source provider; no branch was overwritten.",
      409,
      "publication_conflict",
    );
  if (!report.proposedFiles.length)
    throw new ProjectOnboardingError(
      "There are no proposed setup files to publish. Use the existing recipe or analyze again.",
    );
  // Prove absence at the immutable base even when the repository tree was truncated.
  for (const file of report.proposedFiles) {
    const existing = await request(
      github
        ? `/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${base}`
        : `/repository/files/${encodeURIComponent(file.path)}?ref=${base}`,
      "GET",
      undefined,
      true,
    );
    if (existing !== null)
      throw new ProjectOnboardingError(
        "A proposed setup file already exists at the analyzed commit. Reanalyze without overwriting it.",
        409,
      );
  }
  let head: string | undefined;
  const ref = await request(
    github
      ? `/git/ref/heads/${branch}`
      : `/repository/branches/${encodeURIComponent(branch)}`,
    "GET",
    undefined,
    true,
  );
  if (ref !== null) {
    const commit = object(ref) ? (github ? ref.object : ref.commit) : null;
    head = object(commit) ? String(github ? commit.sha : commit.id) : undefined;
    if (!head || !SHA.test(head)) throw conflict();
    const detail = await request(
      github ? `/commits/${head}` : `/repository/commits/${head}`,
    );
    if (!object(detail)) throw conflict();
    const parents = github ? detail.parents : detail.parent_ids;
    if (
      !Array.isArray(parents) ||
      parents.length !== 1 ||
      (github ? parents[0]?.sha : parents[0]) !== base
    )
      throw conflict();
    const changes = github
      ? detail.files
      : await request(`/repository/commits/${head}/diff?per_page=100`);
    if (
      !Array.isArray(changes) ||
      changes.length !== report.proposedFiles.length ||
      changes.some(
        (change) =>
          !object(change) ||
          !(github ? change.status === "added" : change.new_file === true) ||
          !report.proposedFiles.some(
            (file) =>
              file.path === (github ? change.filename : change.new_path),
          ),
      )
    )
      throw conflict();
    for (const file of report.proposedFiles) {
      const data = await request(
        github
          ? `/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`
          : `/repository/files/${encodeURIComponent(file.path)}?ref=${head}`,
      );
      if (
        !object(data) ||
        data.encoding !== "base64" ||
        typeof data.content !== "string" ||
        Buffer.from(data.content, "base64").toString("utf8") !== file.content
      )
        throw conflict();
    }
  } else if (github) {
    const baseCommit = await request(`/git/commits/${base}`);
    if (
      !object(baseCommit) ||
      !object(baseCommit.tree) ||
      typeof baseCommit.tree.sha !== "string" ||
      !SHA.test(baseCommit.tree.sha)
    )
      throw new Error();
    const tree = await request("/git/trees", "POST", {
      base_tree: baseCommit.tree.sha,
      tree: report.proposedFiles.map((file) => ({
        path: file.path,
        mode: file.path.endsWith(".sh") ? "100755" : "100644",
        type: "blob",
        content: file.content,
      })),
    });
    if (!object(tree) || typeof tree.sha !== "string" || !SHA.test(tree.sha))
      throw new Error();
    const commit = await request("/git/commits", "POST", {
      message: "Add reviewable ShipGremlins test setup",
      tree: tree.sha,
      parents: [base],
    });
    if (
      !object(commit) ||
      typeof commit.sha !== "string" ||
      !SHA.test(commit.sha)
    )
      throw new Error();
    head = commit.sha;
    await request("/git/refs", "POST", {
      ref: `refs/heads/${branch}`,
      sha: head,
    });
  } else {
    const commit = await request("/repository/commits", "POST", {
      branch,
      start_sha: base,
      commit_message: "Add reviewable ShipGremlins test setup",
      actions: report.proposedFiles.map((file) => ({
        action: "create",
        file_path: file.path,
        content: file.content,
        execute_filemode: file.path.endsWith(".sh"),
      })),
    });
    if (
      !object(commit) ||
      typeof commit.id !== "string" ||
      !SHA.test(commit.id)
    )
      throw new Error();
    head = commit.id;
  }
  const owner = project.config.repo.split("/")[0]!;
  const existing = await request(
    github
      ? `/pulls?state=all&head=${encodeURIComponent(owner + ":" + branch)}&base=${encodeURIComponent(report.repository.branch)}&per_page=100`
      : `/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(report.repository.branch)}&per_page=100`,
  );
  if (!Array.isArray(existing) || existing.length > 1) throw conflict();
  const description = `## Reviewable test-environment setup\n\n${report.summary}\n\nAnalyzed base commit: \`${base}\`. This draft adds setup files only. No application code was changed, no environment was provisioned, and no tests were claimed to pass. Review generated commands and synthetic-data behavior before merging. Merge and reanalyze before selecting new recipe files.\n\n### Proposed files\n${report.proposedFiles.map((file) => `- \`${file.path}\`: ${file.reason}`).join("\n")}\n\n### Inputs still needed\n${report.missingInputs.map((item) => `- ${item.label}: ${item.description}`).join("\n") || "None identified; verify this assessment."}\n\nCreated by ShipGremlins Setup Gremlin. No automatic merge.`;
  const pull =
    existing[0] ??
    (await request(
      github ? "/pulls" : "/merge_requests",
      "POST",
      github
        ? {
            title: "Set up a local test environment for ShipGremlins",
            body: description,
            head: branch,
            base: report.repository.branch,
            draft: true,
          }
        : {
            title: "Draft: Set up a local test environment for ShipGremlins",
            description,
            source_branch: branch,
            target_branch: report.repository.branch,
            remove_source_branch: false,
          },
    ));
  if (!object(pull)) throw conflict();
  if (["closed", "merged"].includes(String(pull.state)) || pull.merged_at)
    throw new ProjectOnboardingError(
      "The existing setup draft was closed or merged. Review that pull request and reanalyze the latest repository before preparing another draft.",
      409,
    );
  const url = github ? pull.html_url : pull.web_url,
    number = github ? pull.number : pull.iid;
  const origin =
    project.config.serverUrl ??
    (github ? "https://github.com" : "https://gitlab.com");
  if (
    typeof url !== "string" ||
    new URL(url).origin !== new URL(origin).origin ||
    !Number.isSafeInteger(number) ||
    Number(number) < 1 ||
    (github
      ? pull.draft !== true
      : !(
          pull.draft === true ||
          pull.work_in_progress === true ||
          String(pull.title).startsWith("Draft:")
        ))
  )
    throw conflict();
  return { url, number: Number(number), branch, baseSha: base };
}
