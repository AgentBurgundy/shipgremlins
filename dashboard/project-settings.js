(() => {
  "use strict";
  const targetKinds = [
    ["repository", "Repository only · no hosting required"],
    ["url", "Docker or another host · direct URL"],
    ["vercel", "Vercel preview"],
    ["railway", "Railway service"],
    ["cloud-run", "Google Cloud Run service"],
  ];
  window.createProjectSettings = (
    container,
    prefix,
    original = {},
    options = {},
  ) => {
    let config = structuredClone(original);
    let environments = structuredClone(config.environments || {});
    // Legacy Vercel settings remain opt-in promotion settings until explicitly edited.
    if (!config.verification && config.vercel?.projectId) {
      environments.preview = {
        kind: "vercel",
        role: "preview",
        ...config.vercel,
      };
    }
    let selectedName =
      config.verification?.mode === "browser"
        ? config.verification.environment
        : !config.verification && config.vercel?.projectId
          ? "preview"
          : "";
    let branchEdited = false;
    let connections = options.connections || [];
    const fields = {};
    const root = document.createElement("div");
    root.className = "project-settings";
    const node = (tag, className, text) => {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (text) item.textContent = text;
      return item;
    };
    const tabs = new Map(),
      sections = new Map();
    const navigation = node("div", "project-settings-tabs");
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Project workflow settings");
    const sectionDefinitions = [
      ["environment", "Environment"],
      ["delivery", "Delivery"],
      ["checks", "Checks"],
    ];
    for (const [index, [key, label]] of sectionDefinitions.entries()) {
      const tab = node("button", "", label),
        section = node("section", "settings-tab-panel");
      tab.type = "button";
      tab.id = `${prefix}-tab-${key}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `${prefix}-panel-${key}`);
      section.id = `${prefix}-panel-${key}`;
      section.dataset.settingsTab = key;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("click", () => selectSection(key));
      tab.addEventListener("keydown", (event) => {
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % sectionDefinitions.length
            : event.key === "ArrowLeft"
              ? (index - 1 + sectionDefinitions.length) %
                sectionDefinitions.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? sectionDefinitions.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        selectSection(sectionDefinitions[next][0], true);
      });
      tabs.set(key, tab);
      sections.set(key, section);
      navigation.append(tab);
    }
    root.append(navigation, ...sections.values());
    function selectSection(key, focus = false) {
      if (!tabs.has(key)) return false;
      for (const [name, tab] of tabs) {
        tab.setAttribute("aria-selected", String(name === key));
        tab.tabIndex = name === key ? 0 : -1;
        sections.get(name).hidden = name !== key;
      }
      if (focus) tabs.get(key).focus({ preventScroll: true });
      return true;
    }
    function revealField(input) {
      if (!input) return false;
      for (const [key, section] of sections)
        if (section.contains(input)) selectSection(key);
      let ancestor = input.parentElement;
      while (ancestor) {
        if (ancestor.tagName === "DETAILS") ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      options.onReveal?.(input);
      input.focus();
      return true;
    }
    selectSection("environment");
    const field = (parent, key, label, help = "", options) => {
      const wrapper = node("div", "field");
      const caption = node("label", "", label);
      caption.htmlFor = `${prefix}-${key}`;
      const input = document.createElement(options ? "select" : "input");
      input.id = caption.htmlFor;
      input.dataset.setting = key;
      if (!options) {
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
      } else
        for (const [value, title] of options)
          input.append(new Option(title, value));
      wrapper.append(caption, input);
      if (help) {
        const hint = node("p", "", help);
        hint.id = `${input.id}-help`;
        input.setAttribute("aria-describedby", hint.id);
        wrapper.append(hint);
      }
      parent.append(wrapper);
      fields[key] = input;
      return wrapper;
    };
    const heading = node("div", "settings-heading");
    heading.append(
      node("h3", "", "Where should this project be checked?"),
      node(
        "p",
        "runner-guidance",
        "Start with code and checks. Add a browser target when your project has a web interface.",
      ),
    );
    sections.get("environment").append(heading);
    field(
      sections.get("environment"),
      "target",
      "Verification target",
      "Repository-only work uses your source and configured commands. Browser work visits a preview or staging environment.",
      Object.values(environments).some((target) => target.kind === "docker")
        ? [
            ...targetKinds,
            ["docker", "Disposable local app · edit in Environment"],
          ]
        : targetKinds,
    );
    const browser = node("div", "environment-fields");
    const dockerHint = node(
      "p",
      "runner-guidance",
      "The saved Docker recipe and test accounts are retained. Edit them from this project's Environment tab.",
    );
    browser.append(dockerHint);
    const available = Object.entries(environments).filter(
      ([, value]) => value.role !== "production",
    );
    if (available.length) {
      field(
        browser,
        "existing",
        "Saved environment",
        "Choose an existing test target, or add a named target without removing the others.",
        [
          ["", "Add a new test environment"],
          ...available.map(([name, value]) => [
            name,
            `${name} · ${value.kind}`,
          ]),
        ],
      );
    }
    const identity = node("div", "project-form-grid");
    field(
      identity,
      "environment",
      "Environment name",
      "A reusable name, such as preview or staging.",
    );
    fields.environment.pattern = "[a-z][a-z0-9\\-]*";
    field(
      identity,
      "role",
      "Environment role",
      "Production environments are never browser test targets.",
      [
        ["preview", "Preview"],
        ["staging", "Staging"],
      ],
    );
    browser.append(identity);
    const providerFields = node("div", "project-form-grid");
    const definitions = [
      [
        "connectionId",
        "Vercel connection",
        "Use the saved account or team connection for this environment. Manage accounts in Connections.",
        [["", "Default connection"]],
      ],
      [
        "url",
        "Test URL",
        "An HTTP(S) address reachable from the Docker worker. For a host service, use an address the container can reach.",
      ],
      [
        "projectId",
        "Provider project ID",
        "Use the hosting provider’s project ID, not the repository name.",
      ],
      [
        "teamId",
        "Vercel team ID (optional)",
        "Leave blank to use this connection’s team. A team outside its access requires a different connection.",
      ],
      [
        "branch",
        "Preview branch (optional)",
        "The deployed branch to look up, separate from the PR base. Vercel needs a preview deployment; use its deployed preview branch, such as staging. Blank uses the project’s work branch.",
      ],
      [
        "bypassSecret",
        "Preview bypass variable (optional)",
        "The name of a saved credential, never the token value. Add its value in Connections after saving.",
      ],
      [
        "customEnvironmentId",
        "Vercel custom environment ID (optional)",
        "Set by the Environment picker for custom staging. Leave blank for standard Preview deployments.",
      ],
      [
        "environmentId",
        "Railway environment ID",
        "Select the preview or staging environment in Railway.",
      ],
      [
        "serviceId",
        "Railway service ID",
        "The web service in that environment.",
      ],
      [
        "tokenSecret",
        "Railway token variable",
        "Defaults to RAILWAY_TOKEN. Save credentials separately in Connections.",
      ],
      ["region", "Cloud Run region", "For example, us-central1."],
      [
        "service",
        "Cloud Run service",
        "The service name in your Google Cloud project.",
      ],
      [
        "credentialsSecret",
        "Google credential variable (optional)",
        "Use GCP_SERVICE_ACCOUNT_JSON, or leave blank for the server’s Application Default Credentials.",
      ],
    ];
    const wrappers = {};
    for (const definition of definitions)
      wrappers[definition[0]] = field(providerFields, ...definition);
    wrappers.tokenType = field(
      providerFields,
      "tokenType",
      "Railway token type",
      "Choose Project token only for a token issued for this Railway project.",
      [
        ["account", "Account / workspace token"],
        ["project", "Project token"],
      ],
    );
    fields.url.type = "url";
    browser.append(providerFields);
    const connectionHelp = node("p", "runner-guidance");
    const connectionLink = node(
      "a",
      "",
      "Manage hosting credentials in Connections ↗",
    );
    connectionLink.href = "#connections";
    connectionHelp.append(
      connectionLink,
      document.createTextNode(
        ". Provider credentials stay on the controller and are not given to agents.",
      ),
    );
    browser.append(connectionHelp);
    sections.get("environment").append(browser);
    const deliveryHeading = node("div", "settings-heading");
    deliveryHeading.append(
      node("h3", "", "How should changes reach you?"),
      node(
        "p",
        "runner-guidance",
        "The controller integrates coding drafts and PMs test them. You review each PM's promotion batch.",
      ),
    );
    sections.get("delivery").append(deliveryHeading);
    const workflowGrid = node("div", "project-form-grid");
    field(
      workflowGrid,
      "workflow",
      "How changes are reviewed",
      "Managed delivery handles internal PRs automatically. Pull-request-only projects use your chosen review branch.",
      [
        ["promotion", "PM staging → staging → production (recommended)"],
        ["pull-request", "Pull request / merge request only"],
      ],
    );
    const baseWrapper = field(
      workflowGrid,
      "baseBranch",
      "Base branch",
      "The branch draft changes target. It does not mark tickets Done automatically.",
    );
    sections.get("delivery").append(workflowGrid);
    const promotion = node("div", "promotion-settings");
    promotion.append(
      node(
        "p",
        "runner-guidance",
        "Coders work in pm-staging. Each PM tests its tickets and collects a separate promotion PR to staging. You review each PM's completed batch; ordinary staging and production development can continue.",
      ),
    );
    const branches = node("div", "project-form-grid");
    field(
      promotion,
      "approvalPolicy",
      "Approve work before coding",
      "Approve an epic once, then let the crew implement and QA its child tickets. Existing projects retain their saved ticket policy until changed.",
      [
        ["epic", "Approve epics (recommended)"],
        ["ticket", "Legacy ticket policy"],
      ],
    );
    fields.approvalPolicy.value = config.workflow?.approvalPolicy ?? "ticket";
    field(
      promotion,
      "promotionBatchSize",
      "Tested tickets per PM promotion",
      "Each PM opens a promotion after this many distinct tickets pass QA. A PM can override this target in its full configuration. You can also prepare a smaller batch explicitly.",
    );
    fields.promotionBatchSize.type = "number";
    fields.promotionBatchSize.min = "1";
    fields.promotionBatchSize.max = "100";
    fields.promotionBatchSize.step = "1";
    fields.promotionBatchSize.value = String(
      config.workflow?.promotionBatchSize ?? 10,
    );
    for (const name of ["production", "staging", "integration"])
      field(branches, name, `${name[0].toUpperCase() + name.slice(1)} branch`);
    promotion.append(branches);
    sections.get("delivery").append(promotion);
    const commands = node("section", "command-settings");
    commands.append(
      node("h3", "", "How does your project prove it works?"),
      node(
        "p",
        "runner-guidance",
        "Set the commands your runners use in the app checkout. The Node examples below can be replaced with commands for your stack.",
      ),
    );
    const commandGrid = node("div", "project-form-grid");
    for (const name of ["install", "test", "lint", "typecheck", "build"]) {
      field(
        commandGrid,
        `command-${name}`,
        `${name[0].toUpperCase() + name.slice(1)}${["install", "test"].includes(name) ? " command" : " command (optional)"}`,
      );
      fields[`command-${name}`].value =
        config.commands?.[name] ||
        (name === "install" ? "npm ci" : name === "test" ? "npm test" : "");
      fields[`command-${name}`].required = ["install", "test"].includes(name);
    }
    commands.append(commandGrid);
    sections.get("checks").append(commands);
    const signalsContainer = node("div", "project-signals-settings");
    const signals = window.createSignalsSettings(
      signalsContainer,
      `${prefix}-signals`,
      config.telemetry,
      { ...options, instanceId: config.instanceId },
    );
    root.append(signalsContainer);
    const advanced = node(
      "p",
      "runner-guidance settings-advanced-note",
      "Other saved environments are kept. Manage additional production targets, remove environments, or edit advanced sign-in settings in Configuration.",
    );
    sections.get("environment").append(advanced);
    container.replaceChildren(root);
    const providerKeys = {
      url: ["url"],
      vercel: [
        "connectionId",
        "projectId",
        "teamId",
        "bypassSecret",
        "branch",
        "customEnvironmentId",
      ],
      railway: [
        "projectId",
        "environmentId",
        "serviceId",
        "tokenSecret",
        "tokenType",
        "branch",
      ],
      "cloud-run": ["projectId", "region", "service", "credentialsSecret"],
    };
    const requiredKeys = {
      url: ["url"],
      vercel: ["projectId"],
      railway: ["projectId", "environmentId", "serviceId"],
      "cloud-run": ["projectId", "region", "service"],
    };
    const connectionChoices = (selected = fields.connectionId.value) => {
      const profiles = connections.filter((item) => item.provider === "vercel");
      if (!profiles.some((item) => item.id === "default"))
        profiles.unshift({ id: "default", label: "Default connection" });
      if (selected && !profiles.some((item) => item.id === selected))
        profiles.push({ id: selected, label: selected + " · unavailable" });
      fields.connectionId.replaceChildren(
        ...profiles.map(
          (item) =>
            new Option(
              (item.label || item.id) +
                (item.workspace?.name ? " · " + item.workspace.name : ""),
              item.id === "default" ? "" : item.id,
            ),
        ),
      );
      fields.connectionId.value = selected === "default" ? "" : selected;
    };
    const loadTarget = (name) => {
      const target = environments[name] || {};
      connectionChoices(target.connectionId || "");
      fields.environment.value = name || "preview";
      fields.role.value = target.role === "staging" ? "staging" : "preview";
      for (const [key] of definitions)
        fields[key].value =
          target[key] || (key === "tokenSecret" ? "RAILWAY_TOKEN" : "");
      fields.tokenType.value = target.tokenType || "account";
      if (fields.existing) fields.existing.value = name;
      if (target.kind) fields.target.value = target.kind;
    };
    loadTarget(selectedName);
    fields.target.value = selectedName
      ? environments[selectedName]?.kind || "repository"
      : "repository";
    fields.workflow.value =
      config.workflow?.kind || (config.vercel ? "promotion" : "pull-request");
    fields.baseBranch.value =
      config.workflow?.baseBranch || config.branches?.production || "main";
    for (const name of ["production", "staging", "integration"])
      fields[name].value =
        config.branches?.[name] ||
        { production: "main", staging: "staging", integration: "pm-staging" }[
          name
        ];
    const render = () => {
      const kind = fields.target.value;
      dockerHint.hidden = kind !== "docker";
      browser.hidden = kind === "repository";
      for (const input of browser.querySelectorAll("input,select"))
        input.disabled = browser.hidden;
      fields.environment.required = !browser.hidden;
      for (const [key, wrapper] of Object.entries(wrappers)) {
        wrapper.hidden = !providerKeys[kind]?.includes(key);
        fields[key].disabled = browser.hidden || wrapper.hidden;
        fields[key].required =
          !fields[key].disabled && requiredKeys[kind]?.includes(key);
      }
      promotion.hidden = fields.workflow.value !== "promotion";
      fields.approvalPolicy.disabled = promotion.hidden;
      fields.promotionBatchSize.disabled = promotion.hidden;
      fields.promotionBatchSize.required = !promotion.hidden;
      baseWrapper.hidden = !promotion.hidden;
      fields.baseBranch.disabled = !promotion.hidden;
      fields.baseBranch.required = promotion.hidden;
      for (const name of ["production", "staging", "integration"]) {
        fields[name].disabled = promotion.hidden;
        fields[name].required = !promotion.hidden;
      }
    };
    fields.target.addEventListener("change", render);
    fields.connectionId.addEventListener("change", () => {
      fields.projectId.value = "";
      fields.teamId.value = "";
      fields.customEnvironmentId.value = "";
    });
    fields.workflow.addEventListener("change", render);
    fields.baseBranch.addEventListener("input", () => {
      branchEdited = true;
    });
    const targetValue = () => {
      const value = { role: fields.role.value, kind: fields.target.value };
      for (const key of providerKeys[fields.target.value] || [])
        if (fields[key].value.trim()) value[key] = fields[key].value.trim();
      return value;
    };
    const mergeTarget = (previous, target) => {
      const result = {
        ...(previous?.kind === target.kind ? previous : {}),
        ...target,
      };
      for (const key of providerKeys[target.kind] || [])
        if (!target[key]) delete result[key];
      return result;
    };
    fields.existing?.addEventListener("change", () => {
      const next = fields.existing.value;
      const previous = fields.environment.value.trim();
      if (previous && fields.target.value !== "repository")
        environments[previous] = mergeTarget(
          environments[previous],
          targetValue(),
        );
      selectedName = next;
      loadTarget(next);
      render();
    });
    render();
    let revealingInvalid = false;
    for (const input of Object.values(fields))
      input.addEventListener("invalid", () => {
        if (revealingInvalid) return;
        revealingInvalid = true;
        revealField(input);
        queueMicrotask(() => {
          revealingInvalid = false;
        });
      });
    const signature = () =>
      JSON.stringify(
        Object.entries(fields)
          .map(([key, item]) => [key, item.value])
          .concat([["environments", environments]]),
      );
    let baseline = signature();
    return {
      isDirty: () => signature() !== baseline || signals.isDirty(),
      setProjectName: (name) => signals.setProjectName(name),
      setConnections(value) {
        connections = value;
        connectionChoices();
      },
      focusProvider: (provider) => signals.focusProvider(provider),
      selectSection,
      focus: (key) => revealField(fields[key]),
      setDefaultBranch(value) {
        if (!branchEdited && value) {
          fields.baseBranch.value = value;
        }
      },
      read() {
        for (const input of root.querySelectorAll("input,select"))
          if (!input.disabled && !input.reportValidity())
            throw new Error("Complete the highlighted project setting.");
        const result = {
          environments: structuredClone(environments),
          workflow: {
            ...(fields.workflow.value === "promotion" &&
            config.workflow?.kind === "promotion"
              ? config.workflow
              : {}),
            kind: fields.workflow.value,
          },
          commands: {},
          verification: { mode: "repository" },
        };
        if (fields.workflow.value === "pull-request")
          result.workflow.baseBranch = fields.baseBranch.value.trim();
        else {
          result.workflow.promotionBatchSize = Number(
            fields.promotionBatchSize.value,
          );
          // Do not silently migrate a legacy project during an unrelated edit.
          if (
            config.workflow?.approvalPolicy ||
            fields.approvalPolicy.value !== "ticket"
          )
            result.workflow.approvalPolicy = fields.approvalPolicy.value;
          result.branches = Object.fromEntries(
            ["production", "staging", "integration"].map((name) => [
              name,
              fields[name].value.trim(),
            ]),
          );
        }
        for (const name of ["install", "test", "lint", "typecheck", "build"])
          result.commands[name] =
            fields[`command-${name}`].value.trim() || null;
        if (fields.target.value !== "repository") {
          const name = fields.environment.value.trim();
          if (result.environments[name]?.role === "production")
            throw new Error(
              "That name belongs to a production environment. Choose a preview or staging name.",
            );
          const target = targetValue();
          // Preserve fields outside this form, but never retain fields from another provider kind.
          result.environments[name] = mergeTarget(
            result.environments[name],
            target,
          );
          result.verification = { mode: "browser", environment: name };
        }
        // Omit untouched, absent telemetry; keep an explicit empty object when the
        // user disables the last provider so the config merge removes it.
        if (config.telemetry || signals.isDirty())
          result.telemetry = signals.read();
        return result;
      },
    };
  };
})();
