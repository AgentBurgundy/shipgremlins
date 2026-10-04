import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSymlinks } from "../setup/files.ts";

export const SLACK_BROKER = "https://shipgremlins.ai";
const TTL = 10 * 60_000;
export interface SlackConnection {
  webhookUrl: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  connectedAt: string;
}
export function validSlackWebhook(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "hooks.slack.com" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
        u.pathname,
      )
    );
  } catch {
    return false;
  }
}
function path(root: string, name: string): string {
  const file = join(root, ".run", "slack", name);
  assertNoSymlinks(file);
  return file;
}
async function save(root: string, name: string, value: unknown) {
  const file = path(root, name);
  await mkdir(join(root, ".run", "slack"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function read(root: string, name: string): Promise<unknown> {
  try {
    const raw = await readFile(path(root, name), "utf8");
    if (raw.length > 16_384)
      throw new Error("Slack configuration is too large.");
    return JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Slack configuration could not be read.");
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function connection(value: unknown): SlackConnection {
  if (!record(value) || !validSlackWebhook(value.webhookUrl))
    throw new Error("Invalid Slack connection.");
  for (const key of [
    "teamId",
    "teamName",
    "channelId",
    "channelName",
    "connectedAt",
  ]) {
    if (typeof value[key] !== "string" || value[key].length > 200)
      throw new Error("Invalid Slack connection.");
  }
  return Object.fromEntries(
    [
      "webhookUrl",
      "teamId",
      "teamName",
      "channelId",
      "channelName",
      "connectedAt",
    ].map((key) => [key, value[key]]),
  ) as unknown as SlackConnection;
}
export async function getSlackConnection(
  root: string,
): Promise<SlackConnection | null> {
  const value = await read(root, "connection.json");
  return value === null ? null : connection(value);
}

// The same AES-GCM envelope format is used by the open-source OAuth broker.
export function sealSlackEnvelope(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("shipgremlins-slack-v1"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
function openEnvelope(value: string, key: Buffer): unknown {
  if (!/^[A-Za-z0-9_-]{40,16000}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from("shipgremlins-slack-v1"));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export function createSlackConnect(options: {
  root: string;
  session: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { root, session } = options;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sessionHash = createHash("sha256").update(session).digest("hex");
  let availability: { available: boolean; checkedAt: number } | undefined;
  let busy = false;
  async function available() {
    if (availability && now() - availability.checkedAt < 60_000)
      return availability.available;
    let result = false;
    try {
      const res = await fetcher(`${SLACK_BROKER}/api/slack/status`, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      const data: unknown = await res.json();
      result = res.ok && record(data) && data.available === true;
    } catch {
      /* A manual webhook still works when the broker is unavailable. */
    }
    availability = { available: result, checkedAt: now() };
    return result;
  }
  async function status() {
    const saved = await getSlackConnection(root);
    const enabled = await available();
    return {
      available: enabled,
      connected: !!saved,
      ...(saved
        ? {
            workspace: { id: saved.teamId, name: saved.teamName },
            channel: { id: saved.channelId, name: saved.channelName },
          }
        : {}),
      message: !enabled
        ? "Add to Slack is temporarily unavailable. An incoming webhook can also connect your crew."
        : undefined,
    };
  }
  return {
    status,
    async connect(returnUrl: string) {
      const target = new URL(returnUrl);
      if (
        !/^https?:$/.test(target.protocol) ||
        target.username ||
        target.password ||
        target.pathname !== "/" ||
        target.search ||
        target.hash
      )
        throw new Error("Invalid dashboard return address.");
      const key = randomBytes(32).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      let response: Response;
      try {
        response = await fetcher(`${SLACK_BROKER}/api/slack/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, nonce, returnUrl: target.href }),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
      } catch {
        throw new Error("Could not reach Slack setup. Try again in a moment.");
      }
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok || !record(data) || typeof data.url !== "string")
        throw new Error(
          "Add to Slack is not available yet. You can connect an incoming webhook below.",
        );
      const u = new URL(data.url);
      if (
        u.origin !== SLACK_BROKER ||
        u.pathname !== "/api/slack/authorize" ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new Error("Invalid Slack setup response.");
      await save(root, "pending.json", {
        key,
        nonce,
        sessionHash,
        expires: now() + TTL,
      });
      return { url: u.href };
    },
    async complete(envelope: string) {
      if (busy) throw new Error("Slack connection is already being saved.");
      busy = true;
      try {
        const pending = await read(root, "pending.json");
        if (
          !record(pending) ||
          pending.sessionHash !== sessionHash ||
          typeof pending.expires !== "number" ||
          pending.expires < now() ||
          typeof pending.key !== "string"
        )
          throw new Error(
            "This Slack setup link expired. Click Add to Slack again.",
          );
        let payload: unknown;
        try {
          payload = openEnvelope(
            envelope,
            Buffer.from(pending.key, "base64url"),
          );
        } catch {
          throw new Error(
            "Slack setup could not be verified. Click Add to Slack again.",
          );
        }
        if (
          !record(payload) ||
          payload.nonce !== pending.nonce ||
          typeof payload.expires !== "number" ||
          payload.expires < now() ||
          payload.expires > now() + TTL
        )
          throw new Error(
            "Slack setup could not be verified. Click Add to Slack again.",
          );
        if (payload.error) {
          await unlink(path(root, "pending.json"));
          throw new Error(
            "Slack connection was canceled or could not be authorized. Your existing connection is unchanged.",
          );
        }
        const saved = connection(payload.connection);
        await save(root, "connection.json", saved);
        await unlink(path(root, "pending.json"));
        return status();
      } finally {
        busy = false;
      }
    },
    async webhook(webhookUrl: string) {
      if (!validSlackWebhook(webhookUrl))
        throw new Error(
          "Enter a Slack incoming webhook URL from hooks.slack.com/services/.",
        );
      await save(root, "connection.json", {
        webhookUrl,
        teamId: "",
        teamName: "Incoming webhook",
        channelId: "",
        channelName: "Configured Slack channel",
        connectedAt: new Date(now()).toISOString(),
      });
      await unlink(path(root, "pending.json")).catch(() => {});
      return status();
    },
    async disconnect() {
      await unlink(path(root, "connection.json")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await unlink(path(root, "pending.json")).catch(() => {});
      return status();
    },
  };
}
