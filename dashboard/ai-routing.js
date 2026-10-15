"use strict";
(() => {
  const names = { claude: "Claude Code", codex: "Codex" };
  const sources = {
    workspace: "Workspace default",
    "project-default": "Project default",
    "project-role": "Project role override",
    "pm-role": "PM override",
  };
  const node = (tag, cls, text) => {
    const value = document.createElement(tag);
    if (cls) value.className = cls;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  window.createAiRouting = ({ api, isLocked, onSaved }) => {
    const states = new Map(),
      modelChoices = window.createAiModelChoices({ api });
    function create(project, area) {
      const endpoint = `/api/projects/${encodeURIComponent(project.name)}${area ? `/pms/${encodeURIComponent(area.key)}` : ""}/ai`,
        root = node("details", "ai-routing"),
        summary = node("summary", "ai-routing-heading"),
        identity = node("div"),
        preview = node("span", "ai-routing-preview", "Checking saved choices…");
      identity.append(
        node("strong", "", area ? "AI for this PM" : "AI for this project"),
        node(
          "span",
          "ai-routing-description",
          area
            ? "Choose the provider and model for this PM’s investigations and reviews."
            : "Set the default AI, with separate choices for PM and coding work.",
        ),
      );
      summary.append(identity, preview);
      const form = node("form", "ai-routing-form"),
        fields = node("fieldset"),
        notice = node("p", "form-message"),
        save = node("button", "button button-dark", "Save AI choices"),
        reload = node("button", "small-button", "Reload saved choices"),
        connections = node("a", "small-button", "Manage AI connections ↗"),
        actions = node("div", "button-row");
      fields.append(
        node(
          "legend",
          "sr-only",
          area ? "AI routing for this PM" : "Project AI routing",
        ),
      );
      notice.hidden = true;
      notice.setAttribute("role", "status");
      save.type = "submit";
      reload.type = "button";
      connections.href = "/connections#model-connections";
      actions.append(save, reload, connections);
      const rows = new Map();
      for (const [key, label, description] of area
        ? [["pm", "This PM", "Investigations, discovery and PM reviews"]]
        : [
            [
              "default",
              "Project default",
              "Setup and roles that inherit this project",
            ],
            ["pm", "PM work", "Investigations, discovery and PM reviews"],
            ["coder", "Coding work", "Implementation and coding repairs"],
          ]) {
        const row = node("div", "ai-routing-row"),
          title = node("label", "ai-routing-role", label),
          help = node("span", "ai-routing-help", description),
          provider = node("select"),
          model = node("select"),
          modelLabel = node("label", "sr-only", `Model for ${label}`),
          modelHint = node("p", "ai-routing-model-hint"),
          effective = node("p", "ai-routing-effective");
        const prefix = `ai-routing-${project.name}-${area?.key || "project"}-${key}`;
        provider.id = prefix;
        title.htmlFor = provider.id;
        const inherited = node(
          "option",
          "",
          key === "default"
            ? "Inherit workspace default"
            : area
              ? "Inherit project choice"
              : "Inherit project default",
        );
        inherited.value = "";
        provider.append(inherited);
        for (const id of ["claude", "codex"]) {
          const option = node("option", "", names[id]);
          option.value = id;
          provider.append(option);
        }
        model.id = `${prefix}-model`;
        modelLabel.htmlFor = model.id;
        modelHint.id = `${prefix}-model-catalog`;
        model.setAttribute("aria-describedby", modelHint.id);
        const modelChoice = modelChoices.bind(model, modelHint);
        const choice = node("div", "ai-routing-choice"),
          copy = node("div");
        copy.append(title, help);
        choice.append(provider, modelLabel, model);
        row.append(copy, choice, effective, modelHint);
        fields.append(row);
        rows.set(key, { provider, model, effective, modelChoice });
      }
      const note = node(
        "p",
        "ai-routing-note",
        "Choices apply to new runs. Existing runs keep the provider and model recorded when they started. A missing connection holds work; another provider is never substituted.",
      );
      form.append(fields, note, actions, notice);
      root.append(summary, form);
      const state = {
        root,
        project,
        area,
        saved: null,
        busy: false,
        loaded: false,
        dirty: false,
        notice,
        rows,
      };
      const announce = (message, error = false) => {
        notice.textContent = message;
        notice.hidden = !message;
        notice.setAttribute("role", error ? "alert" : "status");
        notice.classList.toggle("error", error);
      };
      const read = () =>
        Object.fromEntries(
          [...rows].map(([key, row]) => [
            key,
            row.provider.value
              ? {
                  provider: row.provider.value,
                  ...(row.model.value.trim()
                    ? { model: row.model.value.trim() }
                    : {}),
                }
              : null,
          ]),
        );
      const baseline = () =>
        Object.fromEntries(
          [...rows.keys()].map((key) => [
            key,
            state.saved?.overrides?.[key] || null,
          ]),
        );
      const sync = () => {
        const locked = isLocked();
        fields.disabled = locked || state.busy || !state.saved;
        save.disabled = locked || state.busy || !state.saved || !state.dirty;
        reload.disabled = locked || state.busy;
        save.textContent = state.busy ? "Saving…" : "Save AI choices";
        root.setAttribute("aria-busy", String(state.busy));
        for (const row of rows.values()) {
          row.model.disabled = !row.provider.value;
          if (!locked) row.modelChoice.sync();
        }
      };
      const apply = (view) => {
        state.saved = view;
        state.loaded = true;
        state.dirty = false;
        for (const [key, row] of rows) {
          const override = view.overrides?.[key],
            effective = view.effective?.[key === "default" ? "setup" : key];
          row.provider.value = override?.provider || "";
          row.modelChoice.set(row.provider.value, override?.model || "");
          for (const option of [...row.provider.children].slice(1)) {
            const provider = view.providers?.find(
              (item) => item.id === option.value,
            );
            option.textContent = `${names[option.value]} · ${provider?.configured ? "Connected" : "Not connected"}`;
          }
          const connected =
            effective?.configured ??
            view.providers?.find((item) => item.id === effective?.provider)
              ?.configured;
          row.effective.textContent = effective
            ? `${names[effective.provider] || "AI"}${effective.model ? ` · ${effective.model}` : ""} · ${sources[effective.source] || (override ? (area ? "PM override" : "Project override") : "Inherited")}${connected ? "" : " · Connection needed"}`
            : "Effective choice is unavailable.";
        }
        preview.textContent = area
          ? `PM ${names[view.effective?.pm?.provider] || "—"}`
          : `PM ${names[view.effective?.pm?.provider] || "—"} · Coding ${names[view.effective?.coder?.provider] || "—"}`;
        sync();
      };
      const load = async (refreshModels = false) => {
        if (state.busy || isLocked()) return;
        state.busy = true;
        sync();
        try {
          apply(await api(endpoint));
          if (refreshModels)
            for (const row of rows.values()) row.modelChoice.refresh();
          announce("");
        } catch {
          state.loaded = true;
          announce(
            "AI choices could not load. Reload saved choices to try again.",
            true,
          );
        } finally {
          state.busy = false;
          sync();
        }
      };
      state.load = load;
      state.sync = sync;
      for (const row of rows.values()) {
        const change = () => {
          if (!row.provider.value) row.model.value = "";
          state.dirty = JSON.stringify(read()) !== JSON.stringify(baseline());
          sync();
        };
        row.provider.addEventListener("change", () => {
          row.modelChoice.set(row.provider.value, "");
          change();
        });
        row.model.addEventListener("change", change);
      }
      reload.addEventListener("click", () => load(true));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.busy || isLocked() || !state.saved || !state.dirty) return;
        const overrides = read();
        if (
          [...rows.values()].some(
            (row) => !row.modelChoice.allowed(row.model.value),
          ) ||
          Object.values(overrides).some(
            (value) =>
              value &&
              (!["claude", "codex"].includes(value.provider) ||
                (value.model &&
                  !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.model))),
          )
        ) {
          announce(
            "Choose Claude Code or Codex and an available model or Provider default.",
            true,
          );
          return;
        }
        state.busy = true;
        sync();
        try {
          apply(
            await api(
              endpoint,
              { revision: state.saved.revision, ...overrides },
              "PUT",
            ),
          );
          announce("AI choices saved for new runs.");
          try {
            await onSaved?.();
          } catch {
            announce(
              "AI choices saved. Workspace status could not refresh; your selection was kept.",
            );
          }
        } catch (error) {
          announce(
            error?.status === 409
              ? "AI choices changed while you were editing. Your draft is kept; reload saved choices before saving again."
              : "AI choices could not be saved. Your draft is kept; try again.",
            true,
          );
        } finally {
          state.busy = false;
          sync();
        }
      });
      sync();
      return state;
    }
    return {
      mount(root, project, area) {
        const key = JSON.stringify([
          project.name,
          project.instanceId ?? null,
          area?.key ?? null,
          area?.instanceId ?? null,
        ]);
        let state = states.get(key);
        if (!state) {
          state = create(project, area);
          states.set(key, state);
        }
        root.append(state.root);
        state.sync();
        if (!state.loaded && !state.busy && !isLocked()) state.load();
      },
      isDirty: () => [...states.values()].some((state) => state.dirty),
      isBusy: () => [...states.values()].some((state) => state.busy),
      protectFocus: (root) =>
        [...states.values()].some(
          (state) =>
            root.contains(state.root) &&
            (state.busy ||
              state.dirty ||
              state.root.contains(document.activeElement)),
        ),
      forget(project, area) {
        for (const [key, state] of states)
          if (
            state.project.name === project &&
            (!area || state.area?.key === area)
          )
            states.delete(key);
      },
    };
  };
})();
