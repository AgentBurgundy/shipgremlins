import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISCOVERY_FILES,
  discoveryArguments,
  discoveryResult,
  sanitizeKnowledge,
} from "../../runner-local/discovery.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("limits discovery to read/search tools and disables repository customizations", () => {
  const args = discoveryArguments();
  expect(args.slice(0, 6)).toEqual([
    "--tools",
    "Read,Glob,Grep",
    "--allowedTools",
    "Read",
    "Glob",
    "Grep",
  ]);
  expect(args).toContain("--restricted");
  expect(args).toContain("--safe-mode");
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("Bash");
  expect(args).not.toContain("Write");
});
it("parses only complete structured public output and rejects extra paths/oversized values", () => {
  const output = {
    summary: "Read code; runtime not tested.",
    documents: Object.fromEntries(
      DISCOVERY_FILES.map((name) => [name, "# Source evidence"]),
    ),
  };
  const envelope = () =>
    JSON.stringify({
      type: "result",
      is_error: false,
      structured_output: output,
    });
  expect(discoveryResult(envelope())).toEqual(output);
  output.documents["../mandate.md"] = "replace owner";
  expect(() => discoveryResult(envelope())).toThrow();
  delete output.documents["../mandate.md"];
  output.documents["queue.md"] = "x".repeat(65537);
  expect(() => discoveryResult(envelope())).toThrow();
  expect(() => discoveryResult('{"type":"result","is_error":true}')).toThrow();
});
it("sanitizes direct patrol documents with run-specific literal and encoded credential variants", () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-runtime-knowledge-"),
  );
  roots.push(root);
  const secret = 'oauth+/"token';
  const variants = [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
  ];
  writeFileSync(join(root, "memory.md"), variants.join("\n"));
  sanitizeKnowledge(root, (text: string) =>
    variants.reduce(
      (value, token) => value.split(token).join("[redacted]"),
      text,
    ),
  );
  expect(readFileSync(join(root, "memory.md"), "utf8")).toBe(
    "[redacted]\n[redacted]\n[redacted]",
  );
});
it.skipIf(process.platform === "win32")(
  "rejects symlinked patrol artifacts",
  () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "gremlins-runtime-link-"),
    );
    roots.push(root);
    writeFileSync(join(root, "owner.md"), "preserve");
    symlinkSync(join(root, "owner.md"), join(root, "memory.md"));
    expect(() => sanitizeKnowledge(root, (text: string) => text)).toThrow();
    expect(readFileSync(join(root, "owner.md"), "utf8")).toBe("preserve");
  },
);
