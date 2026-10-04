import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Configuration never defaults to the global package's installation directory. */
export function configurationRoot(
  cwd: string,
  explicit?: string,
  home = homedir(),
): string {
  if (explicit) return resolve(cwd, explicit);
  let directory = resolve(cwd);
  for (;;) {
    if (existsSync(join(directory, "hub.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return join(home, ".shipgremlins");
    directory = parent;
  }
}

/** Accept only GitHub repository URLs, without credentials or query strings. */
export function githubRepository(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  if (!match || match.slice(1).some((part) => part === "." || part === ".."))
    return undefined;
  return `${match[1]}/${match[2]}`;
}

export function detectHubRepository(directory: string): string | undefined {
  try {
    while (!existsSync(directory) && dirname(directory) !== directory)
      directory = dirname(directory);
    return githubRepository(
      execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
}
