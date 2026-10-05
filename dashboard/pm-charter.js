"use strict";
(() => {
  const definitions = [
    [
      "direction",
      "Direction",
      "Set a direction",
      "Describe the change this PM should help achieve and how you’ll recognize success.",
      [
        ["ambition", "Product ambition", "What should this product become?"],
        ["goal", "This PM’s goal", "What change should this PM help achieve?"],
        [
          "metricDefinition",
          "How success is measured",
          "Define the outcome, metric, or evidence that matters.",
        ],
      ],
    ],
    [
      "scope",
      "People & scope",
      "Keep the work focused",
      "Name the people this work serves and the capabilities that belong in this PM’s scope.",
      [
        [
          "users",
          "Who it serves",
          "One audience or user group per line.",
          true,
        ],
        [
          "expectedToBuild",
          "Expected capabilities",
          "One capability or product outcome per line.",
          true,
        ],
        [
          "nonGoals",
          "Out of scope",
          "What should this PM deliberately avoid? One item per line.",
          true,
        ],
      ],
    ],
    [
      "boundaries",
      "Boundaries",
      "Give your PM clear boundaries",
      "Set the rules and priorities it should keep in mind during every investigation.",
      [
        [
          "guardrails",
          "Guardrails",
          "Safety, data, product, or technical boundaries. One per line.",
          true,
        ],
        [
          "standingPriorities",
          "Standing priorities",
          "The priorities that should shape every investigation. One per line.",
          true,
        ],
      ],
    ],
  ];
  window.createPmCharter = (root, prefix, initial = {}) => {
    const fields = new Map(),
      tabs = new Map(),
      groups = new Map();
    root.classList.add("pm-charter-editor");
    const navigation = document.createElement("div");
    navigation.className = "charter-navigation";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Product brief sections");
    root.append(navigation);
    let revealingInvalid = false;
    function selectTab(key, focus = false) {
      if (!tabs.has(key)) return false;
      for (const [name, tab] of tabs) {
        tab.setAttribute("aria-selected", String(name === key));
        tab.tabIndex = name === key ? 0 : -1;
        groups.get(name).hidden = name !== key;
      }
      if (focus) tabs.get(key).focus({ preventScroll: true });
      return true;
    }
    function revealField(key) {
      const field = fields.get(key);
      if (!field) return false;
      selectTab(field.groupKey);
      // Older hosts can wrap this editor in a disclosure. Open it before the
      // browser attempts to focus a field with a native validation error.
      let ancestor = field.input.parentElement;
      while (ancestor) {
        if (ancestor.tagName === "DETAILS") ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      field.input.focus();
      return true;
    }
    for (const [
      index,
      [groupKey, title, heading, description, items],
    ] of definitions.entries()) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.id = `${prefix}-tab-${groupKey}`;
      tab.textContent = title;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `${prefix}-panel-${groupKey}`);
      tab.addEventListener("click", () => selectTab(groupKey));
      tab.addEventListener("keydown", (event) => {
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % definitions.length
            : event.key === "ArrowLeft"
              ? (index - 1 + definitions.length) % definitions.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? definitions.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        selectTab(definitions[next][0], true);
      });
      tabs.set(groupKey, tab);
      navigation.append(tab);
      const group = document.createElement("section");
      group.className = "charter-group charter-panel";
      group.id = `${prefix}-panel-${groupKey}`;
      group.setAttribute("role", "tabpanel");
      group.setAttribute("aria-labelledby", tab.id);
      const titleElement = document.createElement("h3"),
        explanation = document.createElement("p");
      titleElement.textContent = heading;
      explanation.className = "charter-panel-description";
      explanation.textContent = description;
      group.append(titleElement, explanation);
      groups.set(groupKey, group);
      for (const [key, label, hint, list] of items) {
        const field = document.createElement("div");
        field.className = "field";
        const caption = document.createElement("label");
        caption.htmlFor = `${prefix}-${key}`;
        caption.textContent = label;
        const input = document.createElement("textarea");
        input.id = caption.htmlFor;
        input.rows = 3;
        input.maxLength = list ? 20020 : 4000;
        input.placeholder = hint;
        input.value = list
          ? (initial[key] || []).join("\n")
          : initial[key] || "";
        input.dataset.charterKey = key;
        fields.set(key, { input, list, groupKey });
        input.addEventListener("invalid", () => {
          if (revealingInvalid) return;
          revealingInvalid = true;
          revealField(key);
          queueMicrotask(() => {
            revealingInvalid = false;
          });
        });
        field.append(caption, input);
        const help = document.createElement("p");
        help.className = "setup-help";
        help.id = `${prefix}-${key}-help`;
        help.textContent = list ? `${hint} Up to 20 entries.` : hint;
        input.setAttribute("aria-describedby", help.id);
        field.append(help);
        group.append(field);
      }
      root.append(group);
    }
    selectTab("direction");
    return {
      fill(charter) {
        for (const [key, { input, list }] of fields)
          input.value = list
            ? (charter[key] || []).join("\n")
            : charter[key] || "";
      },
      read() {
        const charter = {};
        for (const [key, { input, list }] of fields) {
          const value = list
            ? input.value
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
            : input.value.trim();
          if (value.length) charter[key] = value;
        }
        return charter;
      },
      reset() {
        for (const { input } of fields.values()) input.value = "";
        selectTab("direction");
      },
      focus: revealField,
    };
  };
})();
