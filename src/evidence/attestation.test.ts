import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../services/fakes.ts";
import type { CandidateVerification } from "../dispatcher/verification.ts";
import { passingEvidence } from "../dispatcher/verification.test-support.ts";
import { createCandidateVerifier, signAttestation } from "./attestation.ts";

// Complete 1x1 PNG, sufficient for validating the artifact contract in a unit test.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
const keys = () =>
  generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const { privateKey: KEY, publicKey: PUBLIC } = keys();
const CANDIDATE = "c".repeat(40);
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-evidence-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const ctx = makeCtx();
  const dir = join(root, "evidence");
  mkdirSync(dir);
  writeFileSync(join(dir, "screen.png"), PNG);
  const file = join(dir, "signed.json");
  const candidate: CandidateVerification = {
    branch: "pm-release/core/20261002",
    releaseBranch: "pm-release/core/20261002",
    sha: CANDIDATE,
    baseSha: "b".repeat(40),
    changes: [10, 20],
    checkoutDir: "/target",
  };
  const evidence = passingEvidence(CANDIDATE);
  const payload = {
    version: 1,
    project: ctx.project.config.name,
    repo: ctx.project.config.repo,
    branch: candidate.branch,
    releaseBranch: candidate.releaseBranch,
    candidateSha: CANDIDATE,
    baseSha: candidate.baseSha,
    changes: candidate.changes,
    author: ctx.botLogin,
    issuedAt: "2026-10-02T11:00:00Z",
    expiresAt: "2026-10-02T13:00:00Z",
    evidence,
    artifacts: [
      {
        path: "screen.png",
        url: evidence.screenshots[0]!,
        sha256: "untrusted-draft-value",
      },
    ],
  };
  ctx.vercel.seedDeployment("prj_game", candidate.branch, {
    state: "READY",
    sha: CANDIDATE,
    id: evidence.deployment.id,
    url: "candidate.example.test",
  });
  const save = (value: unknown = payload, key = KEY) => {
    const signed = signAttestation(value, key, dir);
    writeFileSync(file, JSON.stringify(signed));
    return signed;
  };
  const verify = () =>
    createCandidateVerifier(ctx, { file, key: PUBLIC })(candidate);
  return { ctx, dir, file, candidate, payload, save, verify };
}

