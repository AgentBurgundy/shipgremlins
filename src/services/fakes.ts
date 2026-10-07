// In-memory Linear, Vercel and Slack for tests, plus makeCtx() which wires a
// complete dispatcher context around them and a FakeForge.

import type {
  Deployment,
  LinearClient,
  LinearComment,
  LinearTicket,
  LinearWorkflowState,
  LinearStateGuard,
  SlackClient,
  VercelClient,
} from "./types.ts";
import { FakeForge } from "../forge/fake.ts";
import type { Ctx } from "../dispatcher/context.ts";
import type {
  AreaConfig,
  HubConfig,
  Project,
  ProjectConfig,
  TiersConfig,
} from "../config.ts";

export class FakeLinear implements LinearClient {
  readonly tickets = new Map<string, LinearTicket>();
  readonly comments = new Map<string, LinearComment[]>();
  readonly created: LinearTicket[] = [];
  readonly workflowStates: LinearWorkflowState[] = [];
  readonly stateUpdates: { ticketId: string; stateId: string }[] = [];
  private n = 1;
  private cid = 1;

  seedTicket(t: Partial<LinearTicket> & { projectId: string }): LinearTicket {
    const num = this.n++;
    const ticket: LinearTicket = {
      id: t.id ?? `uuid-${num}`,
      identifier: t.identifier ?? `T-${num}`,
      title: t.title ?? `Ticket ${num}`,
      description: t.description ?? "",
      labels: t.labels ?? [],
      stateType: t.stateType ?? "backlog",
      stateId: t.stateId ?? "state-backlog",
      teamId: t.teamId ?? "team-1",
      projectId: t.projectId,
      ...(t.parentId ? { parentId: t.parentId } : {}),
      priority: t.priority ?? 3,
      createdAt:
        t.createdAt ?? new Date(Date.UTC(2026, 9, 1, 0, num)).toISOString(),
      updatedAt:
        t.updatedAt ?? new Date(Date.UTC(2026, 9, 1, 0, num)).toISOString(),
      url: `https://linear.app/x/issue/${t.identifier ?? `T-${num}`}`,
    };
    (ticket as LinearTicket & { projectId: string }).projectId = t.projectId;
    this.tickets.set(ticket.id, ticket);
    if (!this.comments.has(ticket.id)) this.comments.set(ticket.id, []);
    return ticket;
  }
  labelsOf(id: string): string[] {
    return this.tickets.get(id)?.labels ?? [];
  }
  commentsOf(id: string): string[] {
    return (this.comments.get(id) ?? []).map((c) => c.body);
  }
  async listTickets(
    projectId: string,
    labels: string[],
  ): Promise<LinearTicket[]> {
    return [...this.tickets.values()]
      .filter(
        (t) =>
          (t as LinearTicket & { projectId: string }).projectId === projectId,
      )
      .filter((t) => labels.every((l) => t.labels.includes(l)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async getTicket(idOrIdentifier: string): Promise<LinearTicket | null> {
    return (
      this.tickets.get(idOrIdentifier) ??
      [...this.tickets.values()].find((t) => t.identifier === idOrIdentifier) ??
      null
    );
  }
  async addLabel(ticketId: string, label: string): Promise<void> {
    const t = this.tickets.get(ticketId);
    if (!t) throw new Error(`no ticket ${ticketId}`);
    if (!t.labels.includes(label)) t.labels.push(label);
  }
  async listWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    return this.workflowStates.filter((s) => s.teamId === teamId);
  }
  async updateWorkflowState(
    ticketId: string,
    stateId: string,
    expected: LinearStateGuard,
  ): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    const state = this.workflowStates.find(
      (s) =>
        s.id === stateId &&
        s.teamId === expected.teamId &&
        s.type === "completed",
    );
    if (
      !ticket ||
      !state ||
      ticket.stateType === "canceled" ||
      ticket.projectId !== expected.projectId ||
      ticket.teamId !== expected.teamId ||
      ticket.stateId !== expected.stateId ||
      ticket.updatedAt !== expected.updatedAt
    )
      throw new Error("ticket changed or workflow state invalid");
    ticket.stateType = state.type;
    ticket.stateId = state.id;
    this.stateUpdates.push({ ticketId, stateId });
  }
  async removeLabel(ticketId: string, label: string): Promise<void> {
    const t = this.tickets.get(ticketId);
    if (!t) throw new Error(`no ticket ${ticketId}`);
    t.labels = t.labels.filter((l) => l !== label);
  }
  async addComment(ticketId: string, body: string): Promise<LinearComment> {
    const c: LinearComment = {
      id: `c${this.cid++}`,
      body,
      createdAt: new Date().toISOString(),
    };
    const list = this.comments.get(ticketId) ?? [];
    list.push(c);
    this.comments.set(ticketId, list);
    return c;
  }
  async listComments(ticketId: string): Promise<LinearComment[]> {
    return [...(this.comments.get(ticketId) ?? [])];
  }
  async createTicket(input: {
    projectId: string;
    parentId?: string;
    title: string;
    description: string;
    labels: string[];
    priority?: number;
  }): Promise<LinearTicket> {
    const t = this.seedTicket({ ...input });
    this.created.push(t);
    return t;
  }
}

export class FakeVercel implements VercelClient {
  private deployments = new Map<string, Deployment>();
  seedDeployment(
    projectId: string,
    branch: string,
    d: Partial<Deployment>,
  ): Deployment {
    const dep: Deployment = {
      id: d.id ?? `dpl_${branch}`,
      state: d.state ?? "READY",
      url: d.url ?? `app-git-${branch}-team.vercel.app`,
      sha: d.sha ?? "0000000",
      branch,
      createdAt: d.createdAt ?? "2026-10-02T11:00:00Z",
    };
    this.deployments.set(`${projectId}#${branch}`, dep);
    return dep;
  }
  async latestDeployment(
    projectId: string,
    _teamId: string | null,
    branch: string,
  ): Promise<Deployment | null> {
    return this.deployments.get(`${projectId}#${branch}`) ?? null;
  }
  async branchUrl(
    projectId: string,
    _teamId: string | null,
    branch: string,
  ): Promise<string | null> {
    const d = this.deployments.get(`${projectId}#${branch}`);
    return d ? `https://${d.url}` : null;
  }
}

export class FakeSlack implements SlackClient {
  readonly posts: { webhookUrl: string; text: string; blocks: unknown[] }[] =
    [];
  async post(
    webhookUrl: string,
    blocks: unknown[],
    text: string,
  ): Promise<void> {
    this.posts.push({ webhookUrl, blocks, text });
  }
}

export const TEST_REPO = "owner/game";
export const HUB_REPO = "owner/pm-hub";

export function makeProject(
  over: {
    config?: Partial<ProjectConfig>;
    areas?: Partial<AreaConfig>[];
    tiers?: Partial<TiersConfig>;
  } = {},
): Project {
  const config: ProjectConfig = {
    name: "game",
    repo: TEST_REPO,
    branches: {
      production: "main",
      staging: "staging",
      integration: "pm-staging",
    },
    vercel: {
      projectId: "prj_game",
      teamId: null,
      bypassSecret: "VERCEL_BYPASS_GAME",
    },
    database: "neon-vercel-integration",
    slackWebhookSecret: "SLACK_WEBHOOK_GAME",
    runnerLabel: null,
    mergeMethod: "squash",
    commands: {
      install: "npm ci",
      test: "npm test",
      lint: null,
      typecheck: null,
    },
    verified: "2026-10-01",
    signIn: null,
    ...over.config,
  };
  const areaDefaults: AreaConfig = {
    key: "core",
    name: "Core",
    paths: ["app/", "lib/"],
    sharedTouchpoints: ["package.json"],
    linearProjectId: "lin_core",
    label: "pm:core",
    wipLimit: 2,
    metric: "play_started",
    schedule: "0 13 * * 1-5",
    enabled: true,
    memoryBranch: "pm/game/core",
  };
  const areas = (over.areas ?? [{}]).map((a) => ({ ...areaDefaults, ...a }));
  const tiers: TiersConfig = {
    ownerOnlyPrefixes: [
      "app/api/auth",
      "middleware.ts",
      "prisma/migrations",
      "*billing*",
    ],
    hubOwnerOnly: [".github/", "prompts/"],
    alwaysFree: ["docs/"],
    guardTests: ["tests/guards/"],
    testFileMarkers: ["/__tests__/", ".test.", "/tests/"],
    ...over.tiers,
  };
  return { config, areas, tiers, dir: `/hub/projects/${config.name}` };
}

export function makeHub(over: Partial<HubConfig> = {}): HubConfig {
  return {
    hubRepo: HUB_REPO,
    runners: { mode: "self-hosted", label: "pm" },
    gce: {
      project: "",
      zone: "us-central1-a",
      image: "pm-runner",
      machineType: "e2-standard-4",
      spot: false,
    },
    ...over,
  };
}

export interface TestCtx extends Ctx {
  forge: FakeForge;
  linear: FakeLinear;
  vercel: FakeVercel;
  slack: FakeSlack;
  lines: string[];
}

/** A complete context with fakes; `now` defaults to 2026-10-02T12:00:00Z. */
export function makeCtx(
  over: {
    project?: Project;
    hub?: HubConfig;
    now?: Date;
    dryRun?: boolean;
  } = {},
): TestCtx {
  const now = over.now ?? new Date("2026-10-02T12:00:00Z");
  const forge = new FakeForge({ hubRepo: HUB_REPO, now: () => now });
  const project = over.project ?? makeProject();
  // a healthy default world: all three branches exist and pm-staging is green
  const integ = forge.seedBranch(
    project.config.repo,
    project.config.branches.integration,
  );
  forge.seedBranch(project.config.repo, project.config.branches.staging);
  forge.seedBranch(project.config.repo, project.config.branches.production);
  forge.seedChecks(project.config.repo, integ, {
    status: "success",
    failedJobs: [],
  });
  const vercel = new FakeVercel();
  if (project.config.vercel)
    vercel.seedDeployment(
      project.config.vercel.projectId,
      project.config.branches.integration,
      { state: "READY", sha: integ },
    );
  const lines: string[] = [];
  return {
    forge,
    linear: new FakeLinear(),
    vercel,
    slack: new FakeSlack(),
    hub: over.hub ?? makeHub(),
    project,
    now: () => now,
    dryRun: over.dryRun ?? false,
    log: (l) => lines.push(l),
    botLogin: forge.botLogin,
    lines,
  };
}
