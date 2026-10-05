import { createHash } from "node:crypto";
import { loadProject } from "../config.ts";
import { createPmKnowledge } from "../pmKnowledge/index.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import { ProjectKnowledgeError } from "./index.ts";

interface SetupProposal {
  commands: {
    install: string;
    test: string;
    lint: string | null;
    typecheck: string | null;
    build: string | null;
  };
  paths: string[];
  sharedTouchpoints: string[];
  rationale: string;
  evidence: string[];
}
function parse(value: unknown): SetupProposal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error();
  const p = value as SetupProposal;
  if (
    Object.keys(p).some(
      (k) =>
        ![
          "commands",
          "paths",
          "sharedTouchpoints",
          "rationale",
          "evidence",
        ].includes(k),
    ) ||
    !p.commands ||
    typeof p.commands !== "object" ||
    Array.isArray(p.commands)
  )
    throw new Error();
  if (
    Object.keys(p.commands).length !== 5 ||
    Object.keys(p.commands).some(
      (k) => !["install", "test", "lint", "typecheck", "build"].includes(k),
    )
  )
    throw new Error();
  for (const [key, command] of Object.entries(p.commands)) {
    if (command === null && !["install", "test"].includes(key)) continue;
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 2000 ||
      /[\r\n\0]/.test(command)
    )
      throw new Error();
  }
  for (const paths of [p.paths, p.sharedTouchpoints, p.evidence])
    if (
      !Array.isArray(paths) ||
      paths.length > 50 ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !path ||
          path.length > 300 ||
          /^(?:[\\/]|[a-z]:)/i.test(path) ||
          path.split(/[\\/]/).includes("..") ||
          /[\r\n\0]/.test(path),
      )
    )
      throw new Error();
  if (
    !p.paths.length ||
    !p.evidence.length ||
    typeof p.rationale !== "string" ||
    !p.rationale.trim() ||
    p.rationale.length > 4000
  )
    throw new Error();
  return p;
}
export function readSetupSuggestions(root: string, name: string, area: string) {
  const knowledge = createPmKnowledge({ root }).read(name, area);
  const projectDoc = readEditableConfig(root, `projects/${name}/project.json`),
    areaDoc = readEditableConfig(root, `projects/${name}/areas.json`);
  const base = {
    revision: projectDoc.revision,
    areaRevision: areaDoc.revision,
    knowledgeRevision: createHash("sha256")
      .update(
        JSON.stringify({
          documents: knowledge.documents,
          provenance: knowledge.provenance,
        }),
      )
      .digest("hex"),
    provenance: knowledge.provenance,
  };
  if (knowledge.stale) return { ...base, state: "stale" as const };
  const document =
    knowledge.documents.find((d) => d.name === "discovery.md")?.content ?? "";
  const blocks = [
    ...document.matchAll(/```shipgremlins-setup\s*\n([\s\S]*?)\n```/g),
  ];
  if (!blocks.length) return { ...base, state: "empty" as const };
  try {
    if (blocks.length !== 1 || Buffer.byteLength(blocks[0]![1]!) > 20000)
      throw new Error();
    const proposal = parse(JSON.parse(blocks[0]![1]!));
    return { ...base, state: "ready" as const, proposal };
  } catch {
    return { ...base, state: "invalid" as const };
  }
}
export function applySetupSuggestions(
  root: string,
  name: string,
  area: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (k) =>
        !["revision", "areaRevision", "knowledgeRevision", "apply"].includes(k),
    ) ||
    !["commands", "ownership"].includes(String(input.apply))
  )
    throw new ProjectKnowledgeError(
      "Choose commands or ownership from the reviewed discovery proposal.",
    );
  const proposal = readSetupSuggestions(root, name, area);
  if (proposal.state !== "ready" || !proposal.proposal)
    throw new ProjectKnowledgeError(
      "Run fresh discovery before applying setup suggestions.",
      409,
    );
  if (
    input.revision !== proposal.revision ||
    input.areaRevision !== proposal.areaRevision ||
    input.knowledgeRevision !== proposal.knowledgeRevision
  )
    throw new ProjectKnowledgeError(
      "Discovery or settings changed. Refresh and review the proposal again.",
      409,
    );
  loadProject(root, name);
  const document = readEditableConfig(
      root,
      `projects/${name}/${input.apply === "commands" ? "project" : "areas"}.json`,
    ),
    raw = JSON.parse(document.content);
  if (input.apply === "commands") {
    raw.commands = proposal.proposal.commands;
    raw.verified = null;
  } else
    Object.assign(raw.areas[area], {
      paths: proposal.proposal.paths,
      sharedTouchpoints: proposal.proposal.sharedTouchpoints,
    });
  const result = saveEditableConfig(root, {
    path: document.path,
    revision:
      input.apply === "commands" ? proposal.revision : proposal.areaRevision,
    content: JSON.stringify(raw, null, 2) + "\n",
  });
  return {
    ok: true,
    ...result,
    message:
      input.apply === "commands"
        ? "Suggested commands saved. Verify the project before enabling automation."
        : "Suggested ownership saved. Review the brief before enabling automation.",
  };
}
