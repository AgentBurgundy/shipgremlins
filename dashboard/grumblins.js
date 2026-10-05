"use strict";
(() => {
  const el = (tag, className = "", text) => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (label, action, primary = false) => {
    const value = el(
      "button",
      primary ? "button button-dark" : "small-button",
      label,
    );
    value.type = "button";
    value.addEventListener("click", action);
    return value;
  };
  const link = (label, href, className = "") => {
    const value = el("a", className, label);
    value.href = href;
    return value;
  };
  const projectPath = (name) => `/projects/${encodeURIComponent(name)}`;
  const active = (job) => ["queued", "running"].includes(job?.status);
  const excerpt = (value, limit = 190) => {
    const text = String(value || "").trim();
    return text.length > limit
      ? `${text.slice(0, limit).replace(/\s+\S*$/, "")}…`
      : text;
  };
  window.createGrumblinReport = ({ root, fetchArtifact, renderMarkdown }) => {
    if (!root) return null;
    const title = el("h3", "run-section-title", "Customer simulation report"),
      notice = el("p", "grumblins-report-notice"),
      content = el("div", "grumblins-report-content");
    notice.setAttribute("role", "status");
    root.append(
      title,
      el(
        "p",
        "grumblins-disclaimer",
        "AI simulation · These observations are hypotheses to check with real customers.",
      ),
      notice,
      content,
    );
    let selected = "",
      currentJob,
      savedKey = "",
      pending,
      last;
    const visible = () =>
      Boolean(currentJob?.grumblin || currentJob?.pmMode === "grumblin");
    function select(id, job) {
      if (selected !== id) {
        selected = id;
        currentJob = job;
        savedKey = "";
        pending = null;
        last = null;
        content.replaceChildren();
        notice.textContent =
          "The simulation report will appear here when it is available.";
      } else currentJob = job;
      root.hidden = !visible();
      if (visible() && last) return render(...last);
    }
    async function render(id, files, context) {
      if (id !== selected || !context.isCurrent()) return;
      last = [id, files, context];
      if (!visible()) return;
      root.hidden = false;
      const file = files.find((value) => value.name === "summary.md");
      if (!file) {
        if (!savedKey)
          notice.textContent = active(currentJob)
            ? "The simulation report will appear here when it is available."
            : "No simulation report is available yet. Check Activity or Evidence for the run’s recorded output.";
        return;
      }
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 65536
      ) {
        notice.textContent =
          "This report cannot be previewed within the 64 KiB reading limit. Open summary.md from Evidence.";
        return;
      }
      const key = JSON.stringify([
        id,
        file.name,
        file.url,
        file.size,
        file.sha256 || "",
      ]);
      if (key === savedKey) return;
      if (pending?.key === key) return pending.promise;
      const request = { key, promise: null };
      pending = request;
      const isCurrent = () =>
        pending === request && selected === id && context.isCurrent();
      notice.textContent = savedKey
        ? "Refreshing the simulation report…"
        : "Loading the simulation report…";
      request.promise = (async () => {
        try {
          const blob = await fetchArtifact(id, file, context.signal);
          if (!isCurrent()) return;
          if (!Number.isSafeInteger(blob.size) || blob.size > 65536)
            throw new Error(
              "The report exceeds the 64 KiB reading limit. Open summary.md from Evidence.",
            );
          const text = await blob.text();
          if (!isCurrent()) return;
          content.replaceChildren(renderMarkdown(text));
          savedKey = key;
          notice.textContent = text.trim()
            ? ""
            : "The saved simulation report is empty. Check Activity and Output for more detail.";
        } catch (error) {
          if (isCurrent())
            notice.textContent = `${error.message || "The simulation report could not load."}${savedKey ? " The previously loaded report is kept." : " Use Refresh to try again."}`;
        } finally {
          if (pending === request) pending = null;
        }
      })();
      return request.promise;
    }
    return { select, render, clear: () => select("", null) };
  };
  window.renderGrumblinsLauncher = (project) => {
    const root = el("section", "grumblins-launcher"),
      copy = el("div");
    copy.append(
      el("h3", "", "Let customers try it"),
      el(
        "p",
        "",
        "Meet AI simulated customers with goals and habits shaped around your app.",
      ),
    );
    root.append(
      copy,
      link(
        "Meet your Grumblins →",
        `${projectPath(project.name)}?tab=grumblins`,
        "small-button",
      ),
    );
    return root;
  };
  window.createGrumblins = ({ api, pages, isLocked, onJob, getJobs }) => {
    const entries = new Map();
    let timer;
    const current = (s) =>
      pages.current === "project" &&
      pages.project === s.project.name &&
      !pages.pm &&
      pages.tab === "grumblins";
    const endpoint = (s) =>
      `/api/projects/${encodeURIComponent(s.project.name)}/grumblins`;
    const alive = (s) => entries.get(s.project.name) === s;
    const jobs = (s) => {
      const merged = new Map();
      for (const job of [
        ...(s.data?.jobs || []),
        ...s.started,
        ...(getJobs?.() || []),
      ]) {
        if (
          !job?.grumblin ||
          job.project !== s.project.name ||
          (job.projectInstanceId ?? null) !== (s.project.instanceId ?? null)
        )
          continue;
        const previous = merged.get(job.id);
        if (
          !previous ||
          !previous.updatedAt ||
          !job.updatedAt ||
          Date.parse(job.updatedAt) >= Date.parse(previous.updatedAt)
        )
          merged.set(job.id, job);
      }
      return [...merged.values()].sort(
        (a, b) =>
          Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") ||
          Number(b.runId || 0) - Number(a.runId || 0),
      );
    };
    function closeDetails(s, restore = true) {
      if (!s.dialog.open) return;
      s.dialog.close();
      if (restore) s.detailTrigger?.focus();
    }
    function details(s, profile, trigger) {
      s.detailTrigger = trigger;
      s.detailTitle.textContent = `Meet ${profile.name}`;
      s.detailBody.replaceChildren();
      const intro = el("p", "grumblins-detail-intro", profile.personality);
      s.detailBody.append(
        el("span", "grumblins-simulation-label", "AI SIMULATED CUSTOMER"),
        intro,
      );
      for (const [label, value] of [
        ["Their goal", profile.goal],
        ["Why they fit your app", profile.relevanceRationale],
        ["Their situation", profile.context],
      ]) {
        if (!value) continue;
        s.detailBody.append(el("h3", "", label), el("p", "", value));
      }
      const traits = el("dl", "grumblins-traits");
      for (const [label, value] of [
        ["Experience", profile.familiarity],
        ["Patience", profile.patience],
        ["Device", profile.device],
        ["Click budget", profile.clickBudget],
      ]) {
        const item = el("div");
        item.append(el("dt", "", label), el("dd", "", value));
        traits.append(item);
      }
      s.detailBody.append(traits);
      for (const [label, values] of [
        ["What success looks like", profile.successCriteria],
        ["Assumptions to check", profile.assumptions],
      ]) {
        if (!values?.length) continue;
        const list = el("ul");
        for (const value of values) list.append(el("li", "", value));
        s.detailBody.append(el("h3", "", label), list);
      }
      s.detailBody.append(
        el(
          "p",
          "grumblins-disclaimer",
          "This is an AI simulation. Treat its findings as hypotheses to check with real customers.",
        ),
      );
      s.dialog.showModal();
      s.detailTitle.focus({ preventScroll: true });
    }
    function make(project) {
      const s = {
        project,
        data: null,
        loading: false,
        busy: "",
        error: "",
        notice: "",
        editing: true,
        cards: new Map(),
        started: [],
        loadedAt: 0,
      };
      s.node = el("section", "grumblins-workspace");
      const header = el("header", "grumblins-heading");
      const copy = el("div");
      s.intro = el(
        "p",
        "",
        "AI simulated customers, each with a reason to use your app. See where they succeed, hesitate, or give up.",
      );
      copy.append(
        el("span", "eyebrow muted", "GRUMBLINS"),
        el("h2", "", "Meet your Grumblins."),
        s.intro,
      );
      s.refine = button("Refine your Grumblins", () => {
        s.editing = true;
        paint(s);
        s.focus.focus();
      });
      header.append(copy, s.refine);
      s.message = el("p", "grumblins-message");
      s.message.setAttribute("role", "status");
      s.retry = button("Try loading again", () => load(s, true));
      s.form = el("form", "grumblins-focus");
      s.focus = el("input");
      s.focus.type = "text";
      s.focus.id = `grumblins-focus-${project.name}`;
      s.focus.maxLength = 1000;
      s.focus.placeholder =
        "For example, a first purchase or setting up a team";
      const label = el("label", "", "Anything you want them to try?");
      label.htmlFor = s.focus.id;
      const help = el(
        "p",
        "grumblins-help",
        "Optional. Leave this blank and we’ll use your project brief and your PMs’ learning.",
      );
      help.id = `${s.focus.id}-help`;
      s.focus.setAttribute("aria-describedby", help.id);
      s.generate = el("button", "button button-dark", "Find my Grumblins");
      s.generate.type = "submit";
      s.keep = button("Keep these Grumblins", () => {
        s.editing = false;
        paint(s);
        s.refine.focus();
      });
      const actions = el("div", "grumblins-form-actions");
      actions.append(s.generate, s.keep);
      s.context = el("p", "grumblins-context");
      s.form.append(label, help, s.focus, s.context, actions);
      s.form.addEventListener("submit", (event) => {
        event.preventDefault();
        generate(s);
      });
      s.blocker = el("aside", "grumblins-guidance");
      s.blocker.setAttribute("aria-label", "Before a simulation can run");
      s.grid = el("div", "grumblins-grid");
      s.history = el("section", "grumblins-history");
      s.node.append(
        header,
        s.message,
        s.retry,
        s.form,
        s.blocker,
        s.grid,
        s.history,
        el(
          "p",
          "grumblins-disclaimer",
          "Simulations reveal possibilities. They are not real customer research, and they never run on a schedule by themselves.",
        ),
      );
      s.dialog = el("dialog", "grumblins-dialog");
      s.dialog.setAttribute(
        "aria-labelledby",
        `grumblins-detail-${project.name}`,
      );
      s.detailTitle = el("h2");
      s.detailTitle.id = `grumblins-detail-${project.name}`;
      s.detailTitle.setAttribute("tabindex", "-1");
      const close = button("×", () => closeDetails(s));
      close.className = "icon-close";
      close.setAttribute("aria-label", "Close Grumblin details");
      const dialogHeader = el("header", "surface-dialog-header");
      dialogHeader.append(s.detailTitle, close);
      s.detailBody = el("div", "surface-dialog-body");
      s.dialog.append(dialogHeader, s.detailBody);
      s.dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDetails(s);
      });
      document.body.append(s.dialog);
      return s;
    }
    function card(s, profile, index) {
      const root = el("article", `grumblin-card grumblin-tone-${index % 3}`);
      const identity = el("div", "grumblin-identity"),
        mark = el(
          "span",
          "grumblin-mark",
          String(profile.name || "?").slice(0, 1),
        );
      mark.setAttribute("aria-hidden", "true");
      const heading = el("div");
      heading.append(
        el("h3", "", profile.name),
        el("p", "grumblin-role", profile.role),
      );
      identity.append(mark, heading);
      root.append(
        identity,
        el("p", "grumblin-personality", excerpt(profile.personality)),
        el("span", "grumblin-goal-label", "THEIR GOAL"),
        el("p", "grumblin-goal", excerpt(profile.goal, 240)),
        el("p", "grumblin-rationale", excerpt(profile.relevanceRationale)),
      );
      const status = el("p", "grumblin-status");
      status.setAttribute("role", "status");
      const actions = el("div", "grumblin-actions");
      const run = button("Simulate", () => simulate(s, profile), true);
      run.setAttribute("aria-label", `Simulate ${profile.name}`);
      const meet = button(`Meet ${profile.name}`, () =>
        details(s, profile, meet),
      );
      const report = link("View run", "", "small-button");
      actions.append(run, report, meet);
      root.append(status, actions);
      return { root, run, meet, status, report, profile };
    }
    function paint(s) {
      const profiles = s.data?.profiles || [],
        allJobs = jobs(s),
        locked = isLocked();
      s.intro.textContent = profiles.length
        ? "Three AI simulated customers, shaped by your app. Pick one to try a journey."
        : "AI simulated customers, each with a reason to use your app. See where they succeed, hesitate, or give up.";
      s.node.setAttribute("aria-busy", String(Boolean(s.busy || s.loading)));
      s.message.textContent =
        s.error ||
        s.notice ||
        (s.loading && !s.data ? "Finding your saved Grumblins…" : "");
      s.message.hidden = !s.message.textContent;
      s.message.classList.toggle("error", Boolean(s.error));
      s.retry.hidden = !s.error;
      s.retry.textContent = s.data ? "Refresh status" : "Try loading again";
      s.retry.disabled = s.loading || Boolean(s.busy) || locked;
      s.refine.hidden = !profiles.length || s.editing;
      s.refine.disabled = Boolean(s.busy) || locked;
      s.form.hidden = (s.loading && !s.data) || !s.editing;
      s.focus.disabled = Boolean(s.busy) || locked;
      s.generate.disabled = Boolean(s.busy) || s.loading || locked;
      s.generate.textContent =
        s.busy === "generate" ? "Finding your Grumblins…" : "Find my Grumblins";
      s.keep.hidden = !profiles.length;
      s.keep.disabled = Boolean(s.busy);
      s.context.textContent = excerpt(s.data?.contextSummary, 280);
      s.context.hidden = !s.context.textContent;
      const blocker = s.data?.readiness?.blockers?.[0];
      const foundation = s.project.foundation?.needed;
      const needsSetup =
        foundation || (s.data?.readiness && !s.data.readiness.canRun);
      s.blocker.replaceChildren();
      s.blocker.hidden = !needsSetup && !s.data?.stale;
      if (s.data?.stale) {
        s.blocker.append(
          el("strong", "", "Your project has changed"),
          el(
            "p",
            "",
            "Find fresh Grumblins before running another simulation. Your previous reports stay in Activity.",
          ),
          button("Refresh my Grumblins", () => {
            s.editing = true;
            paint(s);
            s.focus.focus();
          }),
        );
      } else if (needsSetup) {
        s.blocker.append(
          el(
            "strong",
            "",
            foundation
              ? "Meet them now. Let them try it after the foundation."
              : "A little setup before they can try your app",
          ),
          el(
            "p",
            "",
            foundation
              ? "You can generate relevant Grumblins from your idea today. Build the foundation, then connect and test a live environment before simulating their visit."
              : blocker?.message ||
                  "Connect and test a live app environment, and give a PM the brief before starting a simulation.",
          ),
        );
        const action = blocker?.action;
        const href =
          foundation ||
          ["environment", "verify", "verification"].includes(action)
            ? `${projectPath(s.project.name)}?tab=environment`
            : action === "worker"
              ? "/runners#workers"
              : ["source", "ai", "linear"].includes(action)
                ? "/connections"
                : projectPath(s.project.name);
        s.blocker.append(
          link(
            foundation
              ? "Build the foundation →"
              : action === "worker"
                ? "Set up a runner →"
                : ["source", "ai", "linear"].includes(action)
                  ? "Open Connections →"
                  : action === "mandate" || action === "pm"
                    ? "Set up a PM →"
                    : "Review setup →",
            href,
          ),
        );
      }
      const signature = JSON.stringify(profiles);
      if (s.profileSignature !== signature) {
        s.profileSignature = signature;
        closeDetails(s, false);
        s.cards.clear();
        s.grid.replaceChildren();
        profiles.forEach((profile, index) => {
          const value = card(s, profile, index);
          s.cards.set(profile.id, value);
          s.grid.append(value.root);
        });
      }
      s.grid.hidden = s.editing;
      for (const [id, value] of s.cards) {
        const latest = allJobs.find((job) => job.grumblin?.id === id),
          pending = active(latest);
        value.run.disabled =
          Boolean(s.busy) ||
          locked ||
          Boolean(s.data?.stale) ||
          Boolean(needsSetup) ||
          !s.data?.readiness ||
          pending;
        value.run.textContent =
          s.busy === id
            ? "Starting…"
            : pending
              ? latest.status === "running"
                ? "Simulating…"
                : "Queued"
              : latest
                ? "Simulate again"
                : "Simulate";
        value.status.hidden = !latest;
        value.status.textContent = latest
          ? {
              queued: "Waiting for an available runner",
              running: "Exploring your app now",
              succeeded: "Simulation complete — findings are ready",
              failed: "The simulation could not finish",
              canceled: "Simulation canceled",
            }[latest.status] || latest.status
          : "";
        value.report.hidden = !latest;
        if (latest) {
          value.report.href = `/activity?run=${encodeURIComponent(latest.id)}`;
          value.report.textContent =
            latest.status === "succeeded" ? "Read report" : "View run";
        }
      }
      const historySignature = JSON.stringify(
        allJobs
          .slice(0, 5)
          .map((job) => [job.id, job.status, job.area, job.grumblin?.name]),
      );
      if (s.historySignature !== historySignature) {
        s.historySignature = historySignature;
        s.history.replaceChildren();
        if (allJobs.length) {
          s.history.append(el("h3", "", "Recent simulations"));
          for (const job of allJobs.slice(0, 5)) {
            const row = el("div", "grumblin-history-row"),
              copy = el("div");
            copy.append(
              el("strong", "", job.grumblin?.name || "Grumblin"),
              el("span", "", `AI simulation · ${job.status}`),
            );
            const actions = el("div");
            actions.append(
              link(
                job.status === "succeeded" ? "Read report →" : "View run →",
                `/activity?run=${encodeURIComponent(job.id)}`,
              ),
            );
            if (job.area)
              actions.append(
                link(
                  "PM Learning →",
                  `${projectPath(s.project.name)}?pm=${encodeURIComponent(job.area)}&tab=discovery`,
                ),
              );
            row.append(copy, actions);
            s.history.append(row);
          }
        }
      }
      s.history.hidden = !allJobs.length || s.editing;
    }
    async function load(s, force = false) {
      if (
        !alive(s) ||
        s.loading ||
        s.busy ||
        isLocked() ||
        (!force && Date.now() - s.loadedAt < 10000)
      )
        return;
      s.loading = true;
      paint(s);
      try {
        const data = await api(endpoint(s));
        if (!alive(s)) return;
        const first = !s.data;
        s.data = data;
        s.loadedAt = Date.now();
        s.error = "";
        if (first) {
          s.editing = !data.profiles?.length;
          s.focus.value = data.focus || "";
        }
      } catch (error) {
        if (alive(s))
          s.error =
            error.message || "Your Grumblins could not load. Try again.";
      } finally {
        s.loading = false;
        if (alive(s)) {
          paint(s);
          schedule();
        }
      }
    }
    async function generate(s) {
      if (s.busy || s.loading || isLocked() || !s.form.reportValidity()) return;
      s.busy = "generate";
      s.error = "";
      s.notice = "Creating three customers from your project’s context…";
      paint(s);
      try {
        const focus = s.focus.value.trim();
        const data = await api(
          `${endpoint(s)}/generate`,
          focus ? { focus } : {},
          "POST",
          190000,
        );
        if (!alive(s)) return;
        s.data = { ...s.data, ...data };
        s.editing = false;
        s.notice = "";
      } catch (error) {
        if (alive(s)) {
          s.error =
            error.message ||
            "Your Grumblins could not be generated. Try again.";
          s.notice = "";
        }
      } finally {
        s.busy = "";
        if (alive(s)) {
          paint(s);
          if (!s.error) {
            await load(s, true);
            if (alive(s) && current(s))
              s.cards.values().next().value?.meet.focus();
          }
        }
      }
    }
    async function simulate(s, profile) {
      if (
        s.busy ||
        isLocked() ||
        s.data?.stale ||
        !s.data?.readiness?.canRun ||
        s.project.foundation?.needed ||
        jobs(s).some((job) => job.grumblin?.id === profile.id && active(job))
      )
        return;
      s.busy = profile.id;
      s.error = "";
      s.notice = "";
      paint(s);
      const areas = (s.data.readiness.areas || []).filter(
        (value) => value.canRun !== false,
      );
      const previousArea = jobs(s).find(
        (job) => job.grumblin?.id === profile.id,
      )?.area;
      const area =
        areas.find((value) => value.key === previousArea)?.key ||
        areas.find((value) => value.key === profile.suggestedArea)?.key ||
        areas[0]?.key;
      try {
        const result = await api(`${endpoint(s)}/run`, {
          profileId: profile.id,
          revision: s.data.revision,
          ...(area ? { area } : {}),
        });
        if (!alive(s)) return;
        if (!result?.job?.id)
          throw new Error(
            "The simulation response did not include a run. Check Activity before trying again.",
          );
        s.started = [
          result.job,
          ...s.started.filter((job) => job.id !== result.job.id),
        ];
        s.notice =
          {
            queued: result.reused
              ? `${profile.name} already has a simulation queued.`
              : `${profile.name} is queued.`,
            running: `${profile.name} is trying your app.`,
            succeeded: `${profile.name} finished. The report is ready below.`,
            failed: `${profile.name} could not finish. Review the run below.`,
            canceled: `${profile.name}’s simulation was canceled.`,
          }[result.job.status] ||
          "The simulation was accepted. Follow its run below.";
        onJob?.(result.job);
      } catch (error) {
        if (alive(s))
          s.error =
            error.message ||
            "The simulation could not start. Check Activity before trying again.";
      } finally {
        s.busy = "";
        if (alive(s)) {
          paint(s);
          schedule();
        }
      }
    }
    function schedule() {
      clearTimeout(timer);
      for (const s of entries.values()) if (!current(s)) closeDetails(s, false);
      const s = entries.get(pages.project);
      if (!s || !current(s) || document.hidden || isLocked()) return;
      timer = setTimeout(
        () => load(s, true),
        jobs(s).some(active) ? 5000 : 30000,
      );
    }
    window.addEventListener("dashboard:pagechange", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => clearTimeout(timer));
    return {
      mount(root, project) {
        let s = entries.get(project.name);
        if (
          s &&
          (s.project.instanceId ?? null) !== (project.instanceId ?? null)
        )
          (this.forget(project.name), (s = null));
        if (!s) {
          s = make(project);
          entries.set(project.name, s);
        }
        s.project = project;
        root.append(s.node);
        paint(s);
        load(s);
        schedule();
      },
      resume(projects = []) {
        for (const s of entries.values()) {
          const project = projects.find(
            (value) =>
              value.name === s.project.name &&
              (value.instanceId ?? null) === (s.project.instanceId ?? null),
          );
          if (project) s.project = project;
          if (current(s)) paint(s);
        }
        schedule();
      },
      refresh(name) {
        const s = entries.get(name);
        if (s) return load(s, true);
      },
      forget(name) {
        const s = entries.get(name);
        if (s) {
          closeDetails(s, false);
          s.dialog.remove();
          s.node.remove();
        }
        entries.delete(name);
        schedule();
      },
      protectFocus: () =>
        [...entries.values()].some(
          (s) =>
            current(s) &&
            (s.dialog.open || s.node.contains(document.activeElement)),
        ),
      isBusy: () => [...entries.values()].some((s) => Boolean(s.busy)),
    };
  };
})();
