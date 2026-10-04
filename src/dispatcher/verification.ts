import type { Comment } from "../forge/types.ts";
import { FAILED_PREFIX } from "./notes.ts";

export const VERIFICATION_MARKER = "shipgremlins-verification";
export interface BrowserEvidence {
  schemaVersion: 1;
  sourceSha: string;
  testedSha: string;
  status: "passed" | "failed" | "blocked";
  runId: string;
  deployment: { id: string; url: string; sha: string };
  screenshots: string[];
  assertions: { name: string; status: "passed" | "failed" | "blocked" }[];
}

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const https = (value: unknown): value is string => {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Runtime validation: incomplete or unknown records never authorize release. */
export function isBrowserEvidence(value: unknown): value is BrowserEvidence {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<BrowserEvidence>;
  return (
    e.schemaVersion === 1 &&
    sha(e.sourceSha) &&
    sha(e.testedSha) &&
    ["passed", "failed", "blocked"].includes(e.status ?? "") &&
    nonempty(e.runId) &&
    nonempty(e.deployment?.id) &&
    https(e.deployment?.url) &&
    e.deployment?.sha === e.testedSha &&
    Array.isArray(e.screenshots) &&
    e.screenshots.length > 0 &&
    e.screenshots.every(https) &&
    Array.isArray(e.assertions) &&
    e.assertions.length > 0 &&
    e.assertions.every(
      (a) =>
        a &&
        nonempty(a.name) &&
        ["passed", "failed", "blocked"].includes(a.status),
    ) &&
    (e.status !== "passed" || e.assertions.every((a) => a.status === "passed"))
  );
}

export const formatBrowserEvidence = (e: BrowserEvidence): string =>
  `<!-- ${VERIFICATION_MARKER}: ${JSON.stringify(e)} -->`;

/** Only the authenticated forge author's latest record for this exact change counts. */
export function trustedVerdict(
  comments: Comment[],
  trustedAuthor: string,
  sourceSha: string,
): "verified" | "failed" | "untested" {
  const ordered = comments
    .filter((c) => c.author === trustedAuthor)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  let verdict: "verified" | "failed" | "untested" = "untested";
  for (const c of ordered) {
    if (c.body.trim().startsWith(FAILED_PREFIX)) {
      verdict = "failed";
      continue;
    }
    if (!c.body.includes(VERIFICATION_MARKER)) continue;
    const match = c.body.match(/<!-- shipgremlins-verification: (.*?) -->/s);
    if (!match) {
      verdict = "untested";
      continue;
    }
    try {
      const record: unknown = JSON.parse(match[1]!);
      if (!isBrowserEvidence(record)) {
        verdict = "untested";
        continue;
      }
      if (record.sourceSha !== sourceSha) continue;
      verdict = record.status === "passed" ? "verified" : "failed";
    } catch {
      verdict = "untested";
    }
  }
  return verdict;
}

export interface CandidateVerification {
  branch: string;
  releaseBranch: string;
  sha: string;
  baseSha: string;
  checkoutDir: string;
  changes: number[];
}
export type CandidateVerificationResult =
  | { ok: true; author: string; evidence: BrowserEvidence }
  | { ok: false; reason: string };

export function candidateEvidenceError(
  result: CandidateVerificationResult,
  candidate: CandidateVerification,
  trustedAuthor: string,
): string | null {
  if (!result.ok) return result.reason || "candidate verification did not pass";
  if (result.author !== trustedAuthor)
    return "candidate verifier identity is not trusted";
  if (!isBrowserEvidence(result.evidence))
    return "candidate browser evidence is incomplete or invalid";
  if (
    result.evidence.sourceSha !== candidate.sha ||
    result.evidence.testedSha !== candidate.sha
  )
    return "candidate browser evidence belongs to a different revision";
  if (result.evidence.status !== "passed")
    return `candidate browser verification ${result.evidence.status}`;
  return null;
}
