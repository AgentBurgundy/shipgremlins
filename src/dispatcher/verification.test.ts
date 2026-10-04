import { describe, expect, it } from "vitest";
import type { Comment } from "../forge/types.ts";
import { passingEvidence } from "./verification.test-support.ts";
import {
  candidateEvidenceError,
  formatBrowserEvidence,
  trustedVerdict,
  type CandidateVerification,
} from "./verification.ts";
import { FAILED_PREFIX, VERIFIED_PREFIX } from "./notes.ts";

const SHA = "a".repeat(40);
const BOT = "shipgremlins[bot]";
const comment = (body: string, author = BOT, id = 1): Comment => ({
  id,
  body,
  author,
  createdAt: "2026-10-04T12:00:00Z",
});

describe("authenticated verification", () => {
  it("requires a trusted author and exact source revision instead of prose success", () => {
    expect(
      trustedVerdict([comment(`${VERIFIED_PREFIX} works!`)], BOT, SHA),
    ).toBe("untested");
    expect(
      trustedVerdict(
        [comment(formatBrowserEvidence(passingEvidence(SHA)), "stranger")],
        BOT,
        SHA,
      ),
    ).toBe("untested");
    expect(
      trustedVerdict(
        [comment(formatBrowserEvidence(passingEvidence("b".repeat(40))))],
        BOT,
        SHA,
      ),
    ).toBe("untested");
    expect(
      trustedVerdict(
        [comment(formatBrowserEvidence(passingEvidence(SHA)))],
        BOT,
        SHA,
      ),
    ).toBe("verified");
  });

  it("orders provider comments and invalidates a pass after later failure or malformed evidence", () => {
    const pass = comment(formatBrowserEvidence(passingEvidence(SHA)), BOT, 1);
    const fail = comment(
      formatBrowserEvidence(passingEvidence(SHA, "failed")),
      BOT,
      2,
    );
    expect(trustedVerdict([fail, pass], BOT, SHA)).toBe("failed");
    expect(
      trustedVerdict(
        [pass, comment(`${FAILED_PREFIX} regression`, BOT, 3)],
        BOT,
        SHA,
      ),
    ).toBe("failed");
    expect(
      trustedVerdict(
        [
          pass,
          comment("<!-- shipgremlins-verification: malformed -->", BOT, 3),
        ],
        BOT,
        SHA,
      ),
    ).toBe("untested");
  });

  it.each([
    "wrong-sha",
    "missing-screenshot",
    "blocked-assertion",
    "deployment-sha",
    "untrusted-author",
  ])("rejects %s evidence for the final candidate", (scenario) => {
    const candidate: CandidateVerification = {
      branch: "pm-release/core/20261004",
      releaseBranch: "pm-release/core/20261004",
      sha: SHA,
      baseSha: "b".repeat(40),
      checkoutDir: "/target",
      changes: [1],
    };
    const evidence = passingEvidence(SHA);
    if (scenario === "wrong-sha") evidence.sourceSha = "c".repeat(40);
    if (scenario === "missing-screenshot") evidence.screenshots = [];
    if (scenario === "blocked-assertion")
      evidence.assertions[0]!.status = "blocked";
    if (scenario === "deployment-sha") evidence.deployment.sha = "d".repeat(40);
    const error = candidateEvidenceError(
      {
        ok: true,
        author: scenario === "untrusted-author" ? "stranger" : BOT,
        evidence,
      },
      candidate,
      BOT,
    );
    expect(error).not.toBeNull();
  });
});
