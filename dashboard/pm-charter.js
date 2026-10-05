"use strict";
(() => {
  const definitions = [
    [
      "Direction & success",
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
      "People & scope",
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
      "Boundaries & priorities",
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
    const fields = new Map();
    for (const [title, items] of definitions) {
      const group = document.createElement("details");
      group.className = "charter-group";
      const summary = document.createElement("summary");
      summary.textContent = title;
      group.append(summary);
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
        fields.set(key, { input, list });
        field.append(caption, input);
        if (list) {
          const help = document.createElement("p");
          help.className = "setup-help";
          help.textContent = "Up to 20 entries, one per line.";
          field.append(help);
        }
        group.append(field);
      }
      root.append(group);
    }
    return {
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
      },
    };
  };
})();
