"use strict";
(() => {
  const node = (tag, text, className = "") => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  window.createPmActions = ({
    api,
    getProject,
    getJobs,
    isLocked,
    states,
    onState,
    onChanged,
    onJob,
    onFinished,
  }) => {
    const dialog = node("dialog", undefined, "pm-action-dialog");
    dialog.setAttribute("aria-labelledby", "pm-action-title");
    const heading = node("header"),
      identity = node("div"),
      title = node("h2"),
      subtitle = node("p"),
      close = node("button", "Close ×", "small-button"),
      content = node("div", undefined, "pm-action-steps"),
      status = node("p", "", "form-message"),
      refresh = node("button", "Check again", "button button-dark");
    title.id = "pm-action-title";
    close.type = refresh.type = "button";
    status.setAttribute("role", "status");
    identity.append(title, subtitle);
    heading.append(identity, close);
    dialog.append(heading, content, status, refresh);
    document.body.append(dialog);
    let context = null,
      checking = false;
    // Keep a confirmed run available even when the following dashboard refresh
    // fails or has not observed it yet. A second click opens that run.
    const acceptedJobs = new Map();
    const labels = {
      source: "Connect source control",
      ai: "Connect Claude",
      linear: "Connect Linear",
      mapping: "Fix this PM’s Linear mapping",
      verify: "Verify project",
      worker: "Set up a worker",
      mandate: "Edit PM brief",
      config: "Edit project settings",
    };
    const canPrepareRun = (readiness) =>
      readiness?.canRun === true ||
      (readiness?.blockers?.length > 0 &&
        readiness.blockers.every((blocker) =>
          ["linear_mapping", "verification"].includes(blocker.id),
        ));
    function finish() {
      if (checking) return;
      dialog.close();
      context?.trigger?.focus?.();
      context = null;
    }
    close.addEventListener("click", finish);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    function target(projectName, areaKey) {
      const project = getProject(projectName),
        area = project?.areas?.find((value) => value.key === areaKey);
      if (!project || !area) return null;
      const readiness = project.readiness?.areas?.find(
        (value) => value.key === areaKey,
      );
      return { project, area, readiness };
    }
    function paintSetup() {
      if (!context) return;
      const current = target(context.project, context.area);
      const automation = context.mode === "automation";
      title.textContent = automation
        ? "Turn automation on"
        : context.mode === "exploration"
          ? "Explore product ideas"
          : "Start this PM";
      subtitle.textContent = `${context.project} / ${current?.area.name || context.area}`;
      content.replaceChildren();
      status.textContent = "";
      status.hidden = true;
      const blockers = automation
        ? current?.readiness?.enableBlockers
        : current?.readiness?.blockers;
      const ready = automation
        ? current?.readiness?.canEnable
        : canPrepareRun(current?.readiness);
      if (ready)
        content.append(
          node("p", "Ready. Your PM keeps its saved mandate and settings."),
        );
      else {
        content.append(
          node(
            "p",
            automation
              ? "Finish these steps to schedule patrols and pick up approved coding tickets."
              : "Finish these steps, then run this PM. Automation will stay unchanged.",
          ),
        );
        for (const blocker of blockers || []) {
          const row = node("section", undefined, "pm-action-step"),
            button = node(
              "button",
              labels[blocker.action] || "Review setup",
              "small-button",
            );
          button.type = "button";
          Object.assign(button.dataset, {
            setupAction: blocker.action,
            setupProject: context.project,
            setupArea: context.area,
            setupStep: blocker.id,
          });
          button.addEventListener("click", finish);
          row.append(node("p", blocker.message), button);
          content.append(row);
        }
        if (!blockers?.length)
          content.append(
            node(
              "p",
              "Setup checks are not available yet. Check again to refresh this PM.",
            ),
          );
      }
      refresh.textContent = checking
        ? "Checking…"
        : ready
          ? automation
            ? "Turn automation on"
            : "Run now"
          : "Check again";
      refresh.disabled = checking || isLocked();
      close.disabled = checking;
    }
    function showSetup(project, area, mode, trigger) {
      context = { project, area, mode, trigger };
      paintSetup();
      if (!dialog.open) dialog.showModal();
      close.focus();
    }
    refresh.addEventListener("click", async () => {
      if (!context || checking || isLocked()) return;
      const selected = context;
      checking = true;
      paintSetup();
      try {
        await onChanged();
      } catch (error) {
        status.textContent = error.message;
        status.hidden = false;
        refresh.textContent = "Check again";
        return;
      } finally {
        checking = false;
        refresh.disabled = isLocked();
        close.disabled = false;
      }
      if (context !== selected) return;
      paintSetup();
      const current = target(selected.project, selected.area);
      if (
        selected.mode === "automation"
          ? current?.readiness?.canEnable
          : canPrepareRun(current?.readiness)
      ) {
        finish();
        await execute(
          selected.project,
          selected.area,
          selected.mode,
          selected.trigger,
        );
      }
    });
    async function execute(projectName, areaKey, mode, trigger) {
      const key = `${projectName}/${areaKey}`,
        current = target(projectName, areaKey);
      if (isLocked() || states.get(key)?.busy || !current) return;
      const { project, area, readiness } = current;
      if (mode !== "automation") {
        const jobs = getJobs() || [];
        let accepted = acceptedJobs.get(key);
        if (accepted) {
          const observed = jobs.find((job) => job.id === accepted.job.id);
          if (
            accepted.projectInstanceId !== (project.instanceId ?? null) ||
            (observed && !["queued", "running"].includes(observed.status))
          ) {
            acceptedJobs.delete(key);
            accepted = null;
          }
        }
        const active =
          jobs.find(
            (job) =>
              job.type === "pm" &&
              job.project === projectName &&
              (job.projectInstanceId ?? null) ===
                (project.instanceId ?? null) &&
              job.area === areaKey &&
              ["queued", "running"].includes(job.status),
          ) || accepted?.job;
        if (active) {
          onJob(active);
          return;
        }
      }
      if (
        (mode !== "automation" && !canPrepareRun(readiness)) ||
        (mode === "automation" &&
          !area.enabled &&
          readiness?.canEnable !== true)
      ) {
        showSetup(projectName, areaKey, mode, trigger);
        return;
      }
      states.set(key, { busy: true, mode });
      onState();
      let confirmedMessage = null;
      try {
        if (mode !== "automation") {
          const result = await api(
            "/api/jobs",
            {
              type: "pm",
              project: projectName,
              area: areaKey,
              ...(mode === "exploration" ? { pmMode: "exploration" } : {}),
            },
            "POST",
            90000,
          );
          if (!result.job?.id)
            throw new Error(
              "The server did not confirm this run. Check Activity before trying again.",
            );
          confirmedMessage = "Run queued. Automation is unchanged.";
          acceptedJobs.set(key, {
            job: result.job,
            projectInstanceId: project.instanceId ?? null,
          });
          states.set(key, { busy: true, mode, message: confirmedMessage });
          onJob(result.job);
        } else {
          await api(
            `/api/projects/${encodeURIComponent(projectName)}/areas/${encodeURIComponent(areaKey)}/status`,
            {
              enabled: !area.enabled,
              revision: project.areasRevision,
              projectRevision: project.projectRevision,
            },
          );
          confirmedMessage = area.enabled
            ? "Automation off. Current runs keep going."
            : "Automation on. Scheduled patrols and approved-ticket pickup are enabled.";
          states.set(key, { busy: true, mode, message: confirmedMessage });
        }
        await onChanged();
      } catch (error) {
        states.set(
          key,
          confirmedMessage
            ? {
                busy: true,
                mode,
                message: `${confirmedMessage} The dashboard could not refresh. ${mode === "automation" ? "Refresh before changing automation again." : "Open Activity to follow this run."}`,
              }
            : { busy: true, mode, error: true, message: error.message },
        );
        if (!confirmedMessage) await onChanged().catch(() => {});
      } finally {
        const state = states.get(key);
        if (state) state.busy = false;
        onState();
        onFinished?.(projectName, areaKey, mode);
      }
    }
    return {
      run: (project, area, trigger) => execute(project, area, "run", trigger),
      explore: (project, area, trigger) =>
        execute(project, area, "exploration", trigger),
      toggle: (project, area, trigger) =>
        execute(project, area, "automation", trigger),
      isBusy: () =>
        checking || [...states.values()].some((value) => value.busy),
    };
  };
})();
