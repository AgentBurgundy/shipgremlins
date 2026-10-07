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
const pmSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "mandate", "evidence"],
  properties: {
    name: text(100),
    mandate: text(3000),
    evidence: evidenceSchema,
  },
};
const loginKeys = [
  "loginPath",
  "usernameSelector",
  "passwordSelector",
  "submitSelector",
  "successSelector",
] as const;
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
    firstPm: pmSchema,
    suggestedPms: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: pmSchema,
    },
    appAccess: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "evidence"],
      properties: {
        kind: { enum: ["password", "email-code", "sso", "public", "unknown"] },
        summary: text(1000),
        evidence: { ...evidenceSchema, minItems: 0 },
        password: {
          type: "object",
          additionalProperties: false,
          required: [...loginKeys],
          properties: Object.fromEntries(
            loginKeys.map((key) => [key, text(512)]),
          ),
        },
      },
    },
  },
};
export const PROJECT_SETUP_PROMPT = `Also include projectSetup for the owner's initial project review. It is a proposal, never an applied configuration. commands may contain only install, lint, typecheck, test, build, each {command,rationale,evidence:[{path,quote}]}. Recommend only commands grounded in inspected source (existing package scripts, manifests, Makefiles or documented workflow); do not invent missing scripts, install tools globally, add deployment/production commands, or treat analysis as command verification. Omit uncertain or unavailable commands; an empty commands object is valid. Do not use no-op commands to hide missing tests. Each evidence quote must be an exact nonempty excerpt from the supplied file at the inspected commit, with its actual path. Keep commands on one line and avoid credentials.
Include suggestedPms: 1–4 distinct source-grounded ongoing PM responsibilities, each {name,mandate,evidence:[{path,quote}]}. Select useful product areas from the inspected app, such as its core customer journey, security boundaries, reliability or billing only when supported by actual source. Do not propose a generic crew disconnected from the app. Each mandate should first understand existing behavior, then continuously investigate, propose finite improvements and QA changes in its area under the configured delivery policy. Preserve capabilities, identify unknown intent, and avoid overlapping ownership. Also set firstPm to the most useful suggested PM for compatibility. The analysis itself cannot create PMs, tickets or automation; that restriction applies to this setup operation and must NOT become a permanent ban in a suggested PM's mandate. Do not impose owner review of every ordinary ticket when the project uses managed integration. Explicit owner-authored limits remain authoritative.
Include appAccess: {kind,summary,evidence,password?}. kind is password, email-code, sso, public or unknown based only on inspected auth and UI source. Missing auth evidence means unknown, never public. Public means the inspected intended flows explicitly do not require login; it is still a suggestion for owner confirmation. Password means an actual email/username and password login exists, not merely a password reset, signup form or server dependency. For a clear password login, include password {loginPath,usernameSelector,passwordSelector,submitSelector,successSelector} only if ALL five values are grounded in the cited real UI. Prefer unique stable IDs or data-testid selectors. The success marker must be exclusive to signed-in UI; never use body, a generic heading, a submit button or the login form. loginPath must be a same-app route starting with a single slash, with no query or fragment. Omit password when the route, selectors, modal trigger or success marker is uncertain; describe what remains unknown. Do not invent accounts or secrets and do not claim source detection proves a browser login. Email-code and SSO-only apps need a supported test login or explicit public-only coverage. Confirming the report saves only selected command suggestions; app login settings require a separate live test.`;

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
    !only(value, ["commands", "firstPm", "suggestedPms", "appAccess"]) ||
    !object(value.commands) ||
    !only(value.commands, PROJECT_COMMAND_KEYS) ||
    !object(value.firstPm) ||
    !only(value.firstPm, ["name", "mandate", "evidence"]) ||
    !validText(value.firstPm.name, 100) ||
    !validText(value.firstPm.mandate, 3000, true)
  )
    throw invalid();
  const pm = (item: unknown): ProjectSetupProposal["firstPm"] => {
    if (
      !object(item) ||
      !only(item, ["name", "mandate", "evidence"]) ||
      !validText(item.name, 100) ||
      !validText(item.mandate, 3000, true)
    )
      throw invalid();
    return {
      name: item.name,
      mandate: item.mandate,
      evidence: evidence(item.evidence),
    };
  };
  let suggestedPms: ProjectSetupProposal["suggestedPms"];
  if (value.suggestedPms !== undefined) {
    if (
      !Array.isArray(value.suggestedPms) ||
      !value.suggestedPms.length ||
      value.suggestedPms.length > 4
    )
      throw invalid();
    suggestedPms = value.suggestedPms.map(pm);
    if (
      new Set(suggestedPms.map((item) => item.name.trim().toLowerCase()))
        .size !== suggestedPms.length
    )
      throw invalid();
  }
  let appAccess: ProjectSetupProposal["appAccess"];
  if (value.appAccess !== undefined) {
    const item = value.appAccess;
    if (
      !object(item) ||
      !only(item, ["kind", "summary", "evidence", "password"]) ||
      !["password", "email-code", "sso", "public", "unknown"].includes(
        String(item.kind),
      ) ||
      !validText(item.summary, 1000, true) ||
      !Array.isArray(item.evidence)
    )
      throw invalid();
    const sources = item.evidence.length ? evidence(item.evidence) : [];
    if (item.kind !== "unknown" && !sources.length) throw invalid();
    appAccess = {
      kind: item.kind as NonNullable<ProjectSetupProposal["appAccess"]>["kind"],
      summary: item.summary,
      evidence: sources,
    };
    if (item.password !== undefined) {
      const recipe = item.password;
      if (
        item.kind !== "password" ||
        !object(recipe) ||
        !only(recipe, loginKeys) ||
        loginKeys.some((key) => !validText(recipe[key], 512)) ||
        !/^\/(?!\/)[^?#\\\s]*$/.test(String(recipe.loginPath)) ||
        /^(?:body|html|h[1-6]|button|form|input|\*)$/i.test(
          String(recipe.successSelector).trim(),
        )
      )
        throw invalid();
      appAccess.password = Object.fromEntries(
        loginKeys.map((key) => [key, recipe[key]]),
      ) as NonNullable<typeof appAccess.password>;
    }
  }
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
    ...(suggestedPms ? { suggestedPms } : {}),
    ...(appAccess ? { appAccess } : {}),
  };
}
