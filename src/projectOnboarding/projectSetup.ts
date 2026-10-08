import { object, type RepositorySnapshot } from "./repository.ts";
import { PM_DRAFT_SCHEMA, validatePmDraft } from "../pmPlanner/index.ts";
import {
  PROJECT_COMMAND_KEYS,
  ProjectOnboardingError,
  type ProjectSetupProposal,
  type SetupEvidence,
  type SuggestedPm,
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
const draftSchema = {
  ...PM_DRAFT_SCHEMA,
  required: (PM_DRAFT_SCHEMA.required as string[]).filter(
    (field) => field !== "rationale",
  ),
  properties: Object.fromEntries(
    Object.entries(
      PM_DRAFT_SCHEMA.properties as Record<string, unknown>,
    ).filter(([field]) => field !== "rationale"),
  ),
};
const suggestionSchema = {
  ...pmSchema,
  required: [...pmSchema.required, "draft", "rationale"],
  properties: {
    ...pmSchema.properties,
    draft: draftSchema,
    rationale: text(1600),
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
  required: ["commands", "firstPm", "suggestedPms"],
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
      maxItems: 5,
      items: suggestionSchema,
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
When existingPmCount is zero, include suggestedPms: 1–5 distinct source-grounded ongoing PM responsibilities, each {name,mandate,evidence:[{path,quote}],draft,rationale}. Recommend three to five for a substantial app, fewer when actual product complexity warrants it. When existingPmCount is greater than zero, this may simply be an environment investigation: suggestedPms may be empty or omitted when existing PMs already cover the useful responsibilities. Do not invent a new PM just to complete an environment report. Prefer customer journeys and business areas over generic Security or Performance labels; suggest specialist PMs only when inspected source supports a substantial distinct responsibility. Do not propose a generic crew disconnected from the app or split one responsibility into several cosmetic variations. If evidence is limited, keep scopes narrow and state what needs investigation instead of inventing capabilities. An empty repository still needs its foundation before recurring PM patrols; recommendations do not bypass that gate. Each mandate should first understand existing behavior, then continuously investigate, propose finite improvements and QA changes in its area under the configured delivery policy. Preserve capabilities, identify unknown intent, and avoid overlapping ownership, including the supplied existing PMs. Never replace an existing PM or reuse its key for a new suggestion. Set firstPm to {name,mandate,evidence} from the most useful suggested PM for compatibility; when no new PM is suggested, firstPm may describe a source-grounded existing responsibility and is informational only, never an adoption request.
Every suggested PM needs a complete editable draft: {name,key,paths,sharedTouchpoints,metric,schedule,wipLimit,verificationRequirement,charter}. Match draft.name to name. Give the gremlin a short, memorable creature name; its unique kebab-case key should describe the product responsibility. Choose owned paths and sharedTouchpoints EXACTLY from ownershipPaths. Own at least one path, keep each list to 12 entries, and identify shared dependencies in the rationale. Use a daily five-field UTC schedule, normally 0 13 * * *, and WIP limit 1–3. These are proposed settings, never enabled automation. The metric is an observable outcome to confirm, not an invented telemetry event or baseline.
Choose verificationRequirement from the inspected source and the PM's actual responsibility: "browser" for a PM that must walk through existing screens, interactions or user journeys; "repository" when investigation of code, APIs, CLI or background behavior is sufficient. Cite the supporting source in the PM evidence and explain the choice in its rationale. This is a minimum testing requirement: repository does not disable a configured browser, and browser does not claim the environment already works. Never silently choose repository just because environment setup is unfinished. Keep backend-only and security-code responsibilities useful without requiring an irrelevant UI.
The full charter must contain ambition, goal, metricDefinition, users, expectedToBuild, nonGoals, guardrails, standingPriorities. The first three are concise text; the other five are 1–6 concise strings each. Explain the ongoing product outcome, how to verify it, who benefits (label inferred audiences), specific finite improvements to investigate, boundaries, and ordered standing priorities. For customer-facing areas, include walking the relevant real UI journey and testing implemented changes when configured browser access is available. For non-customer areas, define appropriate reproducible security, operational or integration evidence. configuredTesting is saved configuration, not evidence that sign-in or any feature worked; this analysis itself has no browser. State missing access as a setup dependency, never permanent source-only scope. Never claim customer research, independent browser exploration, successful checks, or current telemetry that was not supplied.
The analysis itself cannot create PMs, tickets or automation; that restriction applies to this setup operation and must NOT become a permanent ban in a suggested PM's mandate or charter. Do not turn a one-time discovery task into an ongoing PM. Under promotion workflow, humans approve epics and final promotion PRs according to approvalPolicy; PMs may investigate, file approved-scope work and QA individual tickets without inventing a human review for each ticket or merge into integration. The PM does not implement code or approve its own implementation evidence. Keep Done tied to production delivery, preserve private data, and use nonproduction testing. Explicit owner-authored limits remain authoritative. Return proposals only; adoption is a separate owner action. Keep all drafts concise.
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
  options: {
    requireCrewDrafts?: boolean;
    allowEmptyCrew?: boolean;
    existingKeys?: string[];
  } = {},
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
  const reservedKeys = [...(options.existingKeys ?? [])];
  const pm = (item: unknown): SuggestedPm => {
    if (
      !object(item) ||
      !only(item, ["name", "mandate", "evidence", "draft", "rationale"]) ||
      !validText(item.name, 100) ||
      !validText(item.mandate, 3000, true)
    )
      throw invalid();
    let planned: Pick<SuggestedPm, "draft" | "rationale"> = {};
    if (item.draft !== undefined || item.rationale !== undefined) {
      if (!object(item.draft) || item.draft.name !== item.name) throw invalid();
      try {
        planned = validatePmDraft(
          { ...item.draft, rationale: item.rationale },
          sourceOwnershipPaths(snapshot.paths),
          reservedKeys,
        );
      } catch {
        throw invalid();
      }
      if (options.requireCrewDrafts && !planned.draft!.verificationRequirement)
        throw invalid();
      reservedKeys.push(planned.draft!.key);
    } else if (options.requireCrewDrafts) throw invalid();
    return {
      name: item.name,
      mandate: item.mandate,
      evidence: evidence(item.evidence),
      ...planned,
    };
  };
  let suggestedPms: ProjectSetupProposal["suggestedPms"];
  if (value.suggestedPms !== undefined) {
    if (
      !Array.isArray(value.suggestedPms) ||
      (!value.suggestedPms.length && !options.allowEmptyCrew) ||
      value.suggestedPms.length > 5
    )
      throw invalid();
    suggestedPms = value.suggestedPms.map(pm);
    if (
      new Set(suggestedPms.map((item) => item.name.trim().toLowerCase()))
        .size !== suggestedPms.length ||
      new Set(suggestedPms.map((item) => item.mandate.trim().toLowerCase()))
        .size !== suggestedPms.length
    )
      throw invalid();
  } else if (options.requireCrewDrafts && !options.allowEmptyCrew) {
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

/** Directory scopes are derived from real paths, never invented by the model. */
export function sourceOwnershipPaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((path) => {
        const parts = path.split("/");
        return [
          path,
          ...parts
            .slice(0, -1)
            .map((_, index) => parts.slice(0, index + 1).join("/")),
        ];
      }),
    ),
  ].sort();
}
