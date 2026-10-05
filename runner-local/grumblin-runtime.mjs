import { validateGrumblinProfileSnapshot } from "./grumblin-profile.mjs";

/** Reject mismatched modes, production targets, and provider write credentials before execution. */
export function validateGrumblinPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Grumblin job.");
  if (input.pmMode !== "grumblin") {
    if (input.grumblin !== undefined || input.grumblinTarget !== undefined)
      throw new Error("A Grumblin profile requires Grumblin mode.");
    return;
  }
  const snapshot = validateGrumblinProfileSnapshot(input.grumblin);
  const target = input.grumblinTarget;
  if (
    input.kind !== "pm" ||
    input.browserVerification !== true ||
    input.delivery ||
    input.reviewPlan ||
    (input.project !== undefined && input.project !== snapshot.project) ||
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    Object.keys(target).some((key) => !["url", "role"].includes(key)) ||
    !["preview", "staging"].includes(target.role)
  )
    throw new Error(
      "Grumblins require their selected non-production browser environment and cannot publish or review deliveries.",
    );
  let url;
  try {
    url = new URL(target.url);
  } catch {
    throw new Error("Grumblins require a valid test URL.");
  }
  if (
    typeof target.url !== "string" ||
    target.url.length > 2048 ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Grumblins require a credential-free test URL.");
  if (
    Object.keys(input.credentials ?? {}).some(
      (key) =>
        ![
          "GITHUB_TOKEN",
          "GITLAB_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "GREMLINS_PREVIEW_BYPASS",
        ].includes(key) &&
        !/^GREMLINS_TEST_(USERNAME|PASSWORD)_[1-8]$/.test(key),
    )
  )
    throw new Error(
      "Grumblins accept only source, Claude, and dedicated browser-test credentials; no Linear or hosting credentials.",
    );
  return snapshot;
}
