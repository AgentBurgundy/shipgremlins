"use strict";
(() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const labels = {
    source: "Connect source control",
    ai: "Connect Claude Code",
    linear: "Connect Linear",
    mapping: "Fix Linear mappings",
    verify: "Verify connections",
    worker: "Set up a worker",
    mandate: "Review PM settings",
    config: "Edit project settings",
  };
  function action(project, code, label, stepId) {
    const button = el(
      "button",
      "small-button setup-action",
      label ||
        ((code === "mapping" || code === "mandate") && !project.areas?.length
          ? "Create your first PM"
          : labels[code]) ||
        "Review setup",
    );
    button.type = "button";
    button.dataset.setupAction = code;
    button.dataset.setupProject = project.name;
    if (stepId) button.dataset.setupStep = stepId;
    return button;
  }
  window.renderCrewSetup = (project, { blockers, compact = false } = {}) => {
    const readiness = project.readiness;
    const root = el("section", "crew-setup" + (compact ? " compact" : ""));
    root.setAttribute("aria-label", `Setup for ${project.name}`);
    if (!readiness) {
      root.append(el("p", "setup-help", "Loading setup checks…"));
      return root;
    }
    const pending = blockers || readiness.blockers || [];
    const first = pending[0];
    const heading = el("div", "crew-setup-heading");
    heading.append(el("strong", "", first ? "Next step" : "Ready for a run"));
    heading.append(
      el(
        "span",
        "",
        first
          ? first.message
          : "Run once to review findings. Enable automation when you're ready for recurring work.",
      ),
    );
    if (first)
      heading.append(action(project, first.action, undefined, first.id));
    root.append(heading);
    if (!compact && readiness.steps?.length) {
      const steps = el("div", "crew-setup-steps");
      for (const step of readiness.steps) {
        const item = el(
          "button",
          "crew-setup-step" + (step.ready ? " ready" : ""),
          `${step.ready ? "✓" : "○"} ${step.label}`,
        );
        item.type = "button";
        item.dataset.setupAction = step.action;
        item.dataset.setupProject = project.name;
        item.dataset.setupStep = step.id;
        item.title = step.message;
        steps.append(item);
      }
      root.append(steps);
    }
    if (pending.length > 1) {
      const details = el("details", "crew-setup-more");
      details.append(
        el(
          "summary",
          "",
          `${pending.length - 1} more setup ${pending.length === 2 ? "step" : "steps"}`,
        ),
      );
      for (const item of pending.slice(1)) {
        const row = el("div", "crew-setup-item");
        row.append(
          el("span", "", item.message),
          action(project, item.action, undefined, item.id),
        );
        details.append(row);
      }
      root.append(details);
    }
    return root;
  };
  window.renderPmControls = (
    project,
    area,
    { locked = false, operation, jobs = [] } = {},
  ) => {
    const root = el("div", "pm-simple-controls"),
      buttons = el("div", "pm-simple-actions");
    const run = el(
      "button",
      "button button-dark",
      operation?.busy && operation.mode === "run"
        ? "Starting…"
        : jobs.some(
              (job) =>
                job.type === "pm" &&
                job.project === project.name &&
                job.area === area.key &&
                ["queued", "running"].includes(job.status),
            )
          ? "View run"
          : "Run now",
    );
    run.type = "button";
    Object.assign(run.dataset, {
      launchProject: project.name,
      launchCrew: "pm",
      launchArea: area.key,
    });
    run.disabled = locked || Boolean(operation?.busy);
    const toggle = el(
      "button",
      "pm-automation-switch" + (area.enabled ? " enabled" : ""),
    );
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(Boolean(area.enabled)));
    toggle.setAttribute(
      "aria-label",
      `Automation for ${area.name || area.key}`,
    );
    Object.assign(toggle.dataset, {
      toggleArea: area.key,
      areaProject: project.name,
      enableArea: String(!area.enabled),
    });
    toggle.append(
      el("span", "pm-switch-track"),
      el(
        "span",
        "",
        operation?.busy && operation.mode === "automation"
          ? "Saving…"
          : `Automation ${area.enabled ? "on" : "off"}`,
      ),
    );
    toggle.disabled = locked || Boolean(operation?.busy);
    buttons.append(run, toggle);
    root.append(buttons);
    if (operation?.message) {
      const message = el(
        "p",
        "form-message" + (operation.error ? " error" : ""),
        operation.message,
      );
      message.setAttribute("role", operation.error ? "alert" : "status");
      root.append(message);
    }
    return root;
  };
  window.renderProjectCrew = (
    project,
    { locked = false, areaActions = new Map(), jobs = [] } = {},
  ) => {
    const root = el("section", "project-crew");
    root.append(window.renderCrewSetup(project));
    const heading = el("div", "project-crew-heading");
    heading.append(el("h3", "", "PM Gremlins"));
    const add = el("button", "small-button", "+ Add PM");
    add.type = "button";
    add.dataset.createPmProject = project.name;
    add.disabled = locked;
    heading.append(add);
    root.append(heading);
    const areas = project.areas || [];
    if (!areas.length)
      root.append(
        el(
          "p",
          "setup-help",
          "Give your first PM a mandate. It starts paused so you can review its setup.",
        ),
      );
    for (const area of areas) {
      const operation = areaActions.get(`${project.name}/${area.key}`);
      const card = el("article", "pm-control-card");
      const identity = el("div", "pm-control-identity");
      const image = el("img", "");
      image.src = "/assets/gremlin-security.webp";
      image.alt = "";
      image.width = 44;
      image.height = 50;
      image.loading = "lazy";
      const text = el("div", "");
      text.append(el("strong", "", area.name || area.key));
      text.append(
        el(
          "span",
          "pm-automation-state" + (area.enabled ? " enabled" : ""),
          area.enabled ? "Automation on" : "Automation paused",
        ),
      );
      identity.append(image, text);
      card.append(identity);
      if (area.mandate)
        card.append(el("p", "pm-control-mandate", area.mandate));
      card.append(
        el(
          "p",
          "setup-help",
          `Schedule: ${area.schedule || "not configured"} UTC · Up to ${area.wipLimit || 1} open work items`,
        ),
      );
      card.append(
        window.renderPmControls(project, area, { locked, operation, jobs }),
      );
      root.append(card);
    }
    const footer = el("div", "project-crew-footer");
    footer.append(
      el(
        "p",
        "setup-help",
        "Automation runs scheduled PM patrols and picks up approved coding tickets. Run once leaves automation unchanged. Pausing keeps current jobs running.",
      ),
    );
    footer.append(action(project, "mapping", "Manage Linear mappings"));
    root.append(footer);
    return root;
  };
})();
