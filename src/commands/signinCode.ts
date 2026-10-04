// `hub signin-code --project <name> [--bootstrap --preview-url <url>]`
//
// The PM's way into an app that signs in with emailed one-time codes. Instead
// of reading an inbox, it does what the target's own auth verification script
// does: seed a code for the project's test account straight into the PREVIEW
// database (`project.json` → signIn, kind `neon-auth-otp`) and print it. The
// PM then types email + code on the sign-in screen like a person would.
//
// `--bootstrap` goes one step further, once, at set-up: it signs in over HTTP
// so the account exists, then prints the account's owner hash — the value a
// target that gates test-mode features per owner (e.g. STRIPE_TEST_OWNER)
// needs in its Preview environment.
//
// The database URL comes from the hub secret NAMED in project.json. It must be
// the preview branch: this command writes a row and refuses a production-named
// host only by convention, so never point the secret at production.

import { createHash, randomInt, randomUUID } from "node:crypto";
import { loadProject } from "../config.ts";
import type { Io } from "./crons.ts";
import { parseFlags } from "./crons.ts";

export type Sql = (query: string, params: unknown[]) => Promise<unknown[]>;

export interface SigninDeps {
  /** opens a query function for a connection string */
  connect: (databaseUrl: string) => Sql;
  fetchImpl?: typeof fetch;
  /** injectable for tests */
  otp?: () => string;
}

/** Better Auth's email-OTP verification value: sha256(code) base64url + ":<attempts>". */
export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("base64url") + ":0";
}

/** The owner id the target derives from a user id (sha256 of `account:<id>`). */
export function accountOwner(userId: string): string {
  return createHash("sha256").update(`account:${userId}`).digest("hex");
}

/** Pull the postgres URL out of whatever was pasted: a bare URL, one wrapped
 *  in quotes, a `psql '…'` snippet, or a `DATABASE_URL=…` line, with any
 *  trailing newline or BOM a shell pipe added. Null when there is none. */
export function extractDatabaseUrl(raw: string): string | null {
  const m = raw.match(/postgres(?:ql)?:\/\/[^\s'"`]+/);
  return m ? m[0] : null;
}

export async function seedCode(
  sql: Sql,
  email: string,
  code: string,
): Promise<void> {
  // a fresh code replaces any earlier unused one for this address
  await sql(`DELETE FROM neon_auth.verification WHERE identifier = $1`, [
    `sign-in-otp-${email}`,
  ]);
  await sql(
    `INSERT INTO neon_auth.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
     VALUES ($1::uuid, $2, $3, now() + interval '10 minutes', now(), now())`,
    [randomUUID(), `sign-in-otp-${email}`, hashOtp(code)],
  );
}

export async function runSigninCode(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: SigninDeps,
): Promise<number> {
  const { values } = parseFlags(args);
  const name = typeof values.project === "string" ? values.project : null;
  if (!name) {
    io.error(
      "usage: signin-code --project <name> [--bootstrap --preview-url <url>]",
    );
    return 1;
  }
  const { config } = loadProject(root, name);
  if (!config.signIn) {
    io.error(`${name} has no signIn recipe in project.json`);
    return 1;
  }
  const rawUrl = env[config.signIn.databaseUrlSecret];
  if (!rawUrl) {
    io.error(
      `${config.signIn.databaseUrlSecret} is not set — add the PREVIEW database URL as a hub secret`,
    );
    return 1;
  }
  const databaseUrl = extractDatabaseUrl(rawUrl);
  if (!databaseUrl) {
    // describe the shape, never the value
    io.error(
      `${config.signIn.databaseUrlSecret} does not contain a postgres:// URL (${rawUrl.trim().length} characters, ${/\s/.test(rawUrl.trim()) ? "has" : "no"} whitespace, ${/^[A-Za-z0-9]+$/.test(rawUrl.trim()) ? "letters and digits only — looks like a different secret was on the clipboard" : "mixed characters"}) — copy the connection string from the preview branch and set the secret again`,
    );
    return 1;
  }
  const sql = deps.connect(databaseUrl);
  const { email, path } = config.signIn;
  if (values.diagnose === true) {
    // shapes only — never a value, never an address
    const rows = (await sql(
      `SELECT identifier, value, "expiresAt" > now() AS live FROM neon_auth.verification ORDER BY "createdAt" DESC LIMIT 8`,
      [],
    )) as { identifier: string; value: string; live: boolean }[];
    for (const r of rows) {
      const v = String(r.value);
      io.log(
        JSON.stringify({
          identifierPrefix: String(r.identifier).replace(
            /[^@\s-]+@.*$/,
            "<email>",
          ),
          valueLength: v.length,
          plainSixDigits: /^\d{6}:\d+$/.test(v),
          hashedBase64Url: /^[A-Za-z0-9_-]{43}:\d+$/.test(v),
          hashedHex: /^[0-9a-f]{64}(:\d+)?$/.test(v),
          hasColon: v.includes(":"),
          live: r.live,
        }),
      );
    }
    const users = (await sql(
      `SELECT count(*)::int AS n FROM neon_auth."user"`,
      [],
    )) as { n: number }[];
    const host = new URL(databaseUrl).hostname.replace(
      /^(ep-[a-z]+-[a-z]+)-[^.]+/,
      "$1-…",
    );
    io.log(JSON.stringify({ users: users[0]?.n, databaseHost: host }));
    return 0;
  }
  const code = (deps.otp ?? (() => String(randomInt(100000, 1000000))))();
  await seedCode(sql, email, code);

  if (values.bootstrap !== true) {
    io.log(JSON.stringify({ email, code, path, expiresInMinutes: 10 }));
    return 0;
  }

  const previewUrl =
    typeof values["preview-url"] === "string"
      ? values["preview-url"].replace(/\/$/, "")
      : null;
  if (!previewUrl) {
    io.error("--bootstrap needs --preview-url <https://…>");
    return 1;
  }
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const bypass = env[config.vercel.bypassSecret] ?? env.VERCEL_BYPASS ?? "";
  // --auth-url posts straight to the auth service (diagnosis: is it the app's
  // auth URL or the code format that is wrong?); the default goes through the
  // app, which is what creates the session cookie path the PM will use.
  const authUrl =
    typeof values["auth-url"] === "string"
      ? values["auth-url"].replace(/\/$/, "")
      : null;
  const target = authUrl
    ? `${authUrl}/sign-in/email-otp`
    : `${previewUrl}/api/auth/sign-in/email-otp`;
  const res = await doFetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: previewUrl,
      ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    },
    body: JSON.stringify({ email, otp: code }),
  });
  if (!res.ok) {
    io.error(
      `sign-in on ${authUrl ? "the auth service directly" : previewUrl} answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
    return 1;
  }
  const rows = (await sql(
    `SELECT id FROM neon_auth."user" WHERE email = $1 LIMIT 1`,
    [email],
  )) as { id: string }[];
  const id = rows[0]?.id;
  if (!id) {
    io.error(`signed in, but no neon_auth user row for ${email}`);
    return 1;
  }
  io.log(JSON.stringify({ email, owner: accountOwner(String(id)) }));
  return 0;
}
