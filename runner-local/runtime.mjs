import { lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const MAX_JOB_MS = 45 * 60_000;
const sourceKeys = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "CI_JOB_TOKEN",
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
    GITLAB_TOKEN: provider === "gitlab" ? (credentials.GITLAB_TOKEN ?? "") : "",
    // Bearer authentication accepts both OAuth and personal access tokens.
    // No refresh token reaches glab: only the controller may rotate a lease.
    GLAB_IS_OAUTH2: "true",
    GLAB_ENABLE_CI_AUTOLOGIN: "false",
    GLAB_SEND_TELEMETRY: "false",
    GIT_ASKPASS: "/opt/gremlins/git-askpass.sh",
    GREMLINS_GIT_TOKEN:
      (provider === "gitlab"
        ? credentials.GITLAB_TOKEN
        : credentials.GITHUB_TOKEN) ?? "",
    GREMLINS_GIT_USERNAME: provider === "gitlab" ? "oauth2" : "x-access-token",
  };
  return { execution, publication };
}

/** Discard CLI settings the model or repository may have written. */
export function preparePublication(directory, repoUrl, publication) {
  restoreGitConfig(directory, repoUrl);
  const origin = new URL(repoUrl);
  const cleanHome = mkdtempSync(join(tmpdir(), "gremlins-publish-"));
  Object.assign(publication, {
    HOME: cleanHome,
    XDG_CONFIG_HOME: cleanHome,
    GH_CONFIG_DIR: cleanHome,
    GLAB_CONFIG_DIR: cleanHome,
    GH_HOST: origin.hostname,
    GITLAB_HOST: origin.host,
    GITLAB_API_HOST: origin.host,
    GLAB_API_PROTOCOL: "https",
    GLAB_DEBUG_HTTP: "false",
    GITLAB_CI: "false",
  });
  return cleanHome;
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

export function enforceDeadline(stop, exit = process.exit, minutes = 45) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 45)
    throw new Error("Invalid job runtime limit.");
  let forced;
  const timer = setTimeout(() => {
    stop();
    forced = setTimeout(() => exit(124), 10_000);
    forced.unref();
  }, minutes * 60_000);
  timer.unref();
  return () => {
    clearTimeout(timer);
    clearTimeout(forced);
  };
}
