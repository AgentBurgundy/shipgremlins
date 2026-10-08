import { describe, expect, it } from "vitest";
import {
  createAccessRedaction,
  RedactionBudgetError,
} from "../../runner-local/access-redaction.mjs";

describe("private browser storage redaction", () => {
  it("accepts a five-MiB cache and preserves separately displayed nested/encoded tokens", () => {
    const token = "private-nested-token-123456789",
      refresh = "private-refresh-token-987654321";
    const redaction = createAccessRedaction();
    const value = JSON.stringify({
      padding: "x".repeat(5 * 1024 * 1024),
      session: { token },
      encoded: JSON.stringify({ refresh }),
    });
    redaction.collect(value);
    for (let index = 0; index < 10; index++) redaction.collect(value);
    expect(redaction.redact(`Account ${token}; ${refresh}`)).toBe(
      "Account [private]; [private]",
    );
    expect(redaction.redact(value)).toBe("[private]");
    expect(redaction.screenshotPlan().maskAll).toBe(false);
    expect(redaction.screenshotPlan().values).toContain(token);
  });
  it("allows ordinary caches with more than 512 unique values", () => {
    const redaction = createAccessRedaction();
    const values = Array.from(
      { length: 1024 },
      (_, index) => `private-cache-value-${index}`,
    );
    redaction.collect(JSON.stringify(values));
    expect(redaction.redact(values[1000])).toBe("[private]");
  });
  it("does not consume extra capacity when the same values are refreshed at the limit", () => {
    const redaction = createAccessRedaction([], { maxValues: 2, maxBytes: 16 });
    redaction.collect("aaaa");
    redaction.collect("bbbb");
    for (let index = 0; index < 20; index++) {
      redaction.collect("aaaa");
      redaction.collect("bbbb");
    }
    expect(redaction.redact("aaaa bbbb")).toBe("[private] [private]");
  });
  it.each([
    { maxBytes: 20 },
    { maxValues: 2 },
    { maxNodes: 3 },
    { maxDepth: 1 },
  ])(
    "latches capacity failures and never reuses a partially collected JSON value: %j",
    (limit) => {
      const redaction = createAccessRedaction([], limit);
      const value = JSON.stringify({
        session: { token: "private-token-must-not-leak" },
        other: "other-value",
      });
      expect(() => redaction.collect(value)).toThrow(RedactionBudgetError);
      expect(() => redaction.collect(value)).toThrow(RedactionBudgetError);
      expect(() => redaction.redact("private-token-must-not-leak")).toThrow(
        RedactionBudgetError,
      );
      expect(() => redaction.screenshotPlan()).toThrow(RedactionBudgetError);
    },
  );
  it("keeps long opaque values protected without creating huge screenshot selectors", () => {
    const value = "private-long-opaque-value-".repeat(5000);
    const redaction = createAccessRedaction([value]);
    expect(redaction.redact(value)).toBe("[private]");
    expect(redaction.screenshotPlan()).toEqual({
      maskAll: false,
      values: [value.slice(0, 128)],
    });
  });
  it("caps screenshot masks and handles lone UTF-16 surrogates without losing redaction", () => {
    const values = Array.from(
      { length: 257 },
      (_, index) => `secret-label-${index}-value`,
    );
    const redaction = createAccessRedaction(values);
    expect(redaction.screenshotPlan()).toEqual({
      maskAll: true,
      values: [],
    });
    redaction.collect("private-\ud800-value");
    expect(redaction.redact("private-\ud800-value")).toBe("[private]");
  });
  it("does not split a surrogate pair when making a bounded screenshot prefix", () => {
    const value = "x".repeat(127) + "\ud83d\ude00" + "y".repeat(3000);
    const redaction = createAccessRedaction([value]);
    expect(redaction.screenshotPlan()).toEqual({
      maskAll: false,
      values: ["x".repeat(127)],
    });
  });
});
