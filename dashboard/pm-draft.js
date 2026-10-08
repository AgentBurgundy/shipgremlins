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
    "verificationRequirement",
    "charter",
  ];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const charterText = {
    ambition: "Product ambition",
    goal: "PM goal",
    metricDefinition: "Success definition",
  };
  const charterLists = {
    users: "People",
    expectedToBuild: "Expected capabilities",
    nonGoals: "Out of scope",
    guardrails: "Guardrails",
    standingPriorities: "Standing priorities",
  };
  window.mergePmDraft = (input, draft, previousGenerated = null) => {
    const values = copy(draft),
      filled = [],
      kept = [];
    const defaults = { metric: "/", schedule: "0 13 * * *", wipLimit: "3" };
    for (const key of fields.filter((key) => key !== "charter")) {
      const existing = input[key];
      const preserve =
        (key === "verificationRequirement" &&
          input.editedFields?.includes(key)) ||
        (String(existing ?? "").trim() &&
          (!previousGenerated ||
            input.editedFields?.includes(key) ||
            JSON.stringify(existing) !==
              JSON.stringify(previousGenerated[key])) &&
          (input.editedFields?.includes(key) ||
            String(existing) !== defaults[key]));
      if (preserve) {
        values[key] = ["paths", "sharedTouchpoints"].includes(key)
          ? String(existing)
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean)
          : key === "wipLimit"
            ? Number(existing)
            : existing;
        if (key === "verificationRequirement" && !existing) delete values[key];
        kept.push(key);
      } else filled.push(key);
    }
    for (const [key, value] of Object.entries(input.charter || {})) {
      if (
        value?.length &&
        (!previousGenerated ||
          JSON.stringify(value) !==
            JSON.stringify(previousGenerated.charter?.[key]))
      ) {
        values.charter[key] = copy(value);
        kept.push(`charter.${key}`);
      }
    }
    return { values, filled, kept };
  };
  function draftValue(plan) {
    const draft = plan?.draft;
    const text = (value, limit) =>
      typeof value === "string" && value.length > 0 && value.length <= limit;
    if (
      !draft ||
      (draft.verificationRequirement !== undefined &&
        !["browser", "repository"].includes(draft.verificationRequirement)) ||
      !draft.charter ||
      !Object.keys(charterText).every((key) =>
        text(draft.charter[key], 4000),
      ) ||
      !Object.keys(charterLists).every(
        (key) =>
          Array.isArray(draft.charter[key]) &&
          draft.charter[key].length > 0 &&
          draft.charter[key].length <= 20 &&
          draft.charter[key].every((value) => text(value, 1000)),
      ) ||
      !text(draft.name, 100) ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(draft.key || "") ||
      !text(draft.metric, 500) ||
      !text(draft.schedule, 200) ||
      draft.schedule.trim().split(/\s+/).length !== 5 ||
      !Number.isInteger(draft.wipLimit) ||
      draft.wipLimit < 1 ||
      draft.wipLimit > 5 ||
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
    const result = Object.fromEntries(
      fields
        .filter((key) => draft[key] !== undefined)
        .map((key) => [key, copy(draft[key])]),
    );
    result.charter = Object.fromEntries(
      [...Object.keys(charterText), ...Object.keys(charterLists)].map((key) => [
        key,
        copy(draft.charter[key]),
      ]),
    );
    return result;
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
      fingerprint = "",
      applied = false;
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
        "Draft the brief and settings from your mandate. Keeps your edits.",
      ),
    );
    const message = node("p", "form-message pm-ai-draft-status");
    message.hidden = true;
    message.setAttribute("role", "status");
    const preview = node("div", "pm-ai-draft-preview");
    preview.hidden = true;
    const context = node("p", "setup-help pm-ai-draft-context");
    const values = node("dl", "pm-ai-draft-fields");
    const rationale = node("p", "pm-ai-draft-rationale");
    const warnings = node("ul", "pm-ai-draft-warnings");
    const actions = node("div", "form-actions pm-ai-draft-actions");
    const discard = node("button", "small-button", "Hide AI summary");
    discard.type = "button";
    actions.append(discard);
    const details = node("section", "pm-ai-review");
    details.append(
      node("h3", "", "Why these settings?"),
      context,
      values,
      rationale,
      warnings,
      actions,
    );
    preview.append(details);
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
      if (draft && !applied && !unchanged())
        show(
          "The form changed while AI was working. Your edits are kept. Fill with AI again to use the current draft.",
        );
      render();
    }
    function reset() {
      ++generation;
      draft = snapshot = null;
      applied = false;
      fingerprint = "";
      show("");
      setBusy(false);
      render();
    }
    async function generateDraft() {
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
      applied = false;
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
          [
            "Testing requirement",
            draft.verificationRequirement === "browser"
              ? "Browser walkthrough required"
              : draft.verificationRequirement === "repository"
                ? "Repository checks sufficient"
                : "Follow project testing mode",
          ],
          ["Area label", `pm:${draft.key}`],
          ...Object.entries(charterText).map(([key, label]) => [
            label,
            draft.charter[key],
          ]),
          ...Object.entries(charterLists).map(([key, label]) => [
            label,
            draft.charter[key].join("\n"),
          ]),
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
        if (!unchanged()) {
          refresh();
          return;
        }
        const result = await onApply(copy(draft), copy(snapshot));
        if (request !== generation) return;
        if (result === false) {
          show(
            "Your form changed. Nothing was filled; try again with the current draft.",
          );
          return;
        }
        applied = true;
        show(result?.message || "Draft filled. Review below, then Create PM.");
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
    }
    fill.addEventListener("click", generateDraft);
    discard.addEventListener("click", reset);
    const form = container.closest?.("form");
    form?.addEventListener("input", refresh);
    form?.addEventListener("change", refresh);
    render();
    return {
      generate: generateDraft,
      refresh,
      reset,
      isBusy: () => busy,
      hasDraft: () => !!draft && !applied,
      setLocked(value) {
        locked = Boolean(value);
        render();
      },
    };
  };
})();
