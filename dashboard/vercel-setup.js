"use strict";
(() => {
  const node = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (text, action, primary = false) => {
    const value = node(
      "button",
      text,
      primary ? "button button-dark" : "small-button",
    );
    value.type = "button";
    value.addEventListener("click", action);
    return value;
  };
  const safePreview = (candidate) =>
    candidate?.selectable === true &&
    candidate.environment !== "production" &&
    candidate.target?.kind === "vercel" &&
    candidate.target.role !== "production";
  const building = (state) =>
    state?.status === "deploying" ||
    ["QUEUED", "INITIALIZING", "BUILDING"].includes(state?.deployment?.state);
  window.createVercelSetup = ({
    api,
    project,
    onSelect,
    getStatus = () => null,
    isLocked = () => false,
  }) => {
    const endpoint = (action = "") =>
      `/api/projects/${encodeURIComponent(project.name)}/onboarding/vercel${action ? `/${action}` : ""}`;
    const root = node("section", undefined, "vercel-setup"),
      heading = node("div", undefined, "vercel-setup-heading"),
      brand = node("img"),
      title = node("div"),
      greeting = node("div", undefined, "vercel-gremlin-greeting"),
      gremlin = node("img"),
      intro = node("div"),
      message = node(
        "p",
        "I can find your existing test deployment or help create a preview for your crew.",
        "vercel-setup-message",
      ),
      stage = node("div", undefined, "vercel-setup-stage"),
      error = node("p", "", "vercel-setup-error"),
      chat = node("details", undefined, "vercel-setup-chat"),
      transcript = node("div", undefined, "vercel-chat-transcript"),
      composer = node("form", undefined, "vercel-chat-composer"),
      question = node("textarea"),
      ask = node("button", "Ask Setup Gremlin", "small-button");
    brand.src = "/assets/brands/vercel.svg";
    brand.alt = "";
    brand.width = brand.height = 20;
    title.append(
      node("h4", "A test home on Vercel"),
      node("span", "Find → review → connect", "vercel-setup-kicker"),
    );
    heading.append(brand, title);
    gremlin.src = "/assets/gremlin.webp";
    gremlin.alt = "";
    gremlin.width = gremlin.height = 42;
    intro.append(node("strong", "Setup Gremlin"), message);
    greeting.append(gremlin, intro);
    message.setAttribute("role", "status");
    error.setAttribute("role", "alert");
    error.hidden = true;
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-label", "Setup conversation");
    question.setAttribute(
      "aria-label",
      "Ask about your Vercel test environment",
    );
    question.placeholder =
      "e.g. My test app is a separate Vercel project. What should I select?";
    question.rows = 2;
    question.maxLength = 2000;
    ask.type = "submit";
    composer.append(question, ask);
    chat.append(
      node("summary", "Need a hand? Ask Setup Gremlin"),
      transcript,
      composer,
      node(
        "p",
        "Chat gives guidance. Changes happen only through the reviewed actions above.",
        "vercel-setup-note",
      ),
    );
    root.append(heading, greeting, stage, error, chat);
    let state = null,
      busy = false,
      chatting = false,
      active = true,
      destroyed = false,
      timer = null,
      loaded = false,
      selected = "",
      signature = "",
      request = 0;
    const controls = new Set(),
      guards = new Map();
    function action(text, fn, primary = false) {
      const value = button(text, fn, primary);
      controls.add(value);
      return value;
    }
    function controlState() {
      stage.setAttribute("aria-busy", String(busy));
      for (const value of controls)
        value.disabled = busy || isLocked() || Boolean(guards.get(value)?.());
      question.disabled = ask.disabled = chatting || isLocked();
    }
    function field(label, value, options, onChange) {
      const wrap = node("div", undefined, "field"),
        caption = node("label", label),
        input = node(options ? "select" : "input");
      input.id = `vercel-${project.name}-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      caption.htmlFor = input.id;
      if (options)
        for (const option of options)
          input.append(new Option(option.label, option.value));
      input.value = value || "";
      input.addEventListener(options ? "change" : "input", () =>
        onChange(input.value),
      );
      controls.add(input);
      wrap.append(caption, input);
      return wrap;
    }
    function schedule() {
      clearTimeout(timer);
      if (active && !destroyed && building(state) && !document.hidden)
        timer = setTimeout(() => load(true), 4000);
    }
    async function call(actionName, body, pending) {
      if (busy || isLocked() || destroyed) return;
      const generation = ++request;
      busy = true;
      error.hidden = true;
      clearTimeout(timer);
      if (pending) message.textContent = pending;
      controlState();
      try {
        const result = await api(endpoint(actionName), body);
        if (destroyed || request !== generation) return;
        state = result;
        if (actionName) selected = "";
        loaded = true;
        render();
      } catch (failure) {
        if (destroyed || request !== generation) return;
        if (actionName) {
          try {
            const current = await api(endpoint());
            if (destroyed || request !== generation) return;
            state = current;
            loaded = true;
            render();
          } catch {
            // Failed mutations may still advance the server revision.
            if (state) {
              state = { ...state, stale: true };
              render();
            }
          }
        }
        error.textContent =
          failure.message || "Vercel setup could not finish. Try again.";
        error.hidden = false;
        message.textContent =
          state?.message ||
          "Your current environment is unchanged. Retry when you are ready.";
      } finally {
        if (request === generation) {
          busy = false;
          controlState();
          schedule();
        }
      }
    }
    async function load(force = false) {
      if (loaded && !force) return;
      await call("", undefined);
    }
    function choose(candidate) {
      if (busy || isLocked() || !safePreview(candidate)) return;
      selected = candidate.id;
      onSelect({
        target: structuredClone(candidate.target),
        label: `${state.inventory?.selectedProject?.name || "Vercel"} · ${candidate.branch || candidate.environment}`,
      });
      message.textContent =
        "Selected. Review app sign-in below, save the environment, then test access before the crew uses it.";
      signature = "";
      render();
    }
    function deploymentCard(candidate) {
      const card = node(
          "div",
          undefined,
          `vercel-environment${selected === candidate.id ? " selected" : ""}`,
        ),
        copy = node("div"),
        label = candidate.customEnvironmentId
          ? state.inventory?.selectedProject?.customEnvironments?.find(
              (item) => item.id === candidate.customEnvironmentId,
            )?.slug || "Custom test environment"
          : "Preview";
      copy.append(
        node(
          "strong",
          `${label} · ${candidate.branch || "No branch reported"}`,
        ),
        node(
          "span",
          `${candidate.state}${candidate.sha ? ` · ${candidate.sha.slice(0, 7)}` : ""}`,
          "vercel-environment-meta",
        ),
      );
      if (candidate.url)
        copy.append(node("span", candidate.url, "vercel-environment-url"));
      card.append(copy);
      if (safePreview(candidate))
        card.append(
          action(
            selected === candidate.id ? "Selected" : "Use this preview",
            () => choose(candidate),
          ),
        );
      else
        card.append(
          node(
            "span",
            candidate.reason || "Not ready",
            "vercel-environment-meta",
          ),
        );
      return card;
    }
    function render() {
      const connections = (getStatus()?.serviceConnections || []).filter(
        (item) => item.provider === "vercel",
      );
      const nextSignature = JSON.stringify([state, selected, connections]);
      if (signature === nextSignature) return;
      signature = nextSignature;
      stage.replaceChildren();
      controls.clear();
      guards.clear();
      if (!selected)
        message.textContent =
          state?.message ||
          "I can find your existing test deployment or help create a preview for your crew.";
      const inventory = state?.inventory;
      if (state?.stale)
        stage.append(
          node(
            "p",
            "Project settings changed. Find environments again before creating a preview.",
            "vercel-setup-note",
          ),
        );
      if (building(state)) {
        stage.append(
          node("div", "Building your test deployment…", "vercel-build-status"),
          node(
            "p",
            `${state.plan?.projectName || "Vercel"} · ${state.plan?.branch || "Preview"}. You can leave this page; come back to check the deployment.`,
            "vercel-setup-note",
          ),
          action("Check deployment", () => load(true)),
        );
        controlState();
        return;
      }
      if (
        state?.target &&
        state.deployment &&
        safePreview({ ...state.deployment, target: state.target })
      ) {
        stage.append(
          node("h4", "Your preview is ready"),
          deploymentCard({ ...state.deployment, target: state.target }),
          node(
            "p",
            "A successful deployment still needs an application access test.",
            "vercel-setup-note",
          ),
        );
      }
      const pickers = node("div", undefined, "vercel-setup-pickers");
      let connectionId =
          inventory?.connectionId ||
          project.vercel?.connectionId ||
          Object.values(project.environments || {}).find(
            (target) => target.kind === "vercel",
          )?.connectionId ||
          connections.find((item) => item.id === "default")?.id ||
          connections.find((item) => item.connected && !item.needsReconnect)
            ?.id ||
          "default",
        teamId = inventory?.teamId,
        projectId = inventory?.selectedProject?.id;
      if (connections.length)
        pickers.append(
          field(
            "Vercel connection",
            connectionId,
            connections.map((item) => ({
              value: item.id,
              label: `${item.label || item.id}${item.workspace?.name ? ` · ${item.workspace.name}` : ""}${item.needsReconnect ? " · reconnect needed" : ""}`,
            })),
            (value) => {
              connectionId = value;
              teamId = undefined;
              projectId = undefined;
            },
          ),
        );
      const discover = () =>
        call(
          "discover",
          {
            ...(state?.revision ? { revision: state.revision } : {}),
            connectionId,
            ...(teamId !== undefined ? { teamId } : {}),
            ...(projectId ? { projectId } : {}),
          },
          "Looking for Vercel projects and test deployments…",
        );
      if (inventory?.projects?.length)
        pickers.append(
          field(
            "Vercel project",
            projectId || "",
            [
              { value: "", label: "Choose a project" },
              ...inventory.projects.map((item) => ({
                value: item.id,
                label: `${item.name}${item.matchesRepository ? " · same repository" : ""}`,
              })),
            ],
            (value) => {
              projectId = value;
            },
          ),
        );
      stage.append(pickers);
      const toolbar = node("div", undefined, "vercel-setup-toolbar"),
        find = action(
          inventory ? "Find environments again" : "Find my Vercel environment",
          discover,
          !inventory,
        );
      toolbar.append(find);
      const manage = node("a", "Manage Vercel connection");
      manage.href = "/connections#vercel-connection";
      toolbar.append(manage);
      stage.append(toolbar);
      const teamChoice = node("details", undefined, "vercel-team-choice");
      teamChoice.append(
        node("summary", "Use another team"),
        node(
          "p",
          "Your saved connection’s team is used by default. For a token with access to several teams, enter the Team ID from Vercel’s team settings.",
          "vercel-setup-note",
        ),
        field("Team ID", teamId || "", null, (value) => {
          teamId = value.trim() || undefined;
          projectId = undefined;
        }),
      );
      stage.append(teamChoice);
      if (!inventory) {
        stage.append(
          node(
            "p",
            "Uses your saved Vercel connection. A separate staging project is fine; you can choose it from the list.",
            "vercel-setup-note",
          ),
        );
        controlState();
        return;
      }
      if (!inventory.projects.length)
        stage.append(
          node(
            "p",
            "No accessible projects found. Check which account or team your Vercel connection can access.",
            "vercel-setup-note",
          ),
        );
      if (!inventory.selectedProject) {
        stage.append(
          node(
            "p",
            "Choose the Vercel project that hosts this app, then find its environments.",
            "vercel-setup-note",
          ),
        );
        controlState();
        return;
      }
      stage.append(
        node(
          "p",
          `Looking in ${inventory.selectedProject.name}${inventory.teamId ? ` · team ${inventory.teamId}` : ""}`,
          "vercel-setup-context",
        ),
      );
      if (inventory.selectedProject.rootDirectory)
        stage.append(
          node(
            "p",
            `App directory: ${inventory.selectedProject.rootDirectory}`,
            "vercel-setup-note",
          ),
        );
      const previews = inventory.deployments.filter(
        (item) => item.environment !== "production",
      );
      if (previews.length) {
        const environments = node("div", undefined, "vercel-environments");
        for (const candidate of previews.slice(0, 4))
          environments.append(deploymentCard(candidate));
        if (previews.length > 4) {
          const more = node("details", undefined, "vercel-more-environments");
          more.append(
            node("summary", `Show ${previews.length - 4} more deployments`),
          );
          for (const candidate of previews.slice(4))
            more.append(deploymentCard(candidate));
          environments.append(more);
        }
        stage.append(environments);
      } else if (!state.target)
        stage.append(
          node(
            "p",
            "No test deployments found here yet. We can prepare a preview for this app.",
            "vercel-setup-note",
          ),
        );
      const productionCount = inventory.deployments.filter(
        (item) => item.environment === "production",
      ).length;
      if (productionCount)
        stage.append(
          node(
            "p",
            `${productionCount} production deployment${productionCount === 1 ? " is" : "s are"} excluded from test choices.`,
            "vercel-setup-note",
          ),
        );
      if (inventory.truncated)
        stage.append(
          node(
            "p",
            "This is a bounded list. If your environment is missing, choose its exact Vercel project or add its test URL below.",
            "vercel-setup-note",
          ),
        );
      if (state.plan && state.status === "prepared" && !state.stale) {
        const plan = state.plan,
          review = node("section", undefined, "vercel-preview-review");
        review.append(
          node("span", "REVIEW BEFORE CREATING", "vercel-setup-kicker"),
          node("h4", `${plan.projectName} · ${plan.branch}`),
        );
        const facts = node("dl", undefined, "vercel-plan-facts");
        for (const [label, value] of [
          [
            "Environment",
            plan.customEnvironmentId
              ? inventory.selectedProject.customEnvironments.find(
                  (item) => item.id === plan.customEnvironmentId,
                )?.slug || plan.customEnvironmentId
              : "Vercel Preview",
          ],
          ["Source", `${plan.baseBranch} · ${plan.sha.slice(0, 7)}`],
          [
            "Branch",
            plan.createBranch ? `Create ${plan.branch}` : `Use ${plan.branch}`,
          ],
        ])
          facts.append(node("dt", label), node("dd", value));
        review.append(facts);
        for (const warning of plan.warnings)
          review.append(node("p", warning, "vercel-setup-note"));
        const acknowledgment = node("label", undefined, "vercel-data-confirm"),
          check = node("input"),
          deploy = action(
            "Create test preview",
            () => {
              if (!check.checked) return;
              return call(
                "deploy",
                { revision: state.revision, confirmTestData: true },
                "Creating the reviewed test preview…",
              );
            },
            true,
          );
        check.type = "checkbox";
        acknowledgment.append(
          check,
          node(
            "span",
            "I checked this environment’s variables and services. It uses test data and dedicated test accounts.",
          ),
        );
        guards.set(deploy, () => !check.checked);
        check.addEventListener("change", controlState);
        controls.add(check);
        review.append(acknowledgment, deploy);
        stage.append(review);
      } else if (!state.stale && state.status !== "deployed") {
        const create = node("details", undefined, "vercel-create-preview");
        create.open = !previews.some(safePreview);
        create.append(
          node("summary", "Create a dedicated test preview"),
          node(
            "p",
            "Review the branch and deployment before anything is created. Vercel build usage may apply.",
            "vercel-setup-note",
          ),
        );
        let branch = "pm-staging",
          baseBranch = inventory.selectedProject.productionBranch || "main",
          customEnvironmentId = "";
        const grid = node("div", undefined, "vercel-setup-pickers");
        grid.append(
          field("Test branch", branch, null, (value) => {
            branch = value;
          }),
          field("Start from branch", baseBranch, null, (value) => {
            baseBranch = value;
          }),
        );
        if (inventory.selectedProject.customEnvironments.length)
          grid.append(
            field(
              "Vercel environment",
              "",
              [
                { value: "", label: "Preview" },
                ...inventory.selectedProject.customEnvironments.map((item) => ({
                  value: item.id,
                  label: item.slug,
                })),
              ],
              (value) => {
                customEnvironmentId = value;
              },
            ),
          );
        create.append(
          grid,
          action("Review preview setup", () =>
            call(
              "prepare",
              {
                revision: state.revision,
                branch: branch.trim(),
                baseBranch: baseBranch.trim(),
                ...(customEnvironmentId ? { customEnvironmentId } : {}),
              },
              "Checking the source branch and preparing your preview plan…",
            ),
          ),
        );
        stage.append(create);
      }
      controlState();
    }
    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = question.value.trim();
      if (!text || text.length > 2000 || chatting || isLocked() || destroyed)
        return;
      chatting = true;
      controlState();
      transcript.append(node("p", text, "vercel-chat-user"));
      question.value = "";
      const reply = node(
        "p",
        "Thinking about your setup…",
        "vercel-chat-gremlin",
      );
      transcript.append(reply);
      try {
        const result = await api(endpoint("chat"), { message: text });
        if (!destroyed)
          reply.textContent =
            result.answer ||
            "I could not prepare an answer. Try a more specific setup question.";
      } catch (failure) {
        if (!destroyed)
          reply.textContent =
            failure.message || "The Setup Gremlin could not answer. Try again.";
      } finally {
        chatting = false;
        if (!destroyed) controlState();
      }
    });
    render();
    return {
      mount(container) {
        container.append(root);
        active = true;
        render();
        load();
        schedule();
      },
      syncConnections: render,
      setActive(value) {
        const wasActive = active;
        active = value;
        if (!active) clearTimeout(timer);
        else if (!wasActive && loaded) load(true);
        else schedule();
      },
      refresh: () => load(true),
      isBusy: () => busy || chatting,
      destroy() {
        destroyed = true;
        request++;
        clearTimeout(timer);
      },
    };
  };
})();
