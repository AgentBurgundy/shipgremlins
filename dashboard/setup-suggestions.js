"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  window.createSetupSuggestions = ({ api, onSaved, onChanged, isLocked }) => {
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
      // Keep the reviewed values stable while the dialog is open. Revision checks
      // still reject a save if discovery or project settings changed meanwhile.
      if (s.view?.dialog.open) {
        s.refreshPending = true;
        return;
      }
      s.loading = true;
      try {
        const next = await api(endpoint(s));
        if (
          s.data?.revision !== next.revision ||
          s.data?.areaRevision !== next.areaRevision ||
          s.data?.knowledgeRevision !== next.knowledgeRevision
        )
          s.confirm = "";
        s.data = next;
        s.error = "";
        s.loaded = true;
      } catch (error) {
        s.error = error.message;
      } finally {
        s.loading = false;
        paint(s);
        onChanged?.();
      }
    }
    function view(s) {
      if (s.view) return s.view;
      const messages = el("div"),
        card = el("div", undefined, "setup-suggestion-card"),
        copy = el("div"),
        dialog = el(
          "dialog",
          undefined,
          "foundation-brief-dialog setup-suggestion-dialog",
        ),
        header = el("header", undefined, "foundation-dialog-header"),
        heading = el("h2", "Review suggested setup"),
        details = el("div", undefined, "setup-suggestion-review"),
        errors = el("div");
      heading.setAttribute("tabindex", "-1");
      heading.setAttribute("autofocus", "");
      dialog.setAttribute("aria-label", "Review suggested setup");
      const close = button("Close", () => dialog.close());
      close.className = "small-button foundation-dialog-close";
      header.append(heading, close);
      dialog.append(
        header,
        errors,
        details,
        button("Done", () => dialog.close()),
      );
      dialog.addEventListener("close", () => {
        if (s.refreshPending) {
          s.refreshPending = false;
          load(s, true);
        }
        onChanged?.();
      });
      copy.append(
        el("h3", "Setup suggestions ready"),
        el(
          "p",
          "Discovery found repository commands and PM ownership for you to review.",
        ),
      );
      card.append(
        copy,
        button("Review suggested setup", () => {
          dialog.showModal();
          heading.focus({ preventScroll: true });
          dialog.scrollTop = 0;
        }),
      );
      s.node.append(messages, card, dialog);
      s.view = { messages, card, dialog, details, errors };
      return s.view;
    }
    function paint(s) {
      const { messages, card, dialog, details, errors } = view(s);
      messages.replaceChildren();
      errors.replaceChildren();
      if (s.notice) {
        const notice = el("p", s.notice, "operations-message");
        notice.setAttribute("role", "status");
        messages.append(notice);
      }
      if (s.error) {
        const error = el("p", s.error, "operations-message error");
        error.setAttribute("role", "status");
        (dialog.open ? errors : messages).append(
          error,
          button(
            "Refresh suggested setup",
            () => {
              if (dialog.open) {
                s.refreshPending = true;
                dialog.close();
              } else load(s, true);
            },
            s.loading,
          ),
        );
      }
      card.hidden = s.data?.state !== "ready" || !s.data.proposal;
      if (card.hidden) {
        if (dialog.open) dialog.close();
        details.replaceChildren();
        return;
      }
      const proposal = s.data.proposal;
      details.replaceChildren();
      details.append(
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
            `Replace ${s.confirm === "commands" ? "this project’s repository commands" : "this PM’s owned and shared paths"} with the values above? Existing automation settings stay unchanged. Applying either choice makes this discovery stale; remaining changes need manual review.`,
          ),
        );
        const save = button(
          s.busy ? "Applying…" : "Apply reviewed settings",
          async () => {
            if (s.busy || isLocked()) return;
            s.busy = true;
            paint(s);
            let applied = false;
            try {
              await api(endpoint(s), {
                revision: s.data.revision,
                areaRevision: s.data.areaRevision,
                knowledgeRevision: s.data.knowledgeRevision,
                apply: s.confirm,
              });
              applied = true;
              s.error = "";
              s.notice =
                "Suggested settings saved. Existing automation settings were preserved. Verify the updated settings and refresh discovery before using further suggestions.";
              s.confirm = "";
              s.data = null;
              s.loaded = false;
              dialog.close();
            } catch (error) {
              s.error = `Suggested settings were not applied. ${error.message}`;
            } finally {
              s.busy = false;
              paint(s);
              onChanged?.();
            }
            if (applied) {
              try {
                await onSaved();
              } catch {
                s.notice =
                  "Suggested settings were saved. Reload the page to see the updated project settings.";
                paint(s);
              }
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
      proposal(project, area) {
        const data = entries.get(`${project}/${area}`)?.data;
        return data?.state === "ready" ? data.proposal : undefined;
      },
      protectFocus: () =>
        [...entries.values()].some((s) => s.view?.dialog.open),
      setActive(key) {
        for (const [id, s] of entries)
          if (id !== key && s.view?.dialog.open) s.view.dialog.close();
      },
      isBusy: () => [...entries.values()].some((s) => s.busy),
      forget(project, area) {
        for (const [key, value] of entries)
          if (value.project === project && (!area || value.area === area)) {
            value.refreshPending = false;
            if (value.view?.dialog.open) value.view.dialog.close();
            entries.delete(key);
          }
      },
    };
  };
})();
