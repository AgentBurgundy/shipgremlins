"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const action = (text, handler, primary = false) => {
    const node = el(
      "button",
      text,
      primary ? "button button-dark" : "small-button",
    );
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };
  // /api/status supplies effective workflow and verification. Match the source
  // selected by the backend's inspectionBranch, excluding unrelated setup edits.
  const inspectionBranch = (project) => {
    const workflow = project?.workflow || {
      kind: "pull-request",
      baseBranch: project?.branches?.production || "main",
    };
    if (
      project?.verification?.mode !== "browser" &&
      workflow.kind === "promotion"
    )
      return project?.branches?.production;
    const target = project?.environments?.[project?.verification?.environment];
    if (
      project?.verification?.mode === "browser" &&
      ["vercel", "railway"].includes(target?.kind) &&
      target.branch
    )
      return target.branch;
    return workflow.kind === "promotion"
      ? project?.branches?.integration
      : workflow.baseBranch;
  };
  const identity = (project) =>
    JSON.stringify([
      project?.name,
      project?.instanceId ?? "legacy",
      project?.provider || "github",
      project?.repo,
      project?.serverUrl ?? null,
      inspectionBranch(project),
    ]);
  const running = (data) => ["analyzing", "publishing"].includes(data?.status);
  const suggested = (data) => {
    const setup = data?.report?.projectSetup;
    return (Array.isArray(setup?.suggestedPms) ? setup.suggestedPms : [])
      .filter((item) => {
        const charter = item?.draft?.charter;
        return (
          typeof item?.name === "string" &&
          item.name.trim() &&
          typeof item?.mandate === "string" &&
          item.mandate.trim() &&
          typeof item.draft?.key === "string" &&
          item.draft.key.trim() &&
          ["ambition", "goal", "metricDefinition"].every(
            (key) => typeof charter?.[key] === "string" && charter[key].trim(),
          ) &&
          [
            "users",
            "expectedToBuild",
            "nonGoals",
            "guardrails",
            "standingPriorities",
          ].every((key) => Array.isArray(charter?.[key]))
        );
      })
      .slice(0, 5);
  };
  const sameRole = (area, suggestion) =>
    (suggestion.draft?.key && area.key === suggestion.draft.key) ||
    area.mandate?.trim() === suggestion.mandate.trim() ||
    area.name?.trim().toLowerCase() === suggestion.name.trim().toLowerCase();

  window.createCrewRecommendations = ({
    api,
    getProject,
    onAdopt,
    isLocked = () => false,
  }) => {
    const entries = new Map();
    let active = null,
      destroyed = false;
    const current = (state) =>
      !destroyed &&
      entries.get(state.project.name) === state &&
      (!getProject ||
        identity(getProject(state.project.name)) === state.sourceIdentity);
    const endpoint = (state, operation = "") =>
      `/api/projects/${encodeURIComponent(state.project.name)}/onboarding${operation ? `/${operation}` : ""}`;

    function deactivate() {
      if (active) clearTimeout(active.timer);
      active = null;
    }
    function resetSource(state, project) {
      clearTimeout(state.timer);
      ++state.generation;
      state.project = project;
      state.sourceIdentity = identity(project);
      state.data = null;
      state.loaded = state.loading = state.busy = false;
      state.error = state.signature = "";
      paint(state);
      if (active === state) load(state, true);
    }
    function schedule(state) {
      clearTimeout(state.timer);
      if (
        !current(state) ||
        active !== state ||
        document.hidden ||
        state.busy ||
        !running(state.data)
      )
        return;
      state.timer = setTimeout(() => load(state, true), 1800);
    }
    async function load(state, force = false) {
      if (
        !current(state) ||
        state.busy ||
        state.loading ||
        isLocked() ||
        (state.loaded && !force)
      )
        return;
      const generation = ++state.generation;
      state.loading = true;
      paint(state);
      try {
        const data = await api(endpoint(state));
        if (!current(state) || generation !== state.generation) return;
        state.data = data;
        state.loaded = true;
        state.error = "";
      } catch (error) {
        if (current(state) && generation === state.generation)
          state.error =
            error.message || "We could not load this investigation. Try again.";
      } finally {
        if (current(state) && generation === state.generation) {
          state.loading = false;
          paint(state);
          schedule(state);
        }
      }
    }
    async function run(state, operation) {
      if (
        !current(state) ||
        state.busy ||
        isLocked() ||
        (running(state.data) && operation !== "cancel")
      )
        return;
      const generation = ++state.generation;
      clearTimeout(state.timer);
      state.loading = false;
      state.busy = true;
      state.error = "";
      paint(state);
      try {
        const data = await api(
          endpoint(state, operation),
          operation === "cancel" ? { revision: state.data.revision } : {},
        );
        if (!current(state) || generation !== state.generation) return;
        state.data = data;
        state.loaded = true;
      } catch (error) {
        if (current(state) && generation === state.generation)
          state.error =
            error.message ||
            "The investigation did not start. Check your connections and try again.";
      } finally {
        if (current(state) && generation === state.generation) {
          state.busy = false;
          paint(state);
          schedule(state);
        }
      }
    }
    function renderSuggestion(state, suggestion, index, disabled) {
      const card = el("article", undefined, "crew-recommendation");
      const heading = el("div", undefined, "crew-recommendation-heading");
      const portrait = el("img", undefined, "crew-recommendation-portrait");
      portrait.src =
        window.gremlinIdentity?.(suggestion)?.image ||
        "/assets/gremlin-investigating.webp";
      portrait.alt = "";
      portrait.width = portrait.height = 48;
      const copy = el("div");
      copy.append(
        el(
          "span",
          suggestion.draft?.key
            ? suggestion.draft.key.replaceAll(/[-_]/g, " ")
            : `SUGGESTED PM ${index + 1}`,
          "eyebrow muted",
        ),
        el("h3", suggestion.name),
      );
      heading.append(portrait, copy);
      card.append(heading);
      const charter = suggestion.draft?.charter || suggestion.charter;
      const purpose = charter?.goal || suggestion.mandate;
      card.append(el("p", purpose, "crew-recommendation-purpose"));
      if (charter?.expectedToBuild?.length) {
        const responsibilities = el(
          "ul",
          undefined,
          "crew-recommendation-responsibilities",
        );
        for (const item of charter.expectedToBuild.slice(0, 3))
          responsibilities.append(el("li", item));
        card.append(responsibilities);
      }
      const evidence = (suggestion.evidence || []).filter(
        (item) =>
          typeof item.path === "string" && typeof item.quote === "string",
      );
      if (evidence.length) {
        const source = el("div", undefined, "crew-recommendation-evidence");
        source.append(el("span", "FOUND IN YOUR CODE", "eyebrow muted"));
        if (suggestion.rationale)
          source.append(
            el("p", suggestion.rationale, "crew-recommendation-rationale"),
          );
        for (const item of evidence.slice(0, 2)) {
          const row = el("p");
          row.append(el("code", item.path), el("span", item.quote));
          source.append(row);
        }
        card.append(source);
      }
      const adopted = state.project.areas?.some((area) =>
        sameRole(area, suggestion),
      );
      if (adopted)
        card.append(el("p", "✓ In your crew", "crew-recommendation-adopted"));
      else {
        const adopt = action(
          "Adopt",
          () => {
            if (
              !current(state) ||
              isLocked() ||
              running(state.data) ||
              state.busy ||
              state.loading ||
              !state.loaded ||
              state.error ||
              state.data?.recommendationsReviewable === false
            )
              return;
            const latest = getProject?.(state.project.name) || state.project;
            if (latest.areas?.some((area) => sameRole(area, suggestion)))
              return;
            onAdopt?.(state.project.name, { ...suggestion, review: true });
          },
          true,
        );
        adopt.setAttribute("aria-label", `Adopt ${suggestion.name}`);
        adopt.disabled = disabled;
        card.append(adopt);
      }
      return card;
    }
    function paint(state) {
      if (!current(state)) return;
      const data = state.data,
        choices = suggested(data),
        inProgress = running(data),
        remaining = choices.filter(
          (item) => !state.project.areas?.some((area) => sameRole(area, item)),
        );
      state.node.className = `crew-recommendations${state.compact ? " crew-recommendations-summary" : ""}`;
      state.node.hidden = Boolean(
        state.hideWhenEmpty && !inProgress && !state.busy && !remaining.length,
      );
      const signature = JSON.stringify([
        data,
        state.compact,
        state.error,
        state.busy,
        state.loading,
        isLocked(),
        state.project.areas?.map(({ key, name, mandate }) => [
          key,
          name,
          mandate,
        ]),
      ]);
      if (signature === state.signature) return;
      state.signature = signature;
      state.node.replaceChildren();
      if (state.compact) {
        const copy = el("div", undefined, "crew-recommendations-summary-copy");
        const changedSource = data?.recommendationsReviewable === false;
        copy.append(
          el("span", "YOUR SUGGESTED CREW", "eyebrow muted"),
          el(
            "h2",
            inProgress
              ? "Your crew investigation is running."
              : changedSource
                ? `${remaining.length} saved gremlin suggestion${remaining.length === 1 ? "" : "s"}`
                : `${remaining.length} suggested gremlin${remaining.length === 1 ? " is" : "s are"} waiting.`,
          ),
          el(
            "p",
            inProgress
              ? data.message || "The repository investigation is running."
              : changedSource
                ? "The inspection source has changed. Review the saved suggestions and their source before continuing."
                : state.error
                  ? "Saved recommendations are still available. Open your crew to refresh their status."
                  : "Your AI recommendations are saved. Pick up where you left off.",
          ),
        );
        const resume = el(
          "a",
          inProgress
            ? "Follow crew investigation"
            : changedSource
              ? "Review saved crew"
              : "Continue choosing your crew",
          "small-button",
        );
        resume.href = `/projects/${encodeURIComponent(state.project.name)}?tab=crew`;
        state.node.append(copy, resume);
        return;
      }
      const hero = el("header", undefined, "crew-recommendations-heading");
      const copy = el("div");
      copy.append(el("span", "A CREW FOR YOUR APP", "eyebrow muted"));
      copy.append(
        el(
          "h2",
          inProgress
            ? "Finding the right gremlins…"
            : choices.length
              ? "Meet your suggested crew."
              : "Let’s find your gremlins.",
        ),
      );
      copy.append(
        el(
          "p",
          choices.length
            ? "PMs with distinct responsibilities, grounded in your code. Pick one, review its brief, and adopt."
            : "Let AI investigate your code and suggest product managers for the areas that matter to this app.",
        ),
      );
      hero.append(copy);
      state.node.append(hero);
      if (state.error) {
        const error = el("div", undefined, "crew-recommendations-error");
        error.setAttribute("role", "alert");
        error.append(
          el("p", state.error),
          action("Refresh status", () => load(state, true)),
        );
        state.node.append(error);
      }
      if (inProgress || state.busy) {
        const progress = el("div", undefined, "crew-recommendations-progress");
        progress.setAttribute("role", "status");
        progress.setAttribute("aria-live", "polite");
        progress.append(
          el("span", "", "crew-recommendations-pulse"),
          el(
            "p",
            state.busy
              ? "Updating the investigation…"
              : data.message || "The repository investigation is running.",
          ),
        );
        if (data?.stage)
          progress.append(
            el(
              "span",
              data.stage.replaceAll("-", " "),
              "crew-recommendations-stage",
            ),
          );
        state.node.append(progress);
        if (data?.status === "analyzing") {
          const stop = action("Stop investigation", () => run(state, "cancel"));
          stop.disabled = state.busy || isLocked();
          state.node.append(stop);
        }
      } else if (state.loading && !state.loaded) {
        const loading = el(
          "p",
          "Checking for a saved investigation…",
          "crew-recommendations-note",
        );
        loading.setAttribute("role", "status");
        state.node.append(loading);
      } else {
        const setup = data?.report?.projectSetup;
        if (
          !choices.length &&
          setup &&
          (!Array.isArray(setup.suggestedPms) || setup.suggestedPms.length)
        )
          state.node.append(
            el(
              "p",
              "Your saved investigation predates complete crew recommendations. Find your gremlins to get product-specific responsibilities and ready-to-review briefs.",
              "crew-recommendations-note",
            ),
          );
        if (data?.recommendationsReviewable === false && choices.length)
          state.node.append(
            el(
              "p",
              "The repository or inspection branch has changed. Investigate again before adopting these suggestions.",
              "crew-recommendations-note",
            ),
          );
        else if (data?.stale)
          state.node.append(
            el(
              "p",
              "These suggestions come from a saved source inspection. Review their scope against the current app, or investigate again for updated recommendations.",
              "crew-recommendations-note",
            ),
          );
        if (["failed", "interrupted"].includes(data?.status)) {
          const failure = el(
            "p",
            data.message ||
              "The last investigation stopped before finishing. You can retry it.",
            "crew-recommendations-error",
          );
          failure.setAttribute("role", "alert");
          state.node.append(failure);
        }
        if (choices.length) {
          const grid = el("div", undefined, "crew-recommendations-grid");
          choices.forEach((suggestion, index) =>
            grid.append(
              renderSuggestion(
                state,
                suggestion,
                index,
                isLocked() ||
                  state.loading ||
                  Boolean(state.error) ||
                  data.recommendationsReviewable === false,
              ),
            ),
          );
          state.node.append(grid);
          const repository = data.report.repository;
          if (repository?.sha)
            state.node.append(
              el(
                "p",
                `Source inspection · ${repository.branch || "repository"} · ${repository.sha.slice(0, 8)} · ${(repository.filesRead || []).length} files read`,
                "crew-recommendations-provenance",
              ),
            );
        }
        const controls = el("div", undefined, "crew-recommendations-actions");
        const inspect = action(
          choices.length ? "Refresh recommendations" : "Find my gremlins",
          () => run(state, "discover"),
          !choices.length,
        );
        const manual = action("Choose a gremlin myself", () => {
          if (current(state) && !isLocked()) onAdopt?.(state.project.name);
        });
        inspect.disabled = manual.disabled = isLocked() || state.loading;
        controls.append(inspect, manual);
        state.node.append(controls);
      }
      state.node.append(
        el(
          "p",
          "This AI investigation reads code; it does not browse the app, change code, create tickets or enable automation. Hosting and test accounts are prepared before browser patrols.",
          "crew-recommendations-note",
        ),
      );
    }
    function forget(name) {
      const state = entries.get(name);
      if (!state) return;
      clearTimeout(state.timer);
      ++state.generation;
      if (active === state) active = null;
      entries.delete(name);
    }
    const visibility = () => {
      if (document.hidden) {
        if (active) clearTimeout(active.timer);
      } else if (active) load(active, true);
    };
    window.addEventListener("pagehide", deactivate);
    document.addEventListener("visibilitychange", visibility);
    return {
      mount(container, project, options = {}) {
        let state = entries.get(project.name);
        if (state && state.sourceIdentity !== identity(project))
          resetSource(state, project);
        if (!state) {
          state = {
            project,
            sourceIdentity: identity(project),
            node: el("section", undefined, "crew-recommendations"),
            data: null,
            loaded: false,
            loading: false,
            busy: false,
            generation: 0,
            error: "",
            signature: "",
            timer: null,
          };
          entries.set(project.name, state);
        }
        state.project = project;
        state.hideWhenEmpty = Boolean(options.hideWhenEmpty);
        state.compact = Boolean(options.compact);
        if (active !== state) deactivate();
        active = state;
        container.append(state.node);
        paint(state);
        load(state);
        schedule(state);
      },
      refresh(name) {
        const state = entries.get(typeof name === "string" ? name : name.name);
        if (state) return load(state, true);
      },
      hasSuggestions(project) {
        const state = entries.get(project.name);
        return Boolean(
          state &&
          state.sourceIdentity === identity(project) &&
          suggested(state.data).length,
        );
      },
      resume(projects) {
        for (const [name, state] of entries) {
          const project = projects.find((item) => item.name === name);
          if (!project) forget(name);
          else if (state.sourceIdentity !== identity(project))
            resetSource(state, project);
          else {
            state.project = project;
            paint(state);
          }
        }
      },
      isBusy: () => [...entries.values()].some((state) => state.busy),
      protectFocus: () =>
        Boolean(active?.node.contains(document.activeElement)),
      deactivate,
      forget,
      destroy() {
        destroyed = true;
        deactivate();
        for (const name of entries.keys()) forget(name);
        window.removeEventListener("pagehide", deactivate);
        document.removeEventListener("visibilitychange", visibility);
      },
    };
  };
})();
