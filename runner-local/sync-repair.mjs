import { existsSync } from "node:fs";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** This is controller-issued metadata, never a public queue request field. */
export function validateSyncRepairPayload(input) {
  if (input.syncRepair === undefined) return;
  const sync = input.syncRepair;
  if (
    !sync ||
    typeof sync !== "object" ||
    Array.isArray(sync) ||
    Object.keys(sync).some((key) => key !== "stagingSha") ||
    !sha(sync.stagingSha) ||
    !sha(input.expectedCommitSha) ||
    sync.stagingSha === input.expectedCommitSha ||
    input.kind !== "developer" ||
    !input.delivery ||
    input.delivery.base !== input.branch ||
    input.browserVerification !== false ||
    input.browserTarget !== undefined ||
    input.testEnvironment !== undefined ||
    input.reviewPlan !== undefined ||
    input.pmMode !== undefined ||
    input.grumblin !== undefined ||
    input.grumblinTarget !== undefined ||
    Object.keys(input.credentials ?? {}).some(
      (key) =>
        ![
          input.provider === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ].includes(key),
    )
  )
    throw new Error(
      "Sync repair requires pinned staging and integration revisions, a developer draft, and only source and Claude credentials.",
    );
}

/** Run before the model starts, with the private source credential. */
export async function prepareSyncRepairCheckout({
  integrationSha,
  stagingSha,
  run,
}) {
  if (!sha(integrationSha) || !sha(stagingSha))
    throw new Error("Invalid sync repair revisions.");
  const shallow = (
    await run("git", ["rev-parse", "--is-shallow-repository"])
  ).trim();
  await run("git", [
    "fetch",
    "--no-tags",
    ...(shallow === "true" ? ["--unshallow"] : []),
    "origin",
    integrationSha,
    stagingSha,
  ]);
  if (
    (await run("git", ["rev-parse", "--is-shallow-repository"])).trim() !==
    "false"
  )
    throw new Error(
      "Sync repair requires the complete history of both admitted branches.",
    );
  for (const revision of [integrationSha, stagingSha])
    if (
      (
        await run("git", ["rev-parse", "--verify", `${revision}^{commit}`])
      ).trim() !== revision
    )
      throw new Error("An admitted sync repair revision could not be fetched.");
  await run("git", ["merge-base", integrationSha, stagingSha]);
}

/** Check Git ancestry itself; a model report never authorizes a sync merge. */
export async function verifySyncRepairAncestry({
  integrationSha,
  stagingSha,
  run,
}) {
  if (!sha(integrationSha) || !sha(stagingSha))
    throw new Error("Invalid sync repair revisions.");
  const grafts = (
    await run("git", [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/grafts",
    ])
  ).trim();
  if (
    existsSync(grafts) ||
    (await run("git", ["rev-parse", "--is-shallow-repository"])).trim() !==
      "false"
  )
    throw new Error(
      "Sync repair history was modified. No changes were published.",
    );
  for (const revision of [integrationSha, stagingSha]) {
    try {
      await run("git", [
        "--no-replace-objects",
        "-c",
        "core.commitGraph=false",
        "merge-base",
        "--is-ancestor",
        revision,
        "HEAD",
      ]);
    } catch {
      throw new Error(
        "Sync repair must preserve both admitted branch histories. No changes were published.",
      );
    }
  }
}
