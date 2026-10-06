import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  loadProject,
  validSourceRepository,
  validSourceServer,
} from "../config.ts";
import {
  createDockerPlanner,
  PlannerExecutionError,
  type PlannerExecutor,
} from "../pmPlanner/docker.ts";
import { readConnections } from "../setup/connections.ts";
import {
  assertNoSymlinks,
  initializeSetup,
  validateName,
} from "../setup/files.ts";
import {
  SourceControlError,
  type NewRepository,
  type SourceControl,
} from "../sourceControl/types.ts";
import { createSourceControl } from "../sourceControl/index.ts";
import { createLinearProvisioning } from "../setup/linearProvisioning.ts";
import { createProjectKnowledge } from "../projectKnowledge/index.ts";
import { redactHistory } from "../storage/activity.ts";
import { sourceRequest } from "../projectOnboarding/repository.ts";
import {
  areaInput,
  CREW_SCHEMA,
  IdeaCrewError,
  object,
  SYSTEM,
  validateCrewPlan,
  type CrewPlan,
} from "./plan.ts";
export { IdeaCrewError } from "./plan.ts";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const busy = new Set<string>();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CrewDraft {
  id: string;
  revision: string;
  idea: string;
  plan: CrewPlan;
  createdAt: string;
}
export interface CrewTarget {
  project: string;
  repo: string;
  provider: "github" | "gitlab";
  serverUrl?: string;
  connectionId: string;
  newRepository?: NewRepository;
}
interface Saved extends CrewDraft {
  launch?: {
    target: CrewTarget;
    stage: "source" | "project" | "crew" | "complete";
    branch?: string;
    initialized?: boolean;
    repositoryId?: string;
  };
}
export interface IdeaCrewOptions {
  root: string;
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  execute?: PlannerExecutor;
  sourceControl?: Pick<SourceControl, "resolveCredential" | "createRepository">;
  fetch?: typeof fetch;
  addArea?: (project: string, input: Record<string, unknown>) => Promise<void>;
}
export function createIdeaCrew(options: IdeaCrewOptions) {
  const { root, packageRoot } = options;
  const source =
    options.sourceControl ?? createSourceControl({ root, env: options.env });
  const execute = options.execute ?? createDockerPlanner({ root, packageRoot });
  const addArea =
    options.addArea ??
    createLinearProvisioning({
      root,
      client: async () => {
        throw new Error("No remote Linear writes during crew creation.");
      },
    }).addArea;
  const knowledge = createProjectKnowledge({ root });
  const directory = join(root, ".run", "idea-crew");
  function file(id: string) {
    if (!UUID.test(id)) throw new IdeaCrewError("Choose a saved idea plan.");
    const path = join(directory, `${id}.json`);
    assertNoSymlinks(path);
    if (
      existsSync(path) &&
      (!lstatSync(path).isFile() ||
        lstatSync(path).nlink !== 1 ||
        lstatSync(path).size > 128 * 1024)
    )
      throw new IdeaCrewError(
        "The saved idea plan cannot be read safely.",
        409,
      );
    return path;
  }
  function write(saved: Saved) {
    const path = file(saved.id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(saved, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  function read(id: string): Saved {
    const path = file(id);
    if (!existsSync(path))
      throw new IdeaCrewError(
        "This idea plan is unavailable. Generate a new plan.",
        404,
      );
    const saved = JSON.parse(readFileSync(path, "utf8")) as Saved;
    saved.plan = validateCrewPlan(saved.plan);
    if (
      saved.id !== id ||
      typeof saved.idea !== "string" ||
      saved.revision !== hash({ idea: saved.idea, plan: saved.plan })
    )
      throw new IdeaCrewError(
        "The saved plan changed. Generate a fresh plan before creating the crew.",
        409,
      );
    return saved;
  }
  const credentials = () => ({
    ...readConnections(root),
    ...(options.env ?? process.env),
  });
  const secrets = () =>
    Object.entries(credentials())
      .filter(
        ([key, value]) =>
          value && /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/.test(key),
      )
      .map(([, value]) => value!);
  function checkSecrets(text: string) {
    if (redactHistory(text, secrets()) !== text)
      throw new IdeaCrewError(
        "Keep credentials out of the idea and crew plan. Save them in Connections.",
      );
  }
  function target(input: Record<string, unknown>): CrewTarget {
    const provider = input.provider ?? "github";
    if (
      typeof input.project !== "string" ||
      typeof input.repo !== "string" ||
      !["github", "gitlab"].includes(String(provider)) ||
      !validSourceRepository(input.repo, String(provider))
    )
      throw new IdeaCrewError(
        "Choose a project name and a GitHub or GitLab repository.",
      );
    try {
      validateName(input.project, "project");
    } catch {
      throw new IdeaCrewError("Use a portable lowercase project ID.");
    }
    if (
      input.serverUrl !== undefined &&
      (provider !== "gitlab" || !validSourceServer(input.serverUrl))
    )
      throw new IdeaCrewError(
        "Use an HTTPS GitLab origin without credentials or a path.",
      );
    const connectionId = input.connectionId ?? "default";
    let newRepository: NewRepository | undefined;
    if (input.newRepository !== undefined) {
      const settings = input.newRepository;
      if (
        !object(settings) ||
        Object.keys(settings).some(
          (k) => !["ownerId", "accountId", "visibility"].includes(k),
        ) ||
        typeof settings.ownerId !== "string" ||
        !/^\d+$/.test(settings.ownerId) ||
        typeof settings.accountId !== "string" ||
        !/^\d+$/.test(settings.accountId) ||
        (settings.visibility !== undefined &&
          !["private", "public"].includes(String(settings.visibility)))
      )
        throw new IdeaCrewError(
          "Choose a repository owner and either private or public visibility.",
        );
      newRepository = {
        ownerId: settings.ownerId,
        accountId: settings.accountId,
        visibility: settings.visibility === "public" ? "public" : "private",
      };
      if (input.repo.split("/").at(-1) !== input.project)
        throw new IdeaCrewError(
          "Use the project name for your new repository.",
        );
    }
    if (
      typeof connectionId !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(connectionId)
    )
      throw new IdeaCrewError("Choose a saved Linear connection.");
    return {
      project: input.project,
      repo: input.repo,
      provider: provider as CrewTarget["provider"],
      ...(input.serverUrl
        ? { serverUrl: String(input.serverUrl).replace(/\/$/, "") }
        : {}),
      connectionId,
      ...(newRepository ? { newRepository } : {}),
    };
  }
  async function prepareSource(saved: Saved) {
    const launch = saved.launch!,
      input = launch.target;
    if (input.newRepository) {
      if (!source.createRepository)
        throw new IdeaCrewError(
          "Repository creation is unavailable. Update the controller before resuming.",
          503,
        );
      const repository = await source.createRepository({
        provider: input.provider,
        serverUrl: input.serverUrl,
        repository: input.repo,
        ...input.newRepository,
        creationId: saved.id,
      });
      if (launch.repositoryId && launch.repositoryId !== repository.id)
        throw new IdeaCrewError(
          "The created repository was replaced. Check its identity before resuming.",
          409,
        );
      launch.repositoryId = repository.id;
      write(saved);
    }
    const credential = await source.resolveCredential({
      provider: input.provider,
      repository: input.repo,
      serverUrl: input.serverUrl,
      write: true,
      minValidityMs: 5 * 60_000,
    });
    const github = input.provider === "github";
    const api = github
      ? `https://api.github.com/repos/${input.repo}`
      : `${input.serverUrl ?? "https://gitlab.com"}/api/v4/projects/${encodeURIComponent(input.repo)}`;
    const signal = AbortSignal.timeout(45000);
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      missing = false,
    ) =>
      sourceRequest(
        options.fetch ?? fetch,
        api + path,
        credential.token,
        signal,
        method,
        body,
        missing,
      ).then((r) => r.value);
    const metadata = await request("");
    if (!object(metadata))
      throw new IdeaCrewError("The repository could not be inspected.", 502);
    const branch =
      typeof metadata.default_branch === "string" && metadata.default_branch
        ? metadata.default_branch
        : "main";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.includes("..")
    )
      throw new IdeaCrewError(
        "Choose a repository with a supported default branch.",
      );
    const branches = await request(
      github ? "/branches?per_page=1" : "/repository/branches?per_page=1",
    );
    if (!Array.isArray(branches))
      throw new IdeaCrewError("Repository branch status is unavailable.", 502);
    const content = `# ${saved.plan.name}\n\n${saved.plan.summary}\n\n## First milestone\n\n${saved.plan.firstMilestone}\n\nThis repository starts from a ShipGremlins product brief. Application code and tests still need to be implemented through reviewed work.\n\n<!-- ShipGremlins idea plan: ${saved.id} -->\n`;
    if (launch.initialized) {
      // A previous write may have succeeded even if its response was lost.
      const existing = await request(
        github
          ? `/contents/README.md?ref=${encodeURIComponent(branch)}`
          : `/repository/files/README.md?ref=${encodeURIComponent(branch)}`,
        "GET",
        undefined,
        true,
      );
      if (existing !== null) {
        if (
          !object(existing) ||
          existing.encoding !== "base64" ||
          typeof existing.content !== "string" ||
          Buffer.from(existing.content, "base64").toString("utf8") !== content
        )
          throw new IdeaCrewError(
            "The initialized repository changed. Review its README before resuming this plan.",
            409,
          );
        launch.branch = branch;
        return;
      }
      if (branches.length)
        throw new IdeaCrewError(
          "The repository changed during initialization. No existing files were overwritten.",
          409,
        );
    }
    if (!branches.length) {
      launch.initialized = true;
      write(saved); // Record the intent before the provider write.
      await request(
        github ? "/contents/README.md" : "/repository/commits",
        github ? "PUT" : "POST",
        github
          ? {
              message: "Start app from reviewed ShipGremlins brief",
              branch,
              content: Buffer.from(content).toString("base64"),
            }
          : {
              branch,
              commit_message: "Start app from reviewed ShipGremlins brief",
              actions: [{ action: "create", file_path: "README.md", content }],
            },
      );
    }
    launch.branch = branch;
  }
  return {
    get(id: string): CrewDraft & {
      project?: string;
      destination?: CrewTarget;
      complete: boolean;
    } {
      const saved = read(id);
      return {
        id: saved.id,
        revision: saved.revision,
        idea: saved.idea,
        plan: saved.plan,
        createdAt: saved.createdAt,
        ...(saved.launch
          ? {
              project: saved.launch.target.project,
              destination: saved.launch.target,
            }
          : {}),
        complete: saved.launch?.stage === "complete",
      };
    },
    async plan(idea: unknown, signal?: AbortSignal): Promise<CrewDraft> {
      if (
        typeof idea !== "string" ||
        idea.trim().length < 25 ||
        idea.length > 12000 ||
        /\p{Cc}/u.test(idea.replace(/[\r\n\t]/g, ""))
      )
        throw new IdeaCrewError(
          "Describe your app in 25–12000 characters: who it is for and what its first version should do.",
        );
      checkSecrets(idea);
      const credential = credentials().CLAUDE_CODE_OAUTH_TOKEN;
      if (!credential)
        throw new IdeaCrewError(
          "Connect Claude Code in Connections before planning your crew.",
        );
      const key = `${resolve(root)}:plan`;
      if (busy.has(key))
        throw new IdeaCrewError(
          "A crew plan is already being generated. Wait or cancel it first.",
          409,
        );
      busy.add(key);
      const bounded = AbortSignal.any([
        AbortSignal.timeout(180000),
        ...(signal ? [signal] : []),
      ]);
      try {
        const output = await execute({
          usageContext: { kind: "idea-planning" },
          credential,
          prompt: JSON.stringify({ idea }),
          system: SYSTEM,
          schema: CREW_SCHEMA,
          signal: bounded,
        });
        bounded.throwIfAborted();
        checkSecrets(JSON.stringify(output));
        const plan = validateCrewPlan(output);
        const saved: Saved = {
          id: randomUUID(),
          idea: idea.trim(),
          plan,
          revision: hash({ idea: idea.trim(), plan }),
          createdAt: new Date().toISOString(),
        };
        write(saved);
        return saved;
      } catch (error) {
        if (error instanceof IdeaCrewError) throw error;
        if (error instanceof PlannerExecutionError)
          throw new IdeaCrewError(error.message, 503);
        throw new IdeaCrewError(
          bounded.aborted
            ? "Crew planning stopped. Your idea was kept; no project was created."
            : "Crew planning could not finish. Check Claude Code and Docker, then retry.",
          bounded.aborted ? 408 : 503,
        );
      } finally {
        busy.delete(key);
      }
    },
    async create(id: string, input: Record<string, unknown>) {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "revision",
              "project",
              "repo",
              "provider",
              "serverUrl",
              "connectionId",
              "newRepository",
            ].includes(key),
        )
      )
        throw new IdeaCrewError(
          "Provide the reviewed plan revision and project destination only.",
        );
      const destination = target(input),
        key = `${resolve(root)}:create`;
      if (busy.has(key))
        throw new IdeaCrewError(
          "A crew is being created. Wait and retry the same plan.",
          409,
        );
      busy.add(key);
      try {
        const saved = read(id);
        if (input.revision !== saved.revision)
          throw new IdeaCrewError(
            "Review the current crew plan before creating it.",
            409,
          );
        checkSecrets(saved.idea + JSON.stringify(saved.plan));
        if (saved.launch && hash(saved.launch.target) !== hash(destination))
          throw new IdeaCrewError(
            "This plan is already bound to another destination. Resume it with the original repository and project ID.",
            409,
          );
        if (!saved.launch) {
          if (existsSync(join(root, "projects", destination.project)))
            throw new IdeaCrewError(
              "That local project already exists. Choose a new project ID.",
              409,
            );
          saved.launch = { target: destination, stage: "source" };
          write(saved);
        }
        const launch = saved.launch;
        if (launch.stage === "source") {
          await prepareSource(saved);
          launch.stage = "project";
          write(saved);
        }
        const projectFile = join(
          root,
          "projects",
          destination.project,
          "project.json",
        );
        assertNoSymlinks(projectFile);
        if (existsSync(projectFile)) {
          const raw = JSON.parse(readFileSync(projectFile, "utf8"));
          if (
            raw.ideaPlanId !== id ||
            raw.repo !== destination.repo ||
            raw.provider !== destination.provider
          )
            throw new IdeaCrewError(
              "This project no longer belongs to the saved idea plan. Existing settings were preserved.",
              409,
            );
        } else {
          if (launch.stage !== "project")
            throw new IdeaCrewError(
              "The created project was removed. Restore it before resuming the plan.",
              409,
            );
          initializeSetup(root, packageRoot, {
            ...destination,
            createInitialPm: false,
            settings: {
              ideaPlanId: id,
              workflow: { kind: "pull-request", baseBranch: launch.branch },
              verification: { mode: "repository" },
              commands: {
                install: "if [ -f package.json ]; then npm install; fi",
                test: "npm test",
                lint: null,
                typecheck: null,
              },
              linear: { connectionId: destination.connectionId },
            },
          });
        }
        if (launch.stage !== "complete") {
          launch.stage = "crew";
          write(saved);
          for (const member of saved.plan.crew) {
            const desired = areaInput(saved.plan, member);
            const existing = loadProject(root, destination.project).areas.find(
              (area) => area.key === member.key,
            );
            if (existing) {
              if (
                existing.name !== desired.name ||
                existing.mandate !== desired.mandate
              )
                throw new IdeaCrewError(
                  "A crew member was edited during setup. Existing PM settings were preserved.",
                  409,
                );
            } else await addArea(destination.project, desired);
          }
          const shared = `Idea crew ${id}\n${saved.plan.summary}\n\nFirst milestone: ${saved.plan.firstMilestone}\nBuild order: ${saved.plan.crew.map((member) => `${member.key} (depends on ${member.dependsOn.join(", ") || "none"})`).join("; ")}\nUse one shared Node.js application with npm start and meaningful npm test checks. Planned ownership paths must be checked against the source after scaffolding. Start with foundation; keep other PMs paused until their prerequisites exist. This brief does not approve implementation tickets.`;
          const state = knowledge.read(destination.project);
          if (
            !state.decisions.some((decision) =>
              decision.text.startsWith(`Idea crew ${id}\n`),
            )
          )
            knowledge.add(destination.project, {
              text: shared,
              revision: state.revision,
            });
          launch.stage = "complete";
          write(saved);
        }
        return {
          ok: true,
          project: destination.project,
          primaryPm: "foundation",
          planId: id,
          crew: saved.plan.crew.map(({ key, name }) => ({ key, name })),
          initializedRepository: launch.initialized === true,
          message:
            "Your repository and crew are ready. Review the foundation build to create its Linear ticket and start a Coding Gremlin. No test environment is needed yet; PM schedules stay paused.",
        };
      } catch (error) {
        if (error instanceof IdeaCrewError) throw error;
        if (error instanceof SourceControlError)
          throw new IdeaCrewError(error.message, error.status);
        throw new IdeaCrewError(
          "Crew setup stopped. Check source access and project setup, then retry this same plan to resume without duplicating saved PMs.",
          503,
        );
      } finally {
        busy.delete(key);
      }
    },
  };
}
export type IdeaCrew = ReturnType<typeof createIdeaCrew>;
