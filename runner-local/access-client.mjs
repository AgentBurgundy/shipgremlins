import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

// This client intentionally has no Playwright handle, browser process or secrets.
// Its bearer token grants only the helper's fixed browser-tool contract.
const { endpoint, token } = JSON.parse(readFileSync(process.argv[2], "utf8"));
let chain = Promise.resolve(),
  screenshotNumber = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  chain = chain.then(async () => {
    let message;
    try {
      if (line.length > 65536) throw Error();
      message = JSON.parse(line);
      const response = await fetch(new URL("/mcp", endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(50000),
      });
      if (response.status === 204) return;
      const result = await response.json();
      if (!response.ok || !result.jsonrpc) throw Error();
      for (const item of result.result?.content || [])
        if (item.type === "image" && item.mimeType === "image/png") {
          const directory = "/output/screenshots";
          mkdirSync(directory, { recursive: true });
          const path = join(
            directory,
            `managed-browser-${++screenshotNumber}.png`,
          );
          writeFileSync(path, Buffer.from(item.data, "base64"));
          result.result.content.push({
            type: "text",
            text: `Screenshot saved: ${path}`,
          });
        }
      if (message.id !== undefined)
        process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
      if (message?.id !== undefined)
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message:
                "The prepared test browser is unavailable or its access has expired. End this investigation and reconnect app access.",
            },
          }) + "\n",
        );
    }
  });
});
