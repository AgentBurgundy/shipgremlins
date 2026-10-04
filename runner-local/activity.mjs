export const ACTIVITY_PREFIX = "GREMLINS_ACTIVITY ";
const privateKey =
  /thinking|reasoning|signature|password|token|authorization|secret|api.?key/i;
function visible(value, depth = 0) {
  if (depth > 4) return "[nested value]";
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value))
    return value.slice(0, 10).map((item) => visible(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateKey.test(key))
        .slice(0, 20)
        .map(([key, item]) => [key, visible(item, depth + 1)]),
    );
  return value;
}

/** Publish model-visible actions and final answers, never private thinking blocks. */
export function createActivityWriter({
  write,
  redact = (value) => value,
  now = () => new Date(),
}) {
  let sequence = 0,
    writtenBytes = 0,
    summary;
  function emit(type, title, detail, status) {
    const essential = ["summary", "check", "result"].includes(type);
    if ((sequence >= 1950 || writtenBytes > 4 * 1024 * 1024) && !essential)
      return;
    if (sequence >= 2000 || writtenBytes > 5 * 1024 * 1024) return;
    const event = {
      id: `event-${String(++sequence).padStart(6, "0")}`,
      type,
      timestamp: now().toISOString(),
      title: redact(String(title)).slice(0, 200),
      ...(detail ? { detail: redact(String(detail)).slice(0, 4000) } : {}),
      ...(status ? { status } : {}),
    };
    const line = ACTIVITY_PREFIX + JSON.stringify(event);
    writtenBytes += Buffer.byteLength(line) + 1;
    write(line);
    return event;
  }
  function modelRecord(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "assistant")
      for (const block of record.message?.content ?? []) {
        if (block.type === "tool_use")
          emit(
            "tool",
            String(block.name ?? "Tool"),
            JSON.stringify(visible(block.input ?? {})),
            "running",
          );
        else if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim()
        )
          emit("progress", "Agent update", block.text);
      }
    if (record.type === "user")
      for (const block of record.message?.content ?? [])
        if (block.type === "tool_result")
          emit(
            "tool",
            "Tool result",
            block.is_error
              ? "The tool reported an error."
              : "The tool completed.",
            block.is_error ? "failed" : "succeeded",
          );
    if (record.type === "result" && typeof record.result === "string") {
      summary = redact(record.result).slice(0, 4000);
      emit(
        "summary",
        "Agent summary",
        summary,
        record.is_error ? "failed" : "succeeded",
      );
    }
  }
  return { emit, modelRecord, summary: () => summary };
}
