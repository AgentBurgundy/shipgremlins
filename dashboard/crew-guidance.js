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
  window.renderProjectCrew = (
    project,
    { locked = false, areaActions = new Map() } = {},
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
      const status = project.readiness?.areas?.find(
        (item) => item.key === area.key,
      );
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
      const buttons = el("div", "pm-control-actions");
      const run = el("button", "small-button launch-pm", "Run once");
      run.type = "button";
      run.dataset.launchProject = project.name;
      run.dataset.launchCrew = "pm";
      run.dataset.launchArea = area.key;
      run.dataset.projectControl = `run-${area.key}`;
      run.disabled = locked || operation?.busy === true;
      const toggle = el(
        "button",
        "small-button",
        operation?.busy
          ? "Saving…"
          : area.enabled
            ? "Pause automation"
            : "Enable automation",
      );
      toggle.type = "button";
      toggle.dataset.toggleArea = area.key;
      toggle.dataset.areaProject = project.name;
      toggle.dataset.enableArea = String(!area.enabled);
      toggle.dataset.projectControl = `toggle-${area.key}`;
      toggle.disabled =
        locked ||
        operation?.busy === true ||
        (!area.enabled && status?.canEnable !== true);
      buttons.append(run, toggle);
      card.append(buttons);
      if (!area.enabled && status?.canEnable !== true) {
        const blocker = (status?.enableBlockers || status?.blockers)?.find(
          (item) => item.action !== "worker",
        );
        const note = el("div", "pm-control-blocker");
        note.append(
          el(
            "span",
            "",
            blocker?.message ||
              "Complete the setup checks to enable automation.",
          ),
        );
        if (blocker)
          note.append(action(project, blocker.action, undefined, blocker.id));
        card.append(note);
      }
      if (operation?.message) {
        const message = el(
          "p",
          "form-message" + (operation.error ? " error" : ""),
          operation.message,
        );
        message.setAttribute("role", operation.error ? "alert" : "status");
        card.append(message);
      }
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
