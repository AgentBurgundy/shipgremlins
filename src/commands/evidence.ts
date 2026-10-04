import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseFlags, type Io } from "./crons.ts";
import {
  formatBrowserEvidence,
  isBrowserEvidence,
} from "../dispatcher/verification.ts";
import {
  AttestationError,
  attestationFailureReason,
  signAttestation,
} from "../evidence/attestation.ts";

export function runEvidence(
  root: string,
  args: string[],
  io: Io,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { values, positionals } = parseFlags(args);
  if (
    positionals.length !== 1 ||
    !["comment", "sign"].includes(positionals[0] ?? "") ||
    typeof values.input !== "string" ||
    Object.keys(values).some((key) => !["input", "output"].includes(key))
  ) {
    io.error(
      "usage: gremlins evidence comment --input browser.json | gremlins evidence sign --input report.json --output signed.json",
    );
    return 1;
  }
  try {
    const input: unknown = JSON.parse(
      readFileSync(resolve(root, values.input), "utf8"),
    );
    if (positionals[0] === "comment") {
      if (!isBrowserEvidence(input))
        throw new AttestationError("Browser evidence is incomplete or invalid");
      io.log(formatBrowserEvidence(input));
    } else {
      if (typeof values.output !== "string")
        throw new AttestationError("--output is required");
      const key = env.SHIPGREMLINS_ATTESTATION_KEY;
      if (!key)
        throw new AttestationError(
          "SHIPGREMLINS_ATTESTATION_KEY is required in the trusted verifier environment",
        );
      const output = resolve(root, values.output);
      const signed = signAttestation(input, key, dirname(output));
      writeFileSync(output, JSON.stringify(signed, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      io.log(
        "Signed evidence written. Keep the signing key outside all agent environments.",
      );
    }
    return 0;
  } catch (error) {
    io.error(attestationFailureReason(error));
    return 1;
  }
}
