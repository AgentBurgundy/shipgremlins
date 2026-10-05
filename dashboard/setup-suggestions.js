"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  window.createSetupSuggestions = ({ api, onSaved, isLocked }) => {
    const entries = new Map();
    function state(project, area) {
      const key = `${project}/${area}`;
      if (!entries.has(key))
        entries.set(key, {
          project,
          area,
          node: el("section", undefined, "setup-suggestions"),
          data: null,
          busy: false,
          loading: false,
          loaded: false,
          error: "",
          notice: "",
          open: false,
          confirm: "",
        });
      return entries.get(key);
    }
    const endpoint = (s) =>
      `/api/projects/${encodeURIComponent(s.project)}/pms/${encodeURIComponent(s.area)}/setup-suggestions`;
    function button(label, action, disabled = false) {
      const item = el("button", label, "small-button");
      item.type = "button";
      item.disabled = disabled;
      item.addEventListener("click", action);
      return item;
    }
    async function load(s, force = false) {
      if (s.loading || s.busy || (!force && s.loaded)) return;
      s.loading = true;
      try {
        s.data = await api(endpoint(s));
        s.error = "";
        s.loaded = true;
      } catch (error) {
        s.error = error.message;
      } finally {
        s.loading = false;
        paint(s);
      }
    }
    function paint(s) {
      s.node.replaceChildren();
      if (s.notice) {
        const notice = el("p", s.notice, "operations-message");
        notice.setAttribute("role", "status");
        s.node.append(notice);
      }
      if (s.error) {
        const error = el("p", s.error, "operations-message error");
        error.setAttribute("role", "status");
        s.node.append(
          error,
          button("Retry suggested setup", () => load(s, true), s.loading),
        );
      }
      if (s.data?.state !== "ready" || !s.data.proposal) return;
      const details = el("details"),
        summary = el("summary", "Suggested setup from discovery"),
        proposal = s.data.proposal;
      details.open = s.open;
      details.addEventListener("toggle", () => {
        s.open = details.open;
      });
      details.append(
        summary,
        el(
          "p",
          "Review these exact settings before applying them. Commands execute in future jobs; discovery suggestions are not trusted instructions until you choose to save them.",
          "runner-guidance",
        ),
      );
      if (proposal.rationale)
        details.append(el("p", proposal.rationale, "suggestion-rationale"));
      const commands = el("dl", undefined, "suggestion-commands");
      for (const [name, value] of Object.entries(proposal.commands || {})) {
        const row = el("div");
        row.append(el("dt", name), el("dd", value || "Not configured"));
        commands.append(row);
      }
      details.append(
        el("h4", "Repository commands"),
        commands,
        el("h4", "PM ownership"),
        el(
          "p",
          `Owned paths: ${(proposal.paths || []).join(", ") || "None"}`,
          "runner-guidance",
        ),
        el(
          "p",
          `Shared touchpoints: ${(proposal.sharedTouchpoints || []).join(", ") || "None"}`,
          "runner-guidance",
        ),
      );
      if (proposal.evidence?.length) {
        const list = el("ul", undefined, "suggestion-evidence");
        for (const evidence of proposal.evidence)
          list.append(el("li", evidence));
        details.append(el("h4", "Evidence"), list);
      }
      const actions = el("div", undefined, "button-row");
      for (const apply of ["commands", "ownership"]) {
        const label =
          apply === "commands" ? "Use these commands" : "Use this PM ownership";
        actions.append(
          button(
            label,
            () => {
              s.confirm = apply;
              s.open = true;
              paint(s);
              s.node.querySelector("[data-apply-suggestion]")?.focus();
            },
            s.busy || isLocked(),
          ),
        );
      }
      details.append(actions);
      if (s.confirm) {
        const confirm = el("div", undefined, "approval-confirm");
        confirm.append(
          el(
            "p",
            `Replace ${s.confirm === "commands" ? "this project’s repository commands" : "this PM’s owned and shared paths"} with the values above? The PM stays paused. Applying either choice makes this discovery stale; remaining changes need manual review.`,
          ),
        );
        const save = button(
          s.busy ? "Applying…" : "Apply reviewed settings",
          async () => {
            if (s.busy || isLocked()) return;
            s.busy = true;
            paint(s);
            try {
              await api(endpoint(s), {
                revision: s.data.revision,
                areaRevision: s.data.areaRevision,
                knowledgeRevision: s.data.knowledgeRevision,
                apply: s.confirm,
              });
              s.notice =
                "Suggested settings saved. The PM remains paused. Verify the updated settings and refresh discovery before using further suggestions.";
              s.confirm = "";
              s.data = null;
              s.loaded = false;
              await onSaved();
            } catch (error) {
              s.error = `Suggested settings were not applied. ${error.message}`;
            } finally {
              s.busy = false;
              paint(s);
            }
          },
          s.busy || isLocked(),
        );
        save.dataset.applySuggestion = "true";
        confirm.append(
          save,
          button(
            "Keep current settings",
            () => {
              s.confirm = "";
              paint(s);
            },
            s.busy,
          ),
        );
        details.append(confirm);
      }
      s.node.append(details);
    }
    return {
      mount(root, project, area) {
        const s = state(project, area);
        root.append(s.node);
        load(s);
      },
      refresh(project, area) {
        return load(state(project, area), true);
      },
      isBusy: () => [...entries.values()].some((s) => s.busy),
      forget(project, area) {
        for (const [key, value] of entries)
          if (value.project === project && (!area || value.area === area))
            entries.delete(key);
      },
    };
  };
})();
