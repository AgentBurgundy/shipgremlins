import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_USAGE_BYTES = 4096;
const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
];

/** Standalone so isolated controller planners can embed this exact parser.
 * Claude's result.modelUsage covers the whole agent tree; result.usage only
 * covers the main loop. Never add either result to the assistant snapshots.
 * https://code.claude.com/docs/en/agent-sdk/cost-tracking
 */
export function parseClaudeUsage(record) {
  if (!record || typeof record !== "object" || record.type !== "result") return;
  const names = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ];
  const snake = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];
  const counts = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const result = {};
    let found = false;
    for (let index = 0; index < names.length; index++) {
      const number = value[keys[index]];
      if (number == null) result[names[index]] = null;
      else if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0
      ) {
        result[names[index]] = number;
        found = true;
      } else return;
    }
    return found ? result : undefined;
  };
  const total = (value) =>
    names.reduce((sum, name) => sum + (value[name] ?? 0), 0);
  const crash = record.subtype === "error_during_execution";
  if (
    record.modelUsage &&
    typeof record.modelUsage === "object" &&
    !Array.isArray(record.modelUsage)
  ) {
    const entries = Object.entries(record.modelUsage);
    if (entries.length > 0 && entries.length <= 128) {
      const values = entries.map(([, value]) => counts(value, names));
      if (values.every(Boolean)) {
        const sum = Object.fromEntries(
          names.map((name) => {
            const known = values
              .map((value) => value[name])
              .filter((number) => number !== null);
            return [
              name,
              known.length ? known.reduce((a, b) => a + b, 0) : null,
            ];
          }),
        );
        const totalTokens = total(sum);
        if (Number.isSafeInteger(totalTokens) && (!crash || totalTokens > 0)) {
          const model =
            entries.length === 1 &&
            /^(?:anthropic\.)?claude-[a-z0-9][a-z0-9._:-]{0,119}$/.test(
              entries[0][0],
            )
              ? entries[0][0]
              : undefined;
          return {
            ...sum,
            totalTokens,
            complete:
              !crash &&
              values.every((value) =>
                names.every((name) => value[name] !== null),
              ),
            ...(model ? { model } : {}),
          };
        }
      }
    }
  }
  const value = counts(record.usage, snake);
  if (!value) return;
  const totalTokens = total(value);
  if (!Number.isSafeInteger(totalTokens) || (crash && totalTokens === 0))
    return;
  return { ...value, totalTokens, complete: false };
}

/** A fresh single-shot CLI process only: no resume/continue or streaming input.
 * Assistant output_tokens is a placeholder. Real per-response output arrives
 * in message_delta, whose usage counters are cumulative, not increments.
 */
export function createUsageCollector({ now = () => new Date() } = {}) {
  const messages = new Map();
  let activeMessage;
  let result;
  let crash = false;
  const validId = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 200;
  function message(id, usage, output = false) {
    if (
      !validId(id) ||
      !usage ||
      typeof usage !== "object" ||
      Array.isArray(usage)
    )
      return;
    let value = messages.get(id);
    if (!value) {
      if (messages.size >= 2048) return;
      value = Object.fromEntries(fields.map((name) => [name, null]));
    }
    const keys = [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ];
    let changed = false;
    for (let index = 0; index < fields.length; index++) {
      if (index === 1 && !output) continue;
      const number = usage[keys[index]];
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 0
      )
        continue;
      value[fields[index]] =
        value[fields[index]] === null
          ? number
          : Math.max(value[fields[index]], number);
      changed = true;
    }
    if (changed) messages.set(id, value);
  }
  function modelRecord(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "result") {
      const value = parseClaudeUsage(record);
      if (value) result = value;
      if (record.subtype === "error_during_execution") crash = true;
      return;
    }
    // The fallback deliberately covers the main loop only. Whole-tree totals
    // come from modelUsage; forwarded subagent envelopes are not additive.
    if (record.parent_tool_use_id) return;
    if (record.type === "assistant")
      message(record.message?.id, record.message?.usage);
    if (record.type !== "stream_event" || !record.event) return;
    const event = record.event;
    if (event.type === "message_start") {
      activeMessage = validId(event.message?.id) ? event.message.id : undefined;
      message(activeMessage, event.message?.usage);
    } else if (event.type === "message_delta")
      message(activeMessage, event.usage, true);
    else if (event.type === "message_stop") activeMessage = undefined;
  }
  function snapshot() {
    let value = result;
    if (!value && messages.size) {
      const sum = Object.fromEntries(
        fields.map((name) => {
          const known = [...messages.values()]
            .map((item) => item[name])
            .filter((number) => number !== null);
          return [name, known.length ? known.reduce((a, b) => a + b, 0) : null];
        }),
      );
      const totalTokens = fields.reduce(
        (total, name) => total + (sum[name] ?? 0),
        0,
      );
      if (Number.isSafeInteger(totalTokens))
        value = { ...sum, totalTokens, complete: false };
    }
    if (!value) return;
    return {
      schemaVersion: 1,
      source: "claude-code",
      ...value,
      complete: value.complete && !crash,
      reportedAt: now().toISOString(),
    };
  }
  return { modelRecord, snapshot };
}

/** Replace any model-written reserved artifact, without following its links. */
export function writeUsageArtifact(directory, value) {
  const file = join(directory, "usage.json");
  try {
    const info = lstatSync(file);
    if (info.isDirectory())
      throw new Error("Reserved usage artifact is not a file.");
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!value) return;
  const counts = Object.fromEntries(fields.map((name) => [name, value[name]]));
  if (
    !fields.every(
      (name) =>
        counts[name] === null ||
        (Number.isSafeInteger(counts[name]) && counts[name] >= 0),
    ) ||
    !fields.some((name) => counts[name] !== null)
  )
    throw new Error("Invalid usage counters.");
  const totalTokens = fields.reduce(
    (sum, name) => sum + (counts[name] ?? 0),
    0,
  );
  if (
    !Number.isSafeInteger(totalTokens) ||
    value.totalTokens !== totalTokens ||
    typeof value.complete !== "boolean" ||
    (value.complete && fields.some((name) => counts[name] === null))
  )
    throw new Error("Invalid usage total.");
  if (
    typeof value.reportedAt !== "string" ||
    value.reportedAt.length > 40 ||
    !Number.isFinite(Date.parse(value.reportedAt))
  )
    throw new Error("Invalid usage timestamp.");
  const model =
    typeof value.model === "string" &&
    /^(?:anthropic\.)?claude-[a-z0-9][a-z0-9._:-]{0,119}$/.test(value.model)
      ? value.model
      : undefined;
  const content =
    JSON.stringify({
      schemaVersion: 1,
      source: "claude-code",
      ...counts,
      totalTokens,
      complete: value.complete,
      reportedAt: new Date(value.reportedAt).toISOString(),
      ...(model ? { model } : {}),
    }) + "\n";
  if (Buffer.byteLength(content) > MAX_USAGE_BYTES)
    throw new Error("Usage artifact is too large.");
  const temporary = join(directory, `.usage-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
