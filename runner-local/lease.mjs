import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = "/run/gremlins-lease.json";
/** The lease file is written by Docker exec as root, never by the model user. */
export function startLeaseWatchdog({
  stop,
  exit = process.exit,
  read = () => JSON.parse(readFileSync(FILE, "utf8")),
  now = Date.now,
  intervalMs = 2000,
}) {
  let expired = false;
  let hardStop;
  const check = () => {
    if (expired) return;
    let valid = false;
    try {
      const lease = read();
      valid =
        Number.isSafeInteger(lease.expiresAt) &&
        lease.expiresAt > now() &&
        lease.expiresAt <= now() + 120000;
    } catch {}
    if (valid) return;
    expired = true;
    stop();
    hardStop = setTimeout(() => exit(124), 10000);
  };
  const timer = setInterval(check, intervalMs);
  check();
  return () => {
    clearInterval(timer);
    clearTimeout(hardStop);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "renew" || process.getuid?.() !== 0)
    throw new Error("Invalid lease operation.");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 100) throw new Error("Invalid lease request.");
  }
  const value = JSON.parse(input);
  if (
    !Number.isInteger(value.ttlMs) ||
    value.ttlMs < 1000 ||
    value.ttlMs > 120000
  )
    throw new Error("Invalid lease duration.");
  writeFileSync(
    `${FILE}.tmp`,
    JSON.stringify({ expiresAt: Date.now() + value.ttlMs }),
    { mode: 0o644 },
  );
  renameSync(`${FILE}.tmp`, FILE);
}
