import { loadProject } from "../config.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
import {
  inspectPmReadiness,
  PmControlError,
  type ReadinessContext,
} from "./pmReadiness.ts";

/** One revision-guarded write after every adopted PM's prerequisites pass. */
export async function activateProjectCrew(
  root: string,
  name: string,
  input: {
    projectRevision: string;
    areasRevision: string;
  },
  options: {
    context: () => Promise<ReadinessContext>;
    validate: (area: string) => Promise<unknown>;
  },
) {
  const projectDocument = readEditableConfig(
    root,
    `projects/${name}/project.json`,
  );
  const areasDocument = readEditableConfig(root, `projects/${name}/areas.json`);
  const unchanged = () => {
    if (
      readEditableConfig(root, projectDocument.path).revision !==
        input.projectRevision ||
      readEditableConfig(root, areasDocument.path).revision !==
        input.areasRevision
    )
      throw new PmControlError(
        "Project setup changed. Refresh your crew before activating it.",
        409,
      );
  };
  unchanged();
  const project = loadProject(root, name);
  if (!project.areas.length)
    throw new PmControlError(
      "Adopt at least one PM before activating your crew.",
      409,
    );
  const context = await options.context();
  const readiness = inspectPmReadiness(project, context);
  const blocked = readiness.areas.filter(
    (area) => !area.canRun || !area.canEnable || !area.coding.canEnable,
  );
  if (blocked.length)
    throw new PmControlError(
      "Finish project setup before activating the crew. " +
        [
          ...new Set(
            blocked.flatMap((area) =>
              [
                ...area.blockers,
                ...area.enableBlockers,
                ...area.coding.enableBlockers,
              ].map((blocker) => blocker.message),
            ),
          ),
        ].join(" "),
      409,
    );
  for (const area of project.areas) await options.validate(area.key);
  unchanged();
  const value = JSON.parse(areasDocument.content);
  for (const area of project.areas)
    Object.assign(value.areas[area.key], {
      enabled: true,
      codingEnabled: true,
    });
  const saved = saveEditableConfig(root, {
    path: areasDocument.path,
    revision: areasDocument.revision,
    content: JSON.stringify(value, null, 2) + "\n",
  });
  return {
    ok: true,
    projectRevision: projectDocument.revision,
    areasRevision: saved.revision,
    readiness: inspectPmReadiness(loadProject(root, name), context),
    message:
      "Your crew is active. PMs run on their schedules; coding picks up eligible work under your saved approval and delivery policy.",
  };
}
