"use strict";
(() => {
  window.dashboardCommandItems = (status, jobs = []) => {
    const projects = Array.isArray(status?.projects) ? status.projects : [];
    const items = projects.map((project) => ({
      label: project.name,
      detail: "Project",
      href: `/projects/${encodeURIComponent(project.name)}`,
    }));
    for (const project of projects)
      for (const area of project.areas || [])
        items.push({
          label: area.name || area.key,
          detail: `Product manager · ${project.name}`,
          href: `/projects/${encodeURIComponent(project.name)}?pm=${encodeURIComponent(area.key)}`,
        });
    const recent = [...jobs]
      .filter((job) =>
        projects.some(
          (project) =>
            project.name === job.project &&
            (project.instanceId ?? null) === (job.projectInstanceId ?? null),
        ),
      )
      .sort((a, b) => (b.runId || 0) - (a.runId || 0))
      .slice(0, 10);
    for (const job of recent)
      items.push({
        label: `Run ${job.runId || ""} · ${job.project}`,
        detail: `${job.type === "developer" ? "Coding" : "Investigation"} · ${job.status}`,
        href: `/activity?run=${encodeURIComponent(job.id)}`,
      });
    for (const [label, href] of [
      ["Overview", "/overview"],
      ["Projects", "/projects"],
      ["Your gremlins", "/runners"],
      ["Activity", "/activity"],
      ["Connections", "/connections"],
      ["Usage", "/usage"],
      ["Review inbox", "/inbox"],
      ["Add a project", "/projects#project-form"],
      ["Connect source control", "/connections#source-control"],
      ["Connect AI", "/connections#model-connections"],
      ["Set up runners", "/runners#workers"],
      ["Workspace settings", "/settings"],
    ])
      items.push({ label, detail: "Workspace action", href });
    return items;
  };
  window.createDashboardCommands = ({ getStatus, getJobs, navigate }) => {
    const node = (tag, className, text) => {
      const value = document.createElement(tag);
      value.className = className || "";
      if (text !== undefined) value.textContent = text;
      return value;
    };
    const dialog = node("dialog", "command-menu"),
      heading = node("header"),
      title = node("h2", "", "Go somewhere"),
      close = node("button", "small-button", "Close"),
      input = node("input"),
      label = node(
        "label",
        "sr-only",
        "Search projects, recent runs, and setup",
      ),
      results = node("div", "command-menu-results"),
      count = node("p", "command-menu-count"),
      help = node(
        "p",
        "command-menu-help",
        "↑ ↓ to choose · Enter to open · Escape to close · Ctrl / ⌘ K opens this menu outside text fields.",
      );
    dialog.id = "workspace-command-menu";
    title.id = "command-menu-title";
    dialog.setAttribute("aria-labelledby", title.id);
    input.id = "command-menu-search";
    label.htmlFor = input.id;
    input.type = "search";
    input.placeholder = "Projects, recent runs, setup…";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "command-menu-results");
    input.setAttribute("aria-expanded", "true");
    results.id = "command-menu-results";
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-label", "Workspace destinations");
    count.setAttribute("role", "status");
    close.type = "button";
    heading.append(title, close);
    dialog.append(heading, label, input, count, results, help);
    document.body.append(dialog);
    let trigger = null,
      matches = [],
      active = 0;
    const finish = () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
      trigger = null;
    };
    const highlight = () => {
      for (const [index, button] of [...results.children].entries()) {
        button.setAttribute("aria-selected", String(index === active));
      }
      if (matches.length)
        input.setAttribute(
          "aria-activedescendant",
          `command-menu-option-${active}`,
        );
      else input.removeAttribute("aria-activedescendant");
    };
    const choose = (item) => {
      finish();
      navigate(item.href);
    };
    const paint = () => {
      const query = input.value.trim().toLowerCase();
      matches = window
        .dashboardCommandItems(getStatus(), getJobs?.() || [])
        .filter((item) =>
          `${item.label} ${item.detail}`.toLowerCase().includes(query),
        )
        .slice(0, 40);
      active = 0;
      results.replaceChildren(
        ...matches.map((item, index) => {
          const button = node("button", "command-menu-option");
          button.type = "button";
          button.id = `command-menu-option-${index}`;
          button.setAttribute("role", "option");
          button.tabIndex = -1;
          button.append(
            node("strong", "", item.label),
            node("span", "", item.detail),
          );
          button.addEventListener("click", () => choose(item));
          return button;
        }),
      );
      count.textContent = matches.length
        ? `${matches.length} destinations`
        : "No matching destinations. Try a project name or setup action.";
      highlight();
    };
    const open = () => {
      if (
        dialog.open ||
        document.querySelector("dialog[open]") ||
        document.body.classList.contains?.("auth-pending") ||
        document.body.classList.contains?.("auth-locked")
      )
        return;
      trigger = document.activeElement;
      input.value = "";
      paint();
      dialog.showModal();
      input.focus();
    };
    close.addEventListener("click", finish);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    input.addEventListener("input", paint);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation?.();
        finish();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = matches.length
          ? (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
            matches.length
          : 0;
        highlight();
        results.children[active]?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && matches[active]) {
        event.preventDefault();
        choose(matches[active]);
      }
    });
    const shortcut = (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")
      )
        return;
      if (
        event.target?.closest?.(
          "input,textarea,select,[contenteditable]:not([contenteditable='false'])",
        )
      )
        return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", shortcut);
    const existingLaunch = document.getElementById("quick-jump-trigger");
    const launch =
      existingLaunch || node("button", "command-menu-trigger", "Find anything");
    launch.type = "button";
    launch.setAttribute(
      "aria-label",
      "Search workspace (Control or Command K)",
    );
    launch.setAttribute("aria-haspopup", "dialog");
    launch.setAttribute("aria-controls", dialog.id);
    if (!existingLaunch) {
      launch.append(node("kbd", "", "⌘ / Ctrl K"));
      document.querySelector(".topbar")?.append(launch);
    }
    launch.addEventListener("click", open);
    return {
      open,
      close: finish,
      destroy() {
        document.removeEventListener("keydown", shortcut);
        dialog.remove();
        launch.removeEventListener("click", open);
        if (!existingLaunch) launch.remove();
      },
    };
  };
})();
