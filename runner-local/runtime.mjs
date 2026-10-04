import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MAX_JOB_MS = 45 * 60_000;
const sourceKeys = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GLAB_TOKEN",
  "GREMLINS_GIT_TOKEN",
]);

export function jobEnvironments(
  credentials,
  provider,
  inherited = process.env,
) {
  const execution = { ...inherited, ...credentials };
  for (const key of sourceKeys) delete execution[key];
  execution.GIT_TERMINAL_PROMPT = "0";
  execution.GIT_CONFIG_GLOBAL = "/dev/null";
  execution.GIT_CONFIG_SYSTEM = "/dev/null";
  execution.GIT_CONFIG_NOSYSTEM = "1";
  execution.GIT_ASKPASS = "/bin/false";
  const publicationBase = { ...execution };
  for (const key of Object.keys(credentials)) delete publicationBase[key];
  const publication = {
    ...publicationBase,
    GH_TOKEN: provider === "github" ? (credentials.GITHUB_TOKEN ?? "") : "",
    GLAB_TOKEN: provider === "gitlab" ? (credentials.GITLAB_TOKEN ?? "") : "",
    GIT_ASKPASS: "/opt/gremlins/git-askpass.sh",
    GREMLINS_GIT_TOKEN:
      (provider === "gitlab"
        ? credentials.GITLAB_TOKEN
        : credentials.GITHUB_TOKEN) ?? "",
    GREMLINS_GIT_USERNAME: provider === "gitlab" ? "oauth2" : "x-access-token",
  };
  return { execution, publication };
}

export function restoreGitConfig(directory, repoUrl) {
  const git = join(directory, ".git");
  const config = join(git, "config");
  if (
    !lstatSync(git).isDirectory() ||
    realpathSync(git) !== resolve(git) ||
    !lstatSync(config).isFile() ||
    lstatSync(config).isSymbolicLink()
  )
    throw new Error(
      "The repository metadata changed. No changes were published.",
    );
  writeFileSync(
    config,
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\thooksPath = /dev/null\n[remote "origin"]\n\turl = ${JSON.stringify(repoUrl)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    { mode: 0o600 },
  );
}

export function enforceDeadline(stop, exit = process.exit) {
  let forced;
  const timer = setTimeout(() => {
    stop();
    forced = setTimeout(() => exit(124), 10_000);
    forced.unref();
  }, MAX_JOB_MS);
  timer.unref();
  return () => {
    clearTimeout(timer);
    clearTimeout(forced);
  };
}
