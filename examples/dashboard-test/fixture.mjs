import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { initializeSetup } from "../../src/setup/files.ts";
import { loadProject } from "../../src/config.ts";
import { createLinearProvisioning } from "../../src/setup/linearProvisioning.ts";
import { summarizeActivity } from "../../src/storage/activity.ts";
import { JobReadinessError } from "../../src/localRunners/jobs.ts";

const notice =
  "DISPOSABLE FIXTURE: providers, AI work and run evidence are simulated. No external service was verified.";
const teamId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const areaProjects = {
  security: "33333333-3333-4333-8333-333333333333",
  accessibility: "44444444-4444-4444-8444-444444444444",
  checkout: "55555555-5555-4555-8555-555555555555",
};
const deny = async () => {
  throw new Error(
    "External operations are disabled in this disposable dashboard fixture.",
  );
};
const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const json = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

/** Real configuration and HTTP/UI behavior; deliberately synthetic provider boundaries. */
export function createFixture(root, packageRoot) {
  initializeSetup(root, packageRoot, {
    project: "dashboard-demo",
    repo: "fixture/dashboard-demo",
    createInitialPm: false,
  });
  initializeSetup(root, packageRoot, {
    project: "checkout-demo",
    repo: "fixture/checkout-demo",
    createInitialPm: false,
  });
  for (const name of ["dashboard-demo", "checkout-demo"]) {
    const file = join(root, "projects", name, "project.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.verified = now().slice(0, 10);
    config.linear = {
      teamId,
      teamName: "Fixture team (synthetic)",
      workspaceId,
    };
    config.commands = {
      install: "npm ci",
      test: "npm test",
      lint: null,
      typecheck: null,
      build: null,
    };
    if (name === "dashboard-demo") {
      config.environments = {
        fixture: {
          kind: "url",
          role: "staging",
          url: "http://app.test:3000",
          access: {
            kind: "password",
            loginPath: "/fixture/login",
            usernameSelector: "#fixture-username",
            passwordSelector: "#fixture-password",
            submitSelector: "#fixture-submit",
            successSelector: "#fixture-signed-in",
            accounts: [
              {
                name: "Synthetic member",
                usernameSecret: "TEST_FIXTURE_USERNAME",
                passwordSecret: "TEST_FIXTURE_PASSWORD",
              },
            ],
          },
        },
      };
      config.verification = { mode: "browser", environment: "fixture" };
    }
    json(file, config);
    const areas = Object.fromEntries(
      (name === "dashboard-demo"
        ? ["security", "accessibility"]
        : ["checkout"]
      ).map((key, index) => [
        key,
        {
          name: `${key[0].toUpperCase() + key.slice(1)} Gremlin`,
          mandate: `Review the synthetic ${key} journey. Reproduce meaningful problems and distinguish observed behavior from simulated provider results. Never claim this fixture proves real worker or OAuth execution.`,
          charter: {
            ambition:
              "Make important dashboard workflows understandable and reliable.",
            goal: "Users can complete the synthetic flow without losing their edits.",
            users: ["New self-hosting owners", "Returning project maintainers"],
            expectedToBuild: ["Clear actionable setup and run feedback"],
            nonGoals: ["Real provider integration testing"],
            guardrails: ["Use only disposable fixture data"],
            standingPriorities: ["Preserve edits", "Accessible controls"],
            metricDefinition: "Successful completion of the fixture scenario.",
          },
          paths: ["dashboard/", "src/commands/"],
          sharedTouchpoints: ["package.json"],
          linearProjectId: areaProjects[key],
          label: `pm:${key}`,
          wipLimit: 2,
          metric: "/projects",
          schedule: "0 13 * * 1-5",
          enabled: index === 0,
        },
      ]),
    );
    json(join(root, "projects", name, "areas.json"), { areas });
  }
  writeFileSync(
    join(root, ".env"),
    "CLAUDE_CODE_OAUTH_TOKEN=fixture-not-a-real-credential\nTEST_FIXTURE_USERNAME=fixture-member\nTEST_FIXTURE_PASSWORD=fixture-password\n",
    { mode: 0o600 },
  );

  const stateFile = join(root, "fixture-state.json");
  const state = {
    nextRunId: 7,
    jobs: [],
    workers: [
      {
        id: "worker-fixture",
        name: "Synthetic local worker",
        status: "ready",
        busy: false,
        paused: false,
        createdAt: now(),
        verifiedAt: now(),
        message: notice,
      },
    ],
    output: {},
    providerProjects: Object.entries(areaProjects).map(([area, id]) => ({
      id,
      name: `Fixture ${area} PM project`,
      teamIds: [teamId],
      url: "https://linear.example.invalid/fixture",
    })),
    providerTickets: [
      ...Object.entries(areaProjects).map(([area, projectId], index) => ({
        id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
        identifier: `FIX-${101 + index}`,
        title: `SYNTHETIC approved ${area} improvement`,
        projectId,
        teamId,
        labels: [`pm:${area}`, "pm-approved"],
        stateType: "unstarted",
      })),
      {
        id: "66666666-6666-4666-8666-000000000099",
        identifier: "FIX-199",
        title: "SYNTHETIC unapproved checkout proposal",
        projectId: areaProjects.checkout,
        teamId,
        labels: ["pm:checkout"],
        stateType: "unstarted",
      },
    ],
  };
  const save = () => {
    json(stateFile + ".tmp", state);
    renameSync(stateFile + ".tmp", stateFile);
  };
  function output(job, browser = false) {
    let events = [
      {
        id: "fixture-start",
        type: "progress",
        timestamp: job.startedAt ?? job.createdAt,
        title: "Simulated investigation started",
        detail: notice,
        status: "succeeded",
      },
      {
        id: "fixture-read",
        type: "tool",
        timestamp: job.createdAt,
        title: "Read",
        detail:
          "Synthetic tool event: dashboard/project-workspace.js. No AI process was executed.",
        status: "succeeded",
      },
      ...(browser
        ? [
            {
              id: "fixture-browser",
              type: "tool",
              timestamp: job.createdAt,
              title: "mcp__playwright__browser_navigate",
              detail:
                "Synthetic recorded navigation event for the run-viewer scenario; not browser verification.",
              status: "succeeded",
            },
          ]
        : []),
      {
        id: "fixture-check",
        type: "check",
        timestamp: job.createdAt,
        title: "Fixture scenario check (simulated)",
        detail: "This seeded check is not a repository test result.",
        status: "succeeded",
      },
      {
        id: "fixture-summary",
        type: "summary",
        timestamp: job.createdAt,
        title: "Synthetic run summary",
        detail: browser
          ? "Demo evidence is available to exercise the run viewer. No real OAuth, AI worker, ticket publication or deployment was tested."
          : "Repository-only demo: no browser was used and no screenshot was captured.",
        status: "succeeded",
      },
    ];
    if (job.status === "queued")
      events = [
        {
          id: "fixture-queued",
          type: "progress",
          timestamp: job.createdAt,
          title: "Simulated run queued",
          detail:
            "No agent has started. This fixture preserves the queued scenario until canceled.",
          status: "running",
        },
      ];
    else if (job.status === "running")
      events = events
        .slice(0, 2)
        .map((event) => ({ ...event, status: "running" }));
    else if (job.status === "failed")
      events = events.map((event) =>
        event.type === "check"
          ? {
              ...event,
              status: "failed",
              detail:
                "Deliberately failed synthetic check for testing failure presentation.",
            }
          : event.type === "summary"
            ? {
                ...event,
                status: "failed",
                detail:
                  "Synthetic failure scenario. No real agent or repository check ran.",
              }
            : event,
      );
    const files = {
      "fixture-summary.md": `# Synthetic run ${job.runId}\n\n${notice}\n\n${browser ? "Includes a sample fixture screenshot for testing artifact presentation." : "No browser evidence."}\n`,
    };
    state.output[job.id] = {
      events,
      lines: [
        notice,
        ...events.map((event) => `GREMLINS_ACTIVITY ${JSON.stringify(event)}`),
      ],
      files,
      browser,
    };
  }
  for (const [index, scenario] of [
    "repository",
    "browser",
    "discovery",
    "failed",
    "queued",
    "running",
  ].entries()) {
    const job = {
      id: `job-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      runId: index + 1,
      type: "pm",
      project: "dashboard-demo",
      area: index % 2 ? "accessibility" : "security",
      workerId: "worker-fixture",
      createdAt: now(),
      status: ["queued", "running", "failed"].includes(scenario)
        ? scenario
        : "succeeded",
      message: `${notice} Scenario: ${scenario}.`,
      runOnce: true,
      ...(scenario === "discovery" ? { pmMode: "discovery" } : {}),
    };
    if (job.status !== "queued") job.startedAt = now();
    if (["succeeded", "failed"].includes(job.status)) {
      job.finishedAt = now();
      job.exitCode = scenario === "failed" ? 1 : 0;
    }
    state.jobs.push(job);
    output(job, scenario === "browser");
  }
  save();
  function lookup(id) {
    const job = state.jobs.find(
      (job) => job.id === id || job.runId === Number(id),
    );
    if (!job) throw new Error("Unknown fixture run.");
    return job;
  }
  const report = async (id) => state.output[id]?.lines ?? [];
  const artifactBytes = (id, name) => {
    const item = state.output[id];
    if (name === "fixture-screenshot.png" && item?.browser)
      return readFileSync(
        join(packageRoot, "examples/dashboard-test/fixture-screenshot.png"),
      );
    if (!item || !Object.hasOwn(item.files, name))
      throw new Error("Unknown fixture artifact.");
    return Buffer.from(item.files[name]);
  };
  const artifacts = async (id) => {
    const item = state.output[id];
    return [
      ...Object.keys(item?.files ?? {}),
      ...(item?.browser ? ["fixture-screenshot.png"] : []),
    ].map((name) => {
      const bytes = artifactBytes(id, name);
      return {
        name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(name.endsWith(".png") ? { png: true } : {}),
      };
    });
  };
  const runners = {
    status: async () => ({
      runners: clone(state.workers),
      jobs: clone(state.jobs).reverse(),
      operation: { phase: "idle", message: notice },
    }),
    jobs: async () => clone(state.jobs),
    job: async (id) =>
      clone(
        state.jobs.find((job) => job.id === id || job.runId === Number(id)) ??
          null,
      ),
    create: async () => {
      const worker = {
        ...state.workers[0],
        id: `worker-${randomUUID()}`,
        name: `Synthetic worker ${state.workers.length + 1}`,
      };
      state.workers.push(worker);
      save();
      return clone(worker);
    },
    action: async (id, action) => {
      const worker = state.workers.find((item) => item.id === id);
      if (!worker) throw new Error("Unknown fixture worker.");
      if (action === "remove")
        state.workers = state.workers.filter((item) => item.id !== id);
      else {
        worker.paused = action === "pause";
        worker.status = worker.paused ? "paused" : "ready";
        worker.message = notice;
      }
      save();
      return clone(worker);
    },
    enqueue: async (input) => {
      const job = {
        ...input,
        id: `job-${randomUUID()}`,
        runId: state.nextRunId++,
        status: "queued",
        createdAt: now(),
        message: "Simulated run queued. It does not start a real agent.",
      };
      state.jobs.push(job);
      output(job);
      save();
      return clone(job);
    },
    cancel: async (id) => {
      const job = lookup(id);
      if (["queued", "running"].includes(job.status))
        Object.assign(job, {
          status: "canceled",
          finishedAt: now(),
          message: "Synthetic run canceled; no worker process existed.",
        });
      save();
      return clone(job);
    },
    withConfigurationMutation: async (target, action) => {
      if (
        state.jobs.some(
          (job) =>
            ["queued", "running"].includes(job.status) &&
            (!target.project || job.project === target.project) &&
            (!target.area || job.area === target.area),
        )
      ) {
        const error = new Error(
          "Cancel this fixture project’s queued/running scenarios before removing it.",
        );
        error.status = 409;
        throw error;
      }
      return action();
    },
    logs: report,
    artifacts,
    readArtifact: async (id, name) => artifactBytes(id, name),
    tick: async () => {},
    start() {},
    stop: async () => {},
    addRemote: deny,
  };
  const activityStore = {
    ensure: async () => {},
    close: async () => {},
    status: async () => ({
      configured: true,
      ready: true,
      mode: "external",
      message: "Synthetic file-backed history; PostgreSQL is not running.",
    }),
    recordRun: async () => {},
    appendEvents: async () => {},
    saveLogs: async () => {},
    saveArtifacts: async () => {},
    captureRun: async () => {},
    listRuns: async ({ limit = 100, beforeRunId } = {}) =>
      clone(
        state.jobs
          .filter((job) => !beforeRunId || job.runId < beforeRunId)
          .reverse()
          .slice(0, limit),
      ),
    getRun: runners.job,
    events: async (id) => clone(state.output[id]?.events ?? []),
    activity: async (id) =>
      summarizeActivity(clone(state.output[id]?.events ?? [])),
    logs: report,
    artifacts,
    readArtifact: runners.readArtifact,
  };
  const sourceControl = {
    status: async () => [
      {
        provider: "github",
        serverUrl: "https://github.com",
        available: false,
        connected: true,
        method: "oauth",
        account: { id: "fixture", login: "FIXTURE ONLY" },
        message: notice,
      },
    ],
    repositories: async () => ({
      repositories: ["dashboard-demo", "checkout-demo"].map((name) => ({
        id: name,
        provider: "github",
        serverUrl: "https://github.com",
        fullName: `fixture/${name}`,
        defaultBranch: "main",
        private: true,
        webUrl: `https://example.invalid/${name}`,
        canPush: true,
      })),
      truncated: false,
    }),
    connect: deny,
    poll: deny,
    disconnect: deny,
    resolveCredential: async () => ({
      token: "fixture-never-sent",
      method: "oauth",
    }),
    acquireLease: deny,
    releaseLease: async () => {},
  };
  const connection = (provider) => ({
    status: async () => ({
      provider,
      available: false,
      connected: provider === "linear",
      method: provider === "linear" ? "oauth" : "none",
      workspace: { id: workspaceId, name: "SYNTHETIC workspace" },
      message: notice,
    }),
    connect: deny,
    complete: deny,
    disconnect: deny,
    resolveCredential: async () => ({
      token: "fixture-never-sent",
      authorization: "Bearer fixture-never-sent",
      method: "oauth",
      workspaceId,
    }),
    acquireLease: deny,
    releaseLease: async () => {},
  });
  const linearClient = {
    organization: async () => ({
      id: workspaceId,
      name: "SYNTHETIC workspace",
    }),
    getTeam: async (id) =>
      id === teamId ? { id, name: "Fixture team", key: "FIX" } : null,
    getProject: async (id) =>
      clone(state.providerProjects.find((item) => item.id === id) ?? null),
    resources: async () => ({
      teams: [{ id: teamId, name: "Fixture team", key: "FIX" }],
      projects: clone(state.providerProjects),
    }),
    createTeam: deny,
    createProject: async (input) => {
      const item = {
        id: input.id ?? randomUUID(),
        name: input.name,
        teamIds: [input.teamId],
        url: "https://linear.example.invalid/synthetic",
      };
      state.providerProjects.push(item);
      save();
      return clone(item);
    },
    updateProject: async () => true,
  };
  const linearProvisioning = createLinearProvisioning({
    root,
    client: async () => linearClient,
  });
  const jobs = {
    selectDeveloperTicket: async (input, previousJobs) => {
      const project = loadProject(root, input.project);
      const ticket = state.providerTickets.find(
        (ticket) =>
          ticket.labels.includes("pm-approved") &&
          ticket.stateType === "unstarted" &&
          project.areas.some(
            (area) =>
              (!input.area || area.key === input.area) &&
              area.linearProjectId === ticket.projectId &&
              ticket.labels.includes(area.label),
          ) &&
          !previousJobs.some(
            (job) =>
              job.type === "developer" &&
              job.project === input.project &&
              job.projectInstanceId === project.config.instanceId &&
              job.ticket === ticket.identifier,
          ),
      );
      if (!ticket)
        throw new JobReadinessError(
          "No approved tickets are ready in this synthetic fixture queue. Existing attempts are preserved; no real Linear request or agent execution occurred.",
        );
      return { ...input, ticket: ticket.identifier };
    },
    validate: async (input) => {
      const project = loadProject(root, input.project);
      if (input.type === "developer") {
        const ticket = state.providerTickets.find(
          (ticket) =>
            ticket.identifier === input.ticket &&
            ticket.labels.includes("pm-approved"),
        );
        const area = project.areas.find(
          (area) =>
            ticket?.projectId === area.linearProjectId &&
            ticket.labels.includes(area.label) &&
            (!input.area || input.area === area.key),
        );
        if (!ticket || !area)
          throw new JobReadinessError(
            "Choose an approved synthetic ticket belonging to this fixture project’s PMs.",
          );
        return {
          project,
          area,
          ticket: clone(ticket),
          linearBinding: {
            connectionId: "default",
            workspaceId,
            ticketId: ticket.id,
          },
        };
      }
      const area =
        project.areas.find((area) => area.key === input.area) ??
        project.areas[0];
      if (!area) throw new Error("Choose a fixture PM.");
      return {
        project,
        area,
        ...(input.pmMode ? { discoveryRevision: "a".repeat(64) } : {}),
      };
    },
    prepareJob: deny,
    releaseJobResources: async () => {},
    scheduledJobs: async () => [],
  };
  const docker = {
    preflight: async () => ({
      available: true,
      os: "linux",
      architecture: "amd64",
      message:
        "SIMULATED capacity. No Docker daemon or real worker is connected inside this fixture.",
    }),
    ensureImage: deny,
    startJob: deny,
    inspectJob: deny,
    logs: deny,
    artifacts: deny,
    readArtifact: deny,
    removeJob: deny,
    stopJob: deny,
  };
  const updater = {
    status: () => ({
      phase: "idle",
      currentVersion: "fixture",
      message: "Updates are disabled in the disposable fixture.",
      restartRequired: false,
      canRollback: false,
    }),
    check: async () => {},
    apply: deny,
    rollback: deny,
  };
  const slack = {
    status: async () => ({
      available: false,
      connected: false,
      message: notice,
    }),
    connect: deny,
    complete: deny,
    disconnect: deny,
    webhook: deny,
  };
  return {
    options: {
      runners,
      activityStore,
      sourceControl,
      linearConnection: connection("linear"),
      vercelConnection: connection("vercel"),
      linearProvisioning,
      jobs,
      docker,
      updater,
      slack,
    },
    state,
    save,
    notice,
  };
}
