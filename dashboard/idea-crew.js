(function () {
  "use strict";
  const storageKey = "shipgremlins.idea-crew";
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  window.createIdeaCrew = ({
    container,
    api,
    onChange = () => {},
    suggestName = () => {},
    onRestore = () => {},
  }) => {
    let draft = null,
      controller = null,
      busy = false,
      creating = false;
    const field = node("div", undefined, "field");
    const label = node("label", "What do you want to build?");
    label.htmlFor = "app-idea";
    const input = node("textarea");
    input.id = "app-idea";
    input.rows = 5;
    input.maxLength = 12000;
    input.placeholder =
      "A booking app for a small pottery studio. Students browse classes and reserve a seat; the owner manages sessions and capacity. First version: bookings, no online payments.";
    const help = node(
      "p",
      "Describe the users, the first useful version, and anything to leave out. Your crew will share one Node.js web app; you can refine each PM after creation.",
    );
    field.append(label, input, help);
    const actions = node("div", undefined, "button-row");
    const generate = node("button", "Plan my crew", "small-button");
    const cancel = node("button", "Cancel planning", "small-button");
    generate.type = cancel.type = "button";
    cancel.hidden = true;
    actions.append(generate, cancel);
    const status = node("p", undefined, "form-message");
    status.setAttribute("role", "status");
    status.hidden = true;
    const preview = node("div", undefined, "idea-crew-preview");
    container.append(field, actions, status, preview);
    function show(text, error = false) {
      status.hidden = !text;
      status.textContent = text;
      status.classList.toggle("error", error);
    }
    function save() {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ idea: input.value, id: draft?.id }),
        );
      } catch {
        /* In-memory drafts still work. */
      }
    }
    function controls() {
      generate.disabled = busy || creating;
      input.disabled = creating;
      generate.textContent = busy
        ? "Planning your crew…"
        : draft
          ? "Plan again"
          : "Plan my crew";
      cancel.hidden = !busy;
      onChange();
    }
    function render() {
      preview.replaceChildren();
      if (!draft) return;
      const plan = draft.plan;
      preview.append(
        node("p", "YOUR PROPOSED CREW", "eyebrow"),
        node("h3", plan.name),
        node("p", plan.summary),
      );
      const milestone = node("div", undefined, "idea-milestone");
      milestone.append(
        node("strong", "First milestone"),
        node("p", plan.firstMilestone),
      );
      preview.append(milestone);
      const cards = node("ol", undefined, "idea-crew-cards");
      for (const member of plan.crew) {
        const card = node("li");
        card.append(
          node("h4", member.name),
          node("p", member.mission),
          node("p", member.why, "idea-why"),
        );
        card.append(
          node("strong", "First assignment"),
          node("p", member.firstTask),
        );
        const criteria = node("ul");
        for (const criterion of member.acceptanceCriteria)
          criteria.append(node("li", criterion));
        card.append(
          criteria,
          node(
            "p",
            member.dependsOn.length
              ? `Starts after: ${member.dependsOn.join(", ")}`
              : "Starts first · owns the shared foundation",
            "idea-dependency",
          ),
        );
        cards.append(card);
      }
      preview.append(cards);
      const assumptions = node("details");
      assumptions.append(
        node("summary", "Assumptions and scope"),
        node("p", `Users: ${plan.users.join("; ")}`),
      );
      for (const [title, items] of [
        ["Assumptions to confirm", plan.assumptions],
        ["Outside the first version", plan.nonGoals],
      ]) {
        assumptions.append(node("strong", title));
        const list = node("ul");
        for (const item of items) list.append(node("li", item));
        assumptions.append(list);
      }
      preview.append(
        assumptions,
        node(
          "p",
          "Choose a repository below, then create the crew together. An empty repository gets a README with this brief. Existing code is preserved. PMs start paused; review their first tickets before Coding Gremlins implement them.",
          "idea-next",
        ),
      );
    }
    input.addEventListener("input", () => {
      draft = null;
      controller?.abort();
      render();
      show("Idea updated. Plan your crew again before creating it.");
      save();
      controls();
    });
    cancel.addEventListener("click", () => controller?.abort());
    generate.addEventListener("click", async () => {
      if (busy || creating) return;
      const idea = input.value.trim();
      if (idea.length < 25) {
        show(
          "Add a little more detail: who the app is for and what its first version should do.",
          true,
        );
        input.focus();
        return;
      }
      busy = true;
      controller = new AbortController();
      const active = controller;
      controls();
      show(
        "Working out the first milestone, responsibilities, and build order…",
      );
      try {
        const result = await api(
          "/api/idea-plans",
          { idea },
          "POST",
          190000,
          active.signal,
        );
        if (active.signal.aborted || input.value.trim() !== idea) return;
        draft = result;
        suggestName(
          result.plan.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 63),
        );
        render();
        save();
        show(
          "Your crew is planned. Review the milestone, then choose where it will work.",
        );
      } catch (error) {
        show(
          active.signal.aborted
            ? "Planning canceled. Your idea is still here."
            : error.message,
          !active.signal.aborted,
        );
      } finally {
        busy = false;
        controller = null;
        controls();
      }
    });
    async function restore() {
      let saved;
      try {
        saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      } catch {
        return;
      }
      if (typeof saved?.idea !== "string") return;
      input.value = saved.idea;
      onRestore();
      if (!saved.id) return;
      try {
        const result = await api(
          `/api/idea-plans/${encodeURIComponent(saved.id)}`,
          undefined,
          "GET",
        );
        if (input.value === saved.idea && !busy) {
          draft = result;
          onRestore(result.destination);
          render();
          show(
            result.complete
              ? `This crew was created for ${result.project}. Open that project to continue.`
              : "Your saved crew plan is ready to resume.",
          );
          controls();
        }
      } catch {
        show("Your idea was restored. Plan the crew again to continue.");
      }
    }
    return {
      restore,
      get busy() {
        return busy || creating;
      },
      hasDraft() {
        return Boolean(input.value.trim());
      },
      ready() {
        return Boolean(
          draft && draft.idea === input.value.trim() && !busy && !creating,
        );
      },
      async create(destination) {
        if (!this.ready())
          throw new Error("Plan and review your crew before creating it.");
        creating = true;
        controls();
        try {
          return await api(
            `/api/idea-plans/${draft.id}/create`,
            { ...destination, revision: draft.revision },
            "POST",
            120000,
          );
        } finally {
          creating = false;
          controls();
        }
      },
      clear() {
        draft = null;
        input.value = "";
        render();
        show("");
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* No saved draft. */
        }
        controls();
      },
    };
  };
})();
