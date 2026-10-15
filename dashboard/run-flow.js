"use strict";
(() => {
  const labels = {
    developer: {
      understand: "Understand",
      baseline: "Baseline",
      tests: "Tests",
      build: "Implement",
      review: "Review",
      verify: "Verify",
      publish: "Draft PR",
    },
    pm: {
      prepare: "Prepare",
      investigate: "Investigate",
      record: "Record findings",
      complete: "Complete",
    },
    verify: {
      prepare: "Prepare",
      browser: "Browser check",
      complete: "Complete",
    },
  };
  const statuses = new Set([
    "pending",
    "running",
    "passed",
    "failed",
    "skipped",
    "blocked",
  ]);
  const terminal = (job) =>
    ["succeeded", "failed", "canceled"].includes(job?.status);
  const copy = (value, limit = 240) =>
    typeof value === "string" ? value.slice(0, limit) : "";
  const phaseLabel = (kind, phase) =>
    labels[kind]?.[phase?.id] ||
    copy(phase?.label, 60) ||
    copy(phase?.id, 60).replace(/[-_]/g, " ");
  const time = (value) =>
    Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  const duration = (seconds) =>
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
  window.runFlowState = (job, { now = Date.now(), failed = false } = {}) => {
    const flow =
      job?.flow?.version === 1 && labels[job.flow.kind] ? job.flow : null;
    const stale = Boolean(failed || flow?.freshness === "stale" || flow?.stale);
    const phases = (Array.isArray(flow?.phases) ? flow.phases : [])
      .filter(
        (phase) => typeof phase?.id === "string" && statuses.has(phase.status),
      )
      .slice(0, 12)
      .map((phase) => ({
        ...phase,
        label: phaseLabel(flow.kind, phase),
        interrupted: terminal(job) && phase.status === "running",
      }));
    const current = phases.find((phase) => phase.id === flow?.phase);
    const label = current?.label || phaseLabel(flow?.kind, { id: flow?.phase });
    const live = Boolean(
      job?.status === "running" &&
      flow?.status === "running" &&
      !stale &&
      current?.status === "running",
    );
    const attention =
      job?.status === "failed" ||
      (!terminal(job) &&
        (["failed", "blocked"].includes(flow?.status) ||
          ["failed", "blocked"].includes(current?.status)));
    const state =
      job?.status === "canceled"
        ? "canceled"
        : job?.status === "succeeded"
          ? "passed"
          : attention
            ? "blocked"
            : job?.status === "queued"
              ? "queued"
              : "running";
    const status = {
      canceled: "Canceled",
      passed: "Finished",
      blocked: job?.status === "failed" ? "Failed" : "Needs attention",
      queued: "Queued",
      running: "Running",
    }[state];
    let stage =
      job?.status === "queued"
        ? {
            "credential-wait": "Waiting for a connection",
            "environment-wait": "Waiting for the test environment",
            "ambiguous-launch": "Dispatch unconfirmed",
          }[job.failure?.category] || "Waiting for a worker"
        : job?.status === "running"
          ? "Working · stage unavailable"
          : "No stage record available";
    if (label)
      stage =
        job?.status === "queued"
          ? `${stage} · last recorded: ${label}`
          : job?.status === "failed"
            ? `Stopped during ${label}`
            : job?.status === "canceled"
              ? `Canceled during ${label}`
              : label;
    const start = Date.parse(job?.startedAt || job?.createdAt),
      finish = terminal(job) ? Date.parse(job.finishedAt) : now;
    const elapsed =
      Number.isFinite(start) && Number.isFinite(finish) && finish >= start
        ? duration(Math.floor((finish - start) / 1000))
        : null;
    const provider =
      job?.ai?.provider === "codex"
        ? "Codex"
        : job?.ai?.provider === "claude"
          ? "Claude Code"
          : "";
    return {
      flow,
      terminal: terminal(job),
      phases,
      current,
      stale,
      live,
      attention,
      state,
      status,
      stage,
      elapsed,
      provider,
      model: provider ? copy(job.ai.model, 80) : "",
      updated: time(flow?.observedAt || flow?.updatedAt),
      summary: copy(current?.summary),
      strategy:
        {
          tdd: "Tests first",
          regression: "Regression fix",
          visual: "Visual change",
          integration: "Integration",
          refactor: "Refactor",
          fast: "Focused change",
        }[flow?.strategy] || "",
    };
  };
  const node = (tag, cls, text) => {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function rail(state, runId) {
    const list = node("ol", "run-flow-rail");
    list.setAttribute("aria-label", `Run ${runId || ""} recorded stages`);
    list.style.gridTemplateColumns = `repeat(${state.phases.length}, minmax(0, 1fr))`;
    for (const [index, phase] of state.phases.entries()) {
      const item = node(
          "li",
          `run-flow-step is-${phase.status}${phase.interrupted ? " is-interrupted" : ""}`,
        ),
        mark = node(
          "span",
          "run-flow-mark",
          phase.status === "passed"
            ? "✓"
            : phase.status === "failed"
              ? "!"
              : String(index + 1),
        );
      mark.setAttribute("aria-hidden", "true");
      item.append(
        mark,
        node("span", "run-flow-step-name", phase.label),
        node(
          "span",
          "sr-only",
          `: ${phase.interrupted ? "interrupted" : phase.status}`,
        ),
      );
      if (phase.id === state.current?.id && !state.terminal)
        item.setAttribute("aria-current", "step");
      list.append(item);
    }
    return list;
  }
  function process(state, job) {
    const root = node("div", "run-flow-process"),
      timeline = node("ol", "run-flow-timeline");
    timeline.setAttribute("aria-label", `Run ${job.runId || ""} stage results`);
    for (const phase of state.phases) {
      const item = node("li", `run-flow-phase is-${phase.status}`),
        heading = node("div", "run-flow-phase-heading");
      heading.append(
        node("strong", "", phase.label),
        node(
          "span",
          "run-flow-phase-state",
          phase.interrupted
            ? job.status === "succeeded"
              ? "Last recorded running"
              : "Interrupted"
            : phase.status === "pending" && terminal(job)
              ? "Not reached"
              : phase.status,
        ),
      );
      item.append(heading);
      if (phase.summary) item.append(node("p", "", copy(phase.summary, 400)));
      const stamp = [time(phase.startedAt), time(phase.finishedAt)]
        .filter(Boolean)
        .join(" → ");
      if (stamp) item.append(node("time", "", stamp));
      timeline.append(item);
    }
    root.append(timeline);
    const events = (Array.isArray(state.flow?.events) ? state.flow.events : [])
      .slice(-6)
      .reverse();
    if (events.length) {
      const list = node("ol", "run-flow-events");
      root.append(node("h4", "", "Latest recorded updates"));
      for (const event of events) {
        const item = node("li");
        item.append(
          node("time", "", time(event.at)),
          node(
            "span",
            "",
            copy(event.summary) ||
              `${phaseLabel(state.flow.kind, { id: event.phase })} · ${copy(event.status, 30)}`,
          ),
        );
        list.append(item);
      }
      root.append(list);
    }
    root.append(
      node(
        "p",
        "run-flow-record-note",
        "Recorded execution stages and check results.",
      ),
    );
    return root;
  }
  function card(job, projects, options = {}) {
    const state = window.runFlowState(job, options),
      project = projects.find(
        (item) =>
          item.name === job.project &&
          (item.instanceId ?? null) === (job.projectInstanceId ?? null),
      ),
      area = project?.areas?.find(
        (item) =>
          item.key === job.area &&
          (item.instanceId ?? null) === (job.areaInstanceId ?? null),
      ),
      coder = project?.coders?.agents?.find(
        (item) =>
          item.key === job.coderKey && item.instanceId === job.coderInstanceId,
      );
    const root = node(
      "article",
      `run-flow-card is-${state.state}${state.live ? " is-live" : ""}${state.stale ? " is-stale" : ""}`,
    );
    root.dataset.runId = job.id;
    const head = node("div", "run-flow-card-head"),
      identity = node("div", "run-flow-identity"),
      role =
        job.type === "developer"
          ? "Coding"
          : job.type === "verify"
            ? "Worker check"
            : job.pmMode === "discovery"
              ? "Discovery"
              : "Investigation";
    const title =
      job.type === "developer"
        ? job.ticket || "Coding run"
        : job.grumblin?.name || area?.name || job.area || role;
    identity.append(
      node(
        "p",
        "run-flow-project",
        [
          copy(job.project, 100) || "Worker verification",
          `Run ${job.runId || "—"}`,
        ].join(" / "),
      ),
      node("h3", "", copy(title, 140)),
      node(
        "p",
        "run-flow-role",
        [
          role,
          job.type === "developer"
            ? copy(
                job.coderName ||
                  coder?.name ||
                  (job.coderKey ? "Previous coding agent" : "Coding agent"),
                100,
              )
            : null,
          state.provider,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const badge = node("span", "run-flow-status", state.status);
    head.append(identity, badge);
    const current = node("div", "run-flow-current"),
      dot = node("span", "run-flow-current-dot");
    dot.setAttribute("aria-hidden", "true");
    const stage = node("strong", "", state.stage);
    current.append(dot, stage);
    if (state.stale)
      current.append(node("span", "run-flow-stale", "Last known"));
    root.append(head, current);
    if (state.phases.length) root.append(rail(state, job.runId));
    else
      root.append(
        node(
          "p",
          "run-flow-unavailable",
          job.status === "queued"
            ? "The process appears when a worker records its first stage."
            : "This run has no recorded process stages. Its activity and evidence remain available.",
        ),
      );
    if (state.attention || (job.status === "queued" && job.failure)) {
      const reason = window.normalizedRunFailure?.(job);
      const blocker = node(
        "p",
        "run-flow-blocker",
        state.summary ||
          reason?.detail ||
          "This run needs attention. Review its recorded evidence before continuing.",
      );
      root.append(blocker);
    } else if (state.summary)
      root.append(node("p", "run-flow-summary", state.summary));
    const footer = node("div", "run-flow-card-footer"),
      metrics = node("div", "run-flow-metrics");
    if (state.elapsed)
      metrics.append(
        node(
          "span",
          "",
          `${job.status === "queued" ? "Waiting" : "Elapsed"} ${state.elapsed}`,
        ),
      );
    if (
      Number.isSafeInteger(state.flow?.repairUsed) &&
      state.flow.repairUsed > 0 &&
      Number.isSafeInteger(state.flow?.repairLimit)
    )
      metrics.append(
        node(
          "span",
          "",
          `Repairs ${state.flow.repairUsed}/${state.flow.repairLimit}`,
        ),
      );
    if (state.updated && state.stale)
      metrics.append(node("span", "", `Observed ${state.updated}`));
    const reason = window.normalizedRunFailure?.(job);
    const evidence = node(
      "a",
      "run-flow-evidence",
      state.attention || job.failure
        ? "Review run →"
        : state.live
          ? "Follow run →"
          : "View evidence →",
    );
    evidence.href = `/activity?run=${encodeURIComponent(job.id)}`;
    evidence.dataset.flowFocus = `evidence:${job.id}`;
    evidence.setAttribute(
      "aria-label",
      `Open evidence for run ${job.runId || job.id}`,
    );
    footer.append(metrics, evidence);
    if (reason?.href?.startsWith("/") && !reason.href.startsWith("//")) {
      const remedy = node(
        "a",
        "small-button run-flow-next-action",
        reason.label,
      );
      remedy.href = reason.href;
      remedy.dataset.flowFocus = `remedy:${job.id}`;
      footer.append(remedy);
    }
    root.append(footer);
    const metadata = [state.provider, state.model, state.strategy]
      .filter(Boolean)
      .join(" · ");
    if (state.phases.length || metadata) {
      const details = node("details", "run-flow-details"),
        summary = node(
          "summary",
          "",
          state.phases.length ? "Process & history" : "Run details",
        );
      summary.dataset.flowFocus = `process:${job.id}`;
      summary.setAttribute(
        "aria-label",
        `Recorded process for run ${job.runId || job.id}`,
      );
      details.open = Boolean(options.open);
      details.addEventListener("toggle", () =>
        options.onToggle?.(details.open),
      );
      details.append(summary);
      if (metadata) details.append(node("p", "run-flow-metadata", metadata));
      if (state.phases.length) details.append(process(state, job));
      root.append(details);
    }
    return root;
  }
  window.renderRunFlowDetail = (root, job) => {
    if (!root) return;
    root.replaceChildren();
    root.hidden = !job;
    if (!job) return;
    const state = window.runFlowState(job);
    root.className = `run-flow-detail${state.live ? " is-live" : ""}`;
    root.append(
      node("h3", "", "Recorded process"),
      node("p", "run-flow-detail-stage", state.stage),
    );
    if (state.phases.length)
      root.append(rail(state, job.runId), process(state, job));
    else
      root.append(
        node(
          "p",
          "run-flow-unavailable",
          "No process stages were recorded for this run.",
        ),
      );
  };
  window.createRunFlowBoard = (
    root,
    { title = "Live work", defaultFilter = "active", id = "runs" } = {},
  ) => {
    if (!root) return null;
    root.classList.add("run-flow-board");
    const heading = node("div", "run-flow-board-heading"),
      identity = node("div"),
      eyebrow = node("span", "run-flow-eyebrow", "YOUR CREW AT WORK"),
      name = node("h2", "", title),
      count = node("span", "run-flow-count", "Checking runs…"),
      tools = node("div", "run-flow-filters");
    identity.append(eyebrow, name, count);
    heading.append(identity, tools);
    const projectLabel = node("label", "sr-only", "Filter runs by project"),
      project = node("select"),
      statusLabel = node("label", "sr-only", "Filter runs by status"),
      status = node("select");
    project.id = `${id}-project-filter`;
    status.id = `${id}-status-filter`;
    projectLabel.htmlFor = project.id;
    statusLabel.htmlFor = status.id;
    for (const [value, text] of [
      ["active", "Active runs"],
      ["all", "All recent runs"],
      ["running", "Running"],
      ["queued", "Queued"],
      ["attention", "Needs attention"],
      ["finished", "Finished"],
    ]) {
      const option = node("option", "", text);
      option.value = value;
      status.append(option);
    }
    status.value = defaultFilter;
    tools.append(projectLabel, project, statusLabel, status);
    const notice = node("p", "run-flow-feed-status"),
      list = node("div", "run-flow-cards");
    notice.setAttribute("role", "status");
    list.setAttribute("aria-label", title);
    root.append(heading, notice, list);
    let data = { jobs: [], projects: [], loaded: false },
      signature = "",
      projectSignature = "";
    const expanded = new Set(),
      collapsed = new Set();
    function paint() {
      const names = [
        ...new Set([
          ...data.projects.map((item) => item.name),
          ...data.jobs.map((item) => item.project).filter(Boolean),
        ]),
      ].sort();
      const nextProjects = JSON.stringify(names);
      if (nextProjects !== projectSignature) {
        projectSignature = nextProjects;
        const selected = project.value;
        project.replaceChildren();
        for (const value of ["", ...names]) {
          const option = node("option", "", value || "All projects");
          option.value = value;
          project.append(option);
        }
        project.value = names.includes(selected) ? selected : "";
      }
      const feedMessage = data.failed
        ? data.loaded
          ? "Updates are unavailable. Showing the last recorded stages."
          : "Run status is unavailable. Refresh the workspace to try again."
        : "Follow the recorded stage, then expand a run for its process and results.";
      if (notice.textContent !== feedMessage) notice.textContent = feedMessage;
      root.setAttribute("aria-busy", String(!data.loaded && !data.failed));
      const visible = data.jobs
        .filter(
          (job) =>
            (!project.value || job.project === project.value) &&
            (status.value === "all" ||
              (status.value === "active" &&
                ["running", "queued"].includes(job.status)) ||
              (status.value === "running" && job.status === "running") ||
              (status.value === "queued" && job.status === "queued") ||
              (status.value === "finished" && terminal(job)) ||
              (status.value === "attention" &&
                window.runFlowState(job, data).attention)),
        )
        .sort(
          (a, b) =>
            Number(["running", "queued"].includes(b.status)) -
              Number(["running", "queued"].includes(a.status)) ||
            (b.runId || 0) - (a.runId || 0),
        );
      count.textContent = !data.loaded
        ? "Checking runs…"
        : status.value === "active"
          ? `${visible.filter((job) => job.status === "running").length} running · ${visible.filter((job) => job.status === "queued").length} queued`
          : `${visible.length} ${visible.length === 1 ? "run" : "runs"}`;
      const shown = visible.slice(0, 24);
      const next = JSON.stringify([
        shown,
        data.projects,
        data.loaded,
        data.failed,
        project.value,
        status.value,
        data.selectedId,
        Math.floor((data.now || Date.now()) / 1000),
      ]);
      if (signature === next) return;
      signature = next;
      const focus = root.contains?.(document.activeElement)
        ? document.activeElement?.dataset?.flowFocus
        : null;
      list.replaceChildren();
      if (!shown.length) {
        const empty = node("div", "run-flow-empty");
        empty.append(
          node(
            "span",
            "run-flow-empty-symbol",
            !data.loaded && !data.failed ? "◌" : "✓",
          ),
          node(
            "h3",
            "",
            !data.loaded && !data.failed
              ? "Finding your crew’s work…"
              : data.failed && !data.loaded
                ? "Waiting for connection"
                : project.value || status.value !== "active"
                  ? "No matching runs"
                  : "Your crew has room to work",
          ),
          node(
            "p",
            "",
            !data.loaded
              ? "Recorded stages appear when worker status is available."
              : "New investigations and coding runs will appear here. Open a project to see its next useful action.",
          ),
        );
        list.append(empty);
      }
      for (const job of shown)
        list.append(
          card(job, data.projects, {
            now: data.now,
            failed: data.failed,
            open:
              expanded.has(job.id) ||
              (data.selectedId === job.id && !collapsed.has(job.id)),
            onToggle: (open) => {
              if (open) {
                expanded.add(job.id);
                collapsed.delete(job.id);
              } else {
                expanded.delete(job.id);
                collapsed.add(job.id);
              }
            },
          }),
        );
      if (visible.length > shown.length)
        list.append(
          node(
            "p",
            "run-flow-record-note",
            `Showing ${shown.length} of ${visible.length} matching runs. Filter by project to narrow this view.`,
          ),
        );
      if (focus)
        [...root.querySelectorAll("[data-flow-focus]")]
          .find((element) => element.dataset.flowFocus === focus)
          ?.focus({ preventScroll: true });
    }
    project.addEventListener("change", paint);
    status.addEventListener("change", paint);
    return {
      update(next) {
        data = { ...data, ...next };
        paint();
      },
    };
  };
})();
