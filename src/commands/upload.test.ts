import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeFor, runUpload, uploadToLinear } from "./upload.ts";

const SLOT = {
  uploadUrl: "https://uploads.linear.app/put/abc",
  assetUrl: "https://uploads.linear.app/asset/abc.png",
  headers: [{ key: "x-amz-acl", value: "public-read" }],
};

function fetchSequence(
  overrides: Partial<{
    slot: Response;
    put: Response;
    verify: Response;
  }> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/graphql"))
        return (
          overrides.slot ??
          new Response(
            JSON.stringify({
              data: { fileUpload: { success: true, uploadFile: SLOT } },
            }),
            { status: 200 },
          )
        );
      if (url === SLOT.uploadUrl)
        return overrides.put ?? new Response(null, { status: 200 });
      if (url === SLOT.assetUrl)
        return (
          overrides.verify ??
          new Response("png", {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        );
      return new Response("nope", { status: 404 });
    },
  );
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("contentTypeFor", () => {
  it("maps image extensions and refuses others", () => {
    expect(contentTypeFor("shot.PNG")).toBe("image/png");
    expect(contentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(() => contentTypeFor("notes.txt")).toThrow(/unsupported/);
  });
});

describe("uploadToLinear", () => {
  it("PUTs with content-type, cache-control AND every header Linear returned, then verifies", async () => {
    const { impl, calls } = fetchSequence();
    const url = await uploadToLinear({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "shot.png",
      apiKey: "lin_x",
      fetchImpl: impl,
    });
    expect(url).toBe(SLOT.assetUrl);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.linear.app/graphql",
      SLOT.uploadUrl,
      SLOT.assetUrl,
    ]);
    const put = calls[1]!.init;
    expect(put.method).toBe("PUT");
    expect(put.headers).toMatchObject({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000",
      "x-amz-acl": "public-read",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.variables).toEqual({
      contentType: "image/png",
      filename: "shot.png",
      size: 3,
    });
  });

  it("fails loudly when the asset does not resolve after the PUT", async () => {
    const { impl } = fetchSequence({
      verify: new Response("", { status: 404 }),
    });
    await expect(
      uploadToLinear({
        bytes: new Uint8Array([1]),
        filename: "s.png",
        apiKey: "k",
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/does not resolve/);
  });

  it("fails when Linear refuses the slot", async () => {
    const { impl } = fetchSequence({
      slot: new Response(
        JSON.stringify({ data: { fileUpload: { success: false } } }),
        { status: 200 },
      ),
    });
    await expect(
      uploadToLinear({
        bytes: new Uint8Array([1]),
        filename: "s.png",
        apiKey: "k",
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/refused/);
  });
});

describe("runUpload", () => {
  it("prints Linear markdown with the alt text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-upload-"));
    const file = join(dir, "landing-390.png");
    writeFileSync(file, new Uint8Array([9, 9]));
    const out: string[] = [];
    const { impl } = fetchSequence();
    const code = await runUpload(
      [file, "--alt", "Landing at 390px"],
      { LINEAR_API_KEY: "k" },
      { log: (l) => out.push(l), error: () => {} },
      impl,
    );
    expect(code).toBe(0);
    expect(out).toEqual([`![Landing at 390px](${SLOT.assetUrl})`]);
  });

  it("refuses without a key, naming it", async () => {
    const errors: string[] = [];
    const code = await runUpload(
      ["x.png"],
      {},
      { log: () => {}, error: (l) => errors.push(l) },
    );
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/LINEAR_API_KEY/);
  });
});
