import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { csvFixture, pngFixture, runFixture } from "./fixture.ts";

let root: string;
let output: string[];
let errors: string[];
const io = {
  log: (value: string) => output.push(value),
  error: (value: string) => errors.push(value),
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-fixture-"));
  output = [];
  errors = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("CSV upload fixtures", () => {
  it("preserves Unicode, CRLF/newlines, commas, quotes, null, numbers and booleans", () => {
    const result = csvFixture([
      { name: "李", note: 'Say "hello", then\nbye', count: 3, active: true },
      { name: "Ana", note: "first\r\nsecond", count: null, active: false },
    ]).toString("utf8");
    expect(result).toBe(
      'name,note,count,active\r\n李,"Say ""hello"", then\nbye",3,true\r\nAna,"first\r\nsecond",,false\r\n',
    );
  });

  it("unions object headers, preserves empty fields and formula-like strings, and optionally emits a BOM", () => {
    const result = csvFixture([{ first: "=SUM(A1:A2)" }, { second: "" }], true);
    expect(result.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(result.subarray(3).toString()).toBe(
      "first,second\r\n=SUM(A1:A2),\r\n,\r\n",
    );
  });

  it("accepts arrays without inventing a header", () => {
    expect(
      csvFixture([
        ["a", "b"],
        ["value", null],
      ]).toString(),
    ).toBe("a,b\r\nvalue,\r\n");
  });

  it.each([
    { input: [] },
    { input: [[1], [1, 2]] },
    { input: [1] },
    { input: [{ nested: {} }] },
    { input: [new Array(257).fill("x")] },
    { input: new Array(10_001).fill(["x"]) },
  ])("rejects structurally unsupported input $input", ({ input }) => {
    expect(() => csvFixture(input)).toThrow();
  });
});

describe("PNG upload fixtures", () => {
  it("produces a decodable RGB image with correct chunk CRCs and dimensions", () => {
    const png = pngFixture(35, 37, 7);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    let offset = 8;
    const types: string[] = [];
    const data: Buffer[] = [];
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      const body = png.subarray(offset + 8, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      expect(png.readUInt32BE(offset + 8 + length)).toBe(
        (crc ^ 0xffffffff) >>> 0,
      );
      types.push(type);
      if (type === "IHDR") {
        expect(body.readUInt32BE(0)).toBe(35);
        expect(body.readUInt32BE(4)).toBe(37);
        expect([...body.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
      }
      if (type === "IDAT") data.push(body);
      offset += length + 12;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(offset).toBe(png.length);
    const pixels = inflateSync(Buffer.concat(data));
    expect(pixels.length).toBe((35 * 3 + 1) * 37);
    for (let row = 0; row < 37; row++)
      expect(pixels[row * (35 * 3 + 1)]).toBe(0);
  });

  it("is reproducible and changing the seed changes actual pixels", () => {
    expect(pngFixture(20, 30, 123)).toEqual(pngFixture(20, 30, 123));
    expect(pngFixture(20, 30, 123)).not.toEqual(pngFixture(20, 30, 124));
  });

  it.each([
    { width: 0, height: 1, seed: 1 },
    { width: 1, height: 2049, seed: 1 },
    { width: 2.5, height: 1, seed: 1 },
    { width: 1, height: 1, seed: -1 },
    { width: 1, height: 1, seed: 4294967296 },
  ])(
    "bounds dimensions and seeds: $width/$height/$seed",
    ({ width, height, seed }) => {
      expect(() => pngFixture(width, height, seed)).toThrow();
    },
  );
});

describe("fixture command", () => {
  it("writes an explicit absolute CSV and emits only its manifest", async () => {
    writeFileSync(
      join(root, "rows.json"),
      JSON.stringify([{ value: "private-synthetic-value" }]),
    );
    const path = join(root, "files", "sample.csv");
    expect(
      await runFixture(
        root,
        ["csv", "--input", "rows.json", "--output", path, "--bom"],
        io,
      ),
    ).toBe(0);
    const bytes = readFileSync(path);
    expect(JSON.parse(output[0]!)).toEqual({
      path,
      mediaType: "text/csv; charset=utf-8",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(output.join("\n")).not.toContain("private-synthetic-value");
  });

  it("refuses to overwrite existing outputs", async () => {
    const args = [
      "png",
      "--output",
      "test.png",
      "--width",
      "2",
      "--height",
      "3",
    ];
    expect(await runFixture(root, args, io)).toBe(0);
    const before = readFileSync(join(root, "test.png"));
    expect(await runFixture(root, [...args, "--seed", "10"], io)).toBe(1);
    expect(readFileSync(join(root, "test.png"))).toEqual(before);
  });

  it.each([
    { args: ["png"] },
    { args: ["png", "--output", "bad.png", "--width", "90000"] },
    { args: ["csv", "--output", "bad.csv"] },
    { args: ["png", "--output", "bad.png", "--seed", "Infinity"] },
  ])("rejects invalid CLI usage $args", async ({ args }) => {
    expect(await runFixture(root, args, io)).toBe(1);
    expect(existsSync(join(root, "bad.png"))).toBe(false);
    expect(existsSync(join(root, "bad.csv"))).toBe(false);
  });

  it("rejects oversized or malformed JSON without echoing input data", async () => {
    writeFileSync(join(root, "bad.json"), '{"private-value":');
    expect(
      await runFixture(
        root,
        ["csv", "--input", "bad.json", "--output", "bad.csv"],
        io,
      ),
    ).toBe(1);
    expect(errors.join("\n")).not.toContain("private-value");
    writeFileSync(join(root, "large.json"), " ".repeat(4 * 1024 * 1024 + 1));
    expect(
      await runFixture(
        root,
        ["csv", "--input", "large.json", "--output", "large.csv"],
        io,
      ),
    ).toBe(1);
    expect(existsSync(join(root, "large.csv"))).toBe(false);
  });
});
