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
  const suggestions = (proposal) =>
    proposal?.suggestedPms?.length
      ? proposal.suggestedPms
      : proposal?.firstPm
        ? [proposal.firstPm]
        : [];

  window.createProjectWelcome = ({
    api,
    pages,
    isLocked = () => false,
    onCreatePm,
    onSetupLinear,
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
    function setupJourney(s) {
      const project = s.project,
        readiness = project.readiness,
        ready = (id) =>
          readiness?.steps?.find((item) => item.id === id)?.ready === true,
        hasCrew = Boolean(project.areas?.length),
        needsPromotionEnvironment = readiness?.areas?.some((area) =>
          area.coding?.enableBlockers?.some(
            (item) => item.id === "promotion_environment",
          ),
        ),
        allReady =
          hasCrew &&
          project.areas.every((area) => {
            const state = readiness?.areas?.find(
              (item) => item.key === area.key,
            );
            return state?.canRun && state.canEnable && state.coding?.canEnable;
          }),
        canVerifyAndActivate =
          hasCrew &&
          !allReady &&
          project.areas.every((area) => {
            const state = readiness?.areas?.find(
              (item) => item.key === area.key,
            );
            const onlyVerification = (items) =>
              items?.length > 0 &&
              items.every((item) => item.id === "verification");
            return (
              state &&
              (state.canRun || onlyVerification(state.blockers)) &&
              (state.canEnable || onlyVerification(state.enableBlockers)) &&
              (state.coding?.canEnable ||
                onlyVerification(state.coding?.enableBlockers))
            );
          }),
        activeCrew =
          hasCrew &&
          project.areas.every(
            (area) => area.enabled && (area.codingEnabled ?? area.enabled),
          ),
        steps = [
          [
            "Connect repository",
            ready("source_connection"),
            "/connections#source-control",
          ],
          [
            "Prepare AI and runner",
            ready("ai_connection") && ready("worker"),
            ready("ai_connection")
              ? "/runners#workers"
              : "/connections#model-connections",
          ],
          [
            "Inspect source",
            Boolean(s.data?.report?.projectSetup),
            `/projects/${encodeURIComponent(project.name)}?tab=setup`,
          ],
          [
            "Review and adopt your crew",
            hasCrew,
            `/projects/${encodeURIComponent(project.name)}?tab=crew`,
          ],
          [
            "Set up Linear",
            hasCrew &&
              ready("linear_connection") &&
              readiness?.areas?.every(
                (area) =>
                  !area.blockers?.some((item) => item.id === "linear_mapping"),
              ),
            "linear",
          ],
          [
            needsPromotionEnvironment
              ? "Prepare integration deployment"
              : project.verification?.mode === "repository"
                ? "Confirm repository checks"
                : "Test app access",
            !needsPromotionEnvironment &&
              (project.verification?.mode === "repository"
                ? ready("verification")
                : ready("test_access") && ready("browser_verification")),
            `/projects/${encodeURIComponent(project.name)}?tab=environment`,
          ],
          ["Activate daily patrols", activeCrew && allReady, "activate"],
        ],
        section = el("section", undefined, "welcome-setup-journey"),
        list = el("ol", undefined, "welcome-setup-steps");
      if (s.suggestionsOnly && activeCrew && allReady) return null;
      section.append(
        el("span", "CREW SETUP", "eyebrow muted"),
        el(
          "h2",
          allReady ? "Your crew is ready." : "Finish setting up your crew.",
        ),
      );
      list.setAttribute("aria-label", "Project setup progress");
      for (const [label, done] of steps) {
        const item = el("li", undefined, done ? "complete" : "pending");
        item.append(el("span", done ? "✓" : "○"), el("span", label));
        list.append(item);
      }
      section.append(list);
      const next = steps.find(([, done]) => !done);
      if ((allReady && !activeCrew) || canVerifyAndActivate) {
        const activate = button(
          s.busy
            ? "Checking crew…"
            : canVerifyAndActivate
              ? "Verify & activate crew"
              : "Activate ready crew",
          async () => {
            if (unavailable(s) || !current(s)) return;
            s.busy = true;
            s.error = "";
            s.notice = "";
            paint(s);
            try {
              if (canVerifyAndActivate) {
                const verification = await api(
                  `/api/projects/${encodeURIComponent(project.name)}/verify`,
                  {},
                  "POST",
                  90000,
                );
                if (!current(s)) return;
                if (!verification.ok) {
                  const failed = (verification.checks || [])
                    .filter((check) => !check.ok)
                    .map(
                      (check) =>
                        `${check.name || "Connection"}: ${check.detail || check.message || "could not be verified"}`,
                    );
                  throw new Error(
                    failed.join(" · ") ||
                      "Project connections could not be verified. Your crew stays paused.",
                  );
                }
              }
              const snapshot = await api(
                `/api/projects/${encodeURIComponent(project.name)}/readiness`,
              );
              if (!current(s)) return;
              const result = await api(
                `/api/projects/${encodeURIComponent(project.name)}/crew/activate`,
                {
                  projectRevision: snapshot.projectRevision,
                  areasRevision: snapshot.areasRevision,
                },
              );
              if (!current(s)) return;
              s.notice =
                result.message ||
                "Your ready crew is active. No epic was approved by activation.";
              try {
                await onSaved(project.name);
              } catch {
                s.notice += " Refresh the dashboard to see the saved status.";
              }
            } catch (error) {
              if (current(s)) s.error = error.message;
            } finally {
              if (current(s)) {
                s.busy = false;
                paint(s);
              }
            }
          },
          true,
        );
        activate.disabled = unavailable(s);
        section.append(activate);
      } else if (next) {
        const [label, , destination] = next;
        if (destination === "linear" && onSetupLinear) {
          const configure = button("Set up Linear", () =>
            onSetupLinear(project.name),
          );
          configure.disabled = unavailable(s);
          section.append(configure);
        } else if (destination === "activate") {
          const blocker = readiness?.areas
            ?.flatMap((area) => area.enableBlockers || [])
            .find(Boolean);
          section.append(
            el(
              "p",
              blocker?.message ||
                "Finish the remaining setup checks before daily patrols can start.",
              "welcome-note",
            ),
          );
          const review = link(
            "Review readiness",
            `/projects/${encodeURIComponent(project.name)}?tab=crew`,
          );
          section.append(review);
        } else
          section.append(
            link(
              label,
              destination === "linear"
                ? "/connections#linear-connection"
                : destination,
            ),
          );
      }
      section.append(
        el(
          "p",
          project.workflow?.kind === "promotion" &&
            project.workflow.approvalPolicy === "epic"
            ? "Approve epics, then review your PMs’ promotion batches. Activate daily PMs and coding for approved epic work; without an approved epic, PMs investigate only. Activation does not approve any epic."
            : "Patrols start only after setup is ready and you activate the crew. Review your configured delivery policy before enabling coding.",
          "welcome-note",
        ),
      );
      return section;
    }
    function crewSuggestions(s, proposal, reviewed, disabled) {
      const section = el("section", undefined, "welcome-recommendation");
      section.append(el("span", "YOUR SUGGESTED CREW", "eyebrow muted"));
      section.append(
        el(
          "p",
          "Adopt the responsibilities you want. Remaining suggestions stay here for later; adopting one does not start daily patrols.",
          "welcome-note",
        ),
      );
      for (const suggestion of suggestions(proposal)) {
        const adopted = s.project.areas?.some(
            (area) => area.mandate?.trim() === suggestion.mandate.trim(),
          ),
          card = el("article", undefined, "welcome-crew-suggestion");
        card.append(el("h3", suggestion.name), el("p", suggestion.mandate));
        if (!reviewed) card.append(evidence(suggestion.evidence));
        if (adopted)
          card.append(el("p", "Already in your crew", "welcome-note"));
        else if (reviewed) {
          const meet = button(
            `Meet ${suggestion.name}`,
            () =>
              onCreatePm?.(s.project.name, {
                name: suggestion.name,
                mandate: suggestion.mandate,
              }),
            true,
          );
          meet.disabled = disabled;
          card.append(meet);
        }
        section.append(card);
      }
      return section;
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
          s.suggestionsOnly,
          s.project.areas?.map((area) => [area.key, area.mandate]),
          s.project.readiness,
          s.project.areas?.map((area) => area.enabled),
        ]);
      if (signature === s.signature) return;
      s.signature = signature;
      s.node.replaceChildren();
      const journey = setupJourney(s);
      if (journey) s.node.append(journey);
      if (s.suggestionsOnly) {
        if (s.notice) s.node.append(el("p", s.notice, "welcome-note"));
        if (s.error) {
          const error = el("p", s.error, "welcome-error");
          error.setAttribute("role", "alert");
          s.node.append(error);
        }
        if (journey && !proposal) return;
        s.node.append(el("h2", "Grow your crew"));
        if (proposal) {
          s.node.append(
            crewSuggestions(
              s,
              proposal,
              confirmed || Boolean(data.setupConfirmation?.confirmedAt),
              disabled,
            ),
          );
          if (data.stale)
            s.node.append(
              el(
                "p",
                "These suggestions come from the saved source inspection. Review their scope against the current app before adoption.",
                "welcome-note",
              ),
            );
        } else
          s.node.append(
            el(
              "p",
              "Inspect the app once to get PM suggestions grounded in its code.",
              "welcome-note",
            ),
          );
        s.node.append(
          link(
            "Review app setup",
            `/projects/${encodeURIComponent(s.project.name)}?tab=setup`,
          ),
        );
        return;
      }
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
      s.node.append(
        crewSuggestions(s, proposal, confirmed, disabled || Boolean(s.error)),
      );
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
        const own = button("Choose a different gremlin", () =>
          onCreatePm?.(s.project.name),
        );
        own.disabled = disabled || Boolean(s.error);
        actions.append(
          own,
          link(
            "Review your crew",
            `/projects/${encodeURIComponent(s.project.name)}?tab=crew`,
          ),
        );
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
          !["", "overview", "brief", "crew", "setup"].includes(pages.tab || ""))
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
      mount(container, project, { suggestionsOnly = false } = {}) {
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
        s.suggestionsOnly = suggestionsOnly;
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
            !s.suggestionsOnly &&
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
