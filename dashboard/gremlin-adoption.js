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
  window.gremlinIdentity = (area = {}) => {
    const scope = [area.name, area.key, area.mandate, area.charter?.goal]
      .filter(Boolean)
      .join(" ");
    const security =
      /\b(security|privacy|permissions|vulnerabilit\w*|authentication|authorization)\b/i.test(
        scope,
      );
    const poses = [
      "/assets/gremlin.webp",
      "/assets/gremlin-investigating.webp",
      "/assets/gremlin-reviewing.webp",
      "/assets/gremlin-building.webp",
    ];
    const identity = String(area.key || area.name || "");
    const pose =
      [...identity].reduce(
        (value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0,
        0,
      ) % poses.length;
    return {
      image: security ? "/assets/gremlin-security.webp" : poses[pose],
      description: security ? "Security & trust PM" : "Product PM",
    };
  };
  window.isCurrentGremlinAdoption = (adopted, project) => {
    const area = project?.areas?.find((item) => item.key === adopted?.key);
    return Boolean(
      adopted &&
      area &&
      project.name === adopted.project &&
      (project.instanceId ?? null) === (adopted.projectInstanceId ?? null) &&
      (area.instanceId ?? null) === (adopted.areaInstanceId ?? null),
    );
  };

  window.createGremlinAdoption = ({
    dialog,
    getInput,
    getProject,
    getJobs = () => [],
    onDraft,
    onFirstTask,
    onOpenHome,
    onOpenSignals,
    onRefreshReadiness,
    isLocked,
  }) => {
    const $ = (id) => document.getElementById(id),
      form = $("pm-create-form"),
      fields = $("pm-create-fields");
    if (!dialog || !form || !fields) return null;
    let stage = "project",
      projectGiven = false,
      accepted = null,
      busy = false,
      firstBusy = false,
      starter = "",
      lastStarter = "",
      welcomeWarning = "";
    const stages = new Map();
    const makeStage = (key) => {
      const value = el("section", `adoption-stage adoption-${key}`);
      value.dataset.adoptionStage = key;
      stages.set(key, value);
      // Keep original controls in the document while moving them between stages.
      fields.append(value);
      return value;
    };
    const project = makeStage("project"),
      mission = makeStage("mission"),
      meet = makeStage("meet"),
      brief = makeStage("brief"),
      advanced = makeStage("advanced"),
      reasoning = makeStage("reasoning");
    const projectField = $("pm-project").closest(".field"),
      missionField = $("pm-mandate").closest(".field"),
      nameField = $("pm-name").closest(".field"),
      keyField = $("pm-key").closest(".field"),
      linearField = $("pm-linear-project").closest(".field");
    project.append(projectField);
    projectField.querySelector("label").textContent =
      "Which app will your gremlin look after?";
    missionField.querySelector("label").textContent =
      "What should your gremlin take care of?";
    const starters = el("div", "adoption-starters");
    starters.setAttribute(
      "aria-label",
      "Starting points for your gremlin’s job",
    );
    const suggestions = [
      [
        "journey",
        "Smooth customer journeys",
        "Help people finish the important journeys in this app. Investigate confusing steps, explain the evidence, and propose a small improvement with clear acceptance criteria.",
      ],
      [
        "trust",
        "Security & trust",
        "Look after the app’s security, privacy, and permissions. Use dedicated test data, investigate risks with evidence, and propose bounded improvements without changing production data.",
      ],
      [
        "ideas",
        "Discover useful ideas",
        "Find useful ways this product could better serve its users. Explain assumptions, learn from the current app, and propose small experiments grounded in the product brief.",
      ],
      ["custom", "A job of my own", ""],
    ];
    const starterNote = el("p", "adoption-starter-note");
    starterNote.setAttribute("role", "status");
    for (const [key, label, mandate] of suggestions) {
      const choice = button(label, () => {
        starter = key;
        const input = $("pm-mandate");
        if (!input.value.trim() || input.value === lastStarter) {
          input.value = mandate;
          lastStarter = mandate;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          starterNote.textContent = "";
        } else
          starterNote.textContent =
            "Your goal is kept. Edit it to fit the job you have in mind.";
        render();
        input.focus();
      });
      choice.dataset.specialty = key;
      choice.setAttribute("aria-pressed", "false");
      starters.append(choice);
    }
    mission.append(starters, missionField, starterNote, $("pm-ai-draft"));
    const manual = button("Write the brief myself", () => {
      if (!validate(mission)) return;
      if (!$("pm-name").value.trim()) {
        $("pm-name").value =
          starter === "trust"
            ? "Trust Gremlin"
            : starter === "journey"
              ? "Journey Gremlin"
              : "Product Gremlin";
        $("pm-name").dispatchEvent(new Event("input", { bubbles: true }));
      }
      show("meet");
    });
    mission.append(manual);
    const creature = el("div", "adoption-creature-card"),
      image = el("img", "adoption-creature"),
      identity = el("div", "adoption-creature-copy"),
      specialty = el("p", "adoption-specialty");
    image.alt = "Your PM Gremlin";
    image.width = 180;
    image.height = 180;
    nameField.querySelector("label").textContent = "Give your gremlin a name";
    const summary = el("p", "adoption-job-summary"),
      home = el("p", "adoption-home");
    identity.append(specialty, nameField, home);
    creature.append(image, identity);
    const reviewActions = el("div", "adoption-review-actions");
    const reasoningButton = button("AI reasoning & assumptions", () =>
      show("reasoning"),
    );
    reviewActions.append(
      button("Review full brief", () => show("brief")),
      button("Advanced settings", () => show("advanced")),
      reasoningButton,
    );
    meet.append(
      creature,
      el("h3", "", "Their job"),
      summary,
      el(
        "p",
        "adoption-contract",
        "Your PM investigates, learns, and proposes work. Coding Gremlins build approved tickets; Grumblins simulate customer visits.",
      ),
      reviewActions,
      $("pm-creation-readiness"),
    );
    brief.append($("pm-charter-fields").closest(".pm-charter-create"));
    const aiPreview = $("pm-ai-draft").querySelector(".pm-ai-draft-preview");
    if (aiPreview) reasoning.append(aiPreview);
    advanced.append(
      el("h3", "", "Technical identity & Linear"),
      keyField,
      linearField,
      $("pm-advanced"),
    );
    const discovery = $("pm-discover-after-create");
    discovery.checked = false;
    discovery.disabled = true;
    discovery.closest("label").hidden = true;
    const footer = $("create-pm").closest(".form-bottom"),
      footerCopy = footer.querySelector("p");
    footerCopy.textContent =
      "Automation stays off. Adoption does not start a run.";
    const back = button("Back", () =>
      show(
        stage === "mission" ? "project" : stage === "meet" ? "mission" : "meet",
      ),
    );
    const next = button("Continue", () => advance(), true);
    footer.prepend(back);
    footer.append(next);
    fields.replaceChildren(
      ...stages.values(),
      discovery.closest("label"),
      footer,
    );
    form.noValidate = true;
    const progress = el("p", "adoption-progress");
    progress.setAttribute("aria-live", "polite");
    form.before(progress);
    const welcome = el("section", "adoption-welcome");
    welcome.hidden = true;
    const welcomeImage = el("img", "adoption-welcome-creature");
    welcomeImage.alt = "Your adopted PM Gremlin";
    welcomeImage.width = 200;
    welcomeImage.height = 200;
    const welcomeTitle = el("h3"),
      welcomeJob = el("p", "adoption-welcome-job"),
      welcomeStatus = el("p", "adoption-welcome-status"),
      welcomeNotice = el("p", "form-message"),
      welcomeActions = el("div", "adoption-welcome-actions");
    welcomeTitle.tabIndex = -1;
    welcomeNotice.setAttribute("role", "status");
    const firstTask = button(
      "Explore the codebase",
      async () => {
        if (!accepted || firstBusy || busy || isLocked()) return;
        if (
          !window.isCurrentGremlinAdoption(
            accepted,
            getProject(accepted.project),
          )
        ) {
          render();
          return;
        }
        firstBusy = true;
        render();
        try {
          await onFirstTask(accepted, firstTask);
        } catch (error) {
          welcomeWarning =
            error.message ||
            "The first task could not start. Your gremlin is safely adopted.";
        } finally {
          firstBusy = false;
          render();
        }
      },
      true,
    );
    const openHome = button("Visit their home", () => {
      if (
        !busy &&
        !firstBusy &&
        window.isCurrentGremlinAdoption(accepted, getProject(accepted?.project))
      )
        onOpenHome(accepted);
    });
    const signals = el("section", "adoption-signals"),
      signalActions = el("div", "adoption-signal-actions"),
      signalButtons = [];
    signals.append(
      el("h4", "", "Give them more to go on."),
      el(
        "p",
        "",
        "Optional signals help your gremlin understand real usage. You can start with code only and add these later.",
      ),
      signalActions,
    );
    for (const [provider, name, purpose] of [
      ["sentry", "Sentry", "Investigate errors"],
      ["mixpanel", "Mixpanel", "Understand user behavior"],
      ["datadog", "Datadog", "Follow service logs"],
    ]) {
      const choice = button("", async () => {
        if (!accepted || busy || firstBusy || isLocked()) return;
        if (
          !window.isCurrentGremlinAdoption(
            accepted,
            getProject(accepted.project),
          )
        ) {
          render();
          return;
        }
        firstBusy = true;
        render();
        try {
          await onOpenSignals?.(accepted, provider, choice);
        } catch (error) {
          welcomeWarning = `Your gremlin is adopted. ${error.message}`;
        } finally {
          firstBusy = false;
          render();
        }
      });
      choice.append(el("strong", "", name), el("span", "", purpose));
      choice.setAttribute("aria-label", `Set up ${name} for this project`);
      signalActions.append(choice);
      signalButtons.push(choice);
    }
    const adoptAnother = button("Adopt another gremlin", () => {
      if (busy || firstBusy) return;
      accepted = null;
      welcomeWarning = "";
      starter = lastStarter = "";
      show(projectGiven ? "mission" : "project");
    });
    const retryReadiness = button("Refresh readiness", async () => {
      if (firstBusy) return;
      firstBusy = true;
      render();
      try {
        await onRefreshReadiness();
        welcomeWarning = "";
      } catch (error) {
        welcomeWarning = `Your gremlin is adopted. ${error.message}`;
      } finally {
        firstBusy = false;
        render();
      }
    });
    welcomeActions.append(firstTask, openHome);
    welcome.append(
      welcomeImage,
      welcomeTitle,
      welcomeJob,
      welcomeStatus,
      welcomeNotice,
      signals,
      welcomeActions,
      retryReadiness,
      el(
        "p",
        "adoption-contract",
        "You decide when your gremlin works, and when to enable automation.",
      ),
      adoptAnother,
    );
    form.after(welcome);
    function validate(section) {
      for (const input of section.querySelectorAll("input, select, textarea"))
        if (!input.disabled && !input.reportValidity()) return false;
      return true;
    }
    function show(value, focus = true) {
      if (accepted) return;
      stage = value;
      render();
      if (focus && dialog.open) {
        const target =
          value === "project"
            ? $("pm-project")
            : value === "mission"
              ? $("pm-mandate")
              : value === "meet"
                ? $("pm-name")
                : stages
                    .get(value)
                    .querySelector("input, textarea, select, button");
        target?.focus({ preventScroll: true });
        dialog.scrollTop = 0;
      }
    }
    async function advance() {
      if (busy || isLocked() || accepted) return;
      if (stage === "project") {
        if (validate(project)) show("mission");
      } else if (stage === "mission") {
        if (validate(mission)) await onDraft();
      } else show("meet");
    }
    function render() {
      const input = getInput(),
        selected = getProject(input.project),
        disabled = busy || isLocked();
      const identity = window.gremlinIdentity(input);
      image.src = identity.image;
      specialty.textContent = identity.description;
      summary.textContent =
        input.charter?.goal ||
        input.mandate ||
        "Give your gremlin a clear goal to work toward.";
      home.textContent = `Their home: ${input.project || "choose an app"}`;
      for (const choice of starters.children) {
        choice.setAttribute(
          "aria-pressed",
          String(choice.dataset.specialty === starter),
        );
        choice.disabled = disabled;
      }
      manual.disabled = disabled;
      back.disabled = disabled;
      next.disabled = disabled;
      $("create-pm").disabled =
        disabled || stage !== "meet" || Boolean(accepted);
      $("create-pm").hidden = stage !== "meet" || Boolean(accepted);
      $("create-pm").textContent = busy
        ? "Adopting…"
        : `Adopt ${input.name.trim() || "this gremlin"}`;
      next.hidden = stage === "meet" || Boolean(accepted);
      next.textContent =
        stage === "mission"
          ? busy
            ? "Getting acquainted…"
            : "Meet my gremlin"
          : ["brief", "advanced", "reasoning"].includes(stage)
            ? "Back to my gremlin"
            : "Continue";
      reasoningButton.hidden = !aiPreview || aiPreview.hidden;
      back.hidden =
        stage === "project" ||
        (stage === "mission" && projectGiven) ||
        Boolean(accepted);
      form.hidden = Boolean(accepted);
      welcome.hidden = !accepted;
      progress.hidden = Boolean(accepted);
      for (const [key, section] of stages) section.hidden = key !== stage;
      const title = $("pm-create-title"),
        subtitle = $("pm-adoption-subtitle");
      title.textContent = accepted
        ? "Welcome to the crew."
        : stage === "meet"
          ? `Meet ${input.name.trim() || "your gremlin"}.`
          : stage === "brief"
            ? "A brief they can work from."
            : stage === "advanced"
              ? "Make it your own."
              : stage === "reasoning"
                ? "Behind their brief."
                : "Adopt a PM Gremlin.";
      subtitle.textContent = accepted
        ? "A little gremlin. A useful job. Your call when they start."
        : stage === "project"
          ? "Give your gremlin an app to call home."
          : stage === "mission"
            ? "Tell them what matters. AI helps turn your goal into a working brief."
            : stage === "meet"
              ? "Review their job, give them a name, and make them part of your crew."
              : "Your edits stay with your gremlin when you return.";
      progress.textContent = ["brief", "advanced", "reasoning"].includes(stage)
        ? "REVIEW DETAILS"
        : `STEP ${stage === "project" ? 1 : stage === "mission" ? (projectGiven ? 1 : 2) : projectGiven ? 2 : 3} OF ${projectGiven ? 2 : 3}`;
      $("pm-creation-readiness").hidden = stage !== "meet";
      if (accepted) {
        const savedProject = getProject(accepted.project),
          savedArea = savedProject?.areas?.find(
            (area) => area.key === accepted.key,
          ),
          ready = savedProject?.readiness?.areas?.find(
            (area) => area.key === accepted.key,
          );
        const currentAdoption = window.isCurrentGremlinAdoption(
          accepted,
          savedProject,
        );
        const replaced = Boolean(
          savedProject &&
          ((savedProject.instanceId ?? null) !==
            (accepted.projectInstanceId ?? null) ||
            (savedArea &&
              (savedArea.instanceId ?? null) !==
                (accepted.areaInstanceId ?? null))),
        );
        const active = getJobs().find(
          (job) =>
            job.type === "pm" &&
            job.project === accepted.project &&
            job.area === accepted.key &&
            (job.projectInstanceId ?? null) ===
              (savedProject?.instanceId ?? null) &&
            ["queued", "running"].includes(job.status),
        );
        welcomeImage.src = window.gremlinIdentity(accepted).image;
        welcomeTitle.textContent = replaced
          ? "This gremlin’s home has changed."
          : `${accepted.name} is part of your crew.`;
        welcomeJob.textContent = accepted.charter?.goal || accepted.mandate;
        welcomeStatus.textContent = replaced
          ? "This project or PM was replaced after adoption. Open the current project from the sidebar to review its crew."
          : savedProject?.foundation?.needed
            ? "First, build the app’s foundation. Your PM’s brief is saved and ready for when there is something to investigate."
            : savedArea
              ? `Their brief is saved. Let them explore the codebase and bring back what they learn. Automation is ${savedArea.enabled ? "on" : "off"}.`
              : "Their brief is saved. Refresh readiness to see the first task options.";
        welcomeNotice.textContent =
          welcomeWarning || accepted.setupMessage || "";
        welcomeNotice.hidden = !welcomeNotice.textContent;
        firstTask.textContent = firstBusy
          ? "Checking…"
          : savedProject?.foundation?.needed
            ? "Build the foundation"
            : !savedArea
              ? "Check first-task readiness"
              : active
                ? "View current task"
                : ready?.discovery?.canRun
                  ? Object.keys(savedProject?.telemetry || {}).length
                    ? "Explore the codebase"
                    : "Start with code only"
                  : "Prepare first mission";
        signals.hidden =
          Boolean(savedProject?.foundation?.needed) || !onOpenSignals;
        for (const choice of signalButtons)
          choice.disabled = firstBusy || busy || isLocked() || !currentAdoption;
        firstTask.disabled =
          firstBusy || busy || isLocked() || !currentAdoption;
        openHome.disabled = firstBusy || busy || !currentAdoption;
        adoptAnother.disabled = firstBusy || busy || isLocked();
        retryReadiness.hidden = !welcomeWarning && currentAdoption;
        retryReadiness.disabled = firstBusy || busy;
      }
      if (selected?.foundation?.needed && stage === "meet")
        $("pm-creation-readiness").textContent =
          "Your gremlin can join now. Build the foundation before their first investigation.";
    }
    form.addEventListener("input", render);
    form.addEventListener("change", render);
    form.addEventListener(
      "invalid",
      (event) => {
        const first = form.querySelector(":invalid:not(fieldset):not(form)");
        if (first && first !== event.target) return;
        reveal(event.target);
        event.target.focus();
      },
      true,
    );
    function reveal(target) {
      if (accepted) return;
      const entry = [...stages].find(
        ([, section]) => section === target || section.contains(target),
      );
      if (entry) show(entry[0], false);
    }
    render();
    return {
      open({ preselected = false } = {}) {
        projectGiven = preselected;
        if (accepted) {
          render();
          welcomeTitle.focus({ preventScroll: true });
          dialog.scrollTop = 0;
          return;
        }
        if (!$("pm-mandate").value.trim())
          stage = preselected ? "mission" : "project";
        show(stage);
      },
      contextChanged() {
        accepted = null;
        welcomeWarning = "";
        starter = lastStarter = "";
        show("mission", false);
      },
      review() {
        show("meet", dialog.open);
      },
      reveal,
      refresh: render,
      setBusy(value) {
        busy = Boolean(value);
        render();
      },
      prepareSubmit() {
        if (accepted || busy || isLocked()) return false;
        if (stage !== "meet") {
          advance();
          return false;
        }
        return form.reportValidity();
      },
      adopted(value) {
        accepted = { ...value };
        welcomeWarning = "";
        render();
        welcomeTitle.focus({ preventScroll: true });
        dialog.scrollTop = 0;
      },
      setWelcomeWarning(value) {
        welcomeWarning = value;
        render();
      },
      focusWelcome() {
        if (!accepted || !dialog.open) return;
        welcomeTitle.focus({ preventScroll: true });
        dialog.scrollTop = 0;
      },
      get accepted() {
        return accepted;
      },
    };
  };
})();
