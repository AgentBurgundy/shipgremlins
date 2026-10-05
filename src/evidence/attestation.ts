import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Ctx } from "../dispatcher/context.ts";
import { promotionVercel } from "../projectCapabilities.ts";
import type { PromoteOpts } from "../dispatcher/promote.ts";
import {
  isBrowserEvidence,
  type BrowserEvidence,
} from "../dispatcher/verification.ts";

export interface Attestation {
  version: 1;
  project: string;
  repo: string;
  branch: string;
  releaseBranch: string;
  candidateSha: string;
  baseSha: string;
  changes: number[];
  author: string;
  issuedAt: string;
  expiresAt: string;
  evidence: BrowserEvidence;
  artifacts: { path: string; url: string; sha256: string }[];
}
export interface SignedAttestation {
  payload: Attestation;
  signature: string;
}
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DAY = 24 * 60 * 60 * 1000;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** Only these controller-authored messages may reach a release digest. */
export class AttestationError extends Error {}
export const attestationFailureReason = (error: unknown): string =>
  error instanceof AttestationError
    ? error.message
    : "Evidence validation could not complete; check the evidence files and deployment provider";

/** Stable recursive encoding prevents object key order from changing a signature. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
function signature(payload: unknown, key: string): string {
  try {
    const privateKey = createPrivateKey(key);
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("wrong key type");
    return sign(null, Buffer.from(canonical(payload)), privateKey).toString(
      "base64",
    );
  } catch {
    throw new AttestationError(
      "Signing requires a dedicated Ed25519 private PEM key in the trusted verifier environment",
    );
  }
}
function validSignature(
  payload: unknown,
  signature: string,
  key: string,
): boolean {
  if (
    !key.includes("-----BEGIN PUBLIC KEY-----") ||
    key.includes("PRIVATE KEY")
  )
    throw new AttestationError(
      "Verification requires an Ed25519 PUBLIC PEM key; private signing keys must never enter the dispatcher",
    );
  try {
    const publicKey = createPublicKey(key);
    if (publicKey.asymmetricKeyType !== "ed25519")
      throw new Error("wrong key type");
    const bytes = Buffer.from(signature, "base64");
    return (
      bytes.length === 64 &&
      bytes.toString("base64") === signature &&
      verify(null, Buffer.from(canonical(payload)), publicKey, bytes)
    );
  } catch {
    throw new AttestationError(
      "Verification requires a valid Ed25519 public PEM key",
    );
  }
}
function validate(value: unknown): asserts value is Attestation {
  if (!object(value)) throw new AttestationError("Invalid attestation object");
  const fields = [
    "version",
    "project",
    "repo",
    "branch",
    "releaseBranch",
    "candidateSha",
    "baseSha",
    "changes",
    "author",
    "issuedAt",
    "expiresAt",
    "evidence",
    "artifacts",
  ];
  if (Object.keys(value).some((field) => !fields.includes(field)))
    throw new AttestationError("Attestation contains unsupported fields");
  const e = value.evidence;
  if (
    value.version !== 1 ||
    ![
      value.project,
      value.repo,
      value.branch,
      value.releaseBranch,
      value.author,
    ].every(nonempty) ||
    typeof value.candidateSha !== "string" ||
    !SHA.test(value.candidateSha) ||
    typeof value.baseSha !== "string" ||
    !SHA.test(value.baseSha) ||
    !Array.isArray(value.changes) ||
    !value.changes.length ||
    !value.changes.every((n) => Number.isSafeInteger(n) && n > 0) ||
    new Set(value.changes).size !== value.changes.length ||
    !isBrowserEvidence(e) ||
    e.status !== "passed" ||
    e.testedSha !== value.candidateSha ||
    e.sourceSha !== value.candidateSha
  )
    throw new AttestationError(
      "Attestation needs complete, passing evidence for the candidate revision",
    );
  const issued =
    typeof value.issuedAt === "string" ? Date.parse(value.issuedAt) : NaN;
  const expires =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > DAY
  )
    throw new AttestationError(
      "Attestation lifetime must be between zero and 24 hours",
    );
  const artifacts = value.artifacts;
  if (
    !Array.isArray(artifacts) ||
    !artifacts.length ||
    !artifacts.every(
      (a: unknown) =>
        object(a) &&
        nonempty(a.path) &&
        nonempty(a.url) &&
        typeof a.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(a.sha256),
    ) ||
    new Set(artifacts.map((a) => a.url)).size !== artifacts.length ||
    new Set(e.screenshots).size !== e.screenshots.length ||
    artifacts.length !== e.screenshots.length ||
    !e.screenshots.every((url) =>
      artifacts.some((a: { url: string }) => a.url === url),
    )
  )
    throw new AttestationError(
      "Every screenshot needs a unique local artifact and SHA-256 digest",
    );
}

/** Reject truncated/header-only stand-ins; the trusted browser verifier owns screenshot provenance. */
function imageContainer(bytes: Buffer): boolean {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let offset = 8;
    let header = false;
    let pixels = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset);
      const end = offset + 12 + size;
      if (end > bytes.length) return false;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (!header) {
        if (
          type !== "IHDR" ||
          size !== 13 ||
          bytes.readUInt32BE(offset + 8) === 0 ||
          bytes.readUInt32BE(offset + 12) === 0
        )
          return false;
        header = true;
      } else if (type === "IHDR") return false;
      if (type === "IDAT" && size > 0) pixels = true;
      if (type === "IEND")
        return header && pixels && size === 0 && end === bytes.length;
      offset = end;
    }
    return false;
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let offset = 2;
    let frame = false;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1]!;
      if (marker === 0xda)
        return frame && bytes.at(-2) === 255 && bytes.at(-1) === 217;
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (
          size < 8 ||
          bytes.readUInt16BE(offset + 5) === 0 ||
          bytes.readUInt16BE(offset + 7) === 0
        )
          return false;
        frame = true;
      }
      offset += size + 2;
    }
    return false;
  }
  return (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(16) > 0 &&
    bytes.readUInt32LE(16) + 20 <= bytes.length
  );
}

