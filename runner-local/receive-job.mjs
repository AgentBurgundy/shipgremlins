import { writeFileSync, renameSync, existsSync } from "node:fs";
import { validateGrumblinPayload } from "./grumblin-runtime.mjs";
const chunks = [];
let size = 0;
try {
  if (existsSync("/work/job.ready")) throw new Error();
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(source);
  if (
    !value ||
    typeof value !== "object" ||
    !["verify", "pm", "developer"].includes(value.kind)
  )
    throw new Error();
  validateGrumblinPayload(value);
  writeFileSync("/work/job.pending", source, { mode: 0o600, flag: "wx" });
  renameSync("/work/job.pending", "/work/job.json");
  writeFileSync("/work/job.ready", "ready\n", { mode: 0o600, flag: "wx" });
  console.log('{"accepted":true}');
} catch {
  console.error("Job payload was not accepted.");
  process.exitCode = 1;
}
