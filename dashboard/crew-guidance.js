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
          ? "Adopt your first gremlin"
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
    if (project.foundation?.needed) {
      const foundation = el("a", "small-button", "Build the foundation first");
      foundation.href = `/projects/${encodeURIComponent(project.name)}?tab=environment`;
      root.append(foundation);
      return root;
    }
    const run = el(
      "button",
      "button button-dark",
      operation?.busy && operation.mode === "run"
        ? "Starting…"
        : jobs.some(
              (job) =>
                job.type === "pm" &&
                job.project === project.name &&
                (job.projectInstanceId ?? null) ===
                  (project.instanceId ?? null) &&
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
    if (operation?.message && operation.error) {
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
  window.renderFoundationLauncher = (project) => {
    const stage = project.foundation?.stage;
    const active = ["queued", "building"].includes(stage);
    const root = el("section", "foundation-launch");
    const copy = el("div", "foundation-launch-copy");
    copy.append(
      el("span", "eyebrow muted", "YOUR FIRST MILESTONE"),
      el(
        "h2",
        "",
        active
          ? "Your foundation is taking shape"
          : stage === "review-code"
            ? "Your first build is ready to review"
            : "Let’s build something your PMs can explore",
      ),
      el(
        "p",
        "",
        active
          ? "A coding agent is building the first working version on your runner. Follow its progress and review the pull request here."
          : "Start with a working app and checks. Your crew sets up Linear and gives a coding agent a focused foundation ticket.",
      ),
    );
    const action = el(
      "a",
      "button button-dark",
      active
        ? "View build"
        : stage === "review-code"
          ? "Review foundation"
          : "Build foundation",
    );
    action.href = `/projects/${encodeURIComponent(project.name)}?tab=environment`;
    root.append(copy, action);
    return root;
  };
  window.renderProjectCrew = (
    project,
    { locked = false, areaActions = new Map(), jobs = [] } = {},
  ) => {
    const root = el("section", "project-crew");
    const heading = el("div", "project-crew-heading");
    heading.append(el("h3", "", "PM Gremlins"));
    const add = el("button", "small-button", "Adopt a gremlin");
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
          "Adopt a PM Gremlin and give it a focused job. You choose its first assignment when it is ready.",
        ),
      );
    for (const area of areas) {
      const operation = areaActions.get(`${project.name}/${area.key}`);
      const card = el("article", "project-pm-row");
      const image = el("img", "");
      image.src =
        window.gremlinIdentity?.(area)?.image || "/assets/gremlin.webp";
      image.alt = "";
      image.width = image.height = 48;
      image.loading = "lazy";
      const copy = el("div", "project-pm-copy"),
        heading = el("h3", ""),
        name = el("a", "", area.name || area.key);
      name.href = `/projects/${encodeURIComponent(project.name)}?pm=${encodeURIComponent(area.key)}`;
      heading.append(name);
      copy.append(
        heading,
        el(
          "p",
          "project-pm-mandate",
          area.charter?.goal ||
            area.mandate ||
            "Add a mandate to give this PM direction.",
        ),
      );
      card.append(
        image,
        copy,
        window.renderPmControls(project, area, { locked, operation, jobs }),
      );
      root.append(card);
    }
    const footer = el("details", "project-crew-footer workspace-disclosure");
    footer.append(el("summary", "", "Setup & automation details"));
    footer.append(window.renderCrewSetup(project));
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
