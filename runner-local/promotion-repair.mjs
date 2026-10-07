import {
  prepareSyncRepairCheckout,
  verifySyncRepairAncestry,
} from "./sync-repair.mjs";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const safePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1000 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !/^[a-z]:/i.test(value) &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  value
    .split("/")
    .every(
      (part) =>
        part && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
    );
const validIntent = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) =>
    ["stagingSha", "sourceShas", "allowedPaths"].includes(key),
  ) &&
  sha(value.stagingSha) &&
  Array.isArray(value.sourceShas) &&
  value.sourceShas.length >= 1 &&
  value.sourceShas.length <= 100 &&
  value.sourceShas.every(sha) &&
  new Set(value.sourceShas).size === value.sourceShas.length &&
  Array.isArray(value.allowedPaths) &&
  value.allowedPaths.length >= 1 &&
  value.allowedPaths.length <= 1000 &&
  value.allowedPaths.every(safePath) &&
  new Set(value.allowedPaths).size === value.allowedPaths.length;
const git = (run, args) =>
  run("git", ["--no-replace-objects", "-c", "core.commitGraph=false", ...args]);
export const promotionPortRef = (nonce) => {
  if (typeof nonce !== "string" || !/^job-[a-z0-9-]{1,58}$/.test(nonce))
    throw new Error("Invalid promotion repair job identity.");
  return `refs/heads/gremlins-port-${nonce}`;
};

/** Controller metadata only. Public job requests never accept this field. */
export function validatePromotionRepairPayload(input) {
  if (input.promotionRepair === undefined) return;
  if (
    !validIntent(input.promotionRepair) ||
    !sha(input.expectedCommitSha) ||
    input.kind !== "developer" ||
    !input.delivery ||
    input.delivery.base !== input.branch ||
    input.delivery.branch !== `gremlins/${input.nonce}` ||
    input.browserVerification !== false ||
    input.browserTarget !== undefined ||
    input.testEnvironment !== undefined ||
    input.syncRepair !== undefined ||
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
      "Promotion repair requires pinned branch histories, a finite source/file scope, a developer draft and only source and Claude credentials.",
    );
  promotionPortRef(input.nonce);
}

async function admittedHistory(integrationSha, repair, run) {
  if (!sha(integrationSha) || !validIntent(repair))
    throw new Error("Invalid promotion repair admission.");
  for (const revision of [repair.stagingSha, ...repair.sourceShas]) {
    if (
      (
        await git(run, ["rev-parse", "--verify", `${revision}^{commit}`])
      ).trim() !== revision
    )
      throw new Error("An admitted promotion source revision is unavailable.");
    try {
      await git(run, ["merge-base", "--is-ancestor", revision, integrationSha]);
    } catch {
      throw new Error(
        "Promotion repair requires current staging and every admitted source change in integration first.",
      );
    }
  }
}

/** Fetch before the model starts, while source access is still private. */
export async function preparePromotionRepairCheckout({
  integrationSha,
  repair,
  run,
}) {
  if (!validIntent(repair))
    throw new Error("Invalid promotion repair admission.");
  await prepareSyncRepairCheckout({
    integrationSha,
    stagingSha: repair.stagingSha,
    run,
  });
  await admittedHistory(integrationSha, repair, run);
}

/** Git objects and exact tested trees establish provenance, never a model result field. */
export async function verifyPromotionRepairSource({
  integrationSha,
  repair,
  nonce,
  commitIdentity,
  run,
}) {
  if (!validIntent(repair))
    throw new Error("Invalid promotion repair admission.");
  await verifySyncRepairAncestry({
    integrationSha,
    stagingSha: repair.stagingSha,
    run,
  });
  await admittedHistory(integrationSha, repair, run);
  const sourceSha = (
    await git(run, [
      "rev-parse",
      "--verify",
      `${promotionPortRef(nonce)}^{commit}`,
    ])
  ).trim();
  if (!sha(sourceSha))
    throw new Error("The standalone promotion source commit is unavailable.");
  const sourceIdentity = (
    await git(run, [
      "show",
      "--no-patch",
      "--format=%an%x00%ae%x00%cn%x00%ce",
      sourceSha,
    ])
  )
    .trim()
    .split("\0");
  if (
    !commitIdentity ||
    sourceIdentity.length !== 4 ||
    sourceIdentity[0] !== commitIdentity.name ||
    sourceIdentity[1] !== commitIdentity.email ||
    sourceIdentity[2] !== commitIdentity.name ||
    sourceIdentity[3] !== commitIdentity.email
  )
    throw new Error(
      "The isolated promotion source must use the configured verified source-account author and committer identity.",
    );
  const parents = (
    await git(run, ["rev-list", "--parents", "-n", "1", sourceSha])
  )
    .trim()
    .split(/\s+/);
  if (
    parents.length !== 2 ||
    parents[0] !== sourceSha ||
    parents[1] !== repair.stagingSha
  )
    throw new Error(
      "The promotion source must be one isolated commit whose only parent is admitted staging.",
    );
  try {
    await git(run, ["merge-base", "--is-ancestor", sourceSha, "HEAD"]);
  } catch {
    throw new Error(
      "The final integration draft must include the independently identified promotion source.",
    );
  }
  const paths = async (base, head) =>
    (
      await git(run, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        base,
        head,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean);
  const sourcePaths = await paths(repair.stagingSha, sourceSha);
  const finalPaths = await paths(integrationSha, "HEAD");
  const allowed = new Set(repair.allowedPaths);
  if (
    !sourcePaths.length ||
    [...sourcePaths, ...finalPaths].some(
      (path) => !safePath(path) || !allowed.has(path),
    )
  )
    throw new Error(
      "Promotion repair changed files outside its admitted ticket lineage or produced an empty port.",
    );
  // An ancestry-only or ours merge must not claim that untested source code was
  // exercised. The final integration tree must contain the exact ported blobs
  // and modes. Overlapping unrelated edits that cannot satisfy this stay blocked.
  const selectedTree = async (revision) => {
    const entries = new Map();
    // Large applications can exceed the runner's complete-output bound. Ask
    // only for the admitted finite paths, in chunks bounded by pathname length.
    for (let offset = 0; offset < sourcePaths.length; offset += 100) {
      const output = await git(run, [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        revision,
        "--",
        ...sourcePaths.slice(offset, offset + 100),
      ]);
      for (const entry of output.split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        entries.set(entry.slice(tab + 1), entry.slice(0, tab));
      }
    }
    return entries;
  };
  const sourceTree = await selectedTree(sourceSha);
  const finalTree = await selectedTree("HEAD");
  if (sourcePaths.some((path) => sourceTree.get(path) !== finalTree.get(path)))
    throw new Error(
      "Integration does not contain the exact promotion source content and file modes. The port cannot inherit QA of different code.",
    );
  return { promotionSourceSha: sourceSha, promotionBaseSha: repair.stagingSha };
}
