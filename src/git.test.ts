import { describe, expect, it } from "vitest";
import { FakeGit, realGit } from "./git.ts";

describe("FakeGit", () => {
  it("records every call and answers the fallback when nothing matches", async () => {
    const git = new FakeGit();
    const r = await git.run(["fetch", "origin"], "/repo");
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(git.calls).toEqual([{ args: ["fetch", "origin"], cwd: "/repo" }]);
    expect(git.commands()).toEqual(["fetch origin"]);
  });

  it("matches scripts by substring or regex against the joined args, first wins", async () => {
    const git = new FakeGit([
      { match: /^cherry-pick -x abc/, result: { code: 1, err: "CONFLICT" } },
      { match: "log --format=%B", result: "trailer text" },
    ]);
    expect(await git.run(["cherry-pick", "-x", "abc"], "/r")).toEqual({
      code: 1,
      out: "",
      err: "CONFLICT",
    });
    expect((await git.run(["log", "--format=%B", "a..b"], "/r")).out).toBe(
      "trailer text",
    );
    expect((await git.run(["cherry-pick", "-x", "def"], "/r")).code).toBe(0);
  });

  it("accepts a map of joined args → result and consumes once-scripts", async () => {
    const git = new FakeGit({ "status --porcelain": "M a.ts" });
    git.when("diff --quiet", { code: 1 }, { once: true });
    expect((await git.run(["status", "--porcelain"], "/r")).out).toBe("M a.ts");
    expect((await git.run(["diff", "--quiet"], "/r")).code).toBe(1);
    expect((await git.run(["diff", "--quiet"], "/r")).code).toBe(0);
  });
});

describe("realGit", () => {
  it("runs git and reports a non-zero exit code without throwing", async () => {
    const ok = await realGit.run(["--version"], process.cwd());
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/git version/);
    const bad = await realGit.run(
      ["rev-parse", "--verify", "--quiet", "no-such-ref-pm-hub"],
      process.cwd(),
    );
    expect(bad.code).not.toBe(0);
  });
});
