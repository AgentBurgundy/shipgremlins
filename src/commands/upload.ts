// `hub upload <file> [--alt "text"]` — deterministic screenshot upload to
// Linear's file storage. Prints `![alt](assetUrl)`, Linear markdown safe to
// paste into a ticket or comment. Ported from crew-os's scripts/pm-upload.mjs,
// which exists because a PM once improvised the upload with curl, dropped the
// extra headers Linear's signed URL requires, and shipped a dead link into
// every ticket: this ALWAYS sends every header Linear returns and GETs the
// asset back before printing anything, so a bad upload fails loudly here.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Io } from "./crons.ts";
import { parseFlags } from "./crons.ts";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Content type from the extension; throws on anything Linear's typed slot won't take. */
export function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const ct = IMAGE_CONTENT_TYPES[ext];
  if (!ct)
    throw new Error(
      `unsupported file extension ".${ext}" — expected one of ${Object.keys(IMAGE_CONTENT_TYPES).join(", ")}`,
    );
  return ct;
}

const FILE_UPLOAD_MUTATION = `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

interface UploadSlot {
  uploadUrl: string;
  assetUrl: string;
  headers?: { key: string; value: string }[];
}

/** Request a slot, PUT the bytes with every returned header, verify the asset resolves. */
export async function uploadToLinear(opts: {
  bytes: Uint8Array;
  filename: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const contentType = contentTypeFor(opts.filename);
  const res = await doFetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: opts.apiKey },
    body: JSON.stringify({
      query: FILE_UPLOAD_MUTATION,
      variables: {
        contentType,
        filename: opts.filename,
        size: opts.bytes.byteLength,
      },
    }),
  });
  if (!res.ok)
    throw new Error(
      `Linear API ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = (await res.json()) as {
    data?: { fileUpload?: { success: boolean; uploadFile?: UploadSlot } };
  };
  const slot = json.data?.fileUpload?.uploadFile;
  if (!json.data?.fileUpload?.success || !slot)
    throw new Error("Linear fileUpload refused the upload slot");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000",
  };
  for (const h of slot.headers ?? []) headers[h.key] = h.value;
  const put = await doFetch(slot.uploadUrl, {
    method: "PUT",
    headers,
    body: opts.bytes,
  });
  if (!put.ok) throw new Error(`Linear upload PUT failed: ${put.status}`);

  const verify = await doFetch(slot.assetUrl, {
    headers: { authorization: opts.apiKey },
  });
  const verifyType = verify.headers.get("content-type") ?? "";
  if (!verify.ok || !verifyType.startsWith("image/"))
    throw new Error(
      `upload PUT succeeded but the asset does not resolve (GET ${slot.assetUrl} → ${verify.status}, content-type "${verifyType}")`,
    );
  return slot.assetUrl;
}

export async function runUpload(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const { positionals, values } = parseFlags(args);
  const file = positionals[0];
  if (!file) {
    io.error('usage: upload <file> [--alt "text"]');
    return 1;
  }
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    io.error("LINEAR_API_KEY is not set");
    return 1;
  }
  const alt = typeof values.alt === "string" ? values.alt : basename(file);
  try {
    const bytes = new Uint8Array(readFileSync(file));
    const url = await uploadToLinear({
      bytes,
      filename: basename(file),
      apiKey,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    io.log(`![${alt.replace(/[[\]]/g, "")}](${url})`);
    return 0;
  } catch (err) {
    io.error(`upload failed: ${(err as Error).message}`);
    return 1;
  }
}
