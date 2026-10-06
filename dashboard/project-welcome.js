"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (label, action, primary = false) => {
    const value = el(
      "button",
      label,
      primary ? "button button-dark" : "small-button",
    );
    value.type = "button";
    value.addEventListener("click", action);
    return value;
  };
  const link = (label, href) => {
    const value = el("a", label, "small-button");
    value.href = href;
    return value;
  };
  const commandNames = {
    install: "Install dependencies",
    lint: "Check code style",
    typecheck: "Check types",
    test: "Run tests",
    build: "Build the app",
  };
  const running = (data) => ["analyzing", "publishing"].includes(data?.status);
  const identity = (project) =>
    `${project.name}/${project.instanceId ?? "legacy"}`;

  window.createProjectWelcome = ({
    api,
    pages,
    isLocked = () => false,
    onCreatePm,
    onSaved = async () => {},
  }) => {
    const entries = new Map();
    let active = null,
      destroyed = false;
    const current = (s) => !destroyed && entries.get(s.project.name) === s;
    const endpoint = (s, action = "") =>
      `/api/projects/${encodeURIComponent(s.project.name)}/onboarding${action ? `/${action}` : ""}`;
    const unavailable = (s) => isLocked() || s.busy || running(s.data);
    function deactivate() {
      if (active) clearTimeout(active.timer);
      active = null;
    }
    function schedule(s) {
      clearTimeout(s.timer);
      if (
        !current(s) ||
        active !== s ||
        document.hidden ||
        s.busy ||
        !running(s.data)
      )
        return;
      s.timer = setTimeout(() => load(s, true), 1800);
    }
    function accept(s, data) {
      if (s.data?.revision !== data.revision) {
        s.selected = new Set(
          Object.keys(data.report?.projectSetup?.commands || {}).filter(
            (key) => key in commandNames,
          ),
        );
      }
      s.data = data;
      s.error = "";
      s.notice = "";
      s.loaded = true;
    }
    async function load(s, force = false) {
      if (
        !current(s) ||
        s.loading ||
        s.busy ||
        (s.loaded && !force) ||
        isLocked()
      )
        return;
      const generation = ++s.generation;
      s.loading = true;
      paint(s);
      try {
        const data = await api(endpoint(s));
        if (current(s) && generation === s.generation) accept(s, data);
      } catch (error) {
        if (current(s) && generation === s.generation)
          s.error =
            error.message || "Your project inspection could not be loaded.";
      } finally {
        if (current(s) && generation === s.generation) {
          s.loading = false;
          paint(s);
          schedule(s);
        }
      }
    }
    async function run(s, action, body) {
      if (
        !current(s) ||
        isLocked() ||
        s.busy ||
        (running(s.data) && action !== "cancel")
      )
        return;
      ++s.generation;
      s.loading = false;
      clearTimeout(s.timer);
      s.busy = true;
      s.error = "";
      paint(s);
      try {
        const data = await api(endpoint(s, action), body);
        if (!current(s)) return;
        accept(s, data);
        if (action === "confirm") {
          try {
            await onSaved(s.project.name);
          } catch {
            // Confirmation is already committed. A dashboard refresh failure
            // must not undo it or prevent the user from meeting their gremlin.
            s.notice =
              "Setup saved. The dashboard could not refresh; you can continue or refresh the inspection.";
          }
        }
      } catch (error) {
        if (current(s))
          s.error =
            error.message ||
            "This step did not finish. Refresh the inspection and try again.";
      } finally {
        if (current(s)) {
          s.busy = false;
          paint(s);
          schedule(s);
        }
      }
    }
    function evidence(items) {
      const result = el("ul", undefined, "welcome-evidence");
      for (const item of items || []) {
        const row = el("li");
        row.append(el("code", item.path), el("span", item.quote));
        result.append(row);
      }
      return result;
    }
    function paint(s) {
      if (!current(s)) return;
      const data = s.data,
        report = data?.report,
        proposal = report?.projectSetup,
        reviewable = data?.status === "analyzed",
        confirmed = Boolean(
          reviewable && data?.setupConfirmation?.confirmed && !data.stale,
        ),
        disabled = unavailable(s),
        signature = JSON.stringify([
          data,
          s.error,
          s.notice,
          s.busy,
          isLocked(),
        ]);
      if (signature === s.signature) return;
      s.signature = signature;
      s.node.replaceChildren();
      const progress = el("ol", undefined, "welcome-progress");
      progress.setAttribute("aria-label", "Project introduction");
      ["Inspect your app", "Review setup", "Meet your gremlin"].forEach(
        (label, index) => {
          const item = el("li", label);
          if (
            index ===
            (confirmed ? 2 : proposal && reviewable && !data.stale ? 1 : 0)
          )
            item.setAttribute("aria-current", "step");
          progress.append(item);
        },
      );
      const hero = el("header", undefined, "welcome-hero"),
        copy = el("div"),
        portrait = el("img", undefined, "welcome-gremlin");
      portrait.src = "/assets/gremlin-investigating.webp";
      portrait.alt = "";
      portrait.width = portrait.height = 120;
      copy.append(el("span", "A HOME FOR YOUR CREW", "eyebrow muted"));
      const title = confirmed
        ? "Meet your first investigator."
        : running(data)
          ? "Your Setup Gremlin is looking around."
          : proposal && reviewable && !data?.stale
            ? "Here’s what we found."
            : !data
              ? "Getting your project ready…"
              : "Let’s get to know your app.";
      copy.append(el("h2", title));
      const description = confirmed
        ? "Your reviewed setup is saved. Now give a gremlin the job of learning your product and finding useful opportunities."
        : running(data)
          ? "Reading the repository to understand the app and recommend a sensible starting setup."
          : proposal && reviewable && !data?.stale
            ? "Review the code’s starting points, then meet the gremlin we suggest for your app."
            : "A Setup Gremlin reads the code, suggests how to check it, and recommends a first investigator. You review its findings before anything is saved.";
      copy.append(el("p", description));
      hero.append(copy, portrait);
      s.node.append(progress, hero);
      if (s.notice) {
        const notice = el("p", s.notice, "welcome-note");
        notice.setAttribute("role", "status");
        s.node.append(notice);
      }
      if (s.error) {
        const error = el("div", undefined, "welcome-error");
        error.setAttribute("role", "alert");
        error.append(
          el("p", s.error),
          button("Refresh inspection", () => load(s, true)),
        );
        s.node.append(error);
      }
      if (!data) {
        if (!s.error) {
          const loading = el(
            "p",
            "Loading the repository inspection…",
            "welcome-note",
          );
          loading.setAttribute("role", "status");
          s.node.append(loading);
        }
        return;
      }
      if (running(data)) {
        const status = el(
          "p",
          data.message || "Inspecting the repository…",
          "welcome-inspecting",
        );
        status.setAttribute("role", "status");
        s.node.append(status);
        if (data.status === "analyzing") {
          const cancel = button("Stop inspection", () =>
            run(s, "cancel", { revision: data.revision }),
          );
          cancel.disabled = isLocked() || s.busy;
          s.node.append(cancel);
        }
        return;
      }
      if (data.stale || !proposal || !reviewable) {
        if (data.stale || ["failed", "interrupted"].includes(data.status))
          s.node.append(
            el(
              "p",
              data.stale
                ? "The project has changed since this inspection. Inspect it again to review a current recommendation."
                : data.message,
              "welcome-note",
            ),
          );
        else if (report)
          s.node.append(
            el(
              "p",
              "This earlier inspection covered the test environment. Inspect again for project commands and a suggested first gremlin.",
              "welcome-note",
            ),
          );
        else if (data.message)
          s.node.append(el("p", data.message, "welcome-note"));
        const actions = el("div", undefined, "welcome-actions"),
          inspect = button(
            report || data.status !== "idle"
              ? "Inspect again"
              : "Inspect my app",
            () => run(s, "discover", {}),
            true,
          ),
          manual = button("Adopt a gremlin myself", () =>
            onCreatePm?.(s.project.name),
          );
        inspect.disabled = manual.disabled = disabled;
        actions.append(inspect, manual, link("Connections", "/connections"));
        s.node.append(
          actions,
          el(
            "p",
            "Inspection uses your source connection, Claude Code, and Docker. Linear and a hosted test app can come later.",
            "welcome-note",
          ),
        );
        return;
      }
      if (!confirmed) {
        s.node.append(el("p", report.summary, "welcome-summary"));
        if (report.stack?.length) {
          const stack = el("ul", undefined, "welcome-stack");
          stack.setAttribute("aria-label", "Detected stack");
          for (const item of report.stack) stack.append(el("li", item));
          s.node.append(stack);
        }
        const commands = el("section", undefined, "welcome-commands");
        commands.append(
          el("h3", "Suggested checks"),
          el(
            "p",
            "Select the commands to save for future runs. They have not been executed.",
            "welcome-note",
          ),
        );
        for (const [key, label] of Object.entries(commandNames)) {
          const suggestion = proposal.commands?.[key];
          if (!suggestion) continue;
          const row = el("label", undefined, "welcome-command"),
            checkbox = el("input"),
            body = el("span", undefined, "welcome-command-body");
          checkbox.type = "checkbox";
          checkbox.checked = s.selected.has(key);
          checkbox.disabled = disabled;
          checkbox.setAttribute(
            "aria-label",
            `Save ${label.toLowerCase()} command`,
          );
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) s.selected.add(key);
            else s.selected.delete(key);
          });
          body.append(
            el("strong", label),
            el("code", suggestion.command),
            el("span", suggestion.rationale),
            evidence(suggestion.evidence),
          );
          row.append(checkbox, body);
          commands.append(row);
        }
        if (!Object.keys(proposal.commands || {}).length)
          commands.append(
            el(
              "p",
              "No command could be recommended from the inspected source. Your existing commands will be kept.",
              "welcome-note",
            ),
          );
        s.node.append(commands);
      }
      const gremlin = el("section", undefined, "welcome-recommendation");
      gremlin.append(
        el("span", "YOUR SUGGESTED FIRST GREMLIN", "eyebrow muted"),
        el("h3", proposal.firstPm.name),
        el("p", proposal.firstPm.mandate),
      );
      if (!confirmed) gremlin.append(evidence(proposal.firstPm.evidence));
      s.node.append(gremlin);
      if (!confirmed && report.warnings?.length) {
        const notes = el("section", undefined, "welcome-open-questions");
        notes.append(el("h3", "Still to check"));
        const warnings = el("ul");
        for (const item of report.warnings) warnings.append(el("li", item));
        notes.append(warnings);
        s.node.append(notes);
      }
      const actions = el("div", undefined, "welcome-actions");
      if (confirmed) {
        const meet = button(
            `Meet ${proposal.firstPm.name}`,
            () =>
              onCreatePm?.(s.project.name, {
                name: proposal.firstPm.name,
                mandate: proposal.firstPm.mandate,
              }),
            true,
          ),
          own = button("Choose a different gremlin", () =>
            onCreatePm?.(s.project.name),
          );
        meet.disabled = own.disabled = disabled || Boolean(s.error);
        actions.append(meet, own);
      } else {
        const confirm = button(
            s.busy ? "Saving reviewed setup…" : "Confirm setup",
            () =>
              run(s, "confirm", {
                revision: data.revision,
                configurationRevision: data.configurationRevision,
                repositorySha: report.repository.sha,
                commandKeys: [...s.selected],
              }),
            true,
          ),
          inspect = button("Inspect again", () => run(s, "discover", {}));
        confirm.disabled = disabled || Boolean(s.error);
        inspect.disabled = disabled;
        actions.append(confirm, inspect);
      }
      s.node.append(
        actions,
        el(
          "p",
          confirmed
            ? "Adoption is a separate review. You choose when the first investigation starts."
            : "Confirmation saves only the selected commands. Hosting, credentials, repository files, and automation stay under your control.",
          "welcome-note",
        ),
      );
      s.node.append(
        el(
          "p",
          `Based on ${report.repository.branch} · ${report.repository.sha.slice(0, 8)} · ${report.repository.filesRead.length} inspected files`,
          "welcome-provenance",
        ),
      );
    }
    function forget(name) {
      const s = entries.get(name);
      if (!s) return;
      clearTimeout(s.timer);
      ++s.generation;
      if (active === s) active = null;
      entries.delete(name);
    }
    function pagechange() {
      if (
        active &&
        (pages.current !== "project" ||
          pages.project !== active.project.name ||
          pages.pm ||
          !["", "overview", "brief"].includes(pages.tab || ""))
      )
        deactivate();
    }
    const visibility = () => {
      if (document.hidden) {
        if (active) clearTimeout(active.timer);
      } else if (active) load(active, true);
    };
    window.addEventListener("dashboard:pagechange", pagechange);
    window.addEventListener("pagehide", deactivate);
    document.addEventListener("visibilitychange", visibility);
    return {
      mount(container, project) {
        let s = entries.get(project.name);
        if (s && identity(s.project) !== identity(project)) {
          forget(project.name);
          s = null;
        }
        if (!s) {
          s = {
            project,
            node: el("section", undefined, "project-welcome"),
            data: null,
            busy: false,
            loading: false,
            loaded: false,
            error: "",
            signature: "",
            generation: 0,
            timer: null,
            selected: new Set(),
          };
          entries.set(project.name, s);
        }
        s.project = project;
        if (active !== s) deactivate();
        active = s;
        container.append(s.node);
        paint(s);
        load(s);
        schedule(s);
      },
      refresh(name) {
        const s = entries.get(typeof name === "string" ? name : name.name);
        if (s) return load(s, true);
      },
      resume(projects) {
        for (const [name, s] of entries) {
          const p = projects.find((item) => item.name === name);
          if (!p || identity(p) !== identity(s.project)) forget(name);
          else if (
            active === s &&
            (p.areas?.length ||
              p.onboardingProgress?.hasMissions ||
              p.onboardingProgress?.investigated)
          )
            deactivate();
        }
        pagechange();
      },
      isBusy: () => [...entries.values()].some((s) => s.busy),
      protectFocus: () =>
        Boolean(active?.node.contains(document.activeElement)),
      forget,
      destroy() {
        destroyed = true;
        deactivate();
        for (const name of entries.keys()) forget(name);
        window.removeEventListener("dashboard:pagechange", pagechange);
        window.removeEventListener("pagehide", deactivate);
        document.removeEventListener("visibilitychange", visibility);
      },
    };
  };
})();
