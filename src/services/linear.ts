// Linear over its GraphQL API with fetch only. Shapes follow what crew-os'
// dispatcher used in production (issues / issueLabels / issueUpdate labelIds /
// commentCreate); labels are created in the ticket's team on first use.

import { fetchJson } from "../http.ts";
import { LABELS } from "../dispatcher/notes.ts";
import type {
  LinearClient,
  LinearComment,
  LinearTicket,
  LinearWorkflowState,
  LinearStateGuard,
} from "./types.ts";

export interface LinearApiOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearProjectResource {
  id: string;
  name: string;
  url: string;
  teamIds: string[];
  description?: string | null;
  content?: string | null;
  icon?: string | null;
  color?: string | null;
}

const PAGE = 100;

const TICKET_FIELDS = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  url
  state { id type }
  team { id }
  project { id }
  labels { nodes { id name } }
`;

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: { id?: string; type: string } | null;
  team: { id: string } | null;
  project?: { id: string } | null;
  labels: { nodes: { id: string; name: string }[] } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function toTicket(n: IssueNode): LinearTicket {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? "",
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
    stateType: n.state?.type ?? "",
    ...(n.state?.id ? { stateId: n.state.id } : {}),
    ...(n.team?.id ? { teamId: n.team.id } : {}),
    ...(n.project?.id ? { projectId: n.project.id } : {}),
    priority: n.priority ?? 0,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    url: n.url,
  };
}

const sameName = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

export class LinearApi implements LinearClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher?: LinearApiOptions["fetch"];
  /** `${teamId}:${label lowercased}` → label id */
  private readonly labelCache = new Map<string, string>();

  constructor(opts: LinearApiOptions) {
    if (!opts.apiKey) throw new Error("LinearApi needs an apiKey");
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint ?? "https://api.linear.app/graphql";
    this.fetcher = opts.fetch;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetchJson<{ data?: T; errors?: { message: string }[] }>(
      this.endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
      },
      { fetch: this.fetcher, retries: 0 },
    );
    if (res.errors?.length) {
      throw new Error(
        `Linear GraphQL: ${res.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!res.data) throw new Error("Linear GraphQL: empty response");
    return res.data;
  }

  async organization(): Promise<{ id: string; name: string }> {
    const data = await this.graphql<{
      organization: { id: string; name: string };
    }>(`query GremlinsOrganization { organization { id name } }`);
    return data.organization;
  }

  /** IDs are persisted before mutation so retries can reconcile a lost response. */
  async getTeam(id: string): Promise<LinearTeam | null> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(
      `query GremlinsTeam($id: ID!) { teams(filter: { id: { eq: $id } }, first: 1) { nodes { id key name } } }`,
      { id },
    );
    return data.teams.nodes.find((team) => team.id === id) ?? null;
  }

  async getProject(id: string): Promise<LinearProjectResource | null> {
    const data = await this.graphql<{
      projects: {
        nodes: Array<{
          id: string;
          name: string;
          url: string;
          description?: string | null;
          content?: string | null;
          icon?: string | null;
          color?: string | null;
          teams: { nodes: Array<{ id: string }> };
        }>;
      };
    }>(
      `query GremlinsProject($id: ID!) { projects(filter: { id: { eq: $id } }, first: 1) { nodes { id name url description content icon color teams { nodes { id } } } } }`,
      { id },
    );
    const project = data.projects.nodes.find((project) => project.id === id);
    return project
      ? {
          id: project.id,
          name: project.name,
          url: project.url,
          teamIds: project.teams.nodes.map((team) => team.id),
          description: project.description,
          content: project.content,
          icon: project.icon,
          color: project.color,
        }
      : null;
  }

  async createTeam(input: {
    id: string;
    name: string;
    key: string;
    description: string;
  }): Promise<LinearTeam> {
    const data = await this.graphql<{
      teamCreate: { success: boolean; team: LinearTeam | null };
    }>(
      `mutation GremlinsCreateTeam($input: TeamCreateInput!) { teamCreate(input: $input) { success team { id key name } } }`,
      { input },
    );
    if (
      !data.teamCreate.success ||
      !data.teamCreate.team ||
      data.teamCreate.team.id !== input.id
    )
      throw new Error("Linear team creation was not confirmed.");
    return data.teamCreate.team;
  }

  /** Bounded, cursor-checked lists for explicit dashboard reuse selections. */
  async resources(): Promise<{
    teams: LinearTeam[];
    projects: LinearProjectResource[];
  }> {
    const teams: LinearTeam[] = [],
      projects: LinearProjectResource[] = [];
    for (const kind of ["teams", "projects"] as const) {
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const fields =
          kind === "teams"
            ? "id key name"
            : "id name url teams { nodes { id } }";
        const data: Record<
          string,
          {
            nodes: Array<
              LinearTeam & {
                url: string;
                teams: { nodes: Array<{ id: string }> };
              }
            >;
            pageInfo: PageInfo;
          }
        > = await this.graphql(
          `query GremlinsResources($after: String) { ${kind}(first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
          { after },
        );
        const result = data[kind]!;
        for (const item of result.nodes) {
          if (kind === "teams")
            teams.push({ id: item.id, key: item.key, name: item.name });
          else
            projects.push({
              id: item.id,
              name: item.name,
              url: item.url,
              teamIds: item.teams.nodes.map((team) => team.id),
            });
        }
        if (!result.pageInfo.hasNextPage) break;
        if (
          !result.pageInfo.endCursor ||
          result.pageInfo.endCursor === after ||
          page === 49
        )
          throw new Error(
            "Linear resource list is incomplete. Narrow the workspace access.",
          );
        after = result.pageInfo.endCursor;
      }
    }
    return { teams, projects };
  }

  /** Every project the key can see, with the ids areas.json needs. */
  async listProjects(): Promise<
    { id: string; name: string; teams: string[]; url: string }[]
  > {
    const data = await this.graphql<{
      projects: {
        nodes: {
          id: string;
          name: string;
          url: string;
          teams: { nodes: { key: string; name: string }[] };
        }[];
      };
    }>(
      `query Projects { projects(first: 100) { nodes { id name url teams { nodes { key name } } } } }`,
    );
    return data.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      teams: p.teams.nodes.map((t) => `${t.name} (${t.key})`),
    }));
  }

  /** Teams the key can see: `{ id, key, name }`. */
  async listTeams(): Promise<{ id: string; key: string; name: string }[]> {
    const data = await this.graphql<{
      teams: { nodes: { id: string; key: string; name: string }[] };
    }>(`query Teams { teams(first: 50) { nodes { id key name } } }`);
    return data.teams.nodes;
  }

  /** Create a project in a team; returns its uuid + url. */
  async createProject(input: {
    id?: string;
    teamId: string;
    name: string;
    description: string;
    content: string;
    icon?: string;
    color?: string;
  }): Promise<{ id: string; url: string }> {
    const data = await this.graphql<{
      projectCreate: { success: boolean; project: { id: string; url: string } };
    }>(
      `mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id url } } }`,
      {
        input: {
          ...(input.id ? { id: input.id } : {}),
          teamIds: [input.teamId],
          name: input.name,
          description: input.description,
          content: input.content,
          ...(input.icon ? { icon: input.icon } : {}),
          ...(input.color ? { color: input.color } : {}),
        },
      },
    );
    if (
      !data.projectCreate.success ||
      !data.projectCreate.project ||
      (input.id && data.projectCreate.project.id !== input.id)
    )
      throw new Error("projectCreate refused");
    return data.projectCreate.project;
  }

  /** Update a project's name, short description and document body. */
  async updateProject(
    id: string,
    input: {
      name?: string;
      description?: string;
      content?: string;
      icon?: string;
      color?: string;
    },
  ): Promise<{ id: string; url: string }> {
    const data = await this.graphql<{
      projectUpdate: { success: boolean; project: { id: string; url: string } };
    }>(
      `mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id url } } }`,
      { id, input },
    );
    if (
      !data.projectUpdate.success ||
      !data.projectUpdate.project ||
      data.projectUpdate.project.id !== id
    )
      throw new Error("projectUpdate refused");
    return data.projectUpdate.project;
  }

  private async issueLabels(
    issueId: string,
  ): Promise<{ teamId: string; labels: { id: string; name: string }[] }> {
    const data = await this.graphql<{ issue: IssueNode | null }>(
      `query IssueLabels($id: String!) {
        issue(id: $id) { id team { id } labels { nodes { id name } } }
      }`,
      { id: issueId },
    );
    if (!data.issue) throw new Error(`Linear: no issue ${issueId}`);
    if (!data.issue.team)
      throw new Error(`Linear: issue ${issueId} has no team`);
    return {
      teamId: data.issue.team.id,
      labels: data.issue.labels?.nodes ?? [],
    };
  }

  private async findLabelId(
    teamId: string,
    name: string,
  ): Promise<string | undefined> {
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const found: {
        issueLabels: {
          nodes: { id: string; name: string; team: { id: string } | null }[];
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await this.graphql(
        `query Labels($name: String!, $after: String) {
        issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 50, after: $after) {
          nodes { id name team { id } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
        { name, after },
      );
      // a workspace label (team == null) serves every team
      const id = found.issueLabels.nodes.find(
        (n) =>
          sameName(n.name, name) && (n.team === null || n.team.id === teamId),
      )?.id;
      if (id) return id;
      const page = found.issueLabels.pageInfo;
      if (!page?.hasNextPage) return undefined;
      if (!page.endCursor || cursors.has(page.endCursor) || cursors.size >= 20)
        throw new Error(
          "Linear: label lookup could not finish; no label was created",
        );
      cursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  private async labelId(teamId: string, name: string): Promise<string> {
    const key = `${teamId}:${name.toLowerCase()}`;
    const cached = this.labelCache.get(key);
    if (cached) return cached;
    let id = await this.findLabelId(teamId, name);
    if (!id) {
      try {
        const created = await this.graphql<{
          issueLabelCreate: {
            success: boolean;
            issueLabel: { id: string } | null;
          };
        }>(
          `mutation CreateLabel($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { success issueLabel { id } }
        }`,
          { input: { name, teamId } },
        );
        id = created.issueLabelCreate.success
          ? created.issueLabelCreate.issueLabel?.id
          : undefined;
      } catch (error) {
        // Another PM may have created the same label, or our response was lost.
        // Reconcile by name and scope before reporting a failed creation.
        id = await this.findLabelId(teamId, name);
        if (!id) throw error;
      }
      if (!id) id = await this.findLabelId(teamId, name);
      if (!id)
        throw new Error(
          `Linear: could not create label "${name}" in team ${teamId}`,
        );
    }
    this.labelCache.set(key, id);
    return id;
  }

  /** Ensure routing labels exist before a PM files its first proposal. */
  async ensureLabels(teamId: string, names: string[]): Promise<void> {
    if (!teamId.trim())
      throw new Error("Linear: a mapped team is required for labels");
    const unique = new Map<string, string>();
    for (const name of names) {
      if (!name.trim() || name !== name.trim())
        throw new Error(
          "Linear: label names must be nonempty without surrounding whitespace",
        );
      unique.set(name.toLowerCase(), name);
    }
    for (const [key, name] of unique) {
      // A previously resolved label may have been deleted since the last patrol.
      this.labelCache.delete(`${teamId}:${key}`);
      await this.labelId(teamId, name);
    }
  }

  /** Caller must establish that this mapped project belongs to exactly one PM. */
  async repairProposalAreaLabels(input: {
    teamId: string;
    projectId: string;
    label: string;
  }): Promise<void> {
    const eligible = (ticket: LinearTicket) =>
      ticket.projectId === input.projectId &&
      ticket.teamId === input.teamId &&
      ["backlog", "unstarted", "started"].includes(ticket.stateType) &&
      ticket.labels.some((label) => sameName(label, LABELS.proposal)) &&
      !ticket.labels.some(
        (label) => sameName(label, input.label) || /^pm:/i.test(label),
      );
    for (const listed of await this.listTickets(input.projectId, [
      LABELS.proposal,
    ])) {
      if (!eligible(listed)) continue;
      const current = await this.getTicket(listed.id);
      if (!current || current.id !== listed.id || !eligible(current)) continue;
      const labelId = await this.labelId(input.teamId, input.label);
      // Atomic addition preserves concurrent owner edits to other labels. There
      // is no state, approval, project or team mutation in this repair operation.
      const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
        `mutation RepairAreaLabel($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id: current.id, input: { addedLabelIds: [labelId] } },
      );
      if (!data.issueUpdate.success)
        throw new Error(
          `Linear: could not repair the routing label for ${current.identifier}`,
        );
    }
  }

  private async setLabels(issueId: string, labelIds: string[]): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation UpdateLabels($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input: { labelIds } },
    );
    if (!data.issueUpdate.success)
      throw new Error(`Linear: issueUpdate refused for ${issueId}`);
  }

  async listTickets(
    projectId: string,
    labels: string[],
  ): Promise<LinearTicket[]> {
    const filter: Record<string, unknown> = {
      project: { id: { eq: projectId } },
    };
    if (labels.length) {
      filter.and = labels.map((name) => ({
        labels: { some: { name: { eqIgnoreCase: name } } },
      }));
    }
    const out: LinearTicket[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { issues: { nodes: IssueNode[]; pageInfo: PageInfo } } =
        await this.graphql(
          `query ProjectTickets($filter: IssueFilter!, $after: String) {
          issues(filter: $filter, first: ${PAGE}, after: $after) {
            nodes { ${TICKET_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
          { filter, after },
        );
      for (const n of data.issues.nodes) {
        const t = toTicket(n);
        if (labels.every((l) => t.labels.some((have) => sameName(have, l))))
          out.push(t);
      }
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor)
        return out;
      after = data.issues.pageInfo.endCursor;
    }
  }

  async getTicket(idOrIdentifier: string): Promise<LinearTicket | null> {
    try {
      const data = await this.graphql<{ issue: IssueNode | null }>(
        `query Ticket($id: String!) { issue(id: $id) { ${TICKET_FIELDS} } }`,
        { id: idOrIdentifier },
      );
      return data.issue ? toTicket(data.issue) : null;
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async addLabel(ticketId: string, label: string): Promise<void> {
    const { teamId, labels } = await this.issueLabels(ticketId);
    if (labels.some((l) => sameName(l.name, label))) return;
    const id = await this.labelId(teamId, label);
    await this.setLabels(ticketId, [...labels.map((l) => l.id), id]);
  }

  async listWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const out: LinearWorkflowState[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        workflowStates: {
          nodes: {
            id: string;
            name: string;
            type: string;
            team: { id: string };
          }[];
          pageInfo: PageInfo;
        };
      } = await this.graphql(
        `query WorkflowStates($teamId: ID!, $after: String) {
          workflowStates(filter: { team: { id: { eq: $teamId } } }, first: ${PAGE}, after: $after) {
            nodes { id name type team { id } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { teamId, after },
      );
      out.push(
        ...data.workflowStates.nodes
          .filter((n) => n.team.id === teamId)
          .map((n) => ({
            id: n.id,
            name: n.name,
            type: n.type,
            teamId: n.team.id,
          })),
      );
      const page = data.workflowStates.pageInfo;
      if (!page.hasNextPage) return out;
      if (!page.endCursor || page.endCursor === after)
        throw new Error("Linear: incomplete workflow state pagination");
      after = page.endCursor;
    }
  }

  async updateWorkflowState(
    ticketId: string,
    stateId: string,
    expected: LinearStateGuard,
  ): Promise<void> {
    const state = (await this.listWorkflowStates(expected.teamId)).find(
      (s) => s.id === stateId,
    );
    if (!state || state.type !== "completed")
      throw new Error(
        "Linear: production completion requires a completed state in the ticket's team",
      );
    const ticket = await this.getTicket(ticketId);
    if (
      !ticket ||
      ticket.projectId !== expected.projectId ||
      ticket.teamId !== expected.teamId ||
      ticket.stateId !== expected.stateId ||
      ticket.updatedAt !== expected.updatedAt ||
      ticket.stateType === "canceled"
    ) {
      throw new Error(
        `Linear: ticket ${ticketId} changed before its state transition`,
      );
    }
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation UpdateWorkflowState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: ticketId, input: { stateId } },
    );
    if (!data.issueUpdate.success)
      throw new Error(`Linear: workflow update refused for ${ticketId}`);
  }

  async removeLabel(ticketId: string, label: string): Promise<void> {
    const { labels } = await this.issueLabels(ticketId);
    const keep = labels.filter((l) => !sameName(l.name, label));
    if (keep.length === labels.length) return;
    await this.setLabels(
      ticketId,
      keep.map((l) => l.id),
    );
  }

  async addComment(ticketId: string, body: string): Promise<LinearComment> {
    const data = await this.graphql<{
      commentCreate: { success: boolean; comment: LinearComment | null };
    }>(
      `mutation Comment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id body createdAt } }
      }`,
      { input: { issueId: ticketId, body } },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new Error(`Linear: commentCreate refused for ${ticketId}`);
    }
    return data.commentCreate.comment;
  }

  async listComments(ticketId: string): Promise<LinearComment[]> {
    const out: LinearComment[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        issue: {
          comments: { nodes: LinearComment[]; pageInfo: PageInfo };
        } | null;
      } = await this.graphql(
        `query Comments($id: String!, $after: String) {
          issue(id: $id) {
            comments(first: ${PAGE}, after: $after) {
              nodes { id body createdAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: ticketId, after },
      );
      if (!data.issue) break;
      out.push(...data.issue.comments.nodes);
      const page = data.issue.comments.pageInfo;
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createTicket(input: {
    id?: string;
    teamId?: string;
    projectId: string;
    title: string;
    description: string;
    labels: string[];
    priority?: number;
  }): Promise<LinearTicket> {
    const proj = await this.graphql<{
      project: {
        teams: { nodes: { id: string }[]; pageInfo?: PageInfo };
      } | null;
    }>(
      `query ProjectTeam($id: String!) { project(id: $id) { teams(first: 100) { nodes { id } pageInfo { hasNextPage endCursor } } } }`,
      { id: input.projectId },
    );
    const teams = proj.project?.teams;
    if (!teams?.nodes.length)
      throw new Error(`Linear: project ${input.projectId} has no team`);
    const teamId =
      input.teamId ??
      (teams.nodes.length === 1 && !teams.pageInfo?.hasNextPage
        ? teams.nodes[0]?.id
        : undefined);
    if (!teamId || !teams.nodes.some((team) => team.id === teamId))
      throw new Error(
        `Linear: choose a mapped team belonging to project ${input.projectId} before creating a ticket`,
      );
    const labelIds: string[] = [];
    for (const name of input.labels)
      labelIds.push(await this.labelId(teamId, name));
    const data = await this.graphql<{
      issueCreate: { success: boolean; issue: IssueNode | null };
    }>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${TICKET_FIELDS} } }
      }`,
      {
        input: {
          ...(input.id ? { id: input.id } : {}),
          teamId,
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          labelIds,
          ...(input.priority === undefined ? {} : { priority: input.priority }),
        },
      },
    );
    if (
      !data.issueCreate.success ||
      !data.issueCreate.issue ||
      (input.id && data.issueCreate.issue.id !== input.id)
    ) {
      throw new Error(`Linear: issueCreate refused for "${input.title}"`);
    }
    return toTicket(data.issueCreate.issue);
  }
}
