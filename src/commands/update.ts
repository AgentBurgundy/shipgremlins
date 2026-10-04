import { createUpdater, type Updater } from "../update/index.ts";
import { parseFlags, type Io } from "./crons.ts";

const USAGE = `Usage: gremlins update [--check | --rollback] [--json]
  update              install the latest version in an isolated runtime
  update --check      check for updates without installing
  update --rollback   return to the previous compatible runtime

Projects, mandates, credentials, and running GitHub Actions jobs stay in place.
The new runtime is used by the next CLI command or dashboard restart.`;

export async function runUpdate(
  configurationRoot: string,
  packageRoot: string,
  args: string[],
  io: Io,
  updater?: Updater,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  if (values.help === true || args.includes("-h")) {
    io.log(USAGE);
    return 0;
  }
  if (
    positionals.length ||
    Object.keys(values).some(
      (key) => !["check", "rollback", "json"].includes(key),
    ) ||
    Object.values(values).some((value) => value !== true) ||
    (values.check && values.rollback)
  ) {
    io.error(USAGE);
    return 1;
  }
  const updates = updater ?? createUpdater({ configurationRoot, packageRoot });
  if (!values.json)
    io.log(
      values.check
        ? "Checking for updates..."
        : values.rollback
          ? "Checking the previous runtime..."
          : "Preparing an update. Your gremlins' configuration stays in place.",
    );
  try {
    const result = values.check
      ? await updates.check()
      : values.rollback
        ? await updates.rollback()
        : await updates.apply();
    if (values.json) io.log(JSON.stringify(result));
    else {
      io.log(result.message);
      if (result.restartRequired)
        io.log(
          "Restart the dashboard using its Updates panel, or stop it and run gremlins setup (add --lan on your server).",
        );
    }
    return result.phase === "error" ? 1 : 0;
  } catch {
    if (values.json)
      io.log(
        JSON.stringify({
          ...updates.status(),
          phase: "error",
          message:
            "Another update is running. Wait for it to finish, then try again.",
        }),
      );
    else
      io.error(
        "Another update is running. Wait for it to finish, then try again.",
      );
    return 1;
  }
}
