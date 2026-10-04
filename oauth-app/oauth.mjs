import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

const SITE = "https://shipgremlins.ai";
const TTL = 600_000;
const providers = new Set(["linear", "vercel"]);
const label = (p) => (p === "linear" ? "Linear" : "Vercel");
const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const digest = (value) => createHash("sha256").update(value).digest();
export function seal(provider, value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`shipgremlins-${provider}-v1`));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
}
export function unseal(provider, value, key) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,16000}$/.test(value))
    throw new Error("Invalid envelope");
  const bytes = Buffer.from(value, "base64url"),
    cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(`shipgremlins-${provider}-v1`));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
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
function body(req) {
  if (
    typeof req.body === "object" &&
    req.body !== null &&
    !Array.isArray(req.body)
  ) {
    if (JSON.stringify(req.body).length > 16384)
      throw new Error("Body too large");
    return req.body;
  }
  if (typeof req.body !== "string" || req.body.length > 16384)
    throw new Error("Invalid body");
  return String(req.headers["content-type"]).startsWith(
    "application/x-www-form-urlencoded",
  )
    ? Object.fromEntries(new URLSearchParams(req.body))
    : JSON.parse(req.body);
}
export function createOAuthBroker(
  provider,
  { env = process.env, fetcher = fetch, now = Date.now } = {},
) {
  if (!providers.has(provider)) throw new Error("Unknown provider");
  const name = label(provider),
    prefix = provider.toUpperCase();
  const clientId = env[`SG_${prefix}_CLIENT_ID`] ?? env[`${prefix}_CLIENT_ID`],
    secret =
      env[`SG_${prefix}_CLIENT_SECRET`] ?? env[`${prefix}_CLIENT_SECRET`];
  const stateKey =
    env[`SG_${prefix}_OAUTH_STATE_KEY`] ?? env[`${prefix}_OAUTH_STATE_KEY`];
  const slug = env.SG_VERCEL_INTEGRATION_SLUG || "shipgremlins";
  const configured = !!(
    clientId &&
    /^[A-Za-z0-9_-]{43}$/.test(stateKey ?? "") &&
    (provider === "linear" || (secret && /^[a-z0-9-]+$/.test(slug)))
  );
  const key = configured ? Buffer.from(stateKey, "base64url") : null;
  const callback = `${SITE}/api/${provider}/callback`;
  const valid = (r) =>
    r &&
    validReturnUrl(r.returnUrl) &&
    /^[A-Za-z0-9_-]{43}$/.test(r.key ?? "") &&
    /^[A-Za-z0-9_-]{32}$/.test(r.nonce ?? "") &&
    (provider !== "linear" ||
      /^[A-Za-z0-9_-]{43}$/.test(r.codeChallenge ?? ""));
  const unpack = (raw) => {
    const r = unseal(provider, raw, key);
    if (
      !valid(r) ||
      !Number.isFinite(r.expires) ||
      r.expires <= now() ||
      r.expires > now() + TTL
    )
      throw new Error("Expired request");
    return r;
  };
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "strict-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://linear.app https://vercel.com; frame-ancestors 'none'; base-uri 'none'`,
    );
    const json = (status, value) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    const page = (status, title, content) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · ShipGremlins</title><link rel="stylesheet" href="/slack-connect.css"><link rel="icon" href="/favicon.svg"></head><body><main><a class="brand" href="${SITE}"><span>{g}</span> ShipGremlins</a><p class="eyebrow">CONNECT YOUR CREW</p><h1>${esc(title)}</h1>${content}<footer>PM Gremlins find the gaps. Coding Gremlins fix them.<br><a href="/connections-privacy.html">Connection privacy</a> · <a href="/docs.html">Documentation</a></footer></main></body></html>`,
      );
    };
    const go = (url) => {
      res.statusCode = 303;
      res.setHeader("Location", url);
      res.end();
    };
    try {
      const u = new URL(req.url, SITE),
        action = u.pathname.split("/").at(-1);
      if (action === "status" && req.method === "GET")
        return json(200, { available: configured });
      if (!configured)
        return page(
          503,
          `${name} connection is being configured.`,
          "<p>Return to Connections in your dashboard and try again shortly. Manual tokens remain available.</p>",
        );
      if (action === "connect" && req.method === "POST") {
        if (!String(req.headers["content-type"]).startsWith("application/json"))
          return json(415, { error: "Use JSON." });
        const b = body(req);
        if (!valid(b))
          return json(400, { error: "Invalid dashboard pairing request." });
        const request = seal(
          provider,
          {
            returnUrl: new URL(b.returnUrl).href,
            key: b.key,
            nonce: b.nonce,
            ...(provider === "linear"
              ? { codeChallenge: b.codeChallenge }
              : {}),
            expires: now() + TTL,
          },
          key,
        );
        return json(200, {
          url: `${SITE}/api/${provider}/authorize?request=${request}`,
          clientId,
          redirectUri: callback,
        });
      }
      if (action === "authorize" && req.method === "GET") {
        const raw = u.searchParams.get("request"),
          r = unpack(raw);
        return page(
          200,
          `Connect your crew to ${name}.`,
          `<p>Continue only if you just clicked <strong>Connect ${name}</strong> on this ShipGremlins server.</p><div class="instance"><small>YOUR SHIPGREMLINS INSTANCE</small><strong>${esc(new URL(r.returnUrl).origin)}</strong></div><p>${provider === "linear" ? "Organize your apps into teams, PM mandates into projects, and findings into issues. Your Linear permissions determine which teams you can create or manage." : "Choose the Vercel projects your crew can inspect. ShipGremlins reads project and deployment details to find ready previews."}</p><form method="post" action="/api/${provider}/authorize"><input type="hidden" name="request" value="${esc(raw)}"><button type="submit">Continue to ${name} <span>↗</span></button></form><p class="fine">${provider === "linear" ? "Your server exchanges the authorization code directly with Linear. Tokens stay on your server." : "Our connection service exchanges the authorization code, then returns the token encrypted to your server. It does not persist your token."} Keep your dashboard open until setup finishes.</p>`,
        );
      }
      if (action === "authorize" && req.method === "POST") {
        if (req.headers.origin !== SITE)
          return page(
            403,
            "Start from your dashboard.",
            `<p>Click Connect ${name} in your dashboard to begin.</p>`,
          );
        const r = unpack(body(req).request),
          browser = randomBytes(24).toString("base64url");
        res.setHeader(
          "Set-Cookie",
          `sg_${provider}_${r.nonce.slice(0, 12)}=${browser}; Path=/api/${provider}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        );
        const state = seal(
          provider,
          { ...r, browser: digest(browser).toString("base64url") },
          key,
        );
        const target = new URL(
          provider === "linear"
            ? "https://linear.app/oauth/authorize"
            : `https://vercel.com/integrations/${slug}/new`,
        );
        target.search = new URLSearchParams(
          provider === "linear"
            ? {
                client_id: clientId,
                redirect_uri: callback,
                response_type: "code",
                scope: "read,write",
                actor: "user",
                state,
                code_challenge: r.codeChallenge,
                code_challenge_method: "S256",
              }
            : { state },
        ).toString();
        return go(target.href);
      }
      if (action === "callback" && req.method === "GET") {
        const r = unpack(u.searchParams.get("state")),
          cookieName = `sg_${provider}_${r.nonce.slice(0, 12)}`;
        const cookies = Object.fromEntries(
          String(req.headers.cookie ?? "")
            .split(";")
            .map((x) => x.trim().split("=")),
        );
        const cookie = cookies[cookieName],
          expected = Buffer.from(
            typeof r.browser === "string" ? r.browser : "",
            "base64url",
          ),
          actual = digest(cookie ?? "");
        if (
          !cookie ||
          expected.length !== actual.length ||
          !timingSafeEqual(expected, actual)
        )
          return page(
            403,
            "This connection could not be verified.",
            `<p>Return to your dashboard and click Connect ${name} again in the same browser.</p>`,
          );
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; Path=/api/${provider}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        );
        const result = { nonce: r.nonce, expires: r.expires },
          code = u.searchParams.get("code");
        if (u.searchParams.has("error") || !code || code.length > 2000)
          result.error = true;
        else if (provider === "linear") result.code = code;
        else {
          try {
            const response = await fetcher(
              "https://api.vercel.com/v2/oauth/access_token",
              {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  client_id: clientId,
                  client_secret: secret,
                  code,
                  redirect_uri: callback,
                }),
                signal: AbortSignal.timeout(10000),
                redirect: "error",
              },
            );
            const value = await response.json();
            const text = (v) =>
              typeof v === "string" && v.length > 0 && v.length < 16384;
            if (
              !response.ok ||
              !text(value.access_token) ||
              !text(value.user_id) ||
              !text(value.installation_id) ||
              (value.team_id != null && !text(value.team_id))
            )
              throw new Error("Invalid exchange");
            result.connection = {
              accessToken: value.access_token,
              userId: value.user_id,
              configurationId: value.installation_id,
              teamId: value.team_id ?? null,
            };
          } catch {
            result.error = true;
          }
        }
        return go(
          `${r.returnUrl}#${provider}=${seal(provider, result, Buffer.from(r.key, "base64url"))}`,
        );
      }
      return json(404, { error: "Not found." });
    } catch {
      return page(
        400,
        "This connection link expired.",
        `<p>Return to your dashboard and click Connect ${name} again.</p>`,
      );
    }
  };
}
