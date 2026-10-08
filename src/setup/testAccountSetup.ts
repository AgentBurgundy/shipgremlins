import { randomUUID } from "node:crypto";
import { loadProject } from "../config.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import {
  parsePasswordRecipe,
  parseTestAccess,
  type PasswordRecipe,
} from "../testAccess.ts";
import type { OnboardingState } from "../projectOnboarding/types.ts";
import {
  ConfigEditorError,
  readEditableConfig,
  saveEditableConfig,
} from "./configEditor.ts";
import { readConnections } from "./connections.ts";
import { stageTestCredentials } from "./testAccountStore.ts";

const controls = (value: string) =>
  [...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const fail = (message: string, status = 400): never => {
  throw new ConfigEditorError(
    status === 409 ? "conflict" : "invalid_config",
    message,
    status,
  );
};
export function testAccountSetupState(
  root: string,
  name: string,
  state: OnboardingState,
) {
  const verification = effectiveVerification(loadProject(root, name).config);
  const access =
    verification.mode === "browser" ? verification.target.access : undefined;
  const saved = { ...process.env, ...readConnections(root) };
  const suggestion = state.recommendationsReviewable
    ? state.report?.projectSetup?.appAccess
    : undefined;
  return {
    testAccountSetupSupported: true,
    testAccounts:
      access?.kind === "password"
        ? access.accounts.map((account, index) => ({
            ...(account.id ? { id: account.id } : {}),
            name: account.name,
            index,
            usernameSaved: !!saved[account.usernameSecret],
            passwordSaved: !!saved[account.passwordSecret],
          }))
        : [],
    ...(suggestion
      ? {
          testAccountSuggestion: {
            kind: suggestion.kind,
            summary: suggestion.summary,
            sourceRevision: state.revision,
            ...(suggestion.password ? { recipe: suggestion.password } : {}),
          },
        }
      : {}),
  };
}

/** Call under the project's controller mutation guard. No network writes or AI job. */
export function connectTestAccount(
  root: string,
  name: string,
  input: unknown,
  state: OnboardingState,
) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "configurationRevision",
          "sourceRevision",
          "recipe",
          "account",
        ].includes(key),
    ) ||
    typeof input.configurationRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.configurationRevision) ||
    (input.sourceRevision !== undefined &&
      (typeof input.sourceRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.sourceRevision))) ||
    !object(input.account)
  )
    return fail(
      "Use the current project settings and a dedicated test account.",
    );
  const document = readEditableConfig(root, `projects/${name}/project.json`);
  if (document.revision !== input.configurationRevision)
    return fail(
      "Project settings changed. Refresh before connecting this test account; your saved accounts are unchanged.",
      409,
    );
  const project = loadProject(root, name).config,
    verification = effectiveVerification(project);
  if (verification.mode !== "browser")
    return fail(
      "Connect this project's test environment before adding its test account.",
      409,
    );
  const current = verification.target.access,
    existing = current?.kind === "password" ? current.accounts : [];
  const account = input.account;
  if (
    Object.keys(account).some(
      (key) =>
        !["id", "index", "name", "username", "password", "assertions"].includes(
          key,
        ),
    ) ||
    typeof account.name !== "string" ||
    !account.name.trim() ||
    account.name.length > 80 ||
    controls(account.name)
  )
    return fail("Give the test account a short, unique name.");
  let index = -1;
  if (account.id !== undefined) {
    if (typeof account.id !== "string")
      return fail("Choose an existing test account.");
    index = existing.findIndex((item) => item.id === account.id);
    if (index < 0)
      return fail(
        "This test account changed. Refresh its saved settings.",
        409,
      );
  }
  if (account.index !== undefined) {
    if (
      !Number.isInteger(account.index) ||
      Number(account.index) < 0 ||
      Number(account.index) >= existing.length ||
      (index >= 0 && index !== account.index)
    )
      return fail(
        "This test account changed. Refresh its saved settings.",
        409,
      );
    index = Number(account.index);
  }
  const previous = existing[index];
  for (const key of ["username", "password"] as const)
    if (
      account[key] !== undefined &&
      (typeof account[key] !== "string" ||
        account[key].length > (key === "username" ? 4096 : 16384) ||
        controls(account[key]))
    )
      return fail(
        "Test-account credentials must be bounded, single-line text.",
      );
  const username =
    typeof account.username === "string" && account.username !== ""
      ? account.username
      : undefined;
  const password =
    typeof account.password === "string" && account.password !== ""
      ? account.password
      : undefined;
  const saved = { ...process.env, ...readConnections(root) };
  if (
    (!username && (!previous || !saved[previous.usernameSecret])) ||
    (!password && (!previous || !saved[previous.passwordSecret]))
  )
    return fail(
      "Enter both the test account username and password. Saved values may be left blank.",
    );
  let rawRecipe = input.recipe;
  if (rawRecipe === undefined && current?.kind === "password") {
    const { kind: _kind, accounts: _accounts, ...recipe } = current;
    rawRecipe = recipe;
  }
  if (rawRecipe === undefined) {
    if (
      !state.recommendationsReviewable ||
      input.sourceRevision !== state.revision ||
      !state.report?.projectSetup?.appAccess?.password
    )
      return fail(
        "Investigate this app's sign-in flow or choose its login details before connecting the account.",
        409,
      );
    rawRecipe = state.report.projectSetup.appAccess.password;
  }
  let recipe: PasswordRecipe;
  try {
    recipe = parsePasswordRecipe(rawRecipe);
  } catch {
    return fail(
      "Use a valid same-app login route and supported sign-in controls.",
    );
  }
  if (
    /^(?:body|html|h[1-6]|button|form|input|\*)$/i.test(
      recipe.successSelector.trim(),
    )
  )
    return fail(
      "The sign-in confirmation must identify UI that only appears after authentication.",
    );
  const staged =
    username !== undefined || password !== undefined
      ? stageTestCredentials(root, project, { username, password })
      : undefined;
  try {
    const updated = {
      ...(previous ?? {}),
      id: previous?.id ?? randomUUID(),
      name: account.name.trim(),
      usernameSecret:
        username !== undefined
          ? staged!.references.username
          : previous!.usernameSecret,
      passwordSecret:
        password !== undefined
          ? staged!.references.password
          : previous!.passwordSecret,
      ...(account.assertions !== undefined
        ? { assertions: account.assertions }
        : {}),
    };
    const accounts: unknown[] = [...existing];
    if (index < 0) accounts.push(updated);
    else accounts[index] = updated;
    let access;
    try {
      access = parseTestAccess({ kind: "password", ...recipe, accounts });
    } catch {
      return fail(
        "Use distinct account names, valid identity checks, and no more than eight test accounts.",
      );
    }
    const raw = JSON.parse(document.content),
      environment = verification.environment ?? "pm-test";
    raw.environments = {
      ...raw.environments,
      [environment]: { ...verification.target, access },
    };
    raw.verification = { mode: "browser", environment };
    raw.verified = null;
    saveEditableConfig(root, {
      path: document.path,
      revision: document.revision,
      content: JSON.stringify(raw, null, 2) + "\n",
    });
    return { id: updated.id, index: index < 0 ? accounts.length - 1 : index };
  } catch (error) {
    staged?.discard();
    throw error;
  }
}
