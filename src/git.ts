// The one seam between the dispatcher and a real git checkout. Promotion
// drives git through this interface so its rules are tested with FakeGit
// (scripted answers, recorded calls) and run with realGit in the workflow.

import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

export interface Git {
  run(args: string[], cwd: string): Promise<GitResult>;
}

export const realGit: Git = {
  run(args, cwd) {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, out: stdout, err: stderr });
          const code = typeof error.code === "number" ? error.code : 127;
          resolve({ code, out: stdout, err: stderr || error.message });
        },
      );
    });
  },
};

export interface GitScript {
  /** a string matches when the joined args CONTAIN it; a RegExp is tested against the joined args */
  match: RegExp | string;
  /** a bare string is stdout with code 0 */
  result: Partial<GitResult> | string;
  /** consumed after its first hit */
  once?: boolean;
}

const FALLBACK: GitResult = { code: 0, out: "", err: "" };

export class FakeGit implements Git {
  readonly calls: { args: string[]; cwd: string }[] = [];
  private scripts: GitScript[];

  constructor(
    scripts: GitScript[] | Record<string, Partial<GitResult> | string> = [],
    private readonly fallback: GitResult = FALLBACK,
  ) {
    this.scripts = Array.isArray(scripts)
      ? [...scripts]
      : Object.entries(scripts).map(([match, result]) => ({ match, result }));
  }

  when(
    match: RegExp | string,
    result: Partial<GitResult> | string,
    opts: { once?: boolean } = {},
  ): this {
    this.scripts.push({ match, result, once: opts.once });
    return this;
  }

  /** every call as its joined args, in order */
  commands(): string[] {
    return this.calls.map((c) => c.args.join(" "));
  }

  async run(args: string[], cwd: string): Promise<GitResult> {
    this.calls.push({ args: [...args], cwd });
    const line = args.join(" ");
    const i = this.scripts.findIndex((s) =>
      typeof s.match === "string" ? line.includes(s.match) : s.match.test(line),
    );
    if (i < 0) return { ...this.fallback };
    const script = this.scripts[i]!;
    if (script.once) this.scripts.splice(i, 1);
    return typeof script.result === "string"
      ? { ...FALLBACK, out: script.result }
      : { ...FALLBACK, ...script.result };
  }
}
