import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  value = "";
  href = "";
  rel = "";
  target = "";
  dataset: Record<string, string> = {};
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener() {}
}
function fixture() {
  const window = {} as {
    renderKnowledgeDocument: (value: string) => Element;
    createPmCharter: (
      root: Element,
      prefix: string,
      initial: object,
    ) => { read(): object; reset(): void };
  };
  const document = {
    createElement: (name: string) => new Element(name.toUpperCase()),
    createTextNode: (value: string) =>
      Object.assign(new Element("#TEXT"), { textContent: value }),
  };
  const context = { window, document, URL, URLSearchParams };
  for (const name of ["project-workspace", "pm-charter"])
    runInNewContext(
      readFileSync(
        new URL(`../../dashboard/${name}.js`, import.meta.url),
        "utf8",
      ),
      context,
    );
  return window;
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  root.textContent + root.children.map(text).join("");

describe("PM workspace knowledge", () => {
  it("renders feature and queue tables as accessible scrollable DOM, including useful evidence links", () => {
    const root = fixture().renderKnowledgeDocument(
      "# Ranked queue\n| Priority | Opportunity | Evidence |\n| --- | --- | --- |\n| **1** | Preserve `deliveryMethod` | [Source](https://github.com/example/app/blob/main/checkout.ts) |\n| 2 | Improve errors | Pending investigation |\n\nOwner approval is still required.",
    );
    expect(all(root).filter((item) => item.tagName === "TABLE")).toHaveLength(
      1,
    );
    expect(all(root).filter((item) => item.tagName === "TH")).toHaveLength(3);
    expect(all(root).filter((item) => item.tagName === "TD")).toHaveLength(6);
    expect(
      all(root)
        .find((item) => item.className === "knowledge-table-wrap")
        ?.attributes.get("role"),
    ).toBe("region");
    expect(
      all(root).find((item) => item.tagName === "STRONG")?.textContent,
    ).toBe("1");
    expect(all(root).find((item) => item.tagName === "CODE")?.textContent).toBe(
      "deliveryMethod",
    );
    expect(all(root).find((item) => item.tagName === "A")?.rel).toBe(
      "noopener noreferrer",
    );
    expect(text(root)).toContain("Owner approval is still required.");
  });
  it("never interprets HTML, private URL credentials, or active schemes as executable content", () => {
    const root = fixture().renderKnowledgeDocument(
      "<script>window.pwned=true</script>\n[Bad](javascript:alert) [Credentials](https://user:secret@example.com) [Token](https://example.com?access_token=private) [Code](https://example.com?code=private)\n![Image](https://example.com/image.png)",
    );
    expect(
      all(root).some((item) => ["SCRIPT", "IMG"].includes(item.tagName)),
    ).toBe(false);
    expect(
      all(root)
        .filter((item) => item.tagName === "A")
        .every(
          (item) => !/javascript:|user:secret|token|code=/.test(item.href),
        ),
    ).toBe(true);
    expect(text(root)).toContain("<script>window.pwned=true</script>");
    expect(text(root)).toContain("Credentials");
  });
  it("preserves code and separates prose, lists, and headings without dropping unrecognized text", () => {
    const root = fixture().renderKnowledgeDocument(
      "## Findings\n1. First\n2. Second\n\n> Check the evidence\n```\n| not | a table |\n<script>literal</script>\n```\nRemaining question.",
    );
    expect(all(root).filter((item) => item.tagName === "OL")).toHaveLength(1);
    expect(all(root).filter((item) => item.tagName === "LI")).toHaveLength(2);
    expect(
      all(root).find((item) => item.tagName === "PRE")?.textContent,
    ).toContain("<script>literal</script>");
    expect(text(root)).toContain("Remaining question.");
  });
});

describe("progressive PM product brief", () => {
  it("round-trips named charter fields and preserves separate creation/edit inputs", () => {
    const api = fixture(),
      first = new Element("DIV"),
      second = new Element("DIV");
    const a = api.createPmCharter(first, "first", {
      ambition: "Useful software",
      users: ["Makers", "Buyers"],
      guardrails: ["Synthetic data only"],
    });
    const b = api.createPmCharter(second, "second", {
      goal: "A different project",
    });
    expect(a.read()).toEqual({
      ambition: "Useful software",
      users: ["Makers", "Buyers"],
      guardrails: ["Synthetic data only"],
    });
    const users = all(first).find(
      (item) => item.dataset.charterKey === "users",
    )!;
    users.value = "  New users  \n\nReturning users\n";
    expect(a.read()).toMatchObject({ users: ["New users", "Returning users"] });
    expect(b.read()).toEqual({ goal: "A different project" });
    a.reset();
    expect(a.read()).toEqual({});
    expect(b.read()).toEqual({ goal: "A different project" });
  });
});
