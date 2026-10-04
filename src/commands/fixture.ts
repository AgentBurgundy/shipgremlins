import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { assertNoSymlinks } from "../setup/files.ts";
import { parseFlags, type Io } from "./crons.ts";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const MAX_DIMENSION = 2048;
const USAGE = `usage: gremlins fixture csv --input rows.json --output data.csv [--bom]
       gremlins fixture png --output test.png [--width 640] [--height 480] [--seed 1]

Creates reproducible upload fixtures. Never overwrites files or prints their data.
CSV accepts arrays of scalar arrays or objects. PNG is a deterministic test grid.
Paths resolve against the configuration directory selected by --home, SHIPGREMLINS_HOME,
the nearest hub.json, or ~/.shipgremlins.`;

function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error(
      "CSV values must be strings, finite numbers, booleans, or null; nested data is not supported",
    );
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Values, including formula-like strings, are preserved for upload-test fidelity. */
export function csvFixture(input: unknown, bom = false): Buffer {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROWS)
    throw new Error(`CSV input must contain 1–${MAX_ROWS} rows`);
  let rows: unknown[][];
  if (Array.isArray(input[0])) {
    const columns = input[0].length;
    if (
      columns === 0 ||
      columns > MAX_COLUMNS ||
      !input.every((row) => Array.isArray(row) && row.length === columns)
    )
      throw new Error(
        `CSV array rows must have the same 1–${MAX_COLUMNS} columns`,
      );
    rows = input as unknown[][];
  } else {
    if (
      !input.every(
        (row) => row !== null && typeof row === "object" && !Array.isArray(row),
      )
    )
      throw new Error("CSV rows must be all objects or all arrays");
    const records = input as Record<string, unknown>[];
    const headers = [...new Set(records.flatMap((row) => Object.keys(row)))];
    if (!headers.length || headers.length > MAX_COLUMNS)
      throw new Error(
        `CSV objects must contain 1–${MAX_COLUMNS} distinct columns`,
      );
    rows = [
      headers,
      ...records.map((row) =>
        headers.map((key) => (Object.hasOwn(row, key) ? row[key] : null)),
      ),
    ];
  }
  const lines: string[] = [];
  let size = bom ? 3 : 0;
  for (const row of rows) {
    const line = row.map(field).join(",") + "\r\n";
    size += Buffer.byteLength(line);
    if (size > MAX_OUTPUT_BYTES)
      throw new Error("CSV output exceeds the 16 MiB fixture limit");
    lines.push(line);
  }
  return Buffer.from((bom ? "\uFEFF" : "") + lines.join(""), "utf8");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

/** A real RGB PNG with deterministic color squares, not an AI-generated illustration. */
export function pngFixture(width = 640, height = 480, seed = 1): Buffer {
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION,
    )
  )
    throw new Error(
      `PNG dimensions must be integers between 1 and ${MAX_DIMENSION}`,
    );
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("PNG seed must be an integer between 0 and 4294967295");
  let state = seed >>> 0;
  const colors = Array.from({ length: 4 }, () =>
    Array.from({ length: 3 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return 32 + ((state >>> 24) % 192);
    }),
  );
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color =
        colors[(Math.floor(x / 32) + Math.floor(y / 32)) % colors.length]!;
      const offset = y * stride + 1 + x * 3;
      pixels[offset] = color[0]!;
      pixels[offset + 1] = color[1]!;
      pixels[offset + 2] = color[2]!;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function runFixture(
  root: string,
  args: string[],
  io: Io,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  if (values.help === true || args.includes("-h")) {
    io.log(USAGE);
    return 0;
  }
  try {
    const kind = positionals[0];
    if (positionals.length !== 1 || !["csv", "png"].includes(kind ?? ""))
      throw new Error(USAGE);
    const allowed = new Set(
      kind === "csv"
        ? ["input", "output", "bom"]
        : ["output", "width", "height", "seed"],
    );
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw new Error("Unknown fixture option");
    if (
      typeof values.output !== "string" ||
      !values.output.trim() ||
      values.output.includes("\0")
    )
      throw new Error("--output PATH is required");
    const output = resolve(root, values.output);
    assertNoSymlinks(output);
    let bytes: Buffer;
    if (kind === "csv") {
      if (typeof values.input !== "string" || !values.input.trim())
        throw new Error("CSV requires --input JSON-file");
      if (values.bom !== undefined && values.bom !== true)
        throw new Error("--bom is a boolean flag");
      const input = resolve(root, values.input);
      let data: unknown;
      try {
        const stats = statSync(input);
        if (!stats.isFile() || stats.size > MAX_INPUT_BYTES)
          throw new Error("size");
        data = JSON.parse(readFileSync(input, "utf8"));
      } catch {
        throw new Error(
          "CSV input must be a readable JSON file no larger than 4 MiB",
        );
      }
      bytes = csvFixture(data, values.bom === true);
    } else {
      const number = (key: string, fallback: number): number => {
        const value = values[key];
        if (value === undefined) return fallback;
        if (typeof value !== "string" || !/^\d+$/.test(value))
          throw new Error(`--${key} must be a nonnegative integer`);
        return Number(value);
      };
      bytes = pngFixture(
        number("width", 640),
        number("height", 480),
        number("seed", 1),
      );
    }
    try {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    } catch {
      throw new Error(
        "Cannot create output. Choose a writable path that does not already exist; existing files are never overwritten",
      );
    }
    io.log(
      JSON.stringify(
        {
          path: output,
          mediaType: kind === "csv" ? "text/csv; charset=utf-8" : "image/png",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    io.error(
      error instanceof Error ? error.message : "Fixture generation failed",
    );
    return 1;
  }
}
