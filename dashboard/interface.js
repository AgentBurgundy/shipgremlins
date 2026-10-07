"use strict";

// Focused settings surfaces preserve the original form nodes and their drafts.
(() => {
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  const connections = document.getElementById("connections");
  if (!connections) return;
  // Provider dialogs take over visibility and labels from legacy category tabs.
  window.dashboardShell?.releaseConnections?.();
  // Navigation switches views without rebuilding controls or discarding drafts.
  const surfaces = [];
  function surface(host, label, entries, before) {
    const nav = node("nav", "surface-tabs settings-navigation");
    nav.setAttribute("aria-label", label);
    const activate = (key) => {
      for (const entry of entries) {
        entry.panel.hidden = entry.key !== key;
        entry.button.setAttribute(
          "aria-current",
          entry.key === key ? "page" : "false",
        );
      }
    };
    for (const entry of entries) {
      entry.button = node("button", "", entry.label);
      entry.button.type = "button";
      entry.button.addEventListener("click", () => activate(entry.key));
      nav.append(entry.button);
    }
    const firstPanel = [...host.children].find((child) =>
      entries.some((entry) => entry.panel === child),
    );
    host.insertBefore(nav, before || firstPanel || entries[0].panel);
    const reveal = (target) => {
      const entry = entries.find(
        (entry) => entry.panel === target || entry.panel.contains(target),
      );
      if (entry) activate(entry.key);
    };
    host.addEventListener(
      "invalid",
      (event) => {
        const first = host.querySelector(":invalid:not(fieldset):not(form)");
        if (!first || first === event.target) reveal(event.target);
      },
      true,
    );
    activate(entries[0].key);
    surfaces.push({ reveal });
    return { reveal };
  }
  const settings = document.getElementById("configuration");
  if (settings)
    surface(settings, "Workspace settings", [
      ...(document.getElementById("account-access")
        ? [
            {
              key: "account",
              label: "Account access",
              panel: document.getElementById("account-access"),
            },
          ]
        : []),
      {
        key: "updates",
        label: "Updates",
        panel: document.getElementById("updates"),
      },
      {
        key: "deleted",
        label: "Recently deleted",
        panel: document.getElementById("deleted-resources"),
      },
      {
        key: "configuration",
        label: "Configuration",
        panel: document.getElementById("advanced-settings"),
      },
    ]);
  const runners = document.getElementById("runners");
  if (runners) {
    const workbench = node("section", "runner-workbench");
    workbench.id = "runner-workbench";
    const workers = document.getElementById("workers");
    workbench.append(
      runners.querySelector(".jobs-heading"),
      document.getElementById("job-form"),
    );
    runners.insertBefore(workbench, workers);
    surface(runners, "Runner workspace", [
      ...(document.getElementById("crew-roster")
        ? [
            {
              key: "crew",
              label: "Your crew",
              panel: document.getElementById("crew-roster"),
            },
          ]
        : []),
      { key: "run", label: "Start a run", panel: workbench },
      { key: "workers", label: "Runners", panel: workers },
    ]);
    const shortcut = runners.querySelector(".panel-heading a");
    if (shortcut) shortcut.hidden = true;
  }
  window.revealDashboardSetting = (target) => {
    surfaces.forEach((surface) => surface.reveal(target));
    window.gremlinAdoption?.reveal(target);
  };
  window.addEventListener("dashboard:pagechange", (event) => {
    const hash = new URL(event.detail.path, location.origin).hash.slice(1);
    const target = document.getElementById(
      hash === "configuration" ? "advanced-settings" : hash,
    );
    if (target) window.revealDashboardSetting(target);
  });
  const initialHash = location.hash.slice(1);
  const initialTarget = document.getElementById(
    initialHash === "configuration" ? "advanced-settings" : initialHash,
  );
  if (initialTarget) window.revealDashboardSetting(initialTarget);
  const definitions = [
    [
      "model-connections",
      "Claude Code",
      "The intelligence behind your gremlins.",
      "claude",
      "essentials",
    ],
    [
      "source-control",
      "GitHub & GitLab",
      "Your repositories, branches, and pull requests.",
      "github",
      "essentials",
    ],
    [
      "linear-connection",
      "Linear",
      "Ideas become tickets. Gremlins keep them organized.",
      "linear",
      "essentials",
    ],
    [
      "slack-connection",
      "Slack",
      "Get useful updates where your team talks.",
      "slack",
      "extras",
    ],
    [
      "vercel-connection",
      "Vercel",
      "Preview deployments and automatic test access.",
      "vercel",
      "hosting",
    ],
    [
      "railway-connection",
      "Railway",
      "A test home for apps and services.",
      "railway",
      "hosting",
    ],
    [
      "cloud-run-connection",
      "Google Cloud",
      "Test your app on a Cloud Run service.",
      "googlecloud",
      "hosting",
    ],
    [
      "sentry-connection",
      "Sentry",
      "Turn real errors into useful investigations.",
      "sentry",
      "insights",
    ],
    [
      "datadog-connection",
      "Datadog",
      "Give your PMs context from application logs.",
      "datadog",
      "insights",
    ],
    [
      "mixpanel-connection",
      "Mixpanel",
      "Understand how people actually use your product.",
      "mixpanel",
      "insights",
    ],
    [
      "project-access",
      "App access",
      "Dedicated test accounts and project credentials.",
      null,
      "extras",
    ],
  ];
  const categories = [
    ["all", "All connections"],
    ["essentials", "Start here"],
    ["hosting", "Hosting"],
    ["insights", "Product insights"],
    ["extras", "Notifications & access"],
  ];
  const library = node("div", "connection-library");
  const toolbar = node("div", "connection-library-toolbar");
  const searchLabel = node("label", "connection-library-search");
  const search = node("input");
  search.type = "search";
  search.placeholder = "Find a connection…";
  search.setAttribute("aria-label", "Find a connection");
  searchLabel.append(search);
  const tabs = node("nav", "surface-tabs");
  tabs.setAttribute("aria-label", "Connection categories");
  const grid = node("div", "connection-library-grid");
  const help = node("p", "connection-library-help");
  const empty = node(
    "p",
    "connection-library-empty",
    "No matching connections. Try a provider name or a different category.",
  );
  empty.hidden = true;
  empty.setAttribute("role", "status");
  const dialog = node("dialog", "connection-detail-dialog");
  dialog.setAttribute("aria-labelledby", "connection-detail-title");
  const header = node("header", "surface-dialog-header");
  const title = node("h2", "", "Connection");
  title.id = "connection-detail-title";
  const dialogCopy = node("div", "connection-dialog-copy");
  const dialogDescription = node("p", "connection-dialog-description");
  dialogDescription.id = "connection-detail-description";
  dialog.setAttribute("aria-describedby", dialogDescription.id);
  dialogCopy.append(title, dialogDescription);
  const close = node("button", "icon-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close connection settings");
  header.append(dialogCopy, close);
  const body = node("div", "surface-dialog-body");
  const continuation = node("footer", "connection-onboarding-next");
  const continueSetup = node("a", "small-button", "Continue setup →");
  continueSetup.href = "/overview";
  continueSetup.addEventListener("click", () => dialog.close());
  continuation.append(
    node("p", "", "Saved your connection? See what your gremlin needs next."),
    continueSetup,
  );
  dialog.append(header, body, continuation);
  const entries = new Map();
  let trigger = null;
  let selectedCategory = "all";
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const entry of entries.values()) {
      const matches =
        (selectedCategory === "all" || entry.category === selectedCategory) &&
        (!query || entry.searchText.includes(query));
      entry.tile.hidden = !matches;
      if (matches) visible++;
    }
    empty.hidden = visible > 0;
  };
  search.addEventListener("input", filter);
  const select = (category) => {
    selectedCategory = category;
    for (const tab of tabs.children)
      tab.setAttribute(
        "aria-current",
        tab.dataset.category === category ? "page" : "false",
      );
    filter();
    help.textContent = {
      all: "Your crew’s connections, in one place. Connect the essentials, then add hosting and product signals.",
      essentials:
        "Connect your AI, source control, and Linear. Your gremlins handle routine project setup from there.",
      hosting:
        "Connect your hosting provider so gremlins can find previews and test your app.",
      insights:
        "Optional context for better product decisions. Add these when you have signals to learn from.",
      extras:
        "Keep up with your crew, and give browser tests the access they need.",
    }[category];
  };
  const finish = () => {
    dialog.close();
    trigger?.focus?.();
  };
  close.addEventListener("click", finish);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      finish();
  });
  const open = (id, source) => {
    const entry = entries.get(id);
    if (!entry) return;
    if (!source && search.value) {
      search.value = "";
      filter();
    }
    trigger = source || entry.button;
    title.textContent = entry.name;
    dialogDescription.textContent = entry.description;
    for (const candidate of entries.values())
      candidate.panel.hidden = candidate !== entry;
    if (!dialog.open) dialog.showModal();
    close.focus();
  };
  for (const [id, name, description, brand, category] of definitions) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    const tile = node("article", "connection-tile");
    const identity = node("div", "connection-tile-identity");
    const mark = node("span", "connection-tile-mark", brand ? "" : "↳");
    if (brand) {
      const image = node("img");
      image.src = `/assets/brands/${brand}.svg`;
      image.alt = "";
      image.width = image.height = 25;
      mark.append(image);
    }
    identity.append(mark, node("h3", "", name));
    const detail = node("p", "", description);
    const footer = node("div", "connection-tile-footer");
    const badge = node("span", "connection-tile-state", "Configure");
    const button = node("button", "small-button", "Manage");
    button.type = "button";
    button.setAttribute("aria-label", `Manage ${name}`);
    button.addEventListener("click", () => open(id, button));
    footer.append(badge, button);
    tile.append(identity, detail, footer);
    grid.append(tile);
    panel.hidden = true;
    panel.classList.add("connection-detail-panel");
    if (
      [
        "model-connections",
        "railway-connection",
        "cloud-run-connection",
        "sentry-connection",
        "datadog-connection",
        "mixpanel-connection",
      ].includes(id)
    ) {
      for (const detail of panel.querySelectorAll("details.service-advanced")) {
        detail.open = true;
        detail.classList.add("connection-primary-form");
      }
    }
    body.append(panel);
    entries.set(id, {
      tile,
      panel,
      button,
      name,
      description,
      category,
      searchText: `${name} ${description} ${category}`.toLowerCase(),
    });
    const sync = () => {
      const state = panel.querySelector(
        ".runtime-badge, .signal-state, .saved-state, .token-state",
      );
      const sourceCount =
        id === "source-control"
          ? document.getElementById("source-count")?.textContent
          : null;
      const text =
        sourceCount && sourceCount !== "—"
          ? `${sourceCount} connected`
          : state?.textContent?.trim() ||
            (id === "project-access" ? "Project scoped" : "Manage access");
      if (badge.textContent !== text) badge.textContent = text;
      button.textContent =
        /^(?:not connected|not configured|missing|set up)/i.test(text)
          ? "Connect"
          : "Manage";
      badge.classList.toggle(
        "is-connected",
        /^(?:✓\s*)?(connected|saved|configured|[1-9])/i.test(text),
      );
      const attention = /unavailable|failed|error|expired/i.test(text);
      badge.classList.toggle("is-unavailable", attention);
      panel.dataset.connectionStatus = attention ? "attention" : "default";
    };
    new MutationObserver(sync).observe(panel, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    sync();
  }
  for (const [key, label] of categories) {
    const button = node("button", "", label);
    button.type = "button";
    button.dataset.category = key;
    button.addEventListener("click", () => select(key));
    tabs.append(button);
  }
  for (const group of connections.querySelectorAll(
    ":scope > .integration-group",
  ))
    group.hidden = true;
  connections.querySelector(".connection-categories")?.remove();
  toolbar.append(tabs, searchLabel);
  library.append(toolbar, help, grid, empty);
  connections.querySelector(".panel-heading").after(library);
  connections.append(dialog);
  select("all");
  const followRoute = (event) => {
    if (event.detail?.page !== "connections") {
      if (dialog.open) dialog.close();
      return;
    }
    const hash = new URL(event.detail.path, location.origin).hash.slice(1);
    const target = document.getElementById(hash);
    const entry = [...entries.values()].find(
      (value) => value.panel === target || value.panel.contains(target),
    );
    if (entry) {
      select(entry.category);
      open(entry.panel.id);
    } else {
      if (dialog.open) dialog.close();
      const category = {
        "crew-connections": "essentials",
        "hosting-connections": "hosting",
        "signals-connections": "insights",
      }[hash];
      if (category) select(category);
    }
  };
  window.addEventListener("dashboard:pagechange", followRoute);
  if (window.dashboardPages?.current === "connections")
    followRoute({ detail: { page: "connections", path: location.href } });
})();
