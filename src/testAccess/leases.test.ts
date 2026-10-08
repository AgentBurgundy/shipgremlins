import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestIdentityLeases, testIdentityKey } from "./leases.ts";
import type { ProjectConfig } from "../config.ts";
const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "gremlins-identities-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("test identity ownership", () => {
  it("is exclusive and durable until verified cleanup; the owning job can resume", () => {
    const path = root(),
      store = createTestIdentityLeases(path),
      key = "a".repeat(64);
    const lease = store.acquire(key, "job-a");
    expect(createTestIdentityLeases(path).acquire(key, "job-a")).toEqual(lease);
    expect(() => store.acquire(key, "job-b")).toThrow(
      /Waiting for the test account/,
    );
    store.release("job-b");
    expect(store.blocker(key, "job-b")).toMatch(/Waiting/);
    store.release("job-a");
    expect(store.acquire(key, "job-b").generation).not.toBe(lease.generation);
  });
  it("quarantines an interrupted reservation instead of guessing it is expired", () => {
    const path = root(),
      key = "b".repeat(64);
    mkdirSync(join(path, ".run", "test-identity-leases", key), {
      recursive: true,
    });
    expect(() => createTestIdentityLeases(path).acquire(key, "job-b")).toThrow(
      /ownership could not be verified/,
    );
  });
  it("keys the same account across password changes without storing account values", () => {
    const config = {
      repo: "owner/app",
      environments: {
        test: { kind: "url", role: "staging", url: "https://app.test/login" },
      },
      verification: { mode: "browser", environment: "test" },
    } as unknown as ProjectConfig;
    const key = testIdentityKey(config, "member@app.test");
    expect(testIdentityKey(config, "MEMBER@app.test")).toBe(key);
    const path = root();
    createTestIdentityLeases(path).acquire(key, "job-a");
    expect(
      readFileSync(
        join(path, ".run", "test-identity-leases", key, "owner.json"),
        "utf8",
      ),
    ).not.toContain("member@app.test");
  });
});
