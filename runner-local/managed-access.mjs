import { AccessFailure } from "./access-executor.mjs";

export function validateManagedAccess(input) {
  if (
    !input ||
    input.version !== 1 ||
    typeof input.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(input.token)
  )
    throw new AccessFailure("invalid_access");
  let endpoint;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new AccessFailure("invalid_access");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    !["/", "/mcp"].includes(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash ||
    !/^gremlins-auth-[a-zA-Z0-9-]+$/.test(endpoint.hostname) ||
    endpoint.port !== "4719"
  )
    throw new AccessFailure("invalid_access");
  return input;
}
export async function managedAccessRequest(access, path = "/ready") {
  try {
    const response = await fetch(new URL(path, access.endpoint), {
      method: path === "/verify" ? "POST" : "GET",
      headers: { authorization: `Bearer ${access.token}` },
      signal: AbortSignal.timeout(40000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new AccessFailure(result.failure?.code || "helper_unavailable");
    return result;
  } catch (error) {
    throw error instanceof AccessFailure
      ? error
      : new AccessFailure("helper_unavailable");
  }
}
