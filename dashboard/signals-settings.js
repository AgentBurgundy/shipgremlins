(() => {
  "use strict";
  const scopePattern = "[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,199}";
  const providers = {
    sentry: {
      name: "Sentry",
      description:
        "Give PMs read access to errors in one project and environment.",
      fields: [
        ["host", "Region", ["sentry.io", "us.sentry.io", "de.sentry.io"]],
        ["organization", "Organization slug", scopePattern],
        ["project", "Project slug", scopePattern],
        ["environment", "Environment", scopePattern],
      ],
      secrets: [["tokenSecret", "Token variable", "SENTRY_AUTH_TOKEN"]],
    },
    datadog: {
      name: "Datadog",
      description: "Let PMs investigate logs for one service and environment.",
      fields: [
        [
          "site",
          "Datadog site",
          [
            "datadoghq.com",
            "us3.datadoghq.com",
            "us5.datadoghq.com",
            "datadoghq.eu",
            "ap1.datadoghq.com",
            "ap2.datadoghq.com",
            "uk1.datadoghq.com",
            "ddog-gov.com",
            "us2.ddog-gov.com",
          ],
        ],
        ["service", "Service", scopePattern],
        ["environment", "Environment", scopePattern],
      ],
      secrets: [
        ["apiKeySecret", "API key variable", "DD_API_KEY"],
        ["appKeySecret", "Application key variable", "DD_APP_KEY"],
      ],
    },
    mixpanel: {
      name: "Mixpanel",
      description:
        "Read saved Insights reports using a service account with access to this project.",
      fields: [
        ["region", "Region", ["us", "eu", "in"]],
        ["projectId", "Project ID", "[1-9][0-9]*"],
        ["workspaceId", "Workspace ID (optional)", "[1-9][0-9]*", true],
      ],
      secrets: [
        [
          "usernameSecret",
          "Service account username variable",
          "MIXPANEL_USERNAME",
        ],
        [
          "passwordSecret",
          "Service account secret variable",
          "MIXPANEL_PASSWORD",
        ],
      ],
    },
  };
  const suffix = (name) => {
    const value = String(name || "PROJECT")
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    return /^[A-Z]/.test(value) ? value : `APP_${value}`;
  };
  // The same model drives the form and contract tests. It contains references only,
  // never credential values, and preserves unedited provider configuration.
  window.createSignalsSettingsModel = (initialTelemetry, options = {}) => {
    const original = structuredClone(initialTelemetry || {});
    const state = {};
    let projectName = options.projectName || "";
    const projectSuffix = (name) =>
      suffix(
        `${name || "PROJECT"}${options.instanceId ? `_${options.instanceId.replace(/-/g, "")}` : ""}`,
      );
    for (const [provider, definition] of Object.entries(providers)) {
      const values = { ...original[provider] };
      for (const [key, , pattern] of definition.fields)
        values[key] ??= Array.isArray(pattern) ? pattern[0] : "";
      for (const [key, , prefix] of definition.secrets)
        values[key] ??= `${prefix}_${projectSuffix(projectName)}`;
      state[provider] = { enabled: !!original[provider], values };
    }
    const snapshot = () =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(state).filter(([, value]) => value.enabled),
        ),
      );
    const baseline = snapshot();
    const initialStates = structuredClone(state);
    return {
      get: (provider) => structuredClone(state[provider]),
      enable(provider, enabled) {
        state[provider].enabled = !!enabled;
      },
      set(provider, key, value) {
        state[provider].values[key] = String(value);
      },
      isDirty: () => snapshot() !== baseline,
      setProjectName(name) {
        for (const [provider, definition] of Object.entries(providers))
          for (const [key, , prefix] of definition.secrets)
            if (
              !original[provider]?.[key] &&
              state[provider].values[key] ===
                `${prefix}_${projectSuffix(projectName)}`
            )
              state[provider].values[key] = `${prefix}_${projectSuffix(name)}`;
        projectName = name;
      },
      read() {
        const result = structuredClone(original);
        for (const [provider, definition] of Object.entries(providers)) {
          const item = state[provider];
          if (!item.enabled) {
            delete result[provider];
            continue;
          }
          const values = { ...item.values };
          for (const [key, label, pattern, optional] of definition.fields) {
            const value = String(values[key] || "").trim();
            if (optional && !value) {
              delete values[key];
              continue;
            }
            if (
              Array.isArray(pattern)
                ? !pattern.includes(value)
                : !new RegExp(`^(?:${pattern})$`).test(value)
            )
              throw new Error(
                `Complete ${definition.name}: ${label}. Use one explicit scope, without wildcards.`,
              );
            values[key] = value;
          }
          for (const [key, , prefix] of definition.secrets) {
            const value = String(values[key] || "").trim();
            if (!new RegExp(`^${prefix}_[A-Z][A-Z0-9_]*$`).test(value))
              throw new Error(
                `${definition.name} needs a credential variable name beginning ${prefix}_, never a token value.`,
              );
            values[key] = value;
          }
          result[provider] =
            JSON.stringify(item) === JSON.stringify(initialStates[provider])
              ? structuredClone(original[provider])
              : values;
        }
        return result;
      },
    };
  };

  window.createSignalsSettings = (
    container,
    prefix,
    initialTelemetry,
    options = {},
  ) => {
    const model = window.createSignalsSettingsModel(initialTelemetry, options);
    const sections = {};
    const inputs = {};
    const tabs = {};
    const providerKeys = Object.keys(providers);
    let revealingInvalid = false;
    const root = document.createElement("section");
    root.className = "signals-settings";
    const node = (tag, className, text) => {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (text) item.textContent = text;
      return item;
    };
    root.append(
      node("h3", "", "Product signals"),
      node(
        "p",
        "runner-guidance",
        "Optional context for your PMs. Choose the app scope here, save, then add credentials in Connections. Secrets are stored separately.",
      ),
    );
    const navigation = node("div", "signals-provider-tabs");
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Product signal provider");
    root.append(navigation);
    const selectProvider = (provider, focus = false) => {
      if (!sections[provider]) return false;
      for (const key of providerKeys) {
        const active = key === provider;
        sections[key].section.hidden = !active;
        tabs[key].setAttribute("aria-selected", String(active));
        tabs[key].tabIndex = active ? 0 : -1;
      }
      if (focus) tabs[provider].focus();
      return true;
    };
    for (const [provider, definition] of Object.entries(providers)) {
      const initial = model.get(provider);
      const section = node(
        "section",
        "signal-provider-settings signal-provider-panel",
      );
      section.dataset.signalProvider = provider;
      section.id = `${prefix}-${provider}-panel`;
      section.setAttribute("role", "tabpanel");
      const tab = node("button", "", definition.name);
      tab.type = "button";
      tab.id = `${prefix}-${provider}-tab`;
      tab.dataset.signalProviderTab = provider;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", section.id);
      section.setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("click", () => selectProvider(provider));
      tab.addEventListener("keydown", (event) => {
        const index = providerKeys.indexOf(provider);
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % providerKeys.length
            : event.key === "ArrowLeft"
              ? (index - 1 + providerKeys.length) % providerKeys.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? providerKeys.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        selectProvider(providerKeys[next], true);
      });
      tabs[provider] = tab;
      navigation.append(tab);
      const toggleLabel = node("label", "signal-enable");
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.id = `${prefix}-${provider}-enabled`;
      enabled.dataset.setting = `${provider}-enabled`;
      enabled.checked = initial.enabled;
      toggleLabel.append(
        enabled,
        document.createTextNode(` Use ${definition.name} for this project`),
      );
      section.append(
        node("p", "runner-guidance", definition.description),
        toggleLabel,
      );
      const fields = document.createElement("fieldset");
      fields.className = "signal-provider-fields";
      const legend = node("legend", "sr-only", `${definition.name} scope`);
      fields.append(legend);
      fields.disabled = !enabled.checked;
      fields.hidden = !enabled.checked;
      const grid = node("div", "project-form-grid");
      inputs[provider] = {};
      const addField = (parent, key, title, pattern, optional = false) => {
        const wrapper = node("div", "field");
        const label = node("label", "", title);
        const input = document.createElement(
          Array.isArray(pattern) ? "select" : "input",
        );
        input.id = `${prefix}-${provider}-${key}`;
        label.htmlFor = input.id;
        input.dataset.setting = `${provider}-${key}`;
        if (Array.isArray(pattern)) {
          for (const value of pattern) input.append(new Option(value, value));
        } else {
          input.type = "text";
          input.pattern = pattern;
          input.autocomplete = "off";
          input.spellcheck = false;
        }
        input.required = !optional;
        input.value = initial.values[key] || "";
        input.addEventListener("input", () =>
          model.set(provider, key, input.value),
        );
        input.addEventListener("change", () =>
          model.set(provider, key, input.value),
        );
        input.addEventListener("invalid", () => {
          const first = input.form?.querySelector(
            ":invalid:not(fieldset):not(form)",
          );
          if (revealingInvalid || (first && first !== input)) return;
          revealingInvalid = true;
          selectProvider(provider);
          if (advanced.contains(input)) setAdvanced(true);
          for (
            let parent = input.parentElement;
            parent;
            parent = parent.parentElement
          )
            if (parent.tagName === "DETAILS") parent.open = true;
          options.onReveal?.(input);
          input.focus();
          queueMicrotask(() => {
            revealingInvalid = false;
          });
        });
        inputs[provider][key] = input;
        wrapper.append(label, input);
        parent.append(wrapper);
      };
      for (const field of definition.fields) addField(grid, ...field);
      fields.append(grid);
      const advanced = node("div", "signal-secret-references");
      advanced.id = `${prefix}-${provider}-references`;
      advanced.hidden = true;
      const advancedToggle = node(
        "button",
        "signal-reference-toggle small-button",
        "Credential variable names",
      );
      advancedToggle.type = "button";
      advancedToggle.setAttribute("aria-controls", advanced.id);
      const setAdvanced = (open) => {
        advanced.hidden = !open;
        advancedToggle.setAttribute("aria-expanded", String(open));
      };
      setAdvanced(false);
      advancedToggle.addEventListener("click", () =>
        setAdvanced(advanced.hidden),
      );
      advanced.append(
        node(
          "p",
          "runner-guidance",
          "Keep these names to reuse saved credentials. Add the secret values in Connections.",
        ),
      );
      const secretGrid = node("div", "project-form-grid");
      for (const [key, label, keyPrefix] of definition.secrets)
        addField(secretGrid, key, label, `${keyPrefix}_[A-Z][A-Z0-9_]*`);
      advanced.append(secretGrid);
      fields.append(advancedToggle, advanced);
      if (provider === "mixpanel")
        fields.append(
          node(
            "p",
            "runner-guidance",
            "Each PM also needs a saved Insights report ID. Add it when creating a PM, or use the PM report settings on the Mixpanel card in Connections. Remove PM report mappings there before disabling Mixpanel.",
          ),
        );
      const credentials = node(
        "a",
        "",
        "Save, then add credentials in Connections ↗",
      );
      credentials.href = "#connections";
      fields.append(credentials);
      section.append(fields);
      enabled.addEventListener("change", () => {
        model.enable(provider, enabled.checked);
        fields.disabled = !enabled.checked;
        fields.hidden = !enabled.checked;
        syncTab();
      });
      const syncTab = () => {
        tab.dataset.enabled = String(enabled.checked);
        tab.setAttribute(
          "aria-label",
          `${definition.name}, ${enabled.checked ? "enabled" : "not enabled"} for this project`,
        );
      };
      syncTab();
      sections[provider] = { section, enabled };
      root.append(section);
    }
    selectProvider(
      providerKeys.find((provider) => model.get(provider).enabled) ||
        providerKeys[0],
    );
    container.replaceChildren(root);
    return {
      read: () => model.read(),
      isDirty: () => model.isDirty(),
      setProjectName(name) {
        model.setProjectName(name);
        for (const [provider, fields] of Object.entries(inputs))
          for (const [key, input] of Object.entries(fields))
            input.value = model.get(provider).values[key] || "";
      },
      focusProvider(provider) {
        const target = sections[provider];
        if (!target) return;
        selectProvider(provider);
        options.onReveal?.(target.enabled);
        target.section.scrollIntoView({ block: "nearest" });
        target.enabled.focus();
      },
      selectProvider,
    };
  };

  window.createMixpanelReports = (container, { api, onSaved } = {}) => {
    let project = "";
    let documentValue;
    let revision;
    let busy = false;
    let sequence = 0;
    let baseline = "";
    const reportFields = new Map();
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    };
    const root = node("details", "mixpanel-report-settings");
    root.append(node("summary", "", "Choose a saved report for each PM"));
    const guidance = node(
      "p",
      "runner-guidance",
      "Use the numeric ID from a saved Mixpanel Insights report. Blank removes a PM's mapping. Credentials and other PM settings are kept.",
    );
    root.append(guidance);
    const label = node("label", "", "Project");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Project for Mixpanel PM reports");
    const projectField = node("div", "field");
    label.append(select);
    projectField.append(label);
    root.append(projectField);
    const list = node("div", "project-form-grid");
    root.append(list);
    const save = node("button", "button secondary", "Save PM reports");
    save.type = "button";
    save.disabled = true;
    const status = node("p", "form-message");
    status.setAttribute("role", "status");
    root.append(save, status);
    container.replaceChildren(root);
    const signature = () =>
      JSON.stringify(
        [...reportFields].map(([key, field]) => [key, field.value]),
      );
    const isDirty = () => !!documentValue && signature() !== baseline;
    const lock = (value) => {
      busy = value;
      select.disabled = value;
      save.disabled = value || !documentValue;
      for (const field of reportFields.values()) field.disabled = value;
    };
    const show = (text, error = false) => {
      status.textContent = text;
      status.classList.toggle("error", error);
    };
    async function load(name) {
      if (busy) return false;
      if (isDirty()) {
        select.value = project;
        show("Save the edited PM report IDs before switching projects.", true);
        return false;
      }
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || "")) {
        project = "";
        documentValue = undefined;
        reportFields.clear();
        list.replaceChildren();
        save.disabled = true;
        return false;
      }
      const current = ++sequence;
      project = name;
      select.value = name;
      documentValue = undefined;
      reportFields.clear();
      list.replaceChildren();
      lock(true);
      show("Loading PM report settings…");
      try {
        const [projectFile, areasFile] = await Promise.all([
          api(
            `/api/config?path=${encodeURIComponent(`projects/${name}/project.json`)}`,
          ),
          api(
            `/api/config?path=${encodeURIComponent(`projects/${name}/areas.json`)}`,
          ),
        ]);
        if (current !== sequence) return false;
        const projectConfig = JSON.parse(projectFile.content);
        if (!projectConfig.telemetry?.mixpanel) {
          show(
            "Configure Mixpanel for this project first, then choose PM reports here.",
          );
          return false;
        }
        const areas = JSON.parse(areasFile.content);
        for (const [key, area] of Object.entries(areas.areas || {})) {
          const field = node("div", "field");
          const caption = node(
            "label",
            "",
            `${area.name || key} · saved report ID`,
          );
          const input = document.createElement("input");
          input.type = "text";
          input.inputMode = "numeric";
          input.pattern = "[1-9][0-9]*";
          input.autocomplete = "off";
          input.value = area.mixpanelReportId || "";
          input.dataset.pmReport = key;
          caption.append(input);
          field.append(caption);
          list.append(field);
          reportFields.set(key, input);
        }
        if (!reportFields.size) {
          show("Create a PM for this project before assigning a saved report.");
          return false;
        }
        documentValue = areas;
        revision = areasFile.revision;
        baseline = signature();
        show(
          "Choose the report each PM should read. An unmapped PM does not query Mixpanel.",
        );
        return true;
      } catch (error) {
        show(error.message || "PM report settings could not be loaded.", true);
        return false;
      } finally {
        if (current === sequence) lock(false);
      }
    }
    select.addEventListener("change", () => load(select.value));
    save.addEventListener("click", async () => {
      if (busy || !documentValue) return;
      const next = structuredClone(documentValue);
      for (const [key, input] of reportFields) {
        const value = input.value.trim();
        if (value && !/^[1-9][0-9]*$/.test(value)) {
          show(
            "Enter a positive numeric saved report ID, or leave it blank to remove the mapping.",
            true,
          );
          input.focus();
          return;
        }
        if (value) next.areas[key].mixpanelReportId = value;
        else delete next.areas[key].mixpanelReportId;
      }
      lock(true);
      show("Saving PM report settings…");
      try {
        const response = await api(
          "/api/config",
          {
            path: `projects/${project}/areas.json`,
            content: `${JSON.stringify(next, null, 2)}\n`,
            revision,
          },
          "PUT",
        );
        documentValue = next;
        revision = response.revision;
        for (const input of reportFields.values())
          input.value = input.value.trim();
        baseline = signature();
        show("PM reports saved. Other PM settings and credentials were kept.");
        try {
          await onSaved?.(project);
        } catch {
          /* Saving succeeded even if status refresh failed. */
        }
      } catch (error) {
        show(
          `${error.message || "PM reports could not be saved."} Your edits are still here. If another editor changed this project, refresh the page to load its latest version before trying again.`,
          true,
        );
      } finally {
        lock(false);
      }
    });
    return {
      isDirty,
      load,
      setProjects(projects) {
        const names = projects
          .map((item) => (typeof item === "string" ? item : item.name))
          .filter((name) => /^[a-z][a-z0-9-]{0,62}$/.test(name || ""))
          .sort();
        select.replaceChildren(
          new Option("Choose a project", ""),
          ...names.map((name) => new Option(name, name)),
        );
        if (names.includes(project)) select.value = project;
        else if (project && !isDirty() && !busy) {
          project = "";
          documentValue = undefined;
          list.replaceChildren();
          reportFields.clear();
          save.disabled = true;
        }
      },
    };
  };
})();