describe("signed browser attestation", () => {
  it("computes actual local image hashes and verifies a matching ready deployment", async () => {
    const f = fixture();
    const signed = f.save();
    expect(signed.payload.artifacts[0]?.sha256).toBe(
      createHash("sha256").update(PNG).digest("hex"),
    );
    expect(await f.verify()).toMatchObject({
      ok: true,
      author: f.ctx.botLogin,
    });
  });

  it("rejects modified payloads and another signer's key", async () => {
    const f = fixture();
    const signed = f.save();
    signed.payload.evidence.runId = "tampered-run";
    writeFileSync(f.file, JSON.stringify(signed));
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: "Attestation signature does not match",
    });
    f.save(f.payload, keys().privateKey);
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: "Attestation signature does not match",
    });
  });

  it.each([
    "project",
    "repo",
    "author",
    "branch",
    "releaseBranch",
    "baseSha",
    "candidateSha",
    "changes",
  ])("rejects correctly signed evidence for another %s", async (field) => {
    const f = fixture();
    const other = {
      ...f.payload,
      [field]:
        field === "changes"
          ? [10, 30]
          : field.endsWith("Sha")
            ? "d".repeat(40)
            : "another-value",
    };
    if (field === "candidateSha")
      other.evidence = passingEvidence("d".repeat(40));
    f.save(other);
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason:
        "Attestation does not match this project, candidate, base, changes and verifier",
    });
  });

  it("compares required changes as a set and rejects duplicates", async () => {
    const f = fixture();
    f.save({ ...f.payload, changes: [20, 10] });
    expect(await f.verify()).toMatchObject({ ok: true });
    expect(() => f.save({ ...f.payload, changes: [10, 10, 20] })).toThrow(
      "complete, passing evidence",
    );
  });

  it.each([
    ["expired", "2026-10-02T10:00:00Z", "2026-10-02T12:00:00Z"],
    ["future", "2026-10-02T12:01:00Z", "2026-10-02T13:00:00Z"],
  ])("rejects %s attestations", async (_name, issuedAt, expiresAt) => {
    const f = fixture();
    f.save({ ...f.payload, issuedAt, expiresAt });
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: "Attestation is expired or not yet valid",
    });
  });

  it("enforces key strength and a positive validity window of no more than 24 hours", () => {
    const f = fixture();
    expect(() => f.save(f.payload, "short")).toThrow("Ed25519 private PEM");
    expect(() =>
      f.save({ ...f.payload, expiresAt: f.payload.issuedAt }),
    ).toThrow("24 hours");
    expect(() =>
      f.save({ ...f.payload, expiresAt: "2026-10-03T11:00:01Z" }),
    ).toThrow("24 hours");
    expect(() =>
      f.save({ ...f.payload, expiresAt: "2026-10-03T11:00:00Z" }),
    ).not.toThrow();
  });

  it("rejects a private signing key in the dispatcher and rejects non-Ed25519 keys", async () => {
    const f = fixture();
    f.save();
    expect(
      await createCandidateVerifier(f.ctx, { file: f.file, key: KEY })(
        f.candidate,
      ),
    ).toMatchObject({ ok: false });
    const wrong = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => f.save(f.payload, wrong.privateKey)).toThrow(
      "Ed25519 private PEM",
    );
    expect(
      await createCandidateVerifier(f.ctx, {
        file: f.file,
        key: wrong.publicKey,
      })(f.candidate),
    ).toMatchObject({ ok: false });
  });

  it("rejects missing, duplicated, or disconnected screenshot artifacts", () => {
    const f = fixture();
    expect(() => f.save({ ...f.payload, artifacts: [] })).toThrow(
      "Every screenshot",
    );
    expect(() =>
      f.save({
        ...f.payload,
        artifacts: [...f.payload.artifacts, ...f.payload.artifacts],
      }),
    ).toThrow("Every screenshot");
    expect(() =>
      f.save({
        ...f.payload,
        artifacts: [
          {
            path: "screen.png",
            url: "https://different.example.test/file.png",
          },
        ],
      }),
    ).toThrow("Every screenshot");
  });

  it("rejects forged magic-header-only files and changed image bytes", async () => {
    const f = fixture();
    f.save();
    const altered = Buffer.from(PNG);
    altered[30] = altered[30]! ^ 0xff;
    writeFileSync(join(f.dir, "screen.png"), altered);
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: "Screenshot artifact digest does not match",
    });
    writeFileSync(join(f.dir, "screen.png"), PNG.subarray(0, 8));
    expect(() => f.save()).toThrow("complete PNG");
    writeFileSync(join(f.dir, "screen.png"), "This is not a screenshot");
    expect(() => f.save()).toThrow("complete PNG");
  });

  it("rejects absolute paths and traversal outside the evidence directory", () => {
    const f = fixture();
    writeFileSync(join(root, "outside.png"), PNG);
    expect(() =>
      f.save({
        ...f.payload,
        artifacts: [
          { ...f.payload.artifacts[0]!, path: join(root, "outside.png") },
        ],
      }),
    ).toThrow("paths must be relative");
    expect(() =>
      f.save({
        ...f.payload,
        artifacts: [{ ...f.payload.artifacts[0]!, path: "../outside.png" }],
      }),
    ).toThrow("outside the evidence directory");
  });

  it("resolves symlinks and rejects an artifact directory pointing outside its root", async () => {
    const f = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "screen.png"), PNG);
    symlinkSync(
      outside,
      join(f.dir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      f.save({
        ...f.payload,
        artifacts: [{ ...f.payload.artifacts[0]!, path: "linked/screen.png" }],
      }),
    ).toThrow("outside the evidence directory");
    f.save();
    const original = readFileSync(join(f.dir, "screen.png"));
    expect(original).toEqual(PNG);
    expect(await f.verify()).toMatchObject({ ok: true });
  });

  it.each(["missing", "BUILDING", "ERROR", "sha", "branch", "id", "url"])(
    "requires the current exact ready deployment (%s)",
    async (scenario) => {
      const f = fixture();
      f.save();
      const deployment = await f.ctx.vercel.latestDeployment(
        "prj_game",
        null,
        f.candidate.branch,
      );
      f.ctx.vercel.latestDeployment = async () => {
        if (scenario === "missing") return null;
        return {
          ...deployment!,
          ...(scenario === "BUILDING" || scenario === "ERROR"
            ? { state: scenario }
            : { [scenario]: "mismatch" }),
        };
      };
      expect(await f.verify()).toMatchObject({
        ok: false,
        reason:
          "Current ready candidate deployment does not match the tested deployment",
      });
    },
  );

  it("fails closed without exposing provider errors, malformed JSON, or the signing key", async () => {
    const f = fixture();
    f.save();
    f.ctx.vercel.latestDeployment = async () => {
      throw new Error(`Authorization: Bearer ${KEY}`);
    };
    const unavailable = await f.verify();
    expect(unavailable.ok).toBe(false);
    expect(JSON.stringify(unavailable)).not.toContain(KEY);
    writeFileSync(f.file, `invalid-json-secret-${KEY}`);
    const malformed = await f.verify();
    expect(malformed.ok).toBe(false);
    expect(JSON.stringify(malformed)).not.toContain(KEY);
  });
});
