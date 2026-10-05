import { request } from "node:http";

/** Probe the controller's host listener using the worker's reserved Docker alias.
 * Node fetch ignores Host overrides, so HTTP alias probes need http.request.
 * This is a readiness probe: return headers/status and discard the response body.
 */
export async function controllerPreviewFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "host.docker.internal")
    return fetch(input, init);
  if (
    url.username ||
    url.password ||
    !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()) ||
    init.body != null
  )
    throw new Error(
      "Docker host readiness probes require a credential-free GET or HEAD URL.",
    );
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  // Do not retain a pooled socket to a response body that this probe discards.
  headers.set("connection", "close");
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("The Docker host preview could not be reached."));
    };
    const req = request(
      {
        hostname: "127.0.0.1",
        port: url.port || "80",
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        signal,
        agent: false,
        maxHeaderSize: 16_384,
      },
      (res) => {
        try {
          const responseHeaders = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          const response = new Response(null, {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage,
            headers: responseHeaders,
          });
          settled = true;
          resolve(response);
        } catch {
          fail();
        } finally {
          // No application body is needed, so streaming or oversized bodies cannot
          // hold doctor open or consume memory. Redirects are handled by its caller.
          res.destroy();
          req.destroy();
        }
      },
    );
    req.once("error", fail);
    req.end();
  });
}
