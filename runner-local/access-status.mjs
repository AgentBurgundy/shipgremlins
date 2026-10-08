// Controller/runner health command. The capability arrives on stdin, never argv.
let raw = "";
try {
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 4096) throw Error();
  }
  const { endpoint, token, path = "/ready", ttlMs } = JSON.parse(raw);
  raw = "";
  if (
    ![
      "/ready",
      "/status",
      "/screenshot",
      "/close",
      "/lease",
      "/verify",
    ].includes(path)
  )
    throw Error();
  const response = await fetch(new URL(path, endpoint), {
    method: ["/close", "/lease", "/verify"].includes(path) ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(path === "/lease" ? { body: JSON.stringify({ ttlMs }) } : {}),
    signal: AbortSignal.timeout(path === "/verify" ? 40000 : 10000),
  });
  const result = await response.json();
  process.stdout.write(JSON.stringify(result));
  if (!response.ok) process.exitCode = 1;
} catch {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      failure: {
        code: "helper_unavailable",
        message: "The private test-access browser is unavailable.",
      },
    }),
  );
  process.exitCode = 1;
}
