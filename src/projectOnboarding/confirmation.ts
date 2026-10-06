import { loadProject, type Project } from "../config.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import {
  digest,
  type createOnboardingStore,
  type StoredOnboarding,
  type SetupAcknowledgement,
} from "./store.ts";
import {
  PROJECT_COMMAND_KEYS,
  ProjectOnboardingError,
  type ConfirmProjectSetupInput,
  type SetupConfirmation,
} from "./types.ts";
import { SHA } from "./repository.ts";

const revisionPattern = /^[a-f0-9]{64}$/;
const reportRevision = (state: StoredOnboarding) =>
  digest(JSON.stringify(state.report));
function sameIdentity(project: Project, ack: SetupAcknowledgement) {
  return (
    ack.projectInstanceId === project.config.instanceId &&
    ack.repository.repo === project.config.repo &&
    ack.repository.provider === (project.config.provider ?? "github") &&
    ack.repository.serverUrl === project.config.serverUrl
  );
}
export function confirmationState(
  state: StoredOnboarding,
  project: Project,
  configurationRevision: string,
): SetupConfirmation {
  const ack = state.setupAcknowledgement;
  if (
    !ack ||
    !sameIdentity(project, ack) ||
    ack.reportRevision !== reportRevision(state)
  )
    return { confirmed: false };
  return {
    confirmed: ack.configurationRevision === configurationRevision,
    confirmedAt: ack.confirmedAt,
    repositorySha: ack.repository.sha,
    commandKeys: [...ack.commandKeys],
  };
}
export function validateConfirmationInput(
  input: unknown,
): asserts input is ConfirmProjectSetupInput {
  const value = input as ConfirmProjectSetupInput;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "revision",
          "configurationRevision",
          "repositorySha",
          "commandKeys",
        ].includes(key),
    ) ||
    typeof value.revision !== "string" ||
    !revisionPattern.test(value.revision) ||
    typeof value.configurationRevision !== "string" ||
    !revisionPattern.test(value.configurationRevision) ||
    typeof value.repositorySha !== "string" ||
    !SHA.test(value.repositorySha) ||
    !Array.isArray(value.commandKeys) ||
    value.commandKeys.length > 5 ||
    value.commandKeys.some((key) => !PROJECT_COMMAND_KEYS.includes(key)) ||
    new Set(value.commandKeys).size !== value.commandKeys.length
  )
    throw new ProjectOnboardingError(
      "Review the current source report and choose only its supported command suggestions.",
      400,
      "invalid_confirmation",
    );
}
/** A durable intent precedes the config CAS, so a lost acknowledgement can recover safely. */
export async function confirmSetup(options: {
  root: string;
  store: ReturnType<typeof createOnboardingStore>;
  project: string;
  input: ConfirmProjectSetupInput;
  checkHead: (project: Project, branch: string) => Promise<string>;
}) {
  const { root, store, project: name, input } = options;
  validateConfirmationInput(input);
  const selected = loadProject(root, name),
    state = store.read(name),
    file = "projects/" + name + "/project.json";
  const conflict = () =>
    new ProjectOnboardingError(
      "Project setup or repository changed. Reload and reanalyze before confirming these suggestions.",
      409,
      "conflict",
    );
  if (!state?.report?.projectSetup)
    throw new ProjectOnboardingError(
      "Analyze this repository again to get reviewable project setup suggestions. Existing reports remain available.",
      409,
      "proposal_missing",
    );
  const sourceReport = state.report,
    sourceRevision = reportRevision(state);
  const keys = PROJECT_COMMAND_KEYS.filter((key) =>
    input.commandKeys.includes(key),
  );
  if (keys.some((key) => !sourceReport.projectSetup!.commands[key]))
    throw new ProjectOnboardingError(
      "Select only command suggestions present in this reviewed report.",
      400,
      "invalid_confirmation",
    );
  const checkState = (value: StoredOnboarding | undefined) => {
    if (
      !value?.report ||
      value.operation ||
      value.status !== "analyzed" ||
      reportRevision(value) !== sourceRevision ||
      value.report.repository.repo !== selected.config.repo ||
      value.report.repository.provider !==
        (selected.config.provider ?? "github") ||
      value.report.repository.sha !== input.repositorySha
    )
      throw conflict();
    const ack = value.setupAcknowledgement;
    const replay =
      ack &&
      sameIdentity(selected, ack) &&
      ack.reportRevision === sourceRevision &&
      ack.requestRevision === input.revision &&
      ack.previousConfigurationRevision === input.configurationRevision &&
      JSON.stringify(ack.commandKeys) === JSON.stringify(keys);
    if (
      !replay &&
      (digest(JSON.stringify(value)) !== input.revision ||
        value.configurationRevision !== input.configurationRevision)
    )
      throw conflict();
    return replay ? ack : undefined;
  };
  const previousAck = checkState(state),
    before = readEditableConfig(root, file);
  if (
    before.revision !== input.configurationRevision &&
    before.revision !== previousAck?.configurationRevision
  )
    throw conflict();
  if (
    (await options.checkHead(selected, sourceReport.repository.branch)) !==
    input.repositorySha
  )
    throw new ProjectOnboardingError(
      "The repository branch changed after analysis. Reanalyze before confirming project setup.",
      409,
      "stale_repository",
    );
  const checkIdentity = () => {
    const current = loadProject(root, name);
    if (
      current.config.instanceId !== selected.config.instanceId ||
      current.config.repo !== selected.config.repo ||
      current.config.provider !== selected.config.provider ||
      current.config.serverUrl !== selected.config.serverUrl
    )
      throw conflict();
  };
  let content = before.content;
  if (!previousAck || before.revision !== previousAck.configurationRevision) {
    const raw = JSON.parse(before.content),
      commands = { ...raw.commands };
    let changed = false;
    for (const key of keys) {
      const command = sourceReport.projectSetup!.commands[key]!.command;
      if (
        typeof command !== "string" ||
        !command.trim() ||
        command.length > 1000 ||
        [...command].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      )
        throw conflict();
      if (commands[key] !== command) {
        commands[key] = command;
        changed = true;
      }
    }
    if (changed) {
      raw.commands = commands;
      raw.verified = null;
      content = JSON.stringify(raw, null, 2) + "\n";
    }
  }
  const targetRevision = previousAck?.configurationRevision ?? digest(content);
  const acknowledgement = await store.change(name, (current) => {
    checkIdentity();
    const existing = checkState(current);
    const document = readEditableConfig(root, file);
    if (
      document.revision !== input.configurationRevision &&
      document.revision !== existing?.configurationRevision
    )
      throw conflict();
    const ack: SetupAcknowledgement = existing ?? {
      requestRevision: input.revision,
      previousConfigurationRevision: input.configurationRevision,
      configurationRevision: targetRevision,
      reportRevision: sourceRevision,
      projectInstanceId: selected.config.instanceId,
      repository: {
        repo: selected.config.repo,
        provider: selected.config.provider ?? "github",
        serverUrl: selected.config.serverUrl,
        branch: sourceReport.repository.branch,
        sha: input.repositorySha,
      },
      confirmedAt: new Date().toISOString(),
      commandKeys: keys,
    };
    current!.setupAcknowledgement = ack;
    return { state: current!, result: ack };
  });
  await store.change(name, (current) => {
    checkIdentity();
    const ack = checkState(current);
    if (!ack || JSON.stringify(ack) !== JSON.stringify(acknowledgement))
      throw conflict();
    const document = readEditableConfig(root, file);
    if (document.revision !== ack.configurationRevision) {
      if (
        document.revision !== input.configurationRevision ||
        digest(content) !== ack.configurationRevision
      )
        throw conflict();
      saveEditableConfig(root, {
        path: file,
        revision: document.revision,
        content,
      });
    }
    current!.configurationRevision = ack.configurationRevision;
    current!.stage = "setup-confirmed";
    current!.message =
      "Project setup reviewed. Selected commands were saved without running them. Review the suggested PM before adoption.";
    current!.updatedAt = new Date().toISOString();
    return { state: current!, result: undefined };
  });
}
