import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

const TTL = 10 * 60_000;
const AAD = Buffer.from("shipgremlins-slack-v1");
export function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function unseal(value, key) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,16000}$/.test(value))
    throw new Error("Invalid connection request.");
  const bytes = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}
export function validReturnUrl(value) {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
      return false;
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    if (u.hostname === "localhost" || u.hostname === "[::1]") return true;
    if (isIP(u.hostname) !== 4) return false;
    const [a, b] = u.hostname.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  } catch {
    return false;
  }
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function html(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · ShipGremlins</title><link rel="stylesheet" href="/slack-connect.css"><link rel="icon" href="/favicon.svg"></head><body><main><a class="brand" href="https://shipgremlins.ai"><span>{g}</span> ShipGremlins</a><p class="eyebrow">A DIRECT LINE TO YOUR CREW</p><h1>${esc(title)}</h1>${body}<footer>PM Gremlins find the gaps. Coding Gremlins fix them.<br><a href="/slack-privacy.html">Slack connection privacy</a></footer></main></body></html>`;
}
function getBody(req) {
  if (
    typeof req.body === "object" &&
    req.body !== null &&
    !Array.isArray(req.body)
  )
    return req.body;
  if (typeof req.body !== "string" || req.body.length > 16_384)
    throw new Error("Invalid request body.");
  if (
    String(req.headers["content-type"]).startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    return Object.fromEntries(new URLSearchParams(req.body));
  return JSON.parse(req.body);
}
export function createSlackBroker({
  env = process.env,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  const site = "https://shipgremlins.ai";
  const redirect = `${site}/api/slack/callback`;
  const configured = !!(
    env.SLACK_CLIENT_ID &&
    env.SLACK_CLIENT_SECRET &&
    /^[A-Za-z0-9_-]{43}$/.test(env.SLACK_OAUTH_STATE_KEY ?? "")
  );
  const key = configured
    ? Buffer.from(env.SLACK_OAUTH_STATE_KEY, "base64url")
    : null;
  const unpack = (value) => {
    const request = unseal(value, key);
    if (
      !request ||
      !Number.isFinite(request.expires) ||
      request.expires < now() ||
      request.expires > now() + TTL ||
      !validReturnUrl(request.returnUrl) ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.key ?? "") ||
      !/^[A-Za-z0-9_-]{32}$/.test(request.nonce ?? "")
    )
      throw new Error(
        "This setup link expired. Return to your dashboard and click Add to Slack again.",
      );
    return request;
  };
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    // Preserve the browser's Origin header on the confirmation POST while never
    // sending the pairing request or OAuth state in a Referer URL.
    res.setHeader("Referrer-Policy", "strict-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://slack.com; frame-ancestors 'none'; base-uri 'none'",
    );
    const json = (status, value) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    const page = (status, title, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html(title, body));
    };
    const go = (url) => {
      res.statusCode = 303;
      res.setHeader("Location", url);
      res.end();
    };
    try {
      const u = new URL(req.url, site);
      const action = u.pathname.split("/").at(-1);
      if (action === "status" && req.method === "GET")
        return json(200, { available: configured });
      if (!configured)
        return page(
          503,
          "The Slack connection is warming up.",
          "<p>Return to your ShipGremlins dashboard and try again shortly. You can also use an incoming webhook from Connections.</p>",
        );
      if (action === "connect" && req.method === "POST") {
        if (!String(req.headers["content-type"]).startsWith("application/json"))
          return json(415, { error: "Use JSON." });
        const body = getBody(req);
        if (
          !validReturnUrl(body.returnUrl) ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.key ?? "") ||
          !/^[A-Za-z0-9_-]{32}$/.test(body.nonce ?? "")
        )
          return json(400, { error: "Invalid dashboard pairing request." });
        const request = seal(
          {
            key: body.key,
            nonce: body.nonce,
            returnUrl: new URL(body.returnUrl).href,
            expires: now() + TTL,
          },
          key,
        );
        return json(200, {
          url: `${site}/api/slack/authorize?request=${request}`,
        });
      }
      if (action === "authorize" && req.method === "GET") {
        const raw = u.searchParams.get("request");
        const request = unpack(raw);
        return page(
          200,
          "Invite your crew to Slack.",
          `<p>Connect Slack to the ShipGremlins dashboard below. Continue only if this is your server and you just clicked <strong>Add to Slack</strong> there.</p><div class="instance"><small>YOUR SHIPGREMLINS INSTANCE</small><strong>${esc(new URL(request.returnUrl).origin)}</strong></div><p>Choose a Slack channel for findings, blockers, and work ready for review. ShipGremlins can post to that channel; it cannot read your messages.</p><form method="post" action="/api/slack/authorize"><input type="hidden" name="request" value="${esc(raw)}"><button type="submit">Continue to Slack <span>↗</span></button></form><p class="fine">Your channel connection is returned encrypted to your server. Keep your dashboard open until setup finishes.</p>`,
        );
      }
      if (action === "authorize" && req.method === "POST") {
        if (req.headers.origin !== site)
          return page(
            403,
            "Start from your dashboard.",
            "<p>Click Add to Slack in your ShipGremlins dashboard to begin.</p>",
          );
        const request = unpack(getBody(req).request);
        const browser = randomBytes(24).toString("base64url");
        const cookieName = `sg_slack_${request.nonce.slice(0, 12)}`;
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${browser}; Path=/api/slack; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        );
        const state = seal({ ...request, browser: hash(browser) }, key);
        const target = new URL("https://slack.com/oauth/v2/authorize");
        target.search = new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          scope: "incoming-webhook",
          redirect_uri: redirect,
          state,
        }).toString();
        return go(target.href);
      }
      if (action === "callback" && req.method === "GET") {
        const request = unpack(u.searchParams.get("state"));
        const cookieName = `sg_slack_${request.nonce.slice(0, 12)}`;
        const cookies = Object.fromEntries(
          String(req.headers.cookie ?? "")
            .split(";")
            .map((x) => x.trim().split("=")),
        );
        const cookie = cookies[cookieName];
        const expected =
          typeof request.browser === "string"
            ? Buffer.from(request.browser)
            : Buffer.alloc(0);
        const actual = Buffer.from(hash(cookie ?? ""));
        if (
          !cookie ||
          expected.length !== actual.length ||
          !timingSafeEqual(expected, actual)
        )
          return page(
            403,
            "This Slack setup could not be verified.",
            "<p>Return to your dashboard and click Add to Slack again in the same browser.</p>",
          );
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; Path=/api/slack; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        );
        const result = { nonce: request.nonce, expires: request.expires };
        const code = u.searchParams.get("code");
        if (u.searchParams.has("error") || !code || code.length > 2000)
          result.error = "authorization_failed";
        else {
          try {
            const response = await fetcher(
              "https://slack.com/api/oauth.v2.access",
              {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  client_id: env.SLACK_CLIENT_ID,
                  client_secret: env.SLACK_CLIENT_SECRET,
                  code,
                  redirect_uri: redirect,
                }),
                signal: AbortSignal.timeout(10_000),
                redirect: "error",
              },
            );
            const value = await response.json();
            const hook = value?.incoming_webhook;
            if (
              !response.ok ||
              value.ok !== true ||
              typeof hook?.url !== "string" ||
              !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
                hook.url,
              ) ||
              !value.team?.id ||
              !hook.channel_id
            ) {
              const knownErrors = new Set([
                "bad_client_secret",
                "invalid_client_id",
                "invalid_code",
                "invalid_redirect_uri",
                "invalid_request",
                "invalid_auth",
                "code_already_used",
                "access_denied",
                "ratelimited",
              ]);
              console.error("Slack OAuth exchange failed", {
                status: response.status,
                reason: knownErrors.has(value.error)
                  ? value.error
                  : "invalid_exchange_response",
                hasWebhook: typeof hook?.url === "string",
              });
              throw new Error();
            }
            result.connection = {
              webhookUrl: hook.url,
              teamId: String(value.team.id).slice(0, 200),
              teamName: String(value.team.name ?? "Slack workspace").slice(
                0,
                200,
              ),
              channelId: String(hook.channel_id).slice(0, 200),
              channelName: String(hook.channel ?? "Slack channel").slice(
                0,
                200,
              ),
              connectedAt: new Date(now()).toISOString(),
            };
            // OAuth bot tokens are deliberately not retained: only the selected channel webhook is needed.
          } catch {
            result.error = "authorization_failed";
          }
        }
        const envelope = seal(result, Buffer.from(request.key, "base64url"));
        return go(`${request.returnUrl}#slack=${envelope}`);
      }
      return json(404, { error: "Not found." });
    } catch {
      // No raw errors, codes, state, connection keys, tokens, or Slack responses in logs.
      return page(
        400,
        "This connection link expired.",
        "<p>Return to your dashboard and click Add to Slack again.</p>",
      );
    }
  };
}