function artifactHash(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\0"))
    throw new AttestationError("Artifact paths must be relative");
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, path));
  const rel = relative(base, file);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !statSync(file).isFile()
  )
    throw new AttestationError("Artifact is outside the evidence directory");
  if (statSync(file).size > 25 * 1024 * 1024)
    throw new AttestationError("Screenshot artifact exceeds the 25 MiB limit");
  const bytes = readFileSync(file);
  if (!imageContainer(bytes))
    throw new AttestationError(
      "Screenshot artifact must be a complete PNG, JPEG or WebP image",
    );
  return createHash("sha256").update(bytes).digest("hex");
}

/** Called by a trusted verifier after real browser checks, outside the agent job. */
export function signAttestation(
  input: unknown,
  key: string,
  artifactRoot: string,
): SignedAttestation {
  if (!object(input) || !Array.isArray(input.artifacts))
    throw new AttestationError("Missing screenshot artifacts");
  const payload = {
    ...input,
    artifacts: input.artifacts.map((a) => {
      if (!object(a) || !nonempty(a.path))
        throw new AttestationError("Invalid artifact path");
      return {
        path: a.path,
        url: a.url,
        sha256: artifactHash(artifactRoot, a.path),
      };
    }),
  };
  validate(payload);
  return { payload, signature: signature(payload, key) };
}

export function createCandidateVerifier(
  ctx: Ctx,
  opts: { file?: string; key?: string },
): NonNullable<PromoteOpts["verifyCandidate"]> {
  return async (candidate) => {
    if (!opts.file || !opts.key)
      return {
        ok: false,
        reason:
          "Candidate needs a trusted signed browser attestation; configure SHIPGREMLINS_VERIFICATION_FILE and SHIPGREMLINS_ATTESTATION_PUBLIC_KEY (docs/VERIFICATION.md)",
      };
    try {
      const signed: unknown = JSON.parse(readFileSync(opts.file, "utf8"));
      if (
        !object(signed) ||
        Object.keys(signed).some(
          (field) => !["payload", "signature"].includes(field),
        ) ||
        typeof signed.signature !== "string" ||
        !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)
      )
        throw new AttestationError("Invalid signed evidence envelope");
      if (!validSignature(signed.payload, signed.signature, opts.key))
        throw new AttestationError("Attestation signature does not match");
      validate(signed.payload);
      const p = signed.payload;
      if (
        p.project !== ctx.project.config.name ||
        p.repo !== ctx.project.config.repo ||
        p.author !== ctx.botLogin ||
        p.branch !== candidate.branch ||
        p.releaseBranch !== candidate.releaseBranch ||
        p.candidateSha !== candidate.sha ||
        p.baseSha !== candidate.baseSha ||
        [...p.changes].sort((a, b) => a - b).join(",") !==
          [...candidate.changes].sort((a, b) => a - b).join(",")
      )
        throw new AttestationError(
          "Attestation does not match this project, candidate, base, changes and verifier",
        );
      const now = ctx.now().getTime();
      if (Date.parse(p.issuedAt) > now || Date.parse(p.expiresAt) <= now)
        throw new AttestationError("Attestation is expired or not yet valid");
      for (const a of p.artifacts)
        if (artifactHash(dirname(opts.file), a.path) !== a.sha256)
          throw new AttestationError(
            "Screenshot artifact digest does not match",
          );
      const v = promotionVercel(ctx.project.config);
      if (!v && !ctx.resolveDeployment)
        throw new AttestationError(
          "This project's workflow has no supported revision-bound promotion target",
        );
      const deployment = ctx.resolveDeployment
        ? await ctx.resolveDeployment(candidate.branch, candidate.sha)
        : await ctx.vercel.latestDeployment(
            v!.projectId,
            v!.teamId ?? null,
            candidate.branch,
          );
      if (
        !deployment ||
        deployment.state !== "READY" ||
        deployment.sha !== candidate.sha ||
        deployment.branch !== candidate.branch ||
        deployment.id !== p.evidence.deployment.id ||
        `https://${deployment.url.replace(/^https:\/\//, "").replace(/\/$/, "")}` !==
          p.evidence.deployment.url.replace(/\/$/, "")
      )
        throw new AttestationError(
          "Current ready candidate deployment does not match the tested deployment",
        );
      return { ok: true, author: p.author, evidence: p.evidence };
    } catch (error) {
      // File paths, provider responses and signing key never appear in digest output.
      return { ok: false, reason: attestationFailureReason(error) };
    }
  };
}
