import type { Ctx } from "../dispatcher/context.ts";
import type {
  Forge,
  PullRequest,
  PullChange,
  RevisionTreeEntry,
} from "../forge/types.ts";
import type {
  LinearClient,
  LinearTicket,
  LinearWorkflowState,
} from "../services/types.ts";

function adapter<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(original, property) {
      if (Object.hasOwn(overrides, property))
        return Reflect.get(overrides, property);
      const value = Reflect.get(original, property, original);
      return typeof value === "function" ? value.bind(original) : value;
    },
  });
}

/** One reconciliation's audit observations. Mutable authority reads and writes are never cached. */
export function productionAuditReads(ctx: Ctx): Ctx {
  const pulls = new Map<string, Promise<PullRequest | null>>();
  const changes = new Map<string, Promise<PullChange[]>>();
  const trees = new Map<string, Promise<RevisionTreeEntry[]>>();
  const compares = new Map<string, ReturnType<Forge["compare"]>>();
  const tickets = new Map<string, Promise<LinearTicket[]>>();
  const states = new Map<string, Promise<LinearWorkflowState[]>>();
  async function once<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    read: () => Promise<T>,
  ): Promise<T> {
    let result = cache.get(key);
    if (!result) {
      result = read().then((value) => structuredClone(value));
      cache.set(key, result);
    }
    return structuredClone(await result);
  }
  const immutableSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const forge = adapter(ctx.forge, {
    getPull: (repo, number) =>
      once(pulls, JSON.stringify([repo, number]), () =>
        ctx.forge.getPull(repo, number),
      ),
    ...(ctx.forge.listPullChanges
      ? {
          listPullChanges: (repo: string, number: number) =>
            once(changes, JSON.stringify([repo, number]), () =>
              ctx.forge.listPullChanges!(repo, number),
            ),
        }
      : {}),
    ...(ctx.forge.getRevisionTree
      ? {
          getRevisionTree: (repo: string, sha: string) =>
            immutableSha.test(sha)
              ? once(trees, JSON.stringify([repo, sha]), () =>
                  ctx.forge.getRevisionTree!(repo, sha),
                )
              : ctx.forge.getRevisionTree!(repo, sha),
        }
      : {}),
    compare: (repo, base, head) =>
      immutableSha.test(base) && immutableSha.test(head)
        ? once(compares, JSON.stringify([repo, base, head]), () =>
            ctx.forge.compare(repo, base, head),
          )
        : ctx.forge.compare(repo, base, head),
  });
  const linear = adapter<LinearClient>(ctx.linear, {
    listTickets: (project, labels) =>
      once(tickets, JSON.stringify([project, [...labels].sort()]), () =>
        ctx.linear.listTickets(project, labels),
      ),
    ...(ctx.linear.listWorkflowStates
      ? {
          listWorkflowStates: (team: string) =>
            once(states, team, () => ctx.linear.listWorkflowStates!(team)),
        }
      : {}),
  });
  return { ...ctx, forge, linear };
}
