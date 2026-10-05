(() => {
  "use strict";
  const fields = [
    "name",
    "key",
    "paths",
    "sharedTouchpoints",
    "metric",
    "schedule",
    "wipLimit",
  ];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function draftValue(plan) {
    const draft = plan?.draft;
    const text = (value, limit) =>
      typeof value === "string" && value.length > 0 && value.length <= limit;
    if (
      !draft ||
      !text(draft.name, 100) ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(draft.key || "") ||
      !text(draft.metric, 500) ||
      !text(draft.schedule, 200) ||
      draft.schedule.trim().split(/\s+/).length !== 5 ||
      !Number.isInteger(draft.wipLimit) ||
      draft.wipLimit < 1 ||
      draft.wipLimit > 20 ||
      ![draft.paths, draft.sharedTouchpoints].every(
        (value) =>
          Array.isArray(value) &&
          value.length <= 200 &&
          value.every((path) => text(path, 1000)),
      ) ||
      !text(plan.rationale, 12000) ||
      !plan.repository ||
      !text(plan.repository.repo, 500) ||
      !text(plan.repository.branch, 500) ||
      !Number.isInteger(plan.repository.pathCount) ||
      plan.repository.pathCount < 0 ||
      !Array.isArray(plan.warnings) ||
      !plan.warnings.every((value) => text(value, 2000))
    )
      throw new Error(
        "The AI suggestion was incomplete. Your form is unchanged; try again or fill it in yourself.",
      );
    return Object.fromEntries(fields.map((key) => [key, copy(draft[key])]));
  }
  const node = (tag, className = "", text = "") => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  };
  window.createPmDraft = (
    container,
    { api, getInput, onApply, onBusy, onError },
  ) => {
    let generation = 0,
      busy = false,
      locked = false,
      draft = null,
      snapshot = null,
      fingerprint = "";
    const root = node("section", "pm-ai-draft");
    root.setAttribute("aria-label", "AI suggestions for this PM");
    const heading = node("div", "pm-ai-draft-heading");
    const fill = node("button", "small-button", "Fill with AI");
    fill.type = "button";
    heading.append(
      fill,
      node(
        "p",
        "setup-help",
        "Turn your brief and repository paths into a suggested PM setup. Review before applying; your original mandate stays yours.",
      ),
    );
    const message = node("p", "form-message pm-ai-draft-status");
    message.hidden = true;
    message.setAttribute("role", "status");
    const preview = node("div", "pm-ai-draft-preview");
    preview.hidden = true;
    const title = node("h4", "", "Suggested setup · not saved");
    const context = node("p", "setup-help pm-ai-draft-context");
    const values = node("dl", "pm-ai-draft-fields");
    const rationale = node("p", "pm-ai-draft-rationale");
    const warnings = node("ul", "pm-ai-draft-warnings");
    const actions = node("div", "form-actions pm-ai-draft-actions");
    const apply = node("button", "button button-dark", "Apply suggestions");
    const discard = node("button", "small-button", "Discard");
    apply.type = discard.type = "button";
    actions.append(apply, discard);
    preview.append(title, context, values, rationale, warnings, actions);
    root.append(heading, message, preview);
    container.replaceChildren(root);
    const currentInput = () => copy(getInput());
    const unchanged = () => {
      try {
        return !!snapshot && JSON.stringify(currentInput()) === fingerprint;
      } catch {
        return false;
      }
    };
    function show(text, error = false) {
      message.textContent = text;
      message.hidden = !text;
      message.classList.toggle("error", error);
      message.setAttribute("role", error ? "alert" : "status");
      if (error) onError?.(text);
    }
    function render() {
      fill.disabled = locked || busy;
      fill.textContent = busy
        ? "Reading repository & drafting…"
        : "Fill with AI";
      apply.disabled = locked || busy || !draft || !unchanged();
      discard.disabled = locked || busy;
      root.setAttribute("aria-busy", String(busy));
      preview.hidden = !draft;
    }
    function setBusy(value) {
      if (busy === value) return;
      busy = value;
      render();
      onBusy?.(value);
    }
    function refresh() {
      if (draft && !unchanged())
        show(
          "The form changed after this suggestion was requested. Your edits are kept. Generate fresh suggestions before applying.",
        );
      render();
    }
    function reset() {
      ++generation;
      draft = snapshot = null;
      fingerprint = "";
      show("");
      setBusy(false);
      render();
    }
    fill.addEventListener("click", async () => {
      if (locked || busy) return;
      let input;
      try {
        input = currentInput();
      } catch {
        show(
          "The PM form could not be read. Your entries are unchanged.",
          true,
        );
        return;
      }
      if (
        !/^[a-z][a-z0-9-]{0,62}$/.test(input?.project || "") ||
        typeof input.mandate !== "string" ||
        !input.mandate.trim() ||
        input.mandate.length > 12000
      ) {
        show(
          "Choose a project and describe what this PM should investigate first.",
          true,
        );
        return;
      }
      const request = ++generation;
      snapshot = input;
      fingerprint = JSON.stringify(input);
      draft = null;
      setBusy(true);
      show(
        "Reading this repository’s paths and drafting suggestions. No PM, ticket, or schedule is created.",
      );
      try {
        const plan = await api(
          `/api/projects/${encodeURIComponent(input.project)}/pm-plan`,
          { mandate: input.mandate },
          "POST",
          200000,
        );
        if (request !== generation) return;
        draft = draftValue(plan);
        context.textContent = `${plan.repository.provider === "gitlab" ? "GitLab" : "GitHub"} · ${plan.repository.repo} · ${plan.repository.branch} · ${plan.repository.pathCount} repository paths${plan.repository.truncated ? " · partial tree" : ""}`;
        const rows = [
          ["PM name", draft.name],
          ["Mandate ID", draft.key],
          ["Owned paths", draft.paths.join("\n") || "None"],
          ["Shared touchpoints", draft.sharedTouchpoints.join("\n") || "None"],
          ["Metric", draft.metric],
          ["Schedule (UTC)", draft.schedule],
          ["WIP limit", String(draft.wipLimit)],
        ];
        values.replaceChildren(
          ...rows.flatMap(([label, value]) => [
            node("dt", "", label),
            node("dd", "", value),
          ]),
        );
        rationale.textContent = plan.rationale;
        warnings.replaceChildren(
          ...plan.warnings.map((text) => node("li", "", text)),
        );
        warnings.hidden = plan.warnings.length === 0;
        if (unchanged())
          show(
            "Review these suggestions, then apply them to the form. Your mandate is preserved. Creating the PM is a separate step.",
          );
        else refresh();
      } catch (error) {
        if (request === generation) {
          draft = null;
          show(
            error.message ||
              "Suggestions could not be generated. Your entries are unchanged.",
            true,
          );
        }
      } finally {
        if (request === generation) setBusy(false);
      }
    });
    apply.addEventListener("click", async () => {
      if (locked || busy || !draft) return;
      if (!unchanged()) {
        refresh();
        return;
      }
      const request = generation;
      const suggestion = copy(draft),
        original = copy(snapshot);
      setBusy(true);
      try {
        const result = await onApply(suggestion, original);
        if (request !== generation) return;
        if (result === false) {
          show(
            "Your form changed. Suggestions were not applied; generate a fresh draft.",
          );
          return;
        }
        draft = snapshot = null;
        fingerprint = "";
        show(
          "Suggestions applied to the form. Review them and choose Create PM when ready. Nothing has been created or enabled yet.",
        );
      } catch (error) {
        if (request === generation)
          show(
            error.message ||
              "Suggestions could not be applied. Review your form before trying again.",
            true,
          );
      } finally {
        if (request === generation) setBusy(false);
      }
    });
    discard.addEventListener("click", reset);
    const form = container.closest?.("form");
    form?.addEventListener("input", refresh);
    form?.addEventListener("change", refresh);
    render();
    return {
      refresh,
      reset,
      isBusy: () => busy,
      hasDraft: () => !!draft,
      setLocked(value) {
        locked = Boolean(value);
        render();
      },
    };
  };
})();
