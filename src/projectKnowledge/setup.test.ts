import { beforeEach, afterEach, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";
import { applySetupSuggestions, readSetupSuggestions } from "./setup.ts";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-setup-discovery-"));
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function seed() {
  const project = loadProject(root, "app"),
    area = project.areas[0]!;
  const proposal = {
    commands: {
      install: "uv sync --frozen",
      test: "uv run pytest",
      lint: "uv run ruff check .",
      typecheck: null,
      build: null,
    },
    paths: ["app"],
    sharedTouchpoints: ["lib"],
    rationale: "Observed Python project; install uv in the worker image.",
    evidence: ["pyproject.toml", "tests/test_app.py"],
  };
  const dir = join(root, ".run", "pm-knowledge", "app", area.key);
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    schema: 1,
    project: "app",
    area: area.key,
    revision: knowledgeRevision(project, area),
    documents: ["discovery.md", "features.md", "queue.md", "memory.md"].map(
      (name) => ({
        name,
        content:
          name === "discovery.md"
            ? "# Discovery\n```shipgremlins-setup\n" +
              JSON.stringify(proposal) +
              "\n```"
            : "Observed source",
      }),
    ),
    provenance: {
      jobId: "job-1",
      runId: 1,
      commitSha: "a".repeat(40),
      repository: "owner/app",
      branch: "main",
      completedAt: "2026-10-05T00:00:00Z",
    },
  };
  const file = join(dir, "latest.json");
  writeFileSync(file, JSON.stringify(snapshot));
  return { file, snapshot, proposal };
}
it("applies reviewed commands only, preserves PMs and requires fresh knowledge after settings change", () => {
  const f = seed(),
    before = readFileSync(join(root, "projects", "app", "areas.json"), "utf8"),
    review = readSetupSuggestions(root, "app", "core");
  expect(review.state).toBe("ready");
  applySetupSuggestions(root, "app", "core", {
    revision: review.revision,
    areaRevision: review.areaRevision,
    knowledgeRevision: review.knowledgeRevision,
    apply: "commands",
  });
  expect(loadProject(root, "app").config.commands).toEqual(f.proposal.commands);
  expect(
    readFileSync(join(root, "projects", "app", "areas.json"), "utf8"),
  ).toBe(before);
  expect(readSetupSuggestions(root, "app", "core").state).toBe("stale");
});
it("rejects changed discovery and invalid proposals without writing config", () => {
  const f = seed(),
    review = readSetupSuggestions(root, "app", "core"),
    before = readFileSync(
      join(root, "projects", "app", "project.json"),
      "utf8",
    );
  f.snapshot.documents[0]!.content += "\nNew observation";
  writeFileSync(f.file, JSON.stringify(f.snapshot));
  expect(() =>
    applySetupSuggestions(root, "app", "core", {
      revision: review.revision,
      areaRevision: review.areaRevision,
      knowledgeRevision: review.knowledgeRevision,
      apply: "commands",
    }),
  ).toThrow(/changed/);
  f.snapshot.documents[0]!.content = "```shipgremlins-setup\n{}\n```";
  writeFileSync(f.file, JSON.stringify(f.snapshot));
  expect(readSetupSuggestions(root, "app", "core").state).toBe("invalid");
  expect(
    readFileSync(join(root, "projects", "app", "project.json"), "utf8"),
  ).toBe(before);
});
