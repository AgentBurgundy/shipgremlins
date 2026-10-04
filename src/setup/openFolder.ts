import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface FolderOpenOptions {
  lan?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  launch?: typeof spawn;
  launchTimeoutMs?: number;
}

/** A browser on another computer cannot open the server's local file manager. */
export function canOpenFolders(
  lan: boolean,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (lan) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return (
    platform === "linux" &&
    Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim())
  );
}

const OPEN_FAILED =
  "The folder could not be opened. Use the directory path shown in the dashboard to open it manually.";

/** Open only one of the two server-owned directories, never a submitted path. */
export async function openDashboardFolder(
  root: string,
  packageRoot: string,
  target: unknown,
  options: FolderOpenOptions = {},
): Promise<void> {
  if (target !== "configuration" && target !== "installation")
    throw new Error("Choose configuration or installation to open a folder.");
  const platform = options.platform ?? process.platform;
  if (
    !canOpenFolders(options.lan ?? false, platform, options.env ?? process.env)
  )
    throw new Error(
      "Folder opening requires a local dashboard on a desktop. Use the directory path to access files on the server.",
    );

  let directory: string;
  try {
    const selected = target === "configuration" ? root : packageRoot;
    if (
      !selected ||
      [...selected].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error();
    // Resolve installation symlinks used by npm/nvm without accepting arbitrary input.
    directory = await realpath(resolve(selected));
    if (!(await stat(directory)).isDirectory()) throw new Error();
  } catch {
    throw new Error(
      "The selected directory is not available yet. Complete installation or setup, then try again.",
    );
  }

  const command =
    platform === "win32"
      ? "explorer.exe"
      : platform === "darwin"
        ? "open"
        : "xdg-open";
  const launch = options.launch ?? spawn;
  const timeout = Math.max(1, Math.min(options.launchTimeoutMs ?? 1500, 5000));
  await new Promise<void>((done, reject) => {
    let settled = false;
    let spawned = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (success) done();
      else reject(new Error(OPEN_FAILED));
    };
    // Explorer may remain alive after opening a window. Do not wait for its exit.
    const timer = setTimeout(() => finish(spawned), timeout);
    try {
      const child = launch(command, [directory], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      child.unref();
    } catch {
      finish(false);
    }
  });
}
