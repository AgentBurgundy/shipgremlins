import { object, type RepositorySnapshot } from "./repository.ts";
import {
  PROJECT_COMMAND_KEYS,
  ProjectOnboardingError,
  type ProjectSetupProposal,
  type SetupEvidence,
} from "./types.ts";

const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const evidenceSchema = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "quote"],
    properties: { path: text(300), quote: text(1200) },
  },
};
const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "rationale", "evidence"],
  properties: {
    command: text(1000),
    rationale: text(1000),
    evidence: evidenceSchema,
  },
};
export const PROJECT_SETUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["commands", "firstPm"],
  properties: {
    commands: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        PROJECT_COMMAND_KEYS.map((key) => [key, commandSchema]),
      ),
    },
    firstPm: {
      type: "object",
      additionalProperties: false,
      required: ["name", "mandate", "evidence"],
      properties: {
        name: text(100),
        mandate: text(3000),
        evidence: evidenceSchema,
      },
    },
  },
};
export const PROJECT_SETUP_PROMPT = `Also include projectSetup for the owner's initial project review. It is a proposal, never an applied configuration. commands may contain only install, lint, typecheck, test, build, each {command,rationale,evidence:[{path,quote}]}. Recommend only commands grounded in inspected source (existing package scripts, manifests, Makefiles or documented workflow); do not invent missing scripts, install tools globally, add deployment/production commands, or treat analysis as command verification. Omit uncertain or unavailable commands; an empty commands object is valid. Do not use no-op commands to hide missing tests. Each evidence quote must be an exact nonempty excerpt from the supplied file at the inspected commit, with its actual path. Keep commands on one line and avoid credentials. firstPm is {name,mandate,evidence:[{path,quote}]}: propose one focused PM whose first task is understanding this real existing app, its users, architecture and current workflows before suggesting changes. Bound that mandate by observed source, explicitly flag unknown product intent, and preserve existing capabilities. It is a recommendation for a later adoption review, not permission to create a PM, tickets, automation or a replacement application. Confirming this report saves only owner-selected command suggestions; it does not execute them or verify an environment.`;

function validText(
  value: unknown,
  max: number,
  multiline = false,
): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    ![...value].some(
      (c) =>
        c.charCodeAt(0) === 127 ||
        (c.charCodeAt(0) < 32 &&
          !(multiline && [9, 10, 13].includes(c.charCodeAt(0)))),
    )
  );
}
export function validateProjectSetup(
  value: unknown,
  snapshot: RepositorySnapshot,
): ProjectSetupProposal {
  const invalid = () =>
    new ProjectOnboardingError(
      "Project setup recommendations must cite inspected source and contain only supported commands. Reanalyze; nothing was saved.",
      422,
      "invalid_analysis",
    );
  const only = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const evidence = (value: unknown): SetupEvidence[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 4)
      throw invalid();
    return value.map((item) => {
      if (
        !object(item) ||
        !only(item, ["path", "quote"]) ||
        !validText(item.path, 300) ||
        !validText(item.quote, 1200, true) ||
        !snapshot.repository.filesRead.includes(item.path) ||
        !snapshot.files.some(
          (file) =>
            file.path === item.path &&
            file.content.includes(item.quote as string),
        )
      )
        throw invalid();
      return { path: item.path, quote: item.quote };
    });
  };
  if (
    !object(value) ||
    !only(value, ["commands", "firstPm"]) ||
    !object(value.commands) ||
    !only(value.commands, PROJECT_COMMAND_KEYS) ||
    !object(value.firstPm) ||
    !only(value.firstPm, ["name", "mandate", "evidence"]) ||
    !validText(value.firstPm.name, 100) ||
    !validText(value.firstPm.mandate, 3000, true)
  )
    throw invalid();
  const commands: ProjectSetupProposal["commands"] = {};
  for (const key of PROJECT_COMMAND_KEYS) {
    const item = value.commands[key];
    if (item === undefined) continue;
    if (
      !object(item) ||
      !only(item, ["command", "rationale", "evidence"]) ||
      !validText(item.command, 1000) ||
      !validText(item.rationale, 1000, true)
    )
      throw invalid();
    commands[key] = {
      command: item.command,
      rationale: item.rationale,
      evidence: evidence(item.evidence),
    };
  }
  return {
    commands,
    firstPm: {
      name: value.firstPm.name,
      mandate: value.firstPm.mandate,
      evidence: evidence(value.firstPm.evidence),
    },
  };
}
