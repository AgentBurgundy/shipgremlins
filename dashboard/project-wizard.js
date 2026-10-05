(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  window.createProjectWizard = ({ api, crew, onProviderChange }) => {
    const form = $("project-form"),
      fields = $("project-fields");
    form.noValidate = true;
    const stash = node("div");
    stash.hidden = true;
    // Keep the existing settings adapters available; these options live in project settings after creation.
    stash.append(...fields.children);
    fields.append(stash);
    const shell = node("div", undefined, "project-wizard");
    const progress = node("p", undefined, "wizard-progress");
    progress.setAttribute("aria-live", "polite");
    const track = node("div", undefined, "wizard-track"),
      fill = node("span");
    track.setAttribute("aria-hidden", "true");
    track.append(fill);
    const title = node("h2");
    title.tabIndex = -1;
    const drawer = $("new-project-drawer");
    const exit = node(
      "button",
      "← Back to projects",
      "small-button wizard-exit",
    );
    exit.type = "button";
    exit.addEventListener("click", () => {
      drawer.open = false;
      $("projects").classList.remove("is-creating");
      document.querySelector('a[href="#new-project-drawer"]')?.focus();
    });
    drawer.insertBefore(exit, form);
    drawer.addEventListener("toggle", () => {
      $("projects").classList.toggle("is-creating", drawer.open);
      if (drawer.open) title.focus({ preventScroll: true });
    });
    const description = node("p", undefined, "wizard-description");
    const body = node("div", undefined, "wizard-body");
    const footer = node("div", undefined, "wizard-footer");
    const back = node("button", "← Back", "small-button");
    back.type = "button";
    const next = $("add-project");
    footer.append(back, next);
    shell.append(progress, track, title, description, body, footer);
    fields.append(shell);
    const sections = {},
      labels = {
        start: ["A little idea. A whole crew.", "Where are you starting?"],
        idea: [
          "What do you want to build?",
          "Tell us who it’s for and what the first useful version should do.",
        ],
        crew: [
          "Meet your first crew.",
          "We’ve split your idea into clear responsibilities. Does this feel right?",
        ],
        name: [
          "What should we call it?",
          "A short name for your project and its home in source control.",
        ],
        provider: [
          "Where should your code live?",
          "Use a source account you’ve connected to ShipGremlins.",
        ],
        owner: [
          "Who should own the repository?",
          "We’ll create a fresh repository here when you finish setup.",
        ],
        repository: [
          "Which app are we joining?",
          "Choose an existing repository your crew can work in.",
        ],
        visibility: [
          "Who can see your code?",
          "Your idea starts private. Make it public only when you’re ready to share it.",
        ],
        review: [
          "Ready to give it a home?",
          "One last look. We’ll save the project and prepare its next step.",
        ],
      };
    for (const key of Object.keys(labels)) {
      const section = node("section");
      section.dataset.wizardStep = key;
      section.hidden = true;
      sections[key] = section;
      body.append(section);
    }
    const cards = node("div", undefined, "wizard-choices");
    for (const [value, heading, detail, symbol] of [
      [
        "idea",
        "I have an idea",
        "Describe it. Get a new repository and a crew with a plan.",
        "✦",
      ],
      [
        "existing",
        "I have an app",
        "Bring your repository. Give your development a crew.",
        "↗",
      ],
    ]) {
      const button = node("button", undefined, "wizard-choice");
      button.type = "button";
      button.append(
        node("span", symbol, "wizard-choice-icon"),
        node("strong", heading),
        node("span", detail),
      );
      button.addEventListener("click", () => {
        $("project-start").value = value;
        $("project-start").dispatchEvent(new Event("change"));
        go(value === "idea" ? (crew().ready() ? "crew" : "idea") : "provider");
      });
      cards.append(button);
    }
    sections.start.append(cards);
    sections.idea.append($("idea-crew-panel"));
    sections.crew.append($("idea-crew-review"));
    sections.name.append($("project-name").closest(".field"));
    $("project-name").maxLength = 63;
    sections.provider.append(
      $("project-provider").closest(".field"),
      $("gitlab-options"),
    );
    const connections = node("a", "Connect or manage source accounts →");
    connections.href = "/connections#source-control";
    sections.provider.append(connections);
    sections.repository.append(
      $("repository-picker"),
      $("repository-search").closest(".repository-tools"),
      $("manual-repository-field"),
    );
    const ownerLabel = node("label", "Repository owner");
    ownerLabel.htmlFor = "new-repository-owner";
    const ownerSelect = node("select");
    ownerSelect.id = "new-repository-owner";
    const ownerStatus = node("p");
    ownerStatus.setAttribute("role", "status");
    const refresh = node("button", "Refresh accounts", "small-button");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadOwners());
    sections.owner.append(ownerLabel, ownerSelect, ownerStatus, refresh);
    const visibility = node("div", undefined, "wizard-choices");
    for (const [value, heading, detail] of [
      [
        "private",
        "Private",
        "Only you and people you grant access. Recommended.",
      ],
      [
        "public",
        "Public · for open source",
        "Anyone can read the code and product brief. Choose a license before inviting contributions.",
      ],
    ]) {
      const label = node("label", undefined, "wizard-choice wizard-radio");
      const radio = node("input");
      radio.type = "radio";
      radio.name = "repository-visibility";
      radio.value = value;
      radio.checked = value === "private";
      label.append(radio, node("strong", heading), node("span", detail));
      visibility.append(label);
    }
    sections.visibility.append(visibility);
    const summary = node("dl", undefined, "wizard-summary");
    const expectation = node("p", undefined, "wizard-expectation");
    const restart = node("button", "Start a different setup", "small-button");
    restart.type = "button";
    restart.hidden = true;
    restart.addEventListener("click", () => {
      crew().clear();
      reset();
    });
    sections.review.append(summary, expectation, restart);
    let step = "start",
      owners = [],
      accountId = "",
      loading = false,
      ownerRevision = 0,
      bound = null,
      previousReady = false;
    const isIdea = () => $("project-start").value === "idea";
    const route = () =>
      isIdea()
        ? [
            "start",
            "idea",
            "crew",
            "name",
            "provider",
            "owner",
            "visibility",
            "review",
          ]
        : ["start", "provider", "repository", "name", "review"];
    function visibilityValue() {
      return (
        form.querySelector('[name="repository-visibility"]:checked')?.value ||
        "private"
      );
    }
    function destination() {
      if (bound) return bound;
      const owner = owners.find((item) => item.id === ownerSelect.value);
      return {
        project: $("project-name").value.trim(),
        repo: isIdea()
          ? `${owner?.path || ""}/${$("project-name").value.trim()}`
          : $("project-repo").value.trim(),
        provider: $("project-provider").value,
        ...($("project-provider").value === "gitlab"
          ? {
              serverUrl:
                $("gitlab-server").value.trim() || "https://gitlab.com",
            }
          : {}),
        connectionId: "default",
        ...(isIdea()
          ? {
              newRepository: {
                ownerId: ownerSelect.value,
                accountId,
                visibility: visibilityValue(),
              },
            }
          : {}),
      };
    }
    function showError(text) {
      const message = $("project-message");
      message.textContent = text;
      message.hidden = !text;
      message.setAttribute("role", text ? "alert" : "status");
      message.classList.toggle("error", Boolean(text));
    }
    async function loadOwners() {
      const revision = ++ownerRevision;
      loading = true;
      owners = [];
      accountId = "";
      ownerSelect.replaceChildren(new Option("Loading accounts…", ""));
      ownerStatus.textContent = "Checking your connected source account…";
      update();
      try {
        const provider = $("project-provider").value;
        const serverUrl =
          $("gitlab-server").value.trim() || "https://gitlab.com";
        const result = await api(
          `/api/source-control/${provider}/owners${provider === "gitlab" ? `?serverUrl=${encodeURIComponent(serverUrl)}` : ""}`,
          undefined,
          "GET",
          60000,
        );
        if (revision !== ownerRevision) return;
        owners = result.owners;
        accountId = result.accountId;
        ownerSelect.replaceChildren(
          ...owners.map((item) => new Option(item.path, item.id)),
        );
        ownerStatus.textContent = owners.length
          ? `${result.truncated ? "Showing the first available accounts. " : ""}Repository creation must be allowed by this account.`
          : "No eligible owners found. Check your source account permissions, then refresh.";
      } catch (error) {
        if (revision !== ownerRevision) return;
        ownerSelect.replaceChildren(
          new Option("Connect an account to continue", ""),
        );
        ownerStatus.textContent = error.message;
      } finally {
        if (revision === ownerRevision) {
          loading = false;
          update();
        }
      }
    }
    function renderSummary() {
      summary.replaceChildren();
      const input = destination();
      const rows = [
        ["Project", input.project],
        [isIdea() ? "New repository" : "Repository", input.repo],
        ["Source", input.provider === "github" ? "GitHub" : "GitLab"],
      ];
      if (input.newRepository)
        rows.push([
          "Visibility",
          input.newRepository.visibility === "public"
            ? "Public · anyone can read your code and brief"
            : "Private · only people you grant access",
        ]);
      if (input.serverUrl && input.serverUrl !== "https://gitlab.com")
        rows.push(["Server", input.serverUrl]);
      if (isIdea())
        rows.push(
          [
            "Crew",
            crew()
              .plan?.crew.map((member) => member.name)
              .join(" · ") || "Saved crew",
          ],
          ["First milestone", crew().plan?.firstMilestone || "Saved milestone"],
        );
      for (const [key, value] of rows)
        summary.append(node("dt", key), node("dd", value));
      expectation.textContent = isIdea()
        ? "We’ll create your repository, add the product brief, and save the crew. Next, review and start the foundation build. We'll set up Linear and check your connections when you do. PM schedules stay paused."
        : "A Setup Gremlin will inspect your app when source and Claude access are ready. Next you’ll choose its environment and shape its crew. Workflow, commands, and Linear can be adjusted in project settings.";
    }
    function update() {
      const ready = crew()?.ready();
      if (ready && !previousReady && step === "idea") {
        previousReady = ready;
        go("crew");
        return;
      }
      previousReady = ready;
      const position = route().indexOf(step);
      progress.textContent =
        step === "start"
          ? "NEW PROJECT"
          : `STEP ${position} OF ${route().length - 1}`;
      fill.style.width = `${step === "start" ? 0 : (position / (route().length - 1)) * 100}%`;
      [title.textContent, description.textContent] = labels[step];
      for (const [key, section] of Object.entries(sections))
        section.hidden = key !== step;
      back.hidden = step === "start" || Boolean(bound);
      back.disabled = Boolean(crew()?.busy);
      next.hidden = step === "start" || step === "idea";
      next.disabled =
        Boolean(crew()?.busy) ||
        (step === "owner" && (loading || !ownerSelect.value));
      next.textContent =
        step === "review"
          ? crew()?.busy
            ? "Creating your project…"
            : bound
              ? "Resume setup"
              : isIdea()
                ? `Create ${visibilityValue()} repository & crew`
                : "Add my app"
          : step === "crew"
            ? "Looks good →"
            : "Continue →";
      restart.hidden = !bound;
      restart.disabled = Boolean(crew()?.busy);
      if (step === "review") renderSummary();
    }
    function go(value) {
      step = value;
      showError("");
      update();
      title.focus({ preventScroll: true });
      shell.scrollIntoView({ block: "start", behavior: "instant" });
    }
    back.addEventListener("click", () =>
      go(route()[Math.max(0, route().indexOf(step) - 1)]),
    );
    form.addEventListener(
      "submit",
      (event) => {
        if (step === "review") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (crew()?.busy) return;
        if (step === "start" || step === "idea") return;
        if (
          step === "name" &&
          (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(
            $("project-name").value.trim(),
          ) ||
            $("project-name").value.trim().length > 63)
        ) {
          showError(
            "Use a name beginning with a letter, with lowercase letters, numbers, and hyphens.",
          );
          $("project-name").focus();
          return;
        }
        if (step === "provider" && $("project-provider").value === "gitlab") {
          try {
            const url = new URL(
              $("gitlab-server").value.trim() || "https://gitlab.com",
            );
            if (
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            )
              throw new Error();
          } catch {
            showError(
              "Enter an HTTPS GitLab server origin without a project path or credentials.",
            );
            return;
          }
        }
        if (
          step === "repository" &&
          (!$("project-repo").value.trim() ||
            !$("project-repo").checkValidity())
        ) {
          showError(
            "Choose your app repository, or enter its owner/repository path.",
          );
          return;
        }
        if (step === "owner" && (loading || !ownerSelect.value)) return;
        const nextStep = route()[route().indexOf(step) + 1];
        go(nextStep);
        if (nextStep === "owner") void loadOwners();
        if (nextStep === "repository") onProviderChange();
      },
      true,
    );
    function reset() {
      form.reset();
      bound = null;
      owners = [];
      accountId = "";
      previousReady = false;
      ownerRevision++;
      loading = false;
      form.querySelector(
        '[name="repository-visibility"][value="private"]',
      ).checked = true;
      go("start");
    }
    document.addEventListener("click", (event) => {
      if (event.target.closest('a[href$="#new-project-drawer"]')) {
        $("new-project-drawer").open = true;
        requestAnimationFrame(() => shell.scrollIntoView({ block: "start" }));
      }
    });
    update();
    return {
      update,
      destination,
      reset,
      restore(destination) {
        if (destination) {
          bound = destination;
          go("review");
        } else if (step === "start") go(crew()?.ready() ? "crew" : "idea");
      },
    };
  };
})();
