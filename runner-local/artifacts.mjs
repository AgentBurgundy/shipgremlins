import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
const MAX_FILE = 10 * 1024 * 1024;
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const safeName = (name) =>
  typeof name === "string" &&
  name.length <= 240 &&
  name !== "pm-review-request.json" &&
  !name.split("/").some((part) => part.startsWith(".")) &&
  (process.env.GREMLINS_TRUSTED_REVIEW === "1" ||
    (name !== "pm-review-proof.json" &&
      !name.startsWith("review-screenshots/"))) &&
  !name.includes("\\") &&
  !name.split("/").some((p) => !p || p === "." || p === "..") &&
  /^[A-Za-z0-9_./ -]+$/.test(name);
async function bytes(name) {
  if (!safeName(name)) throw new Error();
  const file = join("/output", name);
  const info = await lstat(file);
  const real = await realpath(file);
  const rel = relative("/output", real);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size > MAX_FILE ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith("../")
  )
    throw new Error();
  return readFile(file);
}
try {
  const sanitized = await lstat("/output/.sanitized");
  if (!sanitized.isFile() || sanitized.isSymbolicLink()) throw new Error();
  if (process.argv[2] === "read") {
    const data = await bytes(process.argv[3]);
    process.stdout.write(data.toString("base64"));
  } else {
    const files = [];
    async function walk(dir = "", depth = 0) {
      if (depth > 3 || files.length >= 100) return;
      for (const entry of await readdir(join("/output", dir), {
        withFileTypes: true,
      })) {
        const name = dir ? dir + "/" + entry.name : entry.name;
        if (!safeName(name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(name, depth + 1);
        else if (entry.isFile())
          try {
            const data = await bytes(name);
            files.push({
              name,
              size: data.length,
              sha256: createHash("sha256").update(data).digest("hex"),
              ...(name.endsWith(".png")
                ? { png: data.subarray(0, 8).equals(pngMagic) }
                : {}),
            });
          } catch {}
        if (files.length >= 100) break;
      }
    }
    await walk();
    let result = null;
    try {
      const source = await bytes("result.json");
      if (source.length <= 32768) result = JSON.parse(source.toString("utf8"));
    } catch {}
    console.log(JSON.stringify({ result, files }));
  }
} catch {
  console.error("Artifact is unavailable.");
  process.exitCode = 1;
}
