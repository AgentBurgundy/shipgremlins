"use strict";
(() => {
  const node = (tag, className = "", text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const setupLabels = {
    source: "Connect source control",
    ai: "Connect Claude",
    linear: "Connect Linear",
    mapping: "Prepare Linear",
    verify: "Verify connections",
    worker: "Set up a runner",
    mandate: "Review PM brief",
    config: "Open project settings",
    environment: "Set up app sign-in",
  };
  const sameProject = (job, project) =>
    job.type === "developer" &&
    job.project === project.name &&
    (job.projectInstanceId ?? null) === (project.instanceId ?? null);
  const launchButton = (project, label, disabled, secondary = false) => {
    const button = node(
      "button",
      secondary ? "small-button" : "button button-dark",
      label,
    );
    button.type = "button";
    button.disabled = disabled;
    Object.assign(button.dataset, {
      launchProject: project.name,
      launchCrew: "developer",
    });
    return button;
  };
  const link = (label, href, secondary = false) => {
    const element = node(
      "a",
      secondary ? "coding-launch-link" : "button button-dark",
      label,
    );
    element.href = href;
    return element;
  };

  window.renderCodingLauncher = (
    project,
    { locked = false, jobs = [], operation, compact = false } = {},
  ) => {
    const root = node(
      "section",
      `coding-launch${compact ? " coding-launch-compact" : ""}`,
    );
    root.setAttribute("aria-label", `Coding agents for ${project.name}`);
    const identity = node("div", "coding-launch-identity"),
      avatar = node("img", "coding-launch-avatar"),
      copy = node("div", "coding-launch-copy"),
      status = node("span", "coding-launch-status", "CODING AGENTS"),
      title = node("h3"),
      description = node("p"),
      actions = node("div", "coding-launch-actions"),
      progress = node("div", "coding-launch-progress");
    avatar.src = "/assets/gremlin-coding.webp";
    avatar.alt = "";
    avatar.width = avatar.height = 56;
    avatar.loading = "lazy";
    const active = jobs.filter(
      (job) =>
        sameProject(job, project) && ["queued", "running"].includes(job.status),
    );
    const confirmed = jobs.find((job) => job.id === operation?.job?.id);
    const latest =
      active.find((job) => job.status === "running") ||
      active[0] ||
      (!confirmed ? operation?.job : null);
    // Test login limits browser patrols; approved coding can still proceed.
    const blocker =
      project.readiness?.areas
        ?.flatMap((area) => area.coding?.enableBlockers || [])
        .find((item) => item.id === "promotion_environment") ||
      project.readiness?.blockers?.find(
        (item) => !["test_access", "browser_verification"].includes(item.id),
      );
    const path = `/projects/${encodeURIComponent(project.name)}`;
    const promotion = project.workflow?.kind === "promotion";
    root.dataset.state = "ready";
    title.textContent = "Put your runners to work";
    description.textContent = promotion
      ? "Find the next approved ticket and build it. Your PM tests the deployed change before it joins your promotion batch."
      : "Find the next approved ticket, build the change, and open a draft pull request.";

    if (operation?.busy) {
      root.dataset.state = "searching";
      root.setAttribute("aria-busy", "true");
      title.textContent = "Finding your next ticket…";
      description.textContent =
        "Checking approval, PM ownership, and work already in progress.";
      actions.append(launchButton(project, "Finding work…", true));
      progress.setAttribute("role", "status");
      progress.textContent = "Looking through this project’s Linear queue.";
    } else if (
      operation?.kind === "existing" &&
      (confirmed || operation.job)?.status === "succeeded"
    ) {
      const completed = confirmed || operation.job;
      root.dataset.state = "completed";
      title.textContent = "This ticket already has completed work";
      description.textContent = promotion
        ? `${completed.ticket || "Your ticket"} has a completed coding run. Follow its checks, PM QA and promotion status in Changes; a successful coding run is not a QA pass.`
        : `${completed.ticket || "Your ticket"} has a completed coding run. Review its changes and any draft pull request before requesting another implementation.`;
      actions.append(
        link(
          promotion ? "Follow delivery" : "Review existing run",
          promotion
            ? `${path}?tab=changes`
            : `/activity?run=${encodeURIComponent(completed.id)}`,
        ),
        launchButton(project, "Find another ticket", locked, true),
      );
      progress.textContent = "No duplicate run was started.";
    } else if (operation?.kind === "empty") {
      root.dataset.state = "empty";
      title.textContent = active.length
        ? "Your ready work is already underway"
        : "No approved work is ready";
      description.textContent = active.length
        ? "No additional approved ticket can start yet. Follow the current runs, or review the next proposal."
        : "Approve a proposal to give your coding agents something to build. Tickets already attempted stay in Activity for review.";
      actions.append(
        active.length
          ? link(
              "View progress",
              `/activity?run=${encodeURIComponent(latest.id)}`,
            )
          : link("Review proposals", `${path}?tab=review`),
        launchButton(project, "Check again", locked, true),
      );
    } else if (operation?.kind === "error" || operation?.kind === "uncertain") {
      root.dataset.state = "error";
      title.textContent =
        operation.kind === "uncertain"
          ? "Check whether your run started"
          : "Coding needs your attention";
      description.textContent = operation.message;
      description.setAttribute("role", "alert");
      if (operation.kind === "uncertain")
        actions.append(link("Open Activity", "/activity"));
      else
        actions.append(
          launchButton(project, "Try again", locked),
          link("Project setup", path, true),
        );
    } else if (latest) {
      root.dataset.state = "active";
      title.textContent = active.some((job) => job.status === "running")
        ? "Your coding agents are working"
        : "Your coding run is queued";
      description.textContent =
        latest.status === "running"
          ? `${latest.ticket || "Approved work"} is being implemented on your runner.`
          : `${latest.ticket || "Approved work"} will start when an eligible runner has capacity.`;
      const view = link(
        "View progress",
        `/activity?run=${encodeURIComponent(latest.id)}`,
      );
      actions.append(
        view,
        launchButton(project, "Start another", locked, true),
      );
      progress.textContent =
        active.length > 1
          ? `${active.length} coding runs in progress`
          : promotion
            ? "Your PM tests the change. You review the promotion batch."
            : "You’ll get a draft pull request to review.";
    } else if (!project.readiness) {
      root.dataset.state = "loading";
      title.textContent = "Checking your runners";
      description.textContent = "Checking the connections for this project.";
      actions.append(launchButton(project, "Checking setup…", true));
    } else if (
      blocker &&
      (!project.readiness.canRun || blocker.id === "promotion_environment")
    ) {
      root.dataset.state = "setup";
      title.textContent = "One step closer to your first run";
      description.textContent = blocker.message;
      const setup = node(
        "button",
        "button button-dark",
        blocker.id === "promotion_environment"
          ? "Set up test deployment"
          : setupLabels[blocker.action] || "Review setup",
      );
      setup.type = "button";
      setup.disabled = locked;
      Object.assign(setup.dataset, {
        setupProject: project.name,
        setupAction: blocker.action,
        setupStep: blocker.id,
      });
      actions.append(setup);
    } else {
      actions.append(launchButton(project, "Start coding", locked));
      progress.textContent = "Approved tickets only · One ticket per run";
    }

    copy.append(status, title, description);
    identity.append(avatar, copy);
    root.append(identity, actions);
    if (progress.textContent) root.append(progress);
    return root;
  };

  window.createCodingActions = ({
    api,
    getProject,
    isLocked,
    onState,
    onChanged,
    onJob,
    onFinished,
  }) => {
    const states = new Map();
    const stateFor = (name) => {
      const state = states.get(name);
      return state &&
        state.instanceId === (getProject(name)?.instanceId ?? null)
        ? state
        : undefined;
    };
    async function run(name) {
      const project = getProject(name);
      if (!project || isLocked() || stateFor(name)?.busy) return;
      // The server selects and revalidates the ticket. This action never supplies
      // an approval label, bypasses admission, or changes scheduled automation.
      const state = { busy: true, instanceId: project.instanceId ?? null };
      states.set(name, state);
      onState();
      try {
        const result = await api(
          "/api/jobs",
          { type: "developer", project: name },
          "POST",
          90000,
        );
        if (!result?.job?.id) {
          Object.assign(state, {
            kind: "uncertain",
            message:
              "The server did not confirm this run. Check Activity before trying again.",
          });
        } else {
          Object.assign(state, {
            kind: result.reused ? "existing" : "queued",
            job: result.job,
          });
          // A status refresh failure must never turn an accepted run into a
          // failed launch or invite a duplicate dispatch.
          await Promise.resolve()
            .then(onChanged)
            .catch(() => {});
          try {
            onJob(result.job);
          } catch {
            // The progress link remains available if the viewer cannot open.
          }
        }
      } catch (error) {
        const message = error.message || "Could not reach the dashboard.";
        const uncertain =
          !error.status &&
          /too long|cannot reach|unexpected response|network|failed to fetch/i.test(
            message,
          );
        Object.assign(state, {
          kind: uncertain
            ? "uncertain"
            : /No approved tickets are ready/i.test(message)
              ? "empty"
              : "error",
          message: uncertain
            ? "The connection ended before the server confirmed this run. Check Activity before trying again."
            : message,
        });
      } finally {
        state.busy = false;
        onState();
        onFinished?.();
      }
    }
    return {
      run,
      getState: stateFor,
      isBusy: () => [...states.values()].some((state) => state.busy),
    };
  };
})();
