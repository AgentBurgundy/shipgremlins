import { validSourceRepository } from "../config.ts";
import {
  SourceControlError,
  type RepositoryOwner,
  type SourceControl,
} from "./types.ts";

type Reply = { status: number; data: unknown };
export type AccountRequest = (path: string, body?: unknown) => Promise<Reply>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function checked(reply: Reply) {
  if (reply.status === 401)
    throw new SourceControlError(
      "Reconnect your source account in Connections, then resume setup.",
      "reconnect_required",
      401,
    );
  if (reply.status === 403)
    throw new SourceControlError(
      "Your source account cannot create this repository. For GitHub, allow Repository creation (write) or Administration (write) for the app, then accept its updated permissions. For GitLab, use api access and a namespace where you can create projects. Resume this setup after updating access.",
      "repository_creation_denied",
      403,
    );
  if (reply.status === 409 || reply.status === 422 || reply.status === 400)
    throw new SourceControlError(
      "That repository name is unavailable, or your provider does not allow this visibility. Check the destination before retrying.",
      "repository_conflict",
      409,
    );
  if (reply.status < 200 || reply.status >= 300)
    throw new SourceControlError(
      "Repository setup could not reach the source provider. Retry this same setup to check whether it was created.",
      "provider_error",
      503,
    );
  return reply.data;
}
export async function repositoryOwners(
  provider: "github" | "gitlab",
  request: AccountRequest,
) {
  const user = checked(await request("/user"));
  if (
    !object(user) ||
    !id(user.id) ||
    typeof user[provider === "github" ? "login" : "username"] !== "string"
  )
    throw new SourceControlError(
      "Your source account could not be identified.",
      "invalid_response",
      502,
    );
  const owners: RepositoryOwner[] = [];
  if (provider === "github")
    owners.push({
      id: String(user.id),
      path: String(user.login),
      name: String(user.login),
    });
  let truncated = false;
  for (let page = 1; page <= 10; page++) {
    const reply = await request(
      provider === "github"
        ? `/user/orgs?per_page=100&page=${page}`
        : `/namespaces?owned_only=true&per_page=100&page=${page}`,
    );
    // Some GitHub App connections cannot list organizations. Personal creation still works.
    if (provider === "github" && reply.status === 403) break;
    const data = checked(reply);
    if (!Array.isArray(data))
      throw new SourceControlError(
        "Repository owners could not be listed.",
        "invalid_response",
        502,
      );
    for (const entry of data) {
      if (!object(entry) || !id(entry.id)) continue;
      const path = provider === "github" ? entry.login : entry.full_path;
      if (
        typeof path !== "string" ||
        !validSourceRepository(`${path}/app`, provider)
      )
        continue;
      owners.push({ id: String(entry.id), path, name: path });
    }
    if (data.length < 100) break;
    if (page === 10) truncated = true;
  }
  return { accountId: String(user.id), owners, truncated };
}

export async function createRepository(
  input: Parameters<NonNullable<SourceControl["createRepository"]>>[0],
  request: AccountRequest,
) {
  if (
    !validSourceRepository(input.repository, input.provider) ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(
      input.repository.split("/").at(-1) ?? "",
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      input.creationId,
    ) ||
    !/^\d+$/.test(input.ownerId) ||
    !/^\d+$/.test(input.accountId) ||
    !["private", "public"].includes(input.visibility)
  )
    throw new SourceControlError(
      "Review a valid repository owner, name, and visibility first.",
    );
  const github = input.provider === "github";
  const user = checked(await request("/user"));
  if (!object(user) || String(user.id) !== input.accountId)
    throw new SourceControlError(
      "Your connected source account changed. Reconnect the account used for this setup before resuming.",
      "account_changed",
      409,
    );
  const pieces = input.repository.split("/"),
    name = pieces.pop()!,
    owner = pieces.join("/");
  const ownerData = checked(
    await request(
      github
        ? `/users/${encodeURIComponent(owner)}`
        : `/namespaces/${input.ownerId}`,
    ),
  );
  if (
    !object(ownerData) ||
    String(ownerData.id) !== input.ownerId ||
    String(github ? ownerData.login : ownerData.full_path).toLowerCase() !==
      owner.toLowerCase() ||
    (github &&
      ownerData.type !== "Organization" &&
      String(ownerData.id) !== input.accountId)
  )
    throw new SourceControlError(
      "This repository owner does not match the reviewed destination.",
      "owner_changed",
      409,
    );
  const path = github
    ? `/repos/${input.repository}`
    : `/projects/${encodeURIComponent(input.repository)}`;
  const marker = `Created with ShipGremlins. Setup: ${input.creationId}`;
  let reply = await request(path);
  if (reply.status === 404) {
    reply = await request(
      github
        ? ownerData.type === "Organization"
          ? `/orgs/${encodeURIComponent(owner)}/repos`
          : "/user/repos"
        : "/projects",
      github
        ? {
            name,
            private: input.visibility !== "public",
            description: marker,
            auto_init: false,
          }
        : {
            name,
            path: name,
            namespace_id: Number(input.ownerId),
            visibility: input.visibility,
            description: marker,
            initialize_with_readme: false,
          },
    );
  }
  const result = checked(reply);
  if (
    !object(result) ||
    !id(result.id) ||
    String(
      github ? result.full_name : result.path_with_namespace,
    ).toLowerCase() !== input.repository.toLowerCase() ||
    result.description !== marker
  )
    throw new SourceControlError(
      "A repository already uses that name. It was not adopted or changed. Start a new setup with a different name.",
      "repository_conflict",
      409,
    );
  if (
    (github ? result.private : result.visibility === "private") !==
      (input.visibility === "private") ||
    (!github && result.visibility !== input.visibility)
  )
    throw new SourceControlError(
      "Repository visibility differs from the choice you reviewed. Check it at your source provider before resuming.",
      "visibility_changed",
      409,
    );
  return result;
}
