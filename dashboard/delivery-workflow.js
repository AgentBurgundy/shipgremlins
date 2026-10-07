"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (label, fn, primary = false) => {
    const node = el(
      "button",
      label,
      primary ? "button button-dark" : "small-button",
    );
    node.type = "button";
    node.addEventListener("click", fn);
    return node;
  };
  window.createDeliveryWorkflow = ({ api, pages, isLocked, onChanged }) => {
    const entries = new Map();
    let timer;
    const endpoint = (s) =>
      `/api/projects/${encodeURIComponent(s.project.name)}/delivery`;
    function message(node, text, error = false) {
      node.textContent = text;
      node.hidden = !text;
      node.classList.toggle("error", error);
    }
    function dirty(s) {
      return Boolean(
        s.pr.value ||
        s.complete.checked ||
        s.choices.querySelector("input:checked"),
      );
    }
    function make(project) {
      const root = el("section", undefined, "delivery-workflow"),
        s = {
          project,
          node: root,
          data: null,
          busy: false,
          request: null,
          error: "",
          states: null,
          statesError: "",
          revision: "",
          catalogSignature: "",
          confirm: "",
          candidateRevision: "",
          candidateBaseline: "",
          candidateSignature: "",
          trackingOpen: false,
          syncBusy: false,
          syncFeedback: "",
          syncError: false,
        };
      const heading = el("div", undefined, "project-section-title");
      heading.append(
        el("h2", "Move reviewed work forward"),
        button("Refresh delivery", () => load(s, true)),
      );
      s.notice = el("p", "", "operations-message");
      s.notice.hidden = true;
      s.actions = el("div", undefined, "delivery-controller-actions");
      s.sync = el("section", undefined, "delivery-staging-sync");
      s.syncTitle = el("h3", "Keep the test branch current");
      s.syncStatus = el("p", "", "runner-guidance");
      s.syncStatus.setAttribute("role", "status");
      s.syncStatus.setAttribute("aria-live", "polite");
      s.syncChecked = el("p", "", "runner-guidance");
      s.syncNotice = el("p", "", "operations-message");
      s.syncNotice.setAttribute("role", "status");
      s.syncNotice.setAttribute("aria-live", "polite");
      s.syncNotice.hidden = true;
      s.syncRetry = button("Retry sync", async () => {
        if (s.syncRetry.disabled || s.busy || isLocked()) return;
        s.busy = true;
        s.syncBusy = true;
        s.syncFeedback = "Checking staging and the test branch…";
        s.syncError = false;
        paint(s);
        try {
          s.data = await api(`${endpoint(s)}/sync`, {});
          s.syncFeedback = "Sync requested. Its status updates automatically.";
          await onChanged?.(project.name);
        } catch (error) {
          s.syncFeedback = `Sync could not finish. ${error.message}`;
          s.syncError = true;
        } finally {
          s.busy = false;
          s.syncBusy = false;
          paint(s);
          schedule();
        }
      });
      s.syncPull = el("a", "View sync PR / MR ↗", "production-diff-link");
      s.syncPull.target = "_blank";
      s.syncPull.rel = "noopener noreferrer";
      s.syncPull.hidden = true;
      const syncControls = el("div", undefined, "button-row");
      syncControls.append(s.syncRetry, s.syncPull);
      s.sync.append(
        s.syncTitle,
        s.syncStatus,
        s.syncChecked,
        syncControls,
        s.syncNotice,
      );
      s.confirmBox = el("div", undefined, "approval-confirm");
      s.confirmBox.hidden = true;
      s.candidate = el("section", undefined, "delivery-candidate-setup");
      s.candidate.append(
        el("h3", "Choose the promotion test environment"),
        el(
          "p",
          "Use a separate nonproduction target for the exact cherry-picked candidate. A Railway target must use a different environment or service from integration. Vercel can use a branch preview in the same project. This selection does not deploy anything or replace trusted candidate verification.",
          "runner-guidance",
        ),
      );
      const candidateLabel = el("label", "Candidate environment");
      s.candidateSelect = el("select");
      s.candidateSelect.id = `delivery-candidate-${project.name}`;
      s.candidateSelect.addEventListener("change", () => paint(s));
      candidateLabel.htmlFor = s.candidateSelect.id;
      s.candidateNotice = el("p", "", "operations-message");
      s.candidateNotice.hidden = true;
      s.candidateSave = button("Save candidate environment", async () => {
        if (s.busy || isLocked() || !s.candidateSelect.value) return;
        s.busy = true;
        paint(s);
        message(s.candidateNotice, "Saving the candidate environment…");
        try {
          await api(`${endpoint(s)}/environment`, {
            revision: s.candidateRevision,
            environment: s.candidateSelect.value,
          });
          s.candidateBaseline = s.candidateSelect.value;
          message(
            s.candidateNotice,
            "Candidate environment saved. Trusted verification of the exact candidate is still required.",
          );
          await load(s, true);
          await onChanged?.(project.name);
        } catch (error) {
          message(
            s.candidateNotice,
            `${error.message} Your selection is kept.`,
            true,
          );
        } finally {
          s.busy = false;
          paint(s);
        }
      });
      const resetCandidate = button("Reset selection", () => {
        s.candidateSelect.value = s.candidateBaseline;
        s.candidateSignature = "";
        paint(s);
        message(s.candidateNotice, "");
      });
      s.candidate.append(
        candidateLabel,
        s.candidateSelect,
        s.candidateSave,
        resetCandidate,
        s.candidateNotice,
      );
      const promote = el("section");
      promote.append(
        el("h3", "Integration → staging"),
        el(
          "p",
          "The controller tests approved work on the integration environment. Promotion uses isolated cherry-picks and checks; missing evidence keeps it blocked.",
          "runner-guidance",
        ),
      );
      const areaLabel = el("label", "Owning PM"),
        area = el("select");
      area.id = `delivery-pm-${project.name}`;
      areaLabel.htmlFor = area.id;
      for (const pm of project.areas || []) {
        const option = el("option", pm.name || pm.key);
        option.value = pm.key;
        area.append(option);
      }
      s.area = area;
      s.promote = button("Prepare staging promotion", () =>
        confirm(s, "promote"),
      );
      s.advance = button("Advance approved implementation", () =>
        confirm(s, "advance"),
      );
      promote.append(areaLabel, area, s.promote, s.advance);
      s.actions.append(s.sync, s.candidate, promote, s.confirmBox);
      s.productionIntro = el("section", undefined, "production-tracking");
      s.openTracking = button("Track a production release", () => {
        s.trackingOpen = true;
        paint(s);
        trackingTitle.focus();
      });
      s.productionIntro.append(
        el("h3", "Ready for production?"),
        el(
          "p",
          "Choose the reviewed delivery scope and follow its production merge.",
          "runner-guidance",
        ),
        s.openTracking,
      );
      s.tracking = el(
        "section",
        undefined,
        "production-tracking production-tracking-editor",
      );
      const trackingTitle = el("h2", "Track a production release");
      trackingTitle.setAttribute("tabindex", "-1");
      s.tracking.append(
        button("← Promotion controls", () => {
          s.trackingOpen = false;
          paint(s);
          s.openTracking.focus();
        }),
        trackingTitle,
        el(
          "p",
          "After staging review, choose the complete approved scope and its production PR. ShipGremlins checks the actual merge and included changes before updating Linear to Done. This does not merge production.",
          "runner-guidance",
        ),
      );
      const form = el("form"),
        choices = el("div", undefined, "production-scope-options"),
        scope = el("fieldset", undefined, "remote-projects");
      scope.append(
        el("legend", "Deliveries included in this production PR"),
        choices,
      );
      s.choices = choices;
      const fields = el("div", undefined, "remote-fields"),
        pr = el("input"),
        state = el("select");
      s.pr = pr;
      s.state = state;
      pr.type = "number";
      pr.min = "1";
      pr.step = "1";
      pr.required = true;
      pr.id = `production-pr-${project.name}`;
      state.id = `production-state-${project.name}`;
      state.required = true;
      for (const [input, label] of [
        [pr, "Production PR / MR number"],
        [state, "Linear Done state"],
      ]) {
        const field = el("div", undefined, "field"),
          title = el("label", label);
        title.htmlFor = input.id;
        field.append(title, input);
        fields.append(field);
      }
      const diff = el(
        "a",
        "Review production PR diff ↗",
        "production-diff-link",
      );
      diff.hidden = true;
      diff.target = "_blank";
      diff.rel = "noopener noreferrer";
      pr.addEventListener("input", () => {
        const number = Number(pr.value);
        diff.hidden = !Number.isSafeInteger(number) || number < 1;
        if (!diff.hidden) {
          const gitlab = project.provider === "gitlab";
          diff.href = `${gitlab ? project.serverUrl || "https://gitlab.com" : "https://github.com"}/${project.repo}/${gitlab ? "-/merge_requests" : "pull"}/${number}${gitlab ? "/diffs" : "/files"}`;
        }
      });
      const complete = el("input"),
        confirmation = el("label", undefined, "production-scope-confirm");
      complete.type = "checkbox";
      complete.required = true;
      s.complete = complete;
      confirmation.append(
        complete,
        el(
          "span",
          "These are all approved deliverables for these tickets. I reviewed the production PR diff.",
        ),
      );
      s.formMessage = el("p", "", "operations-message");
      s.formMessage.hidden = true;
      s.statesMessage = el("p", "", "operations-message");
      s.statesMessage.hidden = true;
      s.save = el("button", "Track production merge", "button button-dark");
      s.save.type = "submit";
      const controls = el("div", undefined, "button-row");
      controls.append(
        s.save,
        button("Reset scope", () => {
          pr.value = "";
          complete.checked = false;
          for (const input of choices.querySelectorAll("input"))
            input.checked = false;
          diff.hidden = true;
          s.catalogSignature = "";
          paint(s);
          message(s.formMessage, "");
        }),
      );
      form.append(
        scope,
        fields,
        diff,
        s.statesMessage,
        confirmation,
        controls,
        s.formMessage,
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (s.busy || isLocked() || !form.reportValidity()) return;
        const ids = [...choices.querySelectorAll("input")]
          .filter((input) => input.checked)
          .map((input) => input.value);
        if (!ids.length) {
          message(
            s.formMessage,
            "Choose at least one promoted delivery.",
            true,
          );
          return;
        }
        s.busy = true;
        s.save.disabled = true;
        paint(s);
        message(s.formMessage, "Checking the exact delivery scope…");
        try {
          const result = await api(`${endpoint(s)}/production`, {
            revision: s.revision,
            deliveryIds: ids,
            productionPr: Number(pr.value),
            completedStateId: state.value,
            scopeComplete: true,
          });
          s.data = result;
          pr.value = "";
          complete.checked = false;
          for (const input of choices.querySelectorAll("input"))
            input.checked = false;
          diff.hidden = true;
          s.catalogSignature = "";
          message(
            s.formMessage,
            "Production tracking saved. Done waits for the verified production merge and complete approved scope.",
          );
          await onChanged?.(project.name);
        } catch (error) {
          message(
            s.formMessage,
            `${error.message} Your selected scope is kept.`,
            true,
          );
        } finally {
          s.busy = false;
          paint(s);
          schedule();
        }
      });
      s.tracking.append(form);
      s.declarations = el("div", undefined, "production-declarations");
      s.handoffs = el("div", undefined, "candidate-handoffs");
      s.handoffSignature = "";
      s.handoffDialog = el("dialog", undefined, "delivery-detail-dialog");
      s.handoffDialog.setAttribute(
        "aria-labelledby",
        `candidate-handoff-title-${project.name}`,
      );
      const handoffHeader = el("header", undefined, "surface-dialog-header");
      s.handoffTitle = el("h2", "Candidate verification handoff");
      s.handoffTitle.id = `candidate-handoff-title-${project.name}`;
      const closeHandoff = () => {
        s.handoffDialog.close();
        (s.handoffTrigger || heading.querySelector("button"))?.focus();
      };
      const handoffClose = button("×", closeHandoff);
      handoffClose.className = "icon-close";
      handoffClose.setAttribute("aria-label", "Close candidate handoff");
      handoffHeader.append(s.handoffTitle, handoffClose);
      const handoffBody = el("div", undefined, "surface-dialog-body");
      s.handoffNotice = el("p", "", "runner-guidance");
      s.handoffContent = el("textarea");
      s.handoffContent.readOnly = true;
      s.handoffContent.rows = 12;
      s.handoffContent.setAttribute(
        "aria-label",
        "Unsigned candidate coordinates",
      );
      const copyHandoff = button("Copy candidate JSON", async () => {
        try {
          if (navigator.clipboard?.writeText)
            await navigator.clipboard.writeText(s.handoffContent.value);
          else {
            s.handoffContent.focus();
            s.handoffContent.select();
            if (!document.execCommand("copy")) throw new Error("manual");
          }
          s.handoffNotice.textContent =
            "Unsigned candidate coordinates copied. Trusted verification is still required.";
        } catch {
          s.handoffContent.focus();
          s.handoffContent.select();
          s.handoffNotice.textContent =
            "JSON selected. Copy it manually for your trusted verifier.";
        }
      });
      handoffBody.append(s.handoffNotice, s.handoffContent, copyHandoff);
      s.handoffDialog.append(handoffHeader, handoffBody);
      s.handoffDialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeHandoff();
      });
      root.append(
        heading,
        s.notice,
        s.actions,
        s.handoffs,
        s.productionIntro,
        s.tracking,
        s.declarations,
        s.handoffDialog,
      );
      return s;
    }
    function confirm(s, action) {
      s.confirm = action;
      s.confirmBox.replaceChildren();
      s.confirmBox.hidden = false;
      s.confirmBox.append(
        el(
          "p",
          action === "advance"
            ? "Advance one approved ShipGremlins implementation? This may merge its exact reviewed PR into the integration branch. It does not merge staging or production."
            : "Prepare a staging promotion for this PM? The controller will isolate reviewed changes, run checks, and require verification of the exact candidate before creating a draft promotion PR.",
        ),
      );
      const accept = button(
        action === "advance" ? "Advance approved work" : "Prepare promotion",
        async () => {
          if (s.busy || isLocked()) return;
          s.busy = true;
          accept.disabled = true;
          paint(s);
          try {
            s.data = await api(
              `${endpoint(s)}/${action}`,
              action === "promote" ? { area: s.area.value } : {},
            );
            s.confirm = "";
            s.confirmBox.hidden = true;
            await onChanged?.(s.project.name);
          } catch (error) {
            s.error = error.message;
          } finally {
            s.busy = false;
            paint(s);
            schedule();
          }
        },
        true,
      );
      const keep = button("Keep reviewing", () => {
        s.confirm = "";
        s.confirmBox.hidden = true;
      });
      s.confirmBox.append(accept, keep);
      accept.focus();
    }
    function paint(s) {
      const disabled =
        isLocked() || s.busy || s.data?.operation?.phase === "running";
      const available = s.data?.enabled === true;
      s.node.setAttribute("aria-busy", String(s.busy));
      for (const input of s.node.querySelectorAll("input, select"))
        input.disabled = disabled;
      s.actions.hidden = !available || s.trackingOpen;
      s.productionIntro.hidden = !available || s.trackingOpen;
      s.tracking.hidden = !available || !s.trackingOpen;
      s.handoffs.hidden = s.trackingOpen;
      s.declarations.hidden = s.trackingOpen;
      s.openTracking.disabled = disabled;
      const sync = s.data?.stagingSync;
      s.sync.hidden = !sync || sync.phase === "disabled";
      const syncLabels = {
        checking: "Checking the test branch",
        current: "Test branch is up to date",
        "waiting-checks": "Waiting for branch checks",
        "waiting-merge": "Waiting to merge staging changes",
        repairing: "A coding gremlin is resolving conflicts",
        "waiting-deployment": "Waiting for the updated test app",
        blocked: "Staging sync needs attention",
      };
      s.syncTitle.textContent =
        syncLabels[sync?.phase] || "Keep the test branch current";
      s.syncStatus.textContent = sync?.message || "";
      const checkedAt = sync?.checkedAt ? new Date(sync.checkedAt) : null;
      s.syncChecked.hidden = !checkedAt || Number.isNaN(checkedAt.getTime());
      s.syncChecked.textContent = s.syncChecked.hidden
        ? ""
        : `Last checked ${checkedAt.toLocaleString()} · Checks automatically every minute`;
      s.syncRetry.disabled =
        disabled ||
        !available ||
        !sync ||
        ["disabled", "checking", "repairing"].includes(sync.phase);
      s.syncRetry.textContent = s.syncBusy ? "Checking…" : "Retry sync";
      message(s.syncNotice, s.syncFeedback, s.syncError);
      s.syncPull.hidden = true;
      s.syncPull.href = "";
      if (sync?.pullUrl) {
        try {
          const url = new URL(sync.pullUrl);
          if (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            ![...url.searchParams.keys()].some((key) =>
              /token|secret|password|credential/i.test(key),
            )
          ) {
            s.syncPull.href = url.href;
            s.syncPull.hidden = false;
          }
        } catch {
          /* A malformed provider URL must not become a clickable link. */
        }
      }
      const candidate = s.data?.candidateSetup;
      s.candidate.hidden = !candidate;
      const candidateSignature = JSON.stringify(candidate);
      if (
        candidate &&
        s.candidateSelect.value === s.candidateBaseline &&
        candidateSignature !== s.candidateSignature
      ) {
        s.candidateSignature = candidateSignature;
        s.candidateRevision = candidate.revision;
        s.candidateSelect.replaceChildren();
        const empty = el("option", "Choose a nonproduction environment");
        empty.value = "";
        s.candidateSelect.append(empty);
        for (const target of candidate.environments || []) {
          const option = el(
            "option",
            `${target.name} · ${target.provider} · ${target.role}`,
          );
          option.value = target.name;
          s.candidateSelect.append(option);
        }
        if (
          candidate.selected &&
          !(candidate.environments || []).some(
            (target) => target.name === candidate.selected,
          )
        ) {
          const missing = el(
            "option",
            `${candidate.selected} · unavailable — choose another target`,
          );
          missing.value = candidate.selected;
          missing.disabled = true;
          s.candidateSelect.append(missing);
        }
        s.candidateSelect.value = candidate.selected || "";
        s.candidateBaseline = s.candidateSelect.value;
        if (!candidate.environments?.length)
          message(
            s.candidateNotice,
            "Add a separate preview or staging Vercel/Railway environment in Project settings first.",
          );
      }
      s.candidateSave.disabled =
        disabled ||
        !s.candidateSelect.value ||
        !(candidate?.environments || []).some(
          (target) => target.name === s.candidateSelect.value,
        );
      const operation = s.data?.operation;
      message(
        s.notice,
        s.error ||
          operation?.message ||
          s.data?.message ||
          (!s.data ? "Loading delivery controls…" : ""),
        Boolean(s.error || operation?.phase === "error"),
      );
      s.promote.disabled = disabled || !s.area.value;
      s.advance.disabled = disabled;
      s.save.disabled = disabled || !s.states?.length;
      const catalog = JSON.stringify([s.data?.revision, s.states]);
      if (!dirty(s) && catalog !== s.catalogSignature) {
        s.catalogSignature = catalog;
        s.revision = s.data?.revision || "";
        s.choices.replaceChildren();
        const tracked = new Set(
          (s.data?.declarations || []).flatMap((item) => item.deliveryIds),
        );
        for (const item of s.data?.deliveries || []) {
          if (
            item.status !== "promoted" ||
            !item.review ||
            !item.promotion ||
            tracked.has(item.id)
          )
            continue;
          const label = el("label"),
            input = el("input");
          input.type = "checkbox";
          input.value = item.id;
          label.append(
            input,
            el(
              "span",
              `${item.ticket?.identifier || "Delivery"} · ${item.ticket?.title || item.id}`,
            ),
          );
          s.choices.append(label);
        }
        if (!s.choices.children.length)
          s.choices.append(
            el(
              "p",
              "No untracked promoted deliveries yet. Complete PM verification and staging promotion first.",
              "runner-guidance",
            ),
          );
        const previous = s.state.value;
        s.state.replaceChildren();
        const option = el("option", "Choose a completed state");
        option.value = "";
        s.state.append(option);
        for (const item of s.states || []) {
          const option = el("option", item.name);
          option.value = item.id;
          s.state.append(option);
        }
        if ((s.states || []).some((item) => item.id === previous))
          s.state.value = previous;
      }
      message(s.statesMessage, s.statesError, Boolean(s.statesError));
      const handoffs = (s.data?.candidates || []).map((value) =>
        Object.fromEntries(
          [
            "project",
            "repo",
            "author",
            "area",
            "branch",
            "releaseBranch",
            "candidateSha",
            "baseSha",
            "changes",
            "preparedAt",
          ]
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, value[key]]),
        ),
      );
      const handoffSignature = JSON.stringify(handoffs);
      if (handoffSignature !== s.handoffSignature) {
        s.handoffSignature = handoffSignature;
        if (s.handoffDialog.open)
          s.handoffNotice.textContent =
            "Candidate information changed. These coordinates are from when you opened this view. Close and reopen the handoff to review the latest candidate.";
        s.handoffTrigger = null;
        s.handoffs.replaceChildren();
        for (const handoff of handoffs) {
          const detail = el("section", undefined, "production-tracking");
          const open = button("View candidate coordinates", () => {
            s.handoffTrigger = open;
            s.handoffArea = handoff.area;
            s.handoffTitle.textContent = `Candidate handoff · ${handoff.area}`;
            s.handoffContent.value = JSON.stringify(handoff, null, 2);
            s.handoffNotice.textContent =
              "Unsigned preparation only. Give these exact commit coordinates to your trusted candidate verifier. This is not a passing attestation.";
            if (!s.handoffDialog.open) s.handoffDialog.showModal();
            s.handoffDialog.querySelector("button").focus();
          });
          if (s.handoffDialog.open && s.handoffArea === handoff.area)
            s.handoffTrigger = open;
          detail.append(
            el("h3", `Candidate verification handoff · ${handoff.area}`),
            el(
              "p",
              "Review the exact prepared commit coordinates for trusted verification.",
              "runner-guidance",
            ),
            open,
          );
          s.handoffs.append(detail);
        }
      }
      s.declarations.replaceChildren();
      for (const declaration of s.data?.declarations || []) {
        const card = el("article", undefined, "production-declaration");
        const pulls = [
          ...new Set(
            declaration.manifest?.tickets?.flatMap(
              (ticket) =>
                ticket.deliverables?.map((item) => item.productionPr) || [],
            ) || [],
          ),
        ];
        card.append(
          el(
            "strong",
            `Tracking production ${pulls.map((number) => `PR #${number}`).join(", ")}`,
          ),
          el(
            "p",
            `${declaration.deliveryIds?.length || 0} deliveries · scope confirmed ${new Date(declaration.createdAt).toLocaleString()}`,
            "runner-guidance",
          ),
        );
        s.declarations.append(card);
      }
      for (const report of s.data?.productionReports || []) {
        if (report?.report?.tickets) {
          const audit = report.report;
          const group = el("section", undefined, "production-audit");
          group.append(el("h3", "Production checks"));
          if (audit.checkedAt)
            group.append(
              el(
                "p",
                `Last checked ${new Date(audit.checkedAt).toLocaleString()}`,
                "runner-guidance",
              ),
            );
          for (const ticket of audit.tickets) {
            const card = el("article", undefined, "production-declaration"),
              label = ticket.applied
                ? "Linear marked Done"
                : ticket.classification === "production-confirmed" &&
                    ticket.currentState === "completed"
                  ? "Already Done in Linear"
                  : ticket.classification === "production-confirmed"
                    ? "Production merge verified"
                    : ticket.classification === "canceled"
                      ? "Ticket canceled"
                      : ticket.classification === "not-production"
                        ? "Awaiting production"
                        : "Review needed";
            card.append(
              el("strong", `${ticket.identifier} · ${label}`),
              el(
                "p",
                ticket.reason || "Review the current production evidence.",
                "runner-guidance",
              ),
            );
            if (ticket.currentState)
              card.append(
                el(
                  "p",
                  `${ticket.applied ? "Linear state before update" : "Linear state at check"}: ${ticket.currentState}`,
                  "runner-guidance",
                ),
              );
            for (const evidence of ticket.evidence || []) {
              try {
                const url = new URL(evidence.productionUrl);
                if (
                  !["http:", "https:"].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  [...url.searchParams.keys()].some((key) =>
                    /token|secret|password|credential/i.test(key),
                  )
                )
                  continue;
                const link = el(
                  "a",
                  `Production PR #${evidence.productionPr} ↗`,
                  "production-diff-link",
                );
                link.href = url.href;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                card.append(link);
              } catch {
                /* Keep unusable evidence URLs as text-only status. */
              }
            }
            group.append(card);
          }
          s.declarations.append(group);
          continue;
        }
        const value =
          typeof report === "string" ? report : report.message || report.detail;
        if (value) s.declarations.append(el("p", value, "operations-message"));
      }
    }
    async function load(s, force = false) {
      if (s.request) return s.request;
      if (isLocked()) return;
      s.request = (async () => {
        try {
          s.data = await api(endpoint(s));
          s.error = "";
          if (s.data.enabled && (s.states === null || force)) {
            try {
              s.states = (await api(`${endpoint(s)}/states`)).states || [];
              s.statesError = "";
            } catch (error) {
              s.statesError = `Completed Linear states could not load. ${error.message}`;
            }
          }
        } catch (error) {
          s.error = `Delivery controls could not load. ${error.message}`;
        } finally {
          s.request = null;
          paint(s);
          schedule();
        }
      })();
      return s.request;
    }
    function schedule() {
      clearTimeout(timer);
      for (const s of entries.values())
        if (
          s.handoffDialog.open &&
          (pages.current !== "project" ||
            pages.project !== s.project.name ||
            pages.pm ||
            pages.tab !== "delivery")
        )
          s.handoffDialog.close();
      if (
        pages.current !== "project" ||
        pages.pm ||
        pages.tab !== "delivery" ||
        document.hidden ||
        isLocked()
      )
        return;
      const s = entries.get(pages.project);
      if (!s) return;
      timer = setTimeout(
        () => load(s),
        s.data?.operation?.phase === "running" ||
          s.data?.stagingSync?.phase === "checking"
          ? 2000
          : 15000,
      );
    }
    window.addEventListener("dashboard:pagechange", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => clearTimeout(timer));
    return {
      mount(root, project) {
        let s = entries.get(project.name);
        if (!s) {
          s = make(project);
          entries.set(project.name, s);
        }
        root.append(s.node);
        paint(s);
        load(s);
      },
      resume() {
        const s = entries.get(pages.project);
        if (
          pages.current !== "project" ||
          pages.pm ||
          pages.tab !== "delivery" ||
          !s
        )
          return;
        paint(s);
        if (!s.data) load(s);
        else schedule();
      },
      refresh(name) {
        const s = entries.get(name);
        if (s) return load(s, true);
      },
      forget(name) {
        entries.get(name)?.handoffDialog.close();
        entries.delete(name);
        clearTimeout(timer);
      },
      isDirty: () =>
        [...entries.values()].some(
          (s) => dirty(s) || s.candidateSelect.value !== s.candidateBaseline,
        ),
      isBusy: () => [...entries.values()].some((s) => s.busy),
    };
  };
})();
