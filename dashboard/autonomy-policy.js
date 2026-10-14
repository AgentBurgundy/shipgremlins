"use strict";
(() => {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  window.renderAutonomousApprovalPolicy = (root, project, { api } = {}) => {
    const name = typeof project === "string" ? project : project.name;
    const card = el("details", "approval-policy"),
      summary = el("summary", "approval-policy-summary");
    card.id = "approval-policy";
    summary.append(
      el("span", "", "Automatic approvals"),
      el("span", "approval-policy-badge", "Off"),
    );
    const body = el("div", "approval-policy-body"),
      status = el("p", "muted", "Loading saved policy…");
    status.setAttribute("role", "status");
    body.append(status);
    card.append(summary, body);
    root.replaceChildren(card);
    let saved,
      busy = false,
      dirty = false;
    const reviewActions = new Set();
    const reviewNotice = el("p", "approval-policy-note");
    reviewNotice.hidden = true;
    reviewNotice.setAttribute("role", "status");
    const reviewLink = el("a", "small-button", "Open Proposals →");
    reviewLink.href = `/projects/${encodeURIComponent(name)}?tab=review`;
    reviewLink.hidden = true;
    const syncReviewActions = () => {
      for (const button of reviewActions) button.disabled = busy || dirty;
    };
    const endpoint = `/api/projects/${encodeURIComponent(name)}/approval-policy`;
    const fields = [
      ["maxDailyApprovals", "Approvals per day", 10],
      ["maxOpenTickets", "Open automatic tickets", 4],
      ["maxFiles", "Files per ticket", 10],
      ["maxChangedLines", "Changed lines per ticket", 500],
    ];
    async function load() {
      if (busy) return;
      busy = true;
      syncReviewActions();
      const controls = body.querySelectorAll("input,textarea,button");
      for (const control of controls) control.disabled = true;
      try {
        saved = await api(endpoint);
        dirty = false;
        render();
      } catch {
        status.textContent =
          "Approval policy could not be loaded. Your current settings are preserved.";
        const retry = el("button", "small-button", "Try again");
        retry.type = "button";
        retry.onclick = () => {
          retry.remove();
          load();
        };
        body.append(retry);
      } finally {
        busy = false;
        for (const control of controls) control.disabled = false;
        syncReviewActions();
      }
    }
    function render() {
      const policy = saved.policy;
      summary.lastChild.textContent = policy.enabled ? "On · bounded" : "Off";
      const form = el("form", "approval-policy-form");
      reviewActions.clear();
      form.addEventListener("input", () => {
        dirty = true;
        syncReviewActions();
      });
      form.addEventListener("change", () => {
        dirty = true;
        syncReviewActions();
      });
      const intro = el(
        "p",
        "muted",
        "Let gremlins approve small documentation, static style, and test changes inside paths you choose. Other work stays in review.",
      );
      const toggleLabel = el("label", "approval-policy-toggle"),
        enabled = el("input");
      enabled.type = "checkbox";
      enabled.checked = policy.enabled;
      toggleLabel.append(
        enabled,
        el("span", "", "Automatically approve low-risk work"),
      );
      const pathLabel = el(
          "label",
          "approval-policy-field",
          "Allowed repository paths",
        ),
        paths = el("textarea");
      paths.rows = 2;
      paths.value = policy.allowedPaths.join("\n");
      paths.placeholder = "docs\nsrc/styles\ntests";
      paths.required = false;
      pathLabel.append(
        paths,
        el(
          "small",
          "muted",
          "One directory or exact file per line. Broad wildcards are unavailable.",
        ),
      );
      const labelLabel = el(
          "label",
          "approval-policy-field",
          "Candidate ticket label",
        ),
        label = el("input");
      label.value = policy.requiredLabel;
      label.required = true;
      label.pattern = "pm-auto-[a-z0-9-]{1,40}";
      labelLabel.append(
        label,
        el(
          "small",
          "muted",
          "A candidate label requests review against this policy; it grants no permission by itself.",
        ),
      );
      const limits = el("div", "approval-policy-limits"),
        inputs = {};
      for (const [key, title, max] of fields) {
        const wrapper = el("label", "approval-policy-field", title),
          input = el("input");
        input.type = "number";
        input.min = "1";
        input.max = String(max);
        input.step = "1";
        input.required = true;
        input.value = String(policy[key]);
        wrapper.append(input);
        limits.append(wrapper);
        inputs[key] = input;
      }
      const protectedNote = el(
        "p",
        "approval-policy-note",
        "Protected files, sensitive systems, and production release keep their existing approval gates. Each automatic approval records its exact ticket scope and policy.",
      );
      const actions = el("div", "button-row"),
        save = el("button", "button button-dark", "Save approval policy");
      save.type = "submit";
      const reset = el("button", "small-button", "Reload saved policy");
      reset.type = "button";
      reset.onclick = () => {
        if (!busy) load();
      };
      actions.append(save, reset);
      const result = el("p", "muted");
      result.setAttribute("role", "status");
      form.append(
        intro,
        toggleLabel,
        pathLabel,
        labelLabel,
        limits,
        protectedNote,
        actions,
        result,
      );
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        syncReviewActions();
        save.disabled = reset.disabled = true;
        save.textContent = "Saving…";
        const policy = {
          enabled: enabled.checked,
          allowedPaths: paths.value
            .split(/[\n,]/)
            .map((p) => p.trim())
            .filter(Boolean),
          requiredLabel: label.value.trim(),
        };
        for (const [key] of fields) policy[key] = Number(inputs[key].value);
        try {
          saved = await api(endpoint, {
            revision: saved.revision,
            policy,
          });
          summary.lastChild.textContent = policy.enabled
            ? "On · bounded"
            : "Off";
          result.textContent = "Approval policy saved.";
          dirty = false;
        } catch (error) {
          result.textContent =
            error.message ||
            "Policy could not be saved. Reload saved settings and try again.";
        } finally {
          busy = false;
          save.disabled = reset.disabled = false;
          save.textContent = "Save approval policy";
          syncReviewActions();
        }
      };
      body.replaceChildren(form);
      if (saved.audit?.length) {
        const audit = el("details", "approval-policy-audit"),
          heading = el("summary", "", "Recent approval decisions"),
          list = el("ul");
        for (const item of saved.audit.slice(0, 10)) {
          const row = el(
            "li",
            "",
            `${item.identifier} · ${item.status} · ${item.files.length} files`,
          );
          if (item.status !== "manual") {
            const review = el(
              "button",
              "small-button",
              "Send to manual review",
            );
            review.type = "button";
            review.setAttribute(
              "aria-label",
              `Send ${item.identifier} to manual review`,
            );
            reviewActions.add(review);
            review.addEventListener("click", async () => {
              if (busy || dirty) return;
              busy = true;
              syncReviewActions();
              for (const input of form.querySelectorAll(
                "input,textarea,button",
              ))
                input.disabled = true;
              reviewNotice.hidden = true;
              reviewLink.hidden = true;
              try {
                saved = await api(`${endpoint}/review`, {
                  revision: saved.revision,
                  auditId: item.id,
                });
                render();
                reviewNotice.textContent =
                  "Sent to manual review. Review the exact ticket scope in Proposals.";
                reviewNotice.setAttribute("role", "status");
                reviewLink.hidden = false;
              } catch (error) {
                reviewNotice.textContent =
                  error.message ||
                  "The approval could not return to manual review. Refresh the audit before trying again.";
                reviewNotice.setAttribute("role", "alert");
              } finally {
                busy = false;
                for (const input of form.querySelectorAll(
                  "input,textarea,button",
                ))
                  input.disabled = false;
                reviewNotice.hidden = false;
                syncReviewActions();
              }
            });
            row.append(review);
          }
          list.append(row);
        }
        audit.append(heading, list);
        if (reviewActions.size)
          audit.append(
            el(
              "p",
              "muted",
              "Save or reload policy edits before changing an approval decision.",
            ),
          );
        body.append(audit);
      }
      body.append(reviewNotice, reviewLink);
      syncReviewActions();
    }
    if (api) load();
    else
      status.textContent =
        "Approval settings are unavailable in this dashboard session.";
    return { isDirty: () => dirty || busy };
  };
})();
