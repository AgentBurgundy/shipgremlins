import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: EventLike) => void>();
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  id = "";
  name = "";
  checked = false;
  disabled = false;
  hidden = false;
  valid = true;
  focus = vi.fn();
  scrollIntoView = vi.fn();
  classList = {
    add: (name: string) => {
      this.className += ` ${name}`;
    },
    remove: () => {},
    toggle: () => {},
  };
  constructor(public tagName: string) {}
  append(...items: Element[]) {
    for (const item of items) {
      if (item.parent)
        item.parent.children = item.parent.children.filter(
          (child) => child !== item,
        );
      item.parent = this;
      this.children.push(item);
    }
  }
  prepend(...items: Element[]) {
    this.append(...items);
    this.children = [
      ...items,
      ...this.children.filter((item) => !items.includes(item)),
    ];
  }
  replaceChildren(...items: Element[]) {
    this.children = [];
    this.append(...items);
  }
  contains(item: Element) {
    return walk(this).includes(item);
  }
  closest(selector: string): Element | null {
    return this.className.split(" ").includes(selector.slice(1))
      ? this
      : this.parent?.closest(selector) || null;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(name: string, handler: (event: EventLike) => void) {
    this.listeners.set(name, handler);
  }
  dispatchEvent(event: EventLike) {
    this.listeners.get(event.type)?.(event);
  }
  checkValidity() {
    return this.valid;
  }
  querySelector(selector: string) {
    return (
      walk(this).find(
        (item) =>
          item.name === "repository-visibility" &&
          (selector.includes('value="private"')
            ? item.value === "private"
            : item.checked),
      ) || null
    );
  }
  reset() {}
}
type EventLike = {
  type: string;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
};
const walk = (root: Element): Element[] => [
  root,
  ...root.children.flatMap(walk),
];
const source = readFileSync(
  new URL("../../dashboard/project-wizard.js", import.meta.url),
  "utf8",
);
function fixture() {
  const ids = [
    "project-form",
    "project-fields",
    "new-project-drawer",
    "projects",
    "add-project",
    "project-start",
    "idea-crew-panel",
    "idea-crew-review",
    "project-name",
    "project-provider",
    "gitlab-options",
    "repository-picker",
    "repository-search",
    "manual-repository-field",
    "project-message",
    "project-repo",
    "gitlab-server",
  ];
  const nodes = Object.fromEntries(
    ids.map((id) => [id, Object.assign(new Element("div"), { id })]),
  );
  nodes["project-form"]!.append(nodes["project-fields"]!);
  for (const id of ["project-name", "project-provider", "repository-search"]) {
    const field = new Element("div");
    field.className = id === "repository-search" ? "repository-tools" : "field";
    field.append(nodes[id]!);
    nodes["project-fields"]!.append(field);
  }
  for (const id of [
    "idea-crew-panel",
    "idea-crew-review",
    "gitlab-options",
    "repository-picker",
    "manual-repository-field",
  ])
    nodes["project-fields"]!.append(nodes[id]!);
  nodes["project-provider"]!.value = "github";
  nodes["project-start"]!.value = "existing";
  const window = {} as {
    createProjectWizard(options: object): {
      update(): void;
      destination(): object;
      restore(value: object): void;
    };
  };
  const api = vi.fn(async () => ({
    owners: [{ path: "owner", id: "owner-id" }],
    accountId: "account-id",
  }));
  const onProviderChange = vi.fn();
  runInNewContext(source, {
    window,
    document: {
      getElementById: (id: string) => nodes[id],
      createElement: (tag: string) => new Element(tag),
      addEventListener() {},
      querySelector() {
        return null;
      },
    },
    Event: class {
      constructor(public type: string) {}
    },
    URL,
  });
  const wizard = window.createProjectWizard({
    api,
    crew: () => ({ ready: () => true, busy: false }),
    onProviderChange,
  });
  const root = nodes["project-fields"]!;
  const choose = (label: string) =>
    walk(root)
      .find(
        (node) =>
          node.tagName === "button" &&
          node.children.some((child) => child.textContent === label),
      )!
      .dispatchEvent({ type: "click" });
  const submit = () => {
    const event = {
      type: "submit",
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    nodes["project-form"]!.dispatchEvent(event);
    return event;
  };
  const step = () =>
    walk(root).find((node) => node.dataset.wizardStep && !node.hidden)!.dataset
      .wizardStep;
  return { nodes, root, wizard, api, onProviderChange, choose, submit, step };
}

describe("guided repository connection", () => {
  it("connects an existing repository in two screens with the same provider and editable inferred name", () => {
    const f = fixture();
    f.choose("Improve my app");
    expect(f.step()).toBe("repository");
    expect(f.onProviderChange).toHaveBeenCalledTimes(1);
    const repository = walk(f.root).find(
      (node) => node.dataset.wizardStep === "repository",
    )!;
    expect(repository.contains(f.nodes["project-provider"]!)).toBe(true);
    f.nodes["project-repo"]!.value = "owner/shop";
    f.nodes["project-name"]!.value = "shop"; // Existing picker handler supplies this suggestion.
    f.submit();
    expect(f.step()).toBe("review");
    const review = walk(f.root).find(
      (node) => node.dataset.wizardStep === "review",
    )!;
    expect(review.contains(f.nodes["project-name"]!)).toBe(true);
    f.nodes["project-name"]!.value = "my-shop";
    expect(f.wizard.destination()).toMatchObject({
      project: "my-shop",
      repo: "owner/shop",
      provider: "github",
    });
    expect(f.submit().stopImmediatePropagation).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
  });
  it("validates GitLab origins and review names before allowing project creation", () => {
    const f = fixture();
    f.choose("Improve my app");
    f.nodes["project-provider"]!.value = "gitlab";
    f.nodes["gitlab-server"]!.value =
      "https://user:password@gitlab.example.com/path";
    f.nodes["project-repo"]!.value = "group/shop";
    expect(f.submit().stopImmediatePropagation).toHaveBeenCalled();
    expect(f.step()).toBe("repository");
    f.nodes["gitlab-server"]!.value = "https://gitlab.example.com";
    f.submit();
    expect(f.step()).toBe("review");
    f.nodes["project-name"]!.value = "123-invalid";
    expect(f.submit().stopImmediatePropagation).toHaveBeenCalled();
    expect(f.nodes["project-name"]!.focus).toHaveBeenCalled();
    expect(f.nodes["project-message"]!.textContent).toContain(
      "beginning with a letter",
    );
  });
  it("preserves idea setup and a bound creation retry without another repository lookup", () => {
    const f = fixture();
    f.choose("Start from an idea · experimental");
    expect(f.step()).toBe("crew");
    f.submit();
    expect(f.step()).toBe("name");
    f.nodes["project-name"]!.value = "new-app";
    f.submit();
    expect(f.step()).toBe("provider");
    const destination = {
      project: "new-app",
      repo: "owner/new-app",
      provider: "github",
      newRepository: {
        ownerId: "owner-id",
        accountId: "account-id",
        visibility: "private",
      },
    };
    f.wizard.restore(destination);
    expect(f.step()).toBe("review");
    expect(f.wizard.destination()).toEqual(destination);
    expect(f.onProviderChange).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
  });
});
