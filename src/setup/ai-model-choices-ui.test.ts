import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  value = "";
  textContent = "";
  disabled = false;
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
}
type Catalog = {
  provider: string;
  source: string;
  models: Array<{ id: string; label: string }>;
  message?: string;
};
type Api = (path: string) => Promise<Catalog>;
const catalog = (provider = "codex", source = "provider"): Catalog => ({
  provider,
  source,
  models: [
    {
      id: provider === "codex" ? "fixture-coder" : "fixture-pm",
      label: provider === "codex" ? "Fixture coding model" : "Fixture PM model",
    },
  ],
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(api: Api = async () => catalog()) {
  const window = {} as {
    createAiModelChoices(options: { api: Api }): {
      bind(
        select: Element,
        hint: Element,
      ): {
        set(provider: string, model?: string): void;
        allowed(value: string): boolean;
        refresh(): void;
      };
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/ai-models.js", import.meta.url),
      "utf8",
    ),
    { window, document: { createElement: () => new Element() } },
  );
  const select = new Element(),
    hint = new Element(),
    choices = window.createAiModelChoices({ api }),
    control = choices.bind(select, hint);
  return { window, select, hint, choices, control };
}
describe("provider-backed AI model dropdowns", () => {
  it("shares one provider request across workspace and role selectors and never claims account entitlement", async () => {
    const api = vi.fn<Api>(async () => catalog()),
      f = fixture(api),
      second = f.choices.bind(new Element(), new Element());
    f.control.set("codex");
    second.set("codex");
    await settle();
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "/api/ai/models?provider=codex",
    );
    expect(f.select.children.map((x) => [x.value, x.textContent])).toEqual([
      ["", "Provider default"],
      ["fixture-coder", "Fixture coding model"],
    ]);
    expect(f.hint.textContent).toContain(
      "availability depends on your account",
    );
    expect(f.control.allowed("fixture-coder")).toBe(true);
    expect(f.control.allowed("invented-model")).toBe(false);
  });
  it("keeps a previously saved unavailable choice selected and disabled until explicitly changed", async () => {
    const f = fixture();
    f.control.set("codex", "old-model");
    await settle();
    expect(f.select.value).toBe("old-model");
    expect(f.select.children.at(-1)).toMatchObject({
      value: "old-model",
      disabled: true,
    });
    expect(f.select.children.at(-1)?.textContent).toContain("previously saved");
    expect(f.control.allowed("old-model")).toBe(true);
    f.select.value = "";
    await f.control.refresh();
    await settle();
    expect(f.select.value).toBe("");
    expect(f.control.allowed("")).toBe(true);
  });
  it("ignores a delayed previous provider response after the provider switches", async () => {
    let resolveCodex!: (value: Catalog) => void;
    const f = fixture((path) =>
      path.endsWith("codex")
        ? new Promise((resolve) => {
            resolveCodex = resolve;
          })
        : Promise.resolve(catalog("claude", "supported")),
    );
    f.control.set("codex", "old-model");
    await settle();
    f.control.set("claude", "");
    await settle();
    resolveCodex(catalog());
    await settle();
    expect(f.select.value).toBe("");
    expect(f.select.children.map((x) => x.value)).toEqual(["", "fixture-pm"]);
    expect(f.hint.textContent).toContain("Supported model choices");
    expect(f.hint.textContent).toContain(
      "live availability has not been verified",
    );
    expect(f.control.allowed("old-model")).toBe(false);
  });
  it("keeps default and the saved value on a catalog error without exposing diagnostics, then supports explicit retry", async () => {
    let offline = true;
    const api = vi.fn<Api>(async () => {
        if (offline) throw Error("private-token");
        return catalog();
      }),
      f = fixture(api);
    f.control.set("codex", "old-model");
    await settle();
    expect(f.select.value).toBe("old-model");
    expect(f.hint.textContent).toContain("could not load");
    expect(f.hint.textContent).not.toContain("private-token");
    f.control.set("codex", "old-model");
    await settle();
    expect(api).toHaveBeenCalledOnce();
    offline = false;
    f.control.refresh();
    await settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(f.select.children.some((x) => x.value === "fixture-coder")).toBe(
      true,
    );
    expect(f.select.value).toBe("old-model");
  });
  it("uses an honest empty supported catalog rather than fabricating choices", async () => {
    const f = fixture(async () => ({
      ...catalog(),
      source: "supported",
      models: [],
      message: "No model catalog is available on this worker.",
    }));
    f.control.set("codex");
    await settle();
    expect(f.select.children.map((x) => x.value)).toEqual([""]);
    expect(f.hint.textContent).toContain("No model catalog is available");
    expect(f.control.allowed("not-listed")).toBe(false);
  });
  it("rejects mismatched provider catalogs and invalid model IDs", async () => {
    const f = fixture(async () => ({
      ...catalog(),
      models: [
        ...catalog().models,
        { id: "private value with spaces", label: "Invalid" },
      ],
    }));
    f.control.set("codex");
    await settle();
    expect(f.select.children.map((x) => x.value)).toEqual([
      "",
      "fixture-coder",
    ]);
    const wrong = fixture(async () => catalog("claude"));
    wrong.control.set("codex");
    await settle();
    expect(wrong.select.children.map((x) => x.value)).toEqual([""]);
    expect(wrong.hint.textContent).toContain("could not load");
  });
});
