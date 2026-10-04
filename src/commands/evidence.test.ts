import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvidence } from "./evidence.ts";
import { passingEvidence } from "../dispatcher/verification.test-support.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
const { privateKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = { SHIPGREMLINS_ATTESTATION_KEY: privateKey };
let root: string;
let output: string[];
let errors: string[];
const io = {
  log: (line: string) => output.push(line),
  error: (line: string) => errors.push(line),
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-evidence-cli-"));
  output = [];
  errors = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function draft() {
  const evidence = passingEvidence("c".repeat(40));
  const input = {
    version: 1,
    project: "demo",
    repo: "owner/demo",
    branch: "pm-release/core/20261004",
    releaseBranch: "pm-release/core/20261004",
    candidateSha: evidence.testedSha,
    baseSha: "b".repeat(40),
    changes: [10],
    author: "shipgremlins[bot]",
    issuedAt: "2026-10-04T12:00:00Z",
    expiresAt: "2026-10-04T13:00:00Z",
    evidence,
    artifacts: [
      { path: "screenshots/check.png", url: evidence.screenshots[0]! },
    ],
  };
  mkdirSync(join(root, "receipts", "screenshots"), { recursive: true });
  writeFileSync(join(root, "receipts", "screenshots", "check.png"), PNG);
  writeFileSync(join(root, "draft.json"), JSON.stringify(input));
  return input;
}

describe("evidence command", () => {
  it("formats valid browser evidence as an exact structured comment without needing a signing key", () => {
    const evidence = passingEvidence("c".repeat(40));
    writeFileSync(join(root, "browser.json"), JSON.stringify(evidence));
    expect(
      runEvidence(root, ["comment", "--input", "browser.json"], io, {}),
    ).toBe(0);
    expect(output).toEqual([
      `<!-- shipgremlins-verification: ${JSON.stringify(evidence)} -->`,
    ]);
    expect(errors).toEqual([]);
  });

  it("signs using artifacts relative to the output directory and never prints private material", () => {
    draft();
    expect(
      runEvidence(
        root,
        ["sign", "--input", "draft.json", "--output", "receipts/signed.json"],
        io,
        env,
      ),
    ).toBe(0);
    const signed = JSON.parse(
      readFileSync(join(root, "receipts", "signed.json"), "utf8"),
    );
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(signed.payload.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(signed)).not.toContain(privateKey);
    expect(output.join("\n")).not.toContain(privateKey);
    expect(errors).toEqual([]);
  });

  it("never replaces an existing signed receipt", () => {
    draft();
    writeFileSync(join(root, "receipts", "signed.json"), "keep this receipt");
    expect(
      runEvidence(
        root,
        ["sign", "--input", "draft.json", "--output", "receipts/signed.json"],
        io,
        env,
      ),
    ).toBe(1);
    expect(readFileSync(join(root, "receipts", "signed.json"), "utf8")).toBe(
      "keep this receipt",
    );
  });

  it("rejects absent/private-key-invalid settings and creates no output", () => {
    draft();
    const args = [
      "sign",
      "--input",
      "draft.json",
      "--output",
      "receipts/signed.json",
    ];
    expect(runEvidence(root, args, io, {})).toBe(1);
    expect(errors.at(-1)).toContain("trusted verifier environment");
    expect(
      runEvidence(root, args, io, {
        SHIPGREMLINS_ATTESTATION_KEY: "plain-shared-secret",
      }),
    ).toBe(1);
    expect(errors.at(-1)).toContain("Ed25519 private PEM");
    expect(existsSync(join(root, "receipts", "signed.json"))).toBe(false);
  });

  it("rejects a report whose artifact exists only relative to its input file", () => {
    const input = draft();
    writeFileSync(join(root, "check.png"), PNG);
    input.artifacts[0]!.path = "check.png";
    writeFileSync(join(root, "draft.json"), JSON.stringify(input));
    expect(
      runEvidence(
        root,
        ["sign", "--input", "draft.json", "--output", "receipts/signed.json"],
        io,
        env,
      ),
    ).toBe(1);
    expect(existsSync(join(root, "receipts", "signed.json"))).toBe(false);
  });

  it("does not echo malformed JSON contents or private keys in errors", () => {
    writeFileSync(join(root, "invalid.json"), `input-secret-${privateKey}`);
    expect(
      runEvidence(
        root,
        ["sign", "--input", "invalid.json", "--output", "signed.json"],
        io,
        env,
      ),
    ).toBe(1);
    expect(errors.join("\n")).not.toContain("input-secret");
    expect(errors.join("\n")).not.toContain("PRIVATE KEY");
  });

  it.each([
    { args: [] },
    { args: ["approve", "--input", "draft.json"] },
    { args: ["comment", "unexpected", "--input", "draft.json"] },
    {
      args: ["sign", "--input", "draft.json", "--secret", "do-not-print-this"],
    },
  ])("rejects ambiguous or unsupported arguments $args", ({ args }) => {
    expect(runEvidence(root, args, io, env)).toBe(1);
    expect(errors[0]).toContain("usage:");
    expect(errors.join("\n")).not.toContain("do-not-print-this");
  });
});
