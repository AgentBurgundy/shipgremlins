import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function fixture() {
  const values = new Map<string, string>();
  const window = {} as {
    createProjectConnectionReturn(options: object): {
      remember(project: object, connectionId: string, provider?: string): void;
      confirmed(provider: string, connectionId: string): void;
      pending(provider: string, connectionId: string): boolean;
      take(
        projects: object[],
        connectionId: string,
        provider?: string,
      ): { project: string; provider: string; path: string } | null;
      clear(): void;
    };
  };
  runInNewContext(readFileSync("dashboard/connection-return.js", "utf8"), {
    window,
  });
  let now = 1000000;
  const resume = window.createProjectConnectionReturn({
    now: () => now,
    storage: () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }),
  });
  const project = {
    name: "my-app",
    instanceId: "original-instance",
    repo: "owner/app",
    provider: "github",
  };
  return {
    resume,
    project,
    values,
    advance: (ms: number) => (now += ms),
    window,
  };
}

describe("hosting OAuth return", () => {
  it("does not resume a Vercel target or account changed during authorization", () => {
    const f = fixture();
    const project = {
      ...f.project,
      verification: { mode: "browser", environment: "preview" },
      environments: {
        preview: { kind: "vercel", connectionId: "work", projectId: "app-a" },
      },
    };
    f.resume.remember(project, "work");
    f.resume.confirmed("vercel", "work");
    expect(
      f.resume.take(
        [
          {
            ...project,
            environments: {
              preview: {
                kind: "vercel",
                connectionId: "other",
                projectId: "app-b",
              },
            },
          },
        ],
        "work",
      ),
    ).toBeNull();
  });

  it("keeps confirmed completion retryable until fresh project status is available", () => {
    const f = fixture();
    f.resume.remember(f.project, "default", "linear");
    expect(f.resume.pending("linear", "default")).toBe(false);
    f.resume.confirmed("linear", "default");
    expect(f.resume.pending("linear", "default")).toBe(true);
    expect(f.resume.pending("vercel", "default")).toBe(false);
    expect(f.resume.take([f.project], "default", "vercel")).toBeNull();
    expect(f.resume.take([f.project], "default", "linear")).toEqual({
      project: "my-app",
      provider: "linear",
      path: "/projects/my-app",
    });
    expect(f.resume.pending("linear", "default")).toBe(false);
  });

  it("does not continue Linear setup when another account was selected meanwhile", () => {
    const f = fixture();
    f.resume.remember(f.project, "default", "linear");
    f.resume.confirmed("linear", "default");
    expect(
      f.resume.take(
        [{ ...f.project, linear: { connectionId: "other" } }],
        "default",
        "linear",
      ),
    ).toBeNull();
  });
  it("returns once to the exact originating project after the selected account connects", () => {
    const f = fixture();
    f.resume.remember(
      { ...f.project, unrelatedSecret: "must-not-persist" },
      "work",
    );
    expect([...f.values.values()].join()).not.toContain("must-not-persist");
    expect(f.resume.take([f.project], "work")).toBeNull();
    f.resume.confirmed("vercel", "work");
    expect(f.resume.take([f.project], "work")).toEqual({
      project: "my-app",
      provider: "vercel",
      path: "/projects/my-app?tab=environment",
    });
    expect(f.resume.take([f.project], "work")).toBeNull();
  });

  it.each([
    { instanceId: "replacement-instance" },
    { repo: "owner/different-app" },
    { provider: "gitlab" },
    { serverUrl: "https://gitlab.example.test" },
  ])("does not resume a replaced project or changed source: %j", (change) => {
    const f = fixture();
    f.resume.remember(f.project, "default");
    f.resume.confirmed("vercel", "default");
    expect(f.resume.take([{ ...f.project, ...change }], "default")).toBeNull();
  });

  it("does not replay setup after deletion or a different account's OAuth", () => {
    const f = fixture();
    f.resume.remember(f.project, "work");
    f.resume.confirmed("vercel", "work");
    expect(f.resume.take([f.project], "default")).toBeNull();
    f.resume.remember(f.project, "work");
    f.resume.confirmed("vercel", "work");
    expect(f.resume.take([], "work")).toBeNull();
  });

  it("expires abandoned authorization and clears corrupt hints", () => {
    const f = fixture();
    f.resume.remember(f.project, "default");
    f.resume.confirmed("vercel", "default");
    f.advance(3600001);
    expect(f.resume.take([f.project], "default")).toBeNull();
    f.values.set("shipgremlins.project-connection-return", "not-json");
    expect(f.resume.take([f.project], "default")).toBeNull();
    expect(f.values.size).toBe(0);
  });

  it("never accepts an external or arbitrary destination from stored data", () => {
    const f = fixture();
    f.resume.remember(f.project, "default");
    f.resume.confirmed("vercel", "default");
    const value = JSON.parse(
      f.values.get("shipgremlins.project-connection-return")!,
    );
    value.project.name = "https://attacker.test";
    value.returnUrl = "https://attacker.test";
    f.values.set(
      "shipgremlins.project-connection-return",
      JSON.stringify(value),
    );
    expect(
      f.resume.take([{ ...f.project, name: value.project.name }], "default"),
    ).toBeNull();
  });

  it("keeps ordinary connections usable when browser storage cannot be read", () => {
    const f = fixture();
    const resume = f.window.createProjectConnectionReturn({
      storage: () => {
        throw new Error("Storage disabled");
      },
    });
    expect(resume.take([f.project], "default")).toBeNull();
    expect(() => resume.remember(f.project, "default")).toThrow(
      "Storage disabled",
    );
  });
});
