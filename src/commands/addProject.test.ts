import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../config.ts";
import {
  CHECKLIST,
  addProject,
  fillTemplate,
  runAddProject,
  templateVars,
} from "./addProject.ts";

const REAL_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pm-hub-add-"));
  cpSync(
    join(REAL_ROOT, "projects", "_templates"),
    join(root, "projects", "_templates"),
    {
      recursive: true,
    },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("templateVars / fillTemplate", () => {
  it("derives NAME and Area from name and area", () => {
    expect(
      templateVars({
        name: "word-game",
        repo: "o/r",
        area: "core",
        today: "2026-10-02",
      }),
    ).toEqual({
      name: "word-game",
      NAME: "WORD_GAME",
      repo: "o/r",
      area: "core",
      Area: "Core",
      date: "2026-10-02",
    });
  });

  it("replaces every placeholder, repeated ones too", () => {
    const vars = templateVars({
      name: "game",
      repo: "o/g",
      area: "ui",
      today: "2026-10-02",
    });
    expect(
      fillTemplate(
        "{{name}} {{NAME}} {{repo}} {{area}}/{{Area}} {{date}} {{name}}",
        vars,
      ),
    ).toBe("game GAME o/g ui/Ui 2026-10-02 game");
  });
});

describe("addProject", () => {
  it("writes a project that loadProject accepts, from the templates", () => {
    const result = addProject(root, {
      name: "game",
      repo: "owner/game",
      today: "2026-10-02",
    });
    expect(result.dir).toBe(join(root, "projects", "game"));
    expect(result.files.map((f) => f.replace(/\\/g, "/"))).toEqual([
      "projects/game/project.json",
      "projects/game/areas.json",
      "projects/game/tiers.json",
      "projects/game/core/mandate.md",
      "projects/game/core/features.md",
      "projects/game/core/queue.md",
      "projects/game/core/memory.md",
    ]);
    const p = loadProject(root, "game");
    expect(p.config.repo).toBe("owner/game");
    expect(p.config.vercel.bypassSecret).toBe("VERCEL_BYPASS_GAME");
    expect(p.config.slackWebhookSecret).toBe("SLACK_WEBHOOK_GAME");
    expect(p.config.verified).toBeNull();
    expect(p.areas.map((a) => a.key)).toEqual(["core"]);
    expect(p.areas[0]!.label).toBe("pm:core");
    expect(p.areas[0]!.memoryBranch).toBe("pm/game/core");
  });

  it("fills the markdown seeds and leaves no placeholder behind", () => {
    addProject(root, {
      name: "word-game",
      repo: "owner/word-game",
      area: "play",
      today: "2026-10-02",
    });
    const dir = join(root, "projects", "word-game");
    for (const f of [
      "project.json",
      "areas.json",
      "tiers.json",
      "play/mandate.md",
      "play/features.md",
      "play/queue.md",
      "play/memory.md",
    ]) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/\{\{\w+\}\}/);
    }
    const mandate = readFileSync(join(dir, "play", "mandate.md"), "utf8");
    expect(mandate).toContain("# Play PM — mandate");
    expect(mandate).toContain("`projects/word-game/areas.json`");
    const memory = readFileSync(join(dir, "play", "memory.md"), "utf8");
    expect(memory).toContain("pm/word-game/play");
    expect(memory).toContain("2026-10-02");
  });

  it("refuses when the project already exists", () => {
    addProject(root, { name: "game", repo: "owner/game" });
    expect(() =>
      addProject(root, { name: "game", repo: "owner/game" }),
    ).toThrow(/already exists/);
  });

  it("refuses a bad name, repo or area", () => {
    expect(() =>
      addProject(root, { name: "Game", repo: "owner/game" }),
    ).toThrow(/name/);
    expect(() => addProject(root, { name: "game", repo: "game" })).toThrow(
      /owner\/name/,
    );
    expect(() =>
      addProject(root, { name: "game", repo: "owner/game", area: "Core" }),
    ).toThrow(/area/);
    expect(existsSync(join(root, "projects", "game"))).toBe(false);
  });

  it("refuses when the templates are missing", () => {
    rmSync(join(root, "projects", "_templates"), { recursive: true });
    expect(() =>
      addProject(root, { name: "game", repo: "owner/game" }),
    ).toThrow(/_templates/);
  });
});

describe("runAddProject (CLI)", () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  };
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
  });

  it("writes the project and prints the checklist", async () => {
    expect(
      await runAddProject(
        root,
        ["game", "--repo", "owner/game", "--area", "core"],
        io,
      ),
    ).toBe(0);
    expect(
      existsSync(join(root, "projects", "game", "core", "mandate.md")),
    ).toBe(true);
    const text = out.join("\n");
    expect(text).toContain(CHECKLIST);
    expect(text).toContain("SLACK_WEBHOOK_GAME");
    expect(text).toContain("VERCEL_BYPASS_GAME");
    expect(text).toContain("npm run hub -- doctor game");
  });

  it("exits 1 without --repo", async () => {
    expect(await runAddProject(root, ["game"], io)).toBe(1);
    expect(err.join("\n")).toContain("--repo");
  });

  it("exits 1 when the project exists", async () => {
    await runAddProject(root, ["game", "--repo", "owner/game"], io);
    expect(
      await runAddProject(root, ["game", "--repo", "owner/game"], io),
    ).toBe(1);
    expect(err.join("\n")).toContain("already exists");
  });
});
