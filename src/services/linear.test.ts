import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearApi } from "./linear.ts";

type Call = {
  query: string;
  variables: Record<string, unknown>;
  headers: Headers;
};

/** Stub fetch as a Linear GraphQL endpoint; `answer` maps an operation name to data. */
function stubLinear(
  answer: (op: string, vars: Record<string, unknown>, n: number) => unknown,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      expect(input).toBe("https://api.linear.app/graphql");
      const body = JSON.parse(init.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const call: Call = { ...body, headers: new Headers(init.headers) };
      calls.push(call);
      const op = body.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? "?";
      const data = answer(op, body.variables, calls.length);
      const payload =
        data && typeof data === "object" && "errors" in (data as object)
          ? data
          : { data };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const issueNode = (over: Record<string, unknown> = {}) => ({
  id: "uuid-1",
  identifier: "GAME-12",
  title: "Add a thing",
  description: "Tier: A",
  priority: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  url: "https://linear.app/x/issue/GAME-12",
  state: { id: "state-backlog", type: "backlog" },
  team: { id: "team-1" },
  project: { id: "project-1" },
  labels: { nodes: [{ id: "lbl-a", name: "pm-approved" }] },
  ...over,
});

const client = () => new LinearApi({ apiKey: "lin_api_test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinearApi transport", () => {
  it("preserves OAuth authorization and sends persisted IDs for team/project creation", async () => {
    const teamId = "a77c99b2-e7b2-4497-83f4-eac96c4d4e01";
    const projectId = "531672da-9386-476d-832d-2cb9e74ac3ab";
    const calls = stubLinear((op, vars) => {
      if (op === "GremlinsCreateTeam")
        return {
          teamCreate: {
            success: true,
            team: { id: teamId, name: "Demo", key: "DEMO" },
          },
        };
      if (op === "CreateProject")
        return {
          projectCreate: {
            success: true,
            project: {
              id: projectId,
              url: "https://linear.app/test/project/demo",
            },
          },
        };
      throw new Error(`Unexpected operation ${op}: ${Object.keys(vars)}`);
    });
    const api = new LinearApi({ apiKey: "Bearer oauth-access" });
    await api.createTeam({
      id: teamId,
      name: "Demo",
      key: "DEMO",
      description: "App team",
    });
    await api.createProject({
      id: projectId,
      teamId,
      name: "Core",
      description: "Core PM",
      content: "Test core flows",
      icon: "👾",
      color: "#c3f66b",
    });
    expect(
      calls.every(
        (call) => call.headers.get("authorization") === "Bearer oauth-access",
      ),
    ).toBe(true);
    expect(calls[0]!.variables.input).toMatchObject({ id: teamId });
    expect(calls[1]!.variables.input).toMatchObject({
      id: projectId,
      teamIds: [teamId],
      content: "Test core flows",
      icon: "👾",
      color: "#c3f66b",
    });
  });
  it("reads project metadata and patches only selected fields during recovery", async () => {
    const calls = stubLinear((op, vars) => {
      if (op === "GremlinsProject")
        return {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Core",
                url: "https://linear.app/test/project/core",
                description: "Human summary",
                content: null,
                icon: null,
                color: "#c3f66b",
                teams: { nodes: [{ id: "team-1" }] },
              },
            ],
          },
        };
      if (op === "UpdateProject")
        return {
          projectUpdate: {
            success: true,
            project: {
              id: vars.id,
              url: "https://linear.app/test/project/core",
            },
          },
        };
      throw new Error("Unexpected operation");
    });
    const api = client();
    expect(await api.getProject("project-1")).toMatchObject({
      description: "Human summary",
      content: null,
      icon: null,
      color: "#c3f66b",
      teamIds: ["team-1"],
    });
    await api.updateProject("project-1", {
      content: "## Saved mandate",
      icon: "👾",
    });
    expect(calls[1]!.variables).toEqual({
      id: "project-1",
      input: { content: "## Saved mandate", icon: "👾" },
    });
    expect(calls[0]!.query).toContain("description content icon color");
  });
  it("refuses unconfirmed or wrong-ID metadata updates", async () => {
    stubLinear(() => ({
      projectUpdate: {
        success: true,
        project: {
          id: "unrelated-project",
          url: "https://linear.app/test/project/other",
        },
      },
    }));
    await expect(
      client().updateProject("expected-project", { icon: "👾" }),
    ).rejects.toThrow("projectUpdate refused");
  });
  it("paginates resource selections and retains each project's team IDs", async () => {
    let teams = 0;
    const calls = stubLinear((_op, vars) => {
      if (teams < 2) {
        teams++;
        return {
          teams: {
            nodes: [
              { id: `team-${teams}`, key: `T${teams}`, name: `Team ${teams}` },
            ],
            pageInfo: {
              hasNextPage: teams === 1,
              endCursor: teams === 1 ? "next" : null,
            },
          },
        };
      }
      expect(vars.after).toBeNull();
      return {
        projects: {
          nodes: [
            {
              id: "project",
              name: "Core",
              url: "https://linear.app/test/project",
              teams: { nodes: [{ id: "team-2" }] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });
    expect(await client().resources()).toMatchObject({
      teams: [{ id: "team-1" }, { id: "team-2" }],
      projects: [{ id: "project", teamIds: ["team-2"] }],
    });
    expect(calls[1]!.variables.after).toBe("next");
  });
  it("POSTs to api.linear.app with the raw key as Authorization", async () => {
    const calls = stubLinear(() => ({ issue: issueNode() }));
    await client().getTicket("GAME-12");
    expect(calls[0]!.headers.get("authorization")).toBe("lin_api_test");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("throws on GraphQL errors", async () => {
    stubLinear(() => ({
      errors: [{ message: "AUTHENTICATION_ERROR: bad key" }],
    }));
    await expect(client().getTicket("GAME-12")).rejects.toThrow(
      "AUTHENTICATION_ERROR",
    );
  });
});

describe("production workflow transitions", () => {
  const state = {
    id: "done-id",
    name: "Delivered",
    type: "completed",
    team: { id: "team-1" },
  };
  const guard = {
    projectId: "project-1",
    teamId: "team-1",
    stateId: "state-backlog",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  it("paginates actual workflow IDs and excludes states from another team", async () => {
    const calls = stubLinear((_op, vars) => ({
      workflowStates: {
        nodes: vars.after
          ? [state, { ...state, id: "wrong-team", team: { id: "team-2" } }]
          : [],
        pageInfo: {
          hasNextPage: !vars.after,
          endCursor: vars.after ? null : "next",
        },
      },
    }));
    expect(await client().listWorkflowStates("team-1")).toEqual([
      { id: "done-id", name: "Delivered", type: "completed", teamId: "team-1" },
    ]);
    expect(calls.map((c) => c.variables)).toEqual([
      { teamId: "team-1", after: null },
      { teamId: "team-1", after: "next" },
    ]);
  });

  it("reads current ticket immediately before writing only the actual stateId", async () => {
    const calls = stubLinear((op) => {
      if (op === "WorkflowStates")
        return {
          workflowStates: {
            nodes: [state],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      if (op === "Ticket") return { issue: issueNode() };
      return { issueUpdate: { success: true } };
    });
    await client().updateWorkflowState("uuid-1", "done-id", guard);
    expect(calls[2]?.variables).toEqual({
      id: "uuid-1",
      input: { stateId: "done-id" },
    });
    expect(calls[1]?.query).toContain("query Ticket");
  });

  it.each([
    { state: { id: "state-backlog", type: "canceled" } },
    { updatedAt: "2026-10-03T00:00:00Z" },
    { project: { id: "other-project" } },
    { team: { id: "other-team" } },
    { state: { id: "new-state", type: "started" } },
  ])("refuses stale/canceled/out-of-scope ticket %#", async (patch) => {
    const calls = stubLinear((op) =>
      op === "WorkflowStates"
        ? {
            workflowStates: {
              nodes: [state],
              pageInfo: { hasNextPage: false },
            },
          }
        : { issue: issueNode(patch) },
    );
    await expect(
      client().updateWorkflowState("uuid-1", "done-id", guard),
    ).rejects.toThrow("changed before");
    expect(calls.some((c) => c.query.includes("mutation"))).toBe(false);
  });

  it("refuses a non-completed target state and failed mutation", async () => {
    stubLinear(() => ({
      workflowStates: {
        nodes: [{ ...state, type: "started" }],
        pageInfo: { hasNextPage: false },
      },
    }));
    await expect(
      client().updateWorkflowState("uuid-1", "done-id", guard),
    ).rejects.toThrow("completed state");
    stubLinear((op) =>
      op === "WorkflowStates"
        ? {
            workflowStates: {
              nodes: [state],
              pageInfo: { hasNextPage: false },
            },
          }
        : op === "Ticket"
          ? { issue: issueNode() }
          : { issueUpdate: { success: false } },
    );
    await expect(
      client().updateWorkflowState("uuid-1", "done-id", guard),
    ).rejects.toThrow("refused");
  });
});

describe("getTicket", () => {
  it("maps the issue shape", async () => {
    stubLinear(() => ({ issue: issueNode() }));
    await expect(client().getTicket("uuid-1")).resolves.toEqual({
      id: "uuid-1",
      identifier: "GAME-12",
      title: "Add a thing",
      description: "Tier: A",
      labels: ["pm-approved"],
      stateType: "backlog",
      stateId: "state-backlog",
      teamId: "team-1",
      projectId: "project-1",
      priority: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      url: "https://linear.app/x/issue/GAME-12",
    });
  });

  it("passes a uuid or an identifier straight through and maps not-found to null", async () => {
    const calls = stubLinear((_op, vars) =>
      vars.id === "GAME-99"
        ? {
            errors: [
              {
                message:
                  "Entity not found: Issue - Could not find referenced Issue.",
              },
            ],
          }
        : { issue: issueNode() },
    );
    const c = client();
    await expect(c.getTicket("GAME-12")).resolves.toMatchObject({
      identifier: "GAME-12",
    });
    await expect(c.getTicket("GAME-99")).resolves.toBeNull();
    expect(calls.map((c) => c.variables.id)).toEqual(["GAME-12", "GAME-99"]);
  });

  it("defaults a null description to an empty string", async () => {
    stubLinear(() => ({ issue: issueNode({ description: null }) }));
    await expect(client().getTicket("uuid-1")).resolves.toMatchObject({
      description: "",
    });
  });
});

describe("listTickets", () => {
  it("filters by project and every label, pages with first: 100", async () => {
    const both = {
      nodes: [
        { id: "a", name: "pm-approved" },
        { id: "c", name: "pm:core" },
      ],
    };
    const calls = stubLinear((_op, vars) => ({
      issues:
        vars.after == null
          ? {
              nodes: [
                issueNode({ id: "u1", identifier: "GAME-1", labels: both }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur1" },
            }
          : {
              nodes: [
                issueNode({ id: "u2", identifier: "GAME-2", labels: both }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
    }));
    const tickets = await client().listTickets("proj-1", [
      "pm-approved",
      "pm:core",
    ]);
    expect(tickets.map((t) => t.identifier)).toEqual(["GAME-1", "GAME-2"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toMatch(/first:\s*100/);
    expect(calls[0]!.variables.after).toBeNull();
    expect(calls[1]!.variables.after).toBe("cur1");
    expect(calls[0]!.variables.filter).toEqual({
      project: { id: { eq: "proj-1" } },
      and: [
        { labels: { some: { name: { eqIgnoreCase: "pm-approved" } } } },
        { labels: { some: { name: { eqIgnoreCase: "pm:core" } } } },
      ],
    });
  });

  it("drops a ticket the server returned without every label (defence in depth)", async () => {
    stubLinear(() => ({
      issues: {
        nodes: [
          issueNode({
            id: "u1",
            labels: { nodes: [{ id: "a", name: "pm-approved" }] },
          }),
          issueNode({
            id: "u2",
            labels: {
              nodes: [
                { id: "a", name: "PM-Approved" },
                { id: "b", name: "pm-ci" },
              ],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    const tickets = await client().listTickets("proj-1", [
      "pm-approved",
      "pm-ci",
    ]);
    expect(tickets.map((t) => t.id)).toEqual(["u2"]);
  });

  it("with no labels sends no `and` clause", async () => {
    const calls = stubLinear(() => ({
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }));
    await client().listTickets("proj-1", []);
    expect(calls[0]!.variables.filter).toEqual({
      project: { id: { eq: "proj-1" } },
    });
  });
});

describe("labels", () => {
  it("addLabel reuses an existing team label and writes the full label id list", async () => {
    const calls = stubLinear((op) => {
      switch (op) {
        case "IssueLabels":
          return { issue: issueNode() };
        case "Labels":
          return {
            issueLabels: {
              nodes: [
                {
                  id: "lbl-other-team",
                  name: "pm-dispatched",
                  team: { id: "team-2" },
                },
                { id: "lbl-d", name: "pm-dispatched", team: { id: "team-1" } },
              ],
            },
          };
        case "UpdateLabels":
          return { issueUpdate: { success: true } };
        default:
          throw new Error(`unexpected ${op}`);
      }
    });
    await client().addLabel("uuid-1", "pm-dispatched");
    const update = calls.find((c) => c.query.includes("UpdateLabels"))!;
    expect(update.variables).toEqual({
      id: "uuid-1",
      input: { labelIds: ["lbl-a", "lbl-d"] },
    });
    expect(
      calls.map((c) => c.query.match(/(query|mutation)\s+(\w+)/)![2]),
    ).toEqual(["IssueLabels", "Labels", "UpdateLabels"]);
  });

  it("addLabel creates the label in the issue's team when missing and caches it", async () => {
    const calls = stubLinear((op) => {
      switch (op) {
        case "IssueLabels":
          return { issue: issueNode() };
        case "Labels":
          return { issueLabels: { nodes: [] } };
        case "CreateLabel":
          return {
            issueLabelCreate: { success: true, issueLabel: { id: "lbl-new" } },
          };
        case "UpdateLabels":
          return { issueUpdate: { success: true } };
        default:
          throw new Error(`unexpected ${op}`);
      }
    });
    const c = client();
    await c.addLabel("uuid-1", "pm-verified");
    const create = calls.find((c) => c.query.includes("CreateLabel"))!;
    expect(create.variables).toEqual({
      input: { name: "pm-verified", teamId: "team-1" },
    });
    expect(
      calls.find((c) => c.query.includes("UpdateLabels"))!.variables,
    ).toEqual({
      id: "uuid-1",
      input: { labelIds: ["lbl-a", "lbl-new"] },
    });
    // second ticket, same label: no lookup, no create
    await c.addLabel("uuid-1", "pm-verified");
    const ops = calls.map((c) => c.query.match(/(query|mutation)\s+(\w+)/)![2]);
    expect(ops.filter((o) => o === "Labels")).toHaveLength(1);
    expect(ops.filter((o) => o === "CreateLabel")).toHaveLength(1);
  });

  it("addLabel is a no-op when the ticket already carries it (case-insensitive)", async () => {
    const calls = stubLinear(() => ({ issue: issueNode() }));
    await client().addLabel("uuid-1", "PM-APPROVED");
    expect(calls).toHaveLength(1);
  });

  it("removeLabel drops the label from the id list; no-op when absent", async () => {
    const calls = stubLinear((op) => {
      if (op === "IssueLabels")
        return {
          issue: issueNode({
            labels: {
              nodes: [
                { id: "lbl-a", name: "pm-approved" },
                { id: "lbl-d", name: "pm-dispatched" },
              ],
            },
          }),
        };
      return { issueUpdate: { success: true } };
    });
    const c = client();
    await c.removeLabel("uuid-1", "pm-dispatched");
    expect(calls[1]!.variables).toEqual({
      id: "uuid-1",
      input: { labelIds: ["lbl-a"] },
    });
    await c.removeLabel("uuid-1", "pm-nope");
    expect(calls).toHaveLength(3);
  });

  it("throws when issueUpdate refuses", async () => {
    stubLinear((op) =>
      op === "IssueLabels"
        ? { issue: issueNode() }
        : { issueUpdate: { success: false } },
    );
    await expect(client().removeLabel("uuid-1", "pm-approved")).rejects.toThrow(
      /issueUpdate/,
    );
  });
});

describe("comments", () => {
  it("addComment creates and returns the comment", async () => {
    const calls = stubLinear((_op, vars) => ({
      commentCreate: {
        success: true,
        comment: {
          id: "cmt-1",
          body: (vars.input as { body: string }).body,
          createdAt: "2026-10-02T12:00:00.000Z",
        },
      },
    }));
    await expect(
      client().addComment("uuid-1", "Dispatched → run 41"),
    ).resolves.toEqual({
      id: "cmt-1",
      body: "Dispatched → run 41",
      createdAt: "2026-10-02T12:00:00.000Z",
    });
    expect(calls[0]!.variables).toEqual({
      input: { issueId: "uuid-1", body: "Dispatched → run 41" },
    });
  });

  it("listComments pages and returns oldest first", async () => {
    stubLinear((_op, vars) => ({
      issue: {
        comments:
          vars.after == null
            ? {
                nodes: [
                  {
                    id: "c2",
                    body: "second",
                    createdAt: "2026-10-02T11:00:00.000Z",
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "x" },
              }
            : {
                nodes: [
                  {
                    id: "c1",
                    body: "first",
                    createdAt: "2026-10-02T10:00:00.000Z",
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
      },
    }));
    const comments = await client().listComments("uuid-1");
    expect(comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("listComments of an unknown ticket is empty", async () => {
    stubLinear(() => ({ issue: null }));
    await expect(client().listComments("nope")).resolves.toEqual([]);
  });
});

describe("createTicket", () => {
  it("resolves the project's team, resolves/creates labels, then issueCreate", async () => {
    const calls = stubLinear((op, vars) => {
      switch (op) {
        case "ProjectTeam":
          return { project: { teams: { nodes: [{ id: "team-1" }] } } };
        case "Labels":
          return (vars.name as string) === "pm-ci"
            ? {
                issueLabels: {
                  nodes: [{ id: "lbl-ci", name: "pm-ci", team: null }],
                },
              }
            : { issueLabels: { nodes: [] } };
        case "CreateLabel":
          return {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: "lbl-approved" },
            },
          };
        case "CreateIssue":
          return {
            issueCreate: {
              success: true,
              issue: issueNode({
                id: "uuid-new",
                identifier: "GAME-50",
                title: (vars.input as { title: string }).title,
                labels: {
                  nodes: [
                    { id: "lbl-ci", name: "pm-ci" },
                    { id: "lbl-approved", name: "pm-approved" },
                  ],
                },
              }),
            },
          };
        default:
          throw new Error(`unexpected ${op}`);
      }
    });
    const t = await client().createTicket({
      projectId: "proj-1",
      title: "Fix red pm-staging (abc)",
      description: "sha: abc",
      labels: ["pm-ci", "pm-approved"],
      priority: 1,
    });
    expect(t).toMatchObject({
      id: "uuid-new",
      identifier: "GAME-50",
      labels: ["pm-ci", "pm-approved"],
    });
    const create = calls.find((c) => c.query.includes("CreateIssue"))!;
    expect(create.variables).toEqual({
      input: {
        teamId: "team-1",
        projectId: "proj-1",
        title: "Fix red pm-staging (abc)",
        description: "sha: abc",
        labelIds: ["lbl-ci", "lbl-approved"],
        priority: 1,
      },
    });
  });

  it("fails clearly when the project has no team", async () => {
    stubLinear(() => ({ project: { teams: { nodes: [] } } }));
    await expect(
      client().createTicket({
        projectId: "proj-x",
        title: "t",
        description: "",
        labels: [],
      }),
    ).rejects.toThrow(/proj-x.*no team/);
  });
});

describe("LinearApi.listProjects", () => {
  it("returns id, name, team labels and url for every project the key sees", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              projects: {
                nodes: [
                  {
                    id: "uuid-1",
                    name: "ExampleApp — Core",
                    url: "https://linear.app/x/project/example-core",
                    teams: { nodes: [{ key: "FM", name: "ExampleApp" }] },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new LinearApi({ apiKey: "lin_test" });
    const projects = await api.listProjects();
    expect(projects).toEqual([
      {
        id: "uuid-1",
        name: "ExampleApp — Core",
        teams: ["ExampleApp (FM)"],
        url: "https://linear.app/x/project/example-core",
      },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init?.body));
    expect(body.query).toContain("projects(first: 100)");
  });
});
