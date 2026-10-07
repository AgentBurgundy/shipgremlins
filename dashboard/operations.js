"use strict";
(() => {
  const el = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const btn = (label, fn, primary = false) => {
    const value = el(
      "button",
      primary ? "button button-dark" : "small-button",
      label,
    );
    value.type = "button";
    value.addEventListener("click", fn);
    return value;
  };
  const route = (project, tab = "overview") =>
    `/projects/${encodeURIComponent(project)}${tab === "overview" ? "" : `?tab=${tab}`}`;
  const anchor = (label, href, className = "small-button") => {
    const value = el("a", className, label);
    value.href = href;
    return value;
  };
  const safeHref = (href) => {
    try {
      const url = new URL(href, window.location.origin);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null;
      if (
        [...url.searchParams.keys()].some((key) =>
          /token|secret|password|credential/i.test(key),
        )
      )
        return null;
      return url.href;
    } catch {
      return null;
    }
  };
  const labels = {
    setup: "Setup",
    run: "Run needs attention",
    delivery: "Delivery review",
    knowledge: "Product decision",
    proposal: "Proposal",
  };
  const limitFields = [
    [
      "maxConcurrentJobs",
      "Concurrent jobs",
      "How many jobs this project can run at once.",
    ],
    [
      "maxDailyRuns",
      "Runs per day",
      "A daily ceiling for manual and automatic starts.",
    ],
    [
      "maxDailyRuntimeMinutes",
      "Agent runtime minutes per day",
      "PM and coding agent runtime. Trusted browser replay and promotion checks have separate time bounds; provider billing may differ.",
    ],
    [
      "maxJobMinutes",
      "Agent minutes per job",
      "Stop an individual PM or coding agent when it reaches this limit.",
    ],
  ];
  window.createProjectOperations = ({
    api,
    pages,
    inbox,
    onChanged,
    onDiscover,
    onCreatePm,
    getProject,
    getCodingAction,
    getJobs,
    isLocked,
  }) => {
    const states = new Map();
    const deliveryWorkflow = window.createDeliveryWorkflow?.({
      api,
      pages,
      isLocked,
      onChanged: async (name) => {
        await refresh(name, true);
        await onChanged?.();
      },
    });
    let timer,
      globalLoadedAt = 0,
      globalBusy = false,
      globalError = "",
      globalProjects = [],
      filter = "",
      inboxSignature = "";
    function state(name) {
      if (!states.has(name))
        states.set(name, {
          name,
          data: null,
          error: "",
          notice: "",
          busy: false,
          fetching: false,
          loadedAt: 0,
          views: new Map(),
          note: "",
          deletingDecision: null,
          decisionError: "",
          limitDraft: null,
          limitBase: "",
          review: null,
          reviewBusy: false,
          reviewError: "",
          approving: "",
          confirmApproval: "",
        });
      return states.get(name);
    }
    function setMessage(target, text, error = false) {
      target.textContent = text;
      target.hidden = !text;
      target.classList.toggle("error", error);
    }
    function message(text, error = false) {
      const value = el("p", `operations-message${error ? " error" : ""}`, text);
      value.setAttribute("role", "status");
      return value;
    }
    function empty(title, detail, action) {
      const value = el("div", "operations-empty");
      value.append(
        el("span", "operations-empty-mark", "✳"),
        el("h3", "", title),
        el("p", "", detail),
      );
      if (action) value.append(action);
      return value;
    }
    function heading(title, description) {
      const value = el("div", "operations-heading");
      value.append(el("h2", "", title), el("p", "", description));
      return value;
    }
    function itemCard(item, project) {
      const card = el("article", "review-item");
      const copy = el("div", "review-item-copy");
      copy.append(
        el(
          "span",
          `review-kind kind-${item.kind}`,
          labels[item.kind] || "Review",
        ),
        el("h3", "", item.title),
        el("p", "", item.detail),
      );
      const actions = el("div", "review-item-actions");
      const href = item.action?.href && safeHref(item.action.href);
      if (href) {
        const link = anchor(item.action.label || "Review", href);
        if (new URL(href).origin !== window.location.origin) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        actions.append(link);
      }
      actions.append(anchor(project, route(project), "review-project-link"));
      card.append(copy, actions);
      return card;
    }
    function reviewView(s) {
      const content = el("div");
      const items = Array.isArray(s.data?.inbox) ? s.data.inbox : [];
      content.append(
        heading(
          "Decisions, in one place",
          "Review evidence, resolve setup, and choose the next work. Coding still requires an approved ticket.",
        ),
      );
      if (!items.length)
        content.append(
          empty(
            "Nothing waiting for you",
            "New findings and delivery reviews appear here when the crew has something ready for your attention.",
          ),
        );
      else {
        const list = el("div", "review-items");
        for (const item of items) list.append(itemCard(item, s.name));
        content.append(list);
      }
      return content;
    }
    async function refreshReview(s, force = false) {
      if (s.reviewBusy || (!force && s.review !== null)) return;
      s.reviewBusy = true;
      paintReview(s);
      try {
        s.review = await api(
          `/api/projects/${encodeURIComponent(s.name)}/review`,
        );
        s.reviewError = "";
      } catch (error) {
        s.reviewError = `Linear proposals could not refresh. ${error.message}`;
      } finally {
        s.reviewBusy = false;
        paintReview(s);
      }
    }
    function paintReview(s) {
      const view = s.views.get("review");
      if (!view?.proposals) return;
      const root = view.proposals;
      root.replaceChildren();
      const title = el("div", "project-section-title");
      title.append(
        el("h2", "", "Proposals from your PMs"),
        btn(s.reviewBusy ? "Refreshing…" : "Refresh proposals", () =>
          refreshReview(s, true),
        ),
      );
      title.lastElementChild.disabled =
        s.reviewBusy || Boolean(s.approving) || isLocked();
      root.append(
        title,
        el(
          "p",
          "runner-guidance",
          s.review?.approvalPolicy === "epic"
            ? "Review the proposed outcome, evidence and limits. Approve an epic once; its PM manages the child tickets and brings you a tested promotion batch."
            : "Review the proposed outcome, evidence and limits under this project's saved approval policy.",
        ),
      );
      if (s.reviewError) root.append(message(s.reviewError, true));
      if (s.notice) root.append(message(s.notice));
      if (!s.review && s.reviewBusy)
        root.append(
          message(
            "Loading proposals from the project’s selected Linear account…",
          ),
        );
      else if (!s.review?.items?.length && !s.reviewError)
        root.append(
          empty(
            "No proposals awaiting approval",
            "Run a PM patrol or Explore product ideas to get considered proposals for your next improvement.",
          ),
        );
      const selected = s.review?.items?.find(
        (item) => item.id === s.selectedProposal,
      );
      if (selected)
        root.append(
          btn("← All proposals", () => {
            s.selectedProposal = "";
            s.confirmApproval = "";
            paintReview(s);
            const heading = root.querySelector("h2");
            heading?.setAttribute("tabindex", "-1");
            heading?.focus();
          }),
        );
      for (const item of selected ? [selected] : s.review?.items || []) {
        const card = el("article", "proposal-card"),
          head = el("div", "shared-knowledge-heading");
        head.append(
          el(
            "span",
            "review-kind",
            `${item.identifier}${item.area ? ` · ${item.area}` : ""}`,
          ),
        );
        const href = item.url && safeHref(item.url);
        if (href) {
          const link = anchor("Open in Linear ↗", href, "review-project-link");
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          head.append(link);
        }
        card.append(head, el("h3", "", item.title));
        if (!selected) {
          const preview =
            (item.description || "No description supplied.")
              .split(/\r?\n/)
              .find((line) => line.trim() && !/^(#|<!--)/.test(line.trim())) ||
            "Open the proposal to review its scope and evidence.";
          card.append(
            el(
              "p",
              "proposal-preview",
              preview.length > 220 ? `${preview.slice(0, 217)}…` : preview,
            ),
            btn("Read & review", () => {
              s.selectedProposal = item.id;
              paintReview(s);
              const heading = root.querySelector("h3");
              heading?.setAttribute("tabindex", "-1");
              heading?.focus({ preventScroll: true });
              heading?.scrollIntoView?.({ block: "start" });
            }),
          );
          root.append(card);
          continue;
        }
        const details = el("section", "proposal-evidence proposal-reading");
        details.append(
          window.renderKnowledgeDocument(
            item.description || "No description supplied.",
          ),
        );
        card.append(details);
        if (item.reason) card.append(el("p", "runner-guidance", item.reason));
        if (item.canApprove) {
          const approve = btn(
            s.approving === item.id
              ? "Approving…"
              : item.kind === "epic"
                ? "Approve epic"
                : "Approve coding",
            () => {
              s.confirmApproval = item.id;
              paintReview(s);
              root.querySelector("[data-confirm-approval]")?.focus();
            },
            true,
          );
          approve.disabled = Boolean(s.approving) || isLocked();
          if (s.confirmApproval !== item.id) card.append(approve);
          else {
            const confirm = el("div", "approval-confirm");
            confirm.append(
              el(
                "p",
                "",
                item.kind === "epic"
                  ? `Approve ${item.identifier} as this PM’s bounded epic? The PM can create and approve child tickets within this outcome. You review the final promotion batch; changes to the epic’s scope require approval again.`
                  : `Approve this bounded scope for coding (${item.identifier})? The server will re-check this exact proposal and its project.`,
              ),
            );
            const actions = el("div", "button-row"),
              commit = btn(
                s.approving ? "Approving…" : `Approve ${item.identifier}`,
                async () => {
                  if (s.approving || isLocked()) return;
                  s.approving = item.id;
                  s.notice = "";
                  paintReview(s);
                  try {
                    const result = await api(
                      `/api/projects/${encodeURIComponent(s.name)}/review/${encodeURIComponent(item.id)}/approve`,
                      { revision: item.revision },
                    );
                    s.notice =
                      result.message ||
                      `${item.identifier} approved for coding.`;
                    s.confirmApproval = "";
                    await refreshReview(s, true);
                    await refresh(s.name, true);
                  } catch (error) {
                    s.reviewError = `Approval was not completed. ${error.message}`;
                  } finally {
                    s.approving = "";
                    paintReview(s);
                  }
                },
                true,
              );
            commit.dataset.confirmApproval = item.id;
            commit.disabled = Boolean(s.approving) || isLocked();
            const cancel = btn("Keep in review", () => {
              s.confirmApproval = "";
              paintReview(s);
            });
            cancel.disabled = Boolean(s.approving);
            actions.append(commit, cancel);
            confirm.append(actions);
            card.append(confirm);
          }
        }
        root.append(card);
      }
    }
    function overviewView(s) {
      const result = el("div", "project-command-center");
      const project = getProject(s.name),
        areas = project?.areas || [];
      const known = s.data?.knowledge?.areas || [];
      const discovered = known.filter(
        (area) => ["ready", "refreshing"].includes(area.state) && area.summary,
      ).length;
      const first =
        areas.find(
          (area) =>
            !known.some(
              (item) => item.key === area.key && item.state === "ready",
            ),
        ) || areas[0];
      const discovery = project?.readiness?.areas?.find(
        (area) => area.key === first?.key,
      )?.discovery;
      const blocker = discovery?.blockers?.[0];
      const banner = el("section", "project-next-step");
      const copy = el("div");
      let title = "Let your crew learn the product",
        detail =
          "Start with discovery: a grounded product map, feature inventory, and ranked opportunities. It does not create coding tickets or turn automation on.";
      let action;
      if (!areas.length) {
        title = "Give your first PM a purpose";
        detail =
          "Write a brief, set the boundaries, and let discovery map the product before you enable recurring work.";
        action = btn("Create your first PM", () => onCreatePm(s.name), true);
      } else if (blocker && !discovered) {
        title = "One step closer to discovery";
        detail = blocker.message;
        action = btn("Finish setup", () => {}, true);
        action.dataset.setupAction = blocker.action;
        action.dataset.setupProject = s.name;
        action.dataset.setupStep = blocker.id;
        action.dataset.setupArea = first.key;
      } else if (!discovered && first) {
        if (known.some((area) => area.state === "refreshing")) {
          title = "Your crew is learning the product";
          detail =
            "Discovery is in progress. Follow the visible actions now, then review the product map and setup suggestions when it finishes.";
          action = anchor(
            "Follow discovery →",
            `${route(s.name)}?pm=${encodeURIComponent(first.key)}&tab=discovery`,
            "button button-dark",
          );
        } else
          action = btn(
            "Run first discovery",
            () => onDiscover(s.name, first.key),
            true,
          );
      } else if (s.data?.inbox?.length) {
        title = `${s.data.inbox.length} ${s.data.inbox.length === 1 ? "item needs" : "items need"} your attention`;
        detail =
          "Review the evidence and decide what moves forward. Your crew keeps its approval boundaries.";
        action = anchor(
          "Open review inbox →",
          route(s.name, "review"),
          "button button-dark",
        );
      } else if (discovered) {
        title = "Your product context is taking shape";
        detail =
          "Review what your PMs learned, add a shared decision, or send a PM out for another investigation.";
        action = anchor(
          "Explore project knowledge →",
          route(s.name, "knowledge"),
          "button button-dark",
        );
      } else if (first)
        action = btn(
          "Run first discovery",
          () => onDiscover(s.name, first.key),
          true,
        );
      copy.append(
        el("span", "eyebrow", "YOUR NEXT STEP"),
        el("h2", "", title),
        el("p", "", detail),
      );
      if (action) {
        if (action.tagName === "BUTTON") action.disabled = isLocked();
        copy.append(action);
      }
      const art = el("img");
      art.src = "/assets/gremlin-security.webp";
      art.alt = "";
      art.width = 92;
      art.height = 112;
      banner.append(copy, art);
      const signals = el("div", "project-health-strip");
      for (const [value, label, tab] of [
        [s.data?.inbox?.length ?? "—", "To review", "review"],
        [
          `${discovered}/${areas.length}`,
          "PMs with product knowledge",
          "knowledge",
        ],
        [s.data?.budgets?.usage?.activeJobs ?? "—", "Jobs in flight", "limits"],
      ]) {
        const item = anchor("", route(s.name, tab), "project-health-item");
        item.append(el("strong", "", value), el("span", "", label));
        signals.append(item);
      }
      result.append(banner, signals);
      return result;
    }
    function knowledgeExcerpt(value) {
      const plain = String(value || "")
        .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, " ")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, "")
        .replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, "$1")
        .replace(/(\*\*|~~|`+)(.*?)\1/g, "$2")
        .replace(/(?<!\w)__([^_]+)__(?!\w)/g, "$1")
        .replace(/(?<!\w)([_*])([^_*]+)\1(?!\w)/g, "$2")
        .replace(/\s+/g, " ")
        .trim();
      if (plain.length <= 220) return plain;
      const excerpt = plain.slice(0, 219);
      const boundary = excerpt.lastIndexOf(" ");
      return `${(boundary > 0 ? excerpt.slice(0, boundary) : excerpt).trimEnd()}…`;
    }
    function knowledgeBody(s) {
      const map = el("section", "knowledge-team-map");
      map.append(
        heading(
          "One product. A shared understanding.",
          "Discoveries keep their PM and commit context. Your decisions give every PM a common direction.",
        ),
      );
      for (const area of s.data?.knowledge?.areas || []) {
        const card = el("article", "shared-knowledge-card");
        const head = el("div", "shared-knowledge-heading");
        head.append(
          el("h3", "", area.name || area.key),
          el(
            "span",
            `runtime-badge state-${area.state}`,
            area.state === "empty" ? "Discovery needed" : area.state,
          ),
        );
        card.append(
          head,
          el(
            "p",
            "",
            knowledgeExcerpt(area.summary) ||
              (area.summary
                ? "Open discovery for this PM’s saved findings."
                : "No saved discovery yet. A discovery run will map this PM’s area of the product."),
          ),
        );
        const actions = el("div", "project-pm-actions");
        actions.append(
          anchor(
            "Open discovery →",
            `${route(s.name)}?pm=${encodeURIComponent(area.key)}&tab=discovery`,
          ),
        );
        if (area.commitSha)
          actions.append(
            el(
              "small",
              "knowledge-commit",
              `Commit ${area.commitSha.slice(0, 8)}`,
            ),
          );
        card.append(actions);
        map.append(card);
      }
      if (!s.data?.knowledge?.areas?.length)
        map.append(
          empty(
            "Build your product map",
            "Create a PM and run discovery to start a durable record of the product.",
            btn("Create PM", () => onCreatePm(s.name)),
          ),
        );
      const overlaps = s.data?.knowledge?.overlaps || [];
      if (overlaps.length) {
        const section = el("section", "knowledge-overlaps");
        section.append(
          el("h3", "", "Shared ownership"),
          el(
            "p",
            "",
            "These paths belong to more than one PM. Keep shared decisions explicit.",
          ),
        );
        for (const overlap of overlaps) {
          const row = el("div");
          row.append(
            el("code", "", overlap.path),
            el("span", "", overlap.areas.join(" · ")),
          );
          section.append(row);
        }
        map.append(section);
      }
      return map;
    }
    function buildNotes(s) {
      const section = el("aside", "project-decisions");
      section.append(
        el("h3", "", "Shared decisions"),
        el(
          "p",
          "",
          "Owner guidance for this project. Add scope decisions, constraints, and lessons the whole crew should keep.",
        ),
      );
      const notes = el("div", "decision-list");
      const form = el("form", "decision-form");
      const label = el("label", "", "Add a project decision"),
        input = el("textarea");
      input.id = `decision-${s.name}`;
      label.htmlFor = input.id;
      input.rows = 4;
      input.maxLength = 4000;
      input.placeholder =
        "For example: guest checkout comes before customer accounts.";
      input.value = s.note;
      input.addEventListener("input", () => {
        s.note = input.value;
      });
      const status = message("");
      status.hidden = true;
      const save = el("button", "button button-dark", "Save decision");
      save.type = "submit";
      form.append(
        label,
        input,
        el(
          "small",
          "",
          "Saving a decision does not approve a ticket or start a run.",
        ),
        save,
        status,
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (s.busy || isLocked()) return;
        const text = input.value.trim();
        if (!text) {
          setMessage(status, "Write a decision first.", true);
          input.focus();
          return;
        }
        s.busy = true;
        save.disabled = true;
        save.textContent = "Saving…";
        setMessage(status, "");
        try {
          await api(`/api/projects/${encodeURIComponent(s.name)}/decisions`, {
            text,
            ...(s.data?.knowledge?.revision
              ? { revision: s.data.knowledge.revision }
              : {}),
          });
          s.note = "";
          input.value = "";
          await refresh(s.name, true);
          setMessage(status, "Decision saved for the project.");
        } catch (error) {
          setMessage(
            status,
            `${error.message} Your decision draft is kept.`,
            true,
          );
        } finally {
          s.busy = false;
          save.disabled = isLocked();
          save.textContent = "Save decision";
          s.views.get("knowledge")?.notes.update();
        }
      });
      section.append(notes, form);
      return {
        node: section,
        update() {
          notes.replaceChildren();
          for (const note of s.data?.knowledge?.decisions || []) {
            const card = el("article", "decision-note");
            card.append(
              el("p", "", note.text),
              el(
                "small",
                "",
                note.createdAt
                  ? new Date(note.createdAt).toLocaleString()
                  : "Saved decision",
              ),
            );
            const remove = btn("Delete decision", () => {
              if (s.busy || isLocked()) return;
              s.deletingDecision = {
                id: note.id,
                revision: s.data.knowledge.revision,
              };
              s.decisionError = "";
              s.views.get("knowledge")?.notes.update();
            });
            remove.disabled = s.busy || isLocked();
            card.append(remove);
            if (s.deletingDecision?.id === note.id) {
              const prompt = el("div", "approval-confirm");
              prompt.append(
                el(
                  "p",
                  "",
                  "Delete this shared decision? Future runs will no longer receive it. Existing run history is kept.",
                ),
              );
              const accept = btn("Delete this decision", async () => {
                if (s.busy || isLocked()) return;
                const selected = s.deletingDecision;
                s.busy = true;
                accept.disabled = true;
                try {
                  await api(
                    `/api/projects/${encodeURIComponent(s.name)}/decisions/${encodeURIComponent(selected.id)}`,
                    { revision: selected.revision },
                    "DELETE",
                  );
                  s.deletingDecision = null;
                  s.decisionError = "";
                  await refresh(s.name, true);
                  setMessage(
                    status,
                    "Shared decision deleted. Existing run history is kept.",
                  );
                } catch (error) {
                  s.decisionError = `${error.message} Refresh the project and review the decision again before retrying.`;
                } finally {
                  s.busy = false;
                  s.views.get("knowledge")?.notes.update();
                }
              });
              const keep = btn("Keep decision", () => {
                s.deletingDecision = null;
                s.decisionError = "";
                s.views.get("knowledge")?.notes.update();
              });
              accept.disabled = keep.disabled = s.busy || isLocked();
              prompt.append(accept, keep);
              if (s.decisionError)
                prompt.append(message(s.decisionError, true));
              card.append(prompt);
            }
            notes.append(card);
          }
          if (!notes.children.length)
            notes.append(
              el("p", "runner-guidance", "No shared decisions yet."),
            );
          save.disabled = s.busy || isLocked();
        },
      };
    }
    function deliveryView(s) {
      const root = el("div", "project-delivery"),
        delivery = s.data?.delivery;
      const promotion = delivery?.mode === "promotion";
      root.append(
        heading(
          promotion
            ? "Your crew builds. Your PM tests."
            : "From ticket to pull request",
          promotion
            ? "Your crew handles internal PRs, integration checks and PM QA. You review the promotion batch. A ticket is Done only after its production merge is confirmed."
            : "Follow the work, inspect the checks, and review the draft pull request before merging.",
        ),
      );
      const steps = promotion
        ? [
            [
              "Build",
              delivery.branches?.integration || "pm-staging",
              "Checked code deploys for PM QA",
            ],
            [
              "Promote",
              delivery.branches?.staging || "staging",
              "PM-tested changes get a promotion PR",
            ],
            [
              "Release",
              delivery.branches?.production || "production",
              "Production merge confirms Done",
            ],
          ]
        : [
            ["Build", "Working branch", "Approved coding work"],
            ["Review", "Draft PR / MR", "Checks and human review"],
            [
              "Merge",
              delivery?.branches?.base || "main",
              "Release policy belongs to this repository",
            ],
          ];
      const pipeline = el("ol", "delivery-pipeline");
      steps.forEach(([title, branch, detail], index) => {
        const step = el("li");
        step.append(
          el("span", "delivery-step-number", index + 1),
          el("span", "eyebrow muted", title),
          el("strong", "", branch),
          el("p", "", detail),
        );
        pipeline.append(step);
      });
      root.append(pipeline);
      if (!promotion)
        root.append(
          message(
            "This project uses pull requests. Staged promotion is an explicit project workflow; a draft PR is not a production release.",
          ),
        );
      const items = delivery?.items || [];
      if (!items.length)
        root.append(
          empty(
            promotion
              ? "No change in delivery yet"
              : "No delivery awaiting review",
            "Approved work will appear here as its implementation and verification evidence becomes available.",
          ),
        );
      else
        for (const item of items) {
          const card = el("article", "delivery-item");
          card.append(
            el(
              "span",
              `review-kind delivery-${item.status}`,
              (item.integrationRepair
                ? {
                    queued: "Integration repair queued",
                    running: "Coder repairing integration",
                    stopped: "Integration repair stopped",
                    replaced: "Replacement draft registered",
                  }[item.integrationRepair.phase]
                : null) ||
                (item.status === "failed" && item.rework
                  ? {
                      queued: "Coding follow-up queued",
                      running: "Coder addressing PM feedback",
                      "awaiting-review": "Fix awaiting fresh PM QA",
                      stopped: "Coding follow-up stopped",
                    }[item.rework.phase]
                  : null) ||
                {
                  "awaiting-merge": "Integration checks",
                  "awaiting-deployment": "Waiting for deployment",
                  "awaiting-review": "PM QA pending",
                  verified: "PM QA passed",
                  failed: "PM QA failed · follow-up needed",
                  blocked: "Needs attention",
                  promoted: "Promotion PR published",
                  released: "Production merged",
                }[item.status] ||
                item.stage ||
                item.status ||
                "Delivery",
            ),
            el("h3", "", item.title || item.ticket?.title || "Delivery item"),
          );
          if (item.detail || item.message)
            card.append(el("p", "", item.detail || item.message));
          if (item.rework?.message)
            card.append(el("p", "runner-guidance", item.rework.message));
          if (item.integrationRepair?.message)
            card.append(
              el("p", "runner-guidance", item.integrationRepair.message),
            );
          if (item.ticket?.identifier)
            card.append(
              el(
                "p",
                "delivery-ticket",
                `${item.ticket.identifier}${item.area ? ` · ${item.area}` : ""}`,
              ),
            );
          const links = el("div", "project-pm-actions");
          for (const [label, url] of [
            [
              promotion ? "Crew-managed PR ↗" : "Implementation PR ↗",
              item.implementation?.url,
            ],
            ["Review promotion PR ↗", item.promotion?.url],
            ["Tested deployment ↗", item.review?.deployment?.url],
          ]) {
            const href = url && safeHref(url);
            if (!href) continue;
            const a = anchor(label, href);
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            links.append(a);
          }
          if (item.review?.jobId)
            links.append(
              anchor(
                "PM test activity →",
                `/activity?run=${encodeURIComponent(item.review.jobId)}`,
              ),
            );
          if (item.rework?.jobId)
            links.append(
              anchor(
                "Coding follow-up →",
                `/activity?run=${encodeURIComponent(item.rework.jobId)}`,
              ),
            );
          if (item.integrationRepair?.jobId)
            links.append(
              anchor(
                "Integration repair activity →",
                `/activity?run=${encodeURIComponent(item.integrationRepair.jobId)}`,
              ),
            );
          card.append(links);
          if (item.review) {
            const evidence = el("details", "delivery-evidence");
            evidence.append(el("summary", "", "Verification evidence"));
            for (const [label, value] of [
              ["Tested commit", item.review.testedSha],
              ["Deployment commit", item.review.deployment?.sha],
              ["Test branch", item.review.deployment?.branch],
              ["Verified at", item.review.at],
            ])
              if (value) {
                const row = el("dl", "project-fact");
                row.append(el("dt", "", label), el("dd", "", value));
                evidence.append(row);
              }
            for (const artifact of item.review.artifacts || [])
              evidence.append(
                el(
                  "p",
                  "runner-guidance",
                  `${artifact.name}${artifact.sha256 ? ` · SHA256 ${artifact.sha256.slice(0, 12)}…` : ""}`,
                ),
              );
            card.append(evidence);
          }
          if (item.status === "promoted")
            card.append(
              el(
                "p",
                "runner-guidance",
                "Promoted changes still need staging review and the production merge. This ticket is not Done yet.",
              ),
            );
          root.append(card);
        }
      return root;
    }
    function buildLimits(s) {
      const root = el("div", "project-limits");
      root.append(
        heading(
          "Keep the crew within bounds",
          "Set time and capacity ceilings for this project. These are execution limits, not a currency spending estimate.",
        ),
      );
      const usage = el("div", "limits-usage"),
        form = el("form", "limits-form"),
        fields = new Map();
      const status = message("");
      status.hidden = true;
      for (const [key, label, help] of limitFields) {
        const field = el("div", "field"),
          input = el("input"),
          title = el("label", "", label);
        input.type = "number";
        input.min = "1";
        input.max = String(
          {
            maxConcurrentJobs: 4,
            maxDailyRuns: 1000,
            maxDailyRuntimeMinutes: 10080,
            maxJobMinutes: 45,
          }[key],
        );
        input.step = "1";
        input.placeholder = "No project limit";
        input.id = `limit-${s.name}-${key}`;
        title.htmlFor = input.id;
        input.addEventListener("input", () => {
          s.limitDraft = read();
        });
        fields.set(key, input);
        field.append(title, input, el("p", "", help));
        form.append(field);
      }
      function read() {
        const data = {};
        for (const [key, input] of fields)
          if (input.value.trim()) data[key] = Number(input.value);
        return data;
      }
      const actions = el("div", "button-row"),
        save = el("button", "button button-dark", "Save run limits");
      save.type = "submit";
      const reset = btn("Reset edits", () => {
        s.limitDraft = null;
        update();
        setMessage(status, "");
      });
      actions.append(save, reset);
      form.append(actions, status);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (s.busy || isLocked() || !form.reportValidity()) return;
        s.busy = true;
        save.disabled = true;
        save.textContent = "Saving…";
        setMessage(status, "");
        try {
          await api(`/api/projects/${encodeURIComponent(s.name)}/execution`, {
            limits: read(),
            revision: s.limitRevision,
          });
          s.limitDraft = null;
          await refresh(s.name, true);
          await onChanged?.();
          setMessage(
            status,
            "Run limits saved. The controller enforces them for this project.",
          );
        } catch (error) {
          setMessage(status, `${error.message} Your edits are kept.`, true);
        } finally {
          s.busy = false;
          save.textContent = "Save run limits";
          update();
        }
      });
      const cost = el("p", "limits-cost-note");
      root.append(usage, form, cost);
      function update() {
        const value = s.data?.budgets?.usage || {};
        usage.replaceChildren();
        for (const [number, label] of [
          [value.runsToday, "Runs today"],
          [value.runtimeMinutesToday, "Agent runtime minutes today"],
          [value.activeJobs, "Active jobs"],
        ]) {
          const metric = el("div");
          metric.append(el("strong", "", number ?? "—"), el("span", "", label));
          usage.append(metric);
        }
        const limits = s.data?.budgets?.limits || {};
        if (s.limitDraft === null) {
          for (const [key, input] of fields) input.value = limits[key] ?? "";
          s.limitBase = JSON.stringify(limits);
          s.limitRevision = s.data?.budgets?.revision;
        }
        save.disabled = isLocked() || s.busy || !s.data;
        reset.disabled = s.busy;
        cost.textContent =
          s.data?.budgets?.cost?.reason ||
          "Token and currency cost reporting is not available. Check your model provider for billing.";
      }
      return { node: root, update };
    }
    function view(s, tab) {
      if (!s.views.has(tab)) {
        const root = el("div", `operations-view operations-${tab}`),
          alert = message(""),
          content = el("div");
        alert.hidden = true;
        root.append(alert, content);
        const value = {
          node: root,
          alert,
          content,
          notes: null,
          limits: null,
          signature: "",
        };
        if (tab === "review") {
          value.reviewSummary = el("div");
          value.proposals = el("section", "project-proposals");
          const nav = el("nav", "surface-tabs review-navigation");
          nav.setAttribute("aria-label", "Review sections");
          const choose = (section) => {
            value.reviewSummary.hidden = section !== "attention";
            value.proposals.hidden = section !== "proposals";
            for (const button of nav.children)
              button.setAttribute(
                "aria-current",
                button.dataset.section === section ? "page" : "false",
              );
          };
          for (const [section, label] of [
            ["proposals", "Product proposals"],
            ["attention", "Needs attention"],
          ]) {
            const button = btn(label, () => choose(section));
            button.dataset.section = section;
            nav.append(button);
          }
          choose(
            getProject(s.name)?.foundation?.needed ? "attention" : "proposals",
          );
          content.append(nav, value.proposals, value.reviewSummary);
        }
        if (tab === "delivery") {
          value.deliverySummary = el("section");
          value.deliverySummary.id = `delivery-work-${s.name}`;
          value.deliveryHost = el("section");
          value.deliveryHost.id = `delivery-controls-${s.name}`;
          value.deliverySection = "work";
          value.deliveryNav = el("nav", "surface-tabs delivery-navigation");
          value.deliveryNav.setAttribute("aria-label", "Delivery sections");
          value.chooseDelivery = (section) => {
            const promotion = s.data?.delivery?.mode === "promotion";
            value.deliverySection = promotion ? section : "work";
            value.deliveryNav.hidden = !promotion;
            value.deliverySummary.hidden = value.deliverySection !== "work";
            value.deliveryHost.hidden =
              !promotion || value.deliverySection !== "controls";
            for (const button of value.deliveryNav.children)
              button.setAttribute(
                "aria-current",
                button.dataset.section === value.deliverySection
                  ? "page"
                  : "false",
              );
          };
          for (const [section, label, panel] of [
            ["work", "Work & evidence", value.deliverySummary],
            ["controls", "Promotion controls", value.deliveryHost],
          ]) {
            const button = btn(label, () => value.chooseDelivery(section));
            button.dataset.section = section;
            button.setAttribute("aria-controls", panel.id);
            value.deliveryNav.append(button);
          }
          value.chooseDelivery("work");
          content.append(
            value.deliveryNav,
            value.deliverySummary,
            value.deliveryHost,
          );
        }
        if (tab === "knowledge") {
          value.notes = buildNotes(s);
          value.knowledgeMap = el("div");
          const grid = el("div", "project-knowledge-grid");
          grid.append(value.knowledgeMap, value.notes.node);
          content.append(grid);
        }
        if (tab === "limits") {
          value.limits = buildLimits(s);
          content.append(value.limits.node);
        }
        s.views.set(tab, value);
      }
      return s.views.get(tab);
    }
    function paint(s) {
      for (const [tab, v] of s.views) {
        setMessage(
          v.alert,
          s.error || (s.data ? "" : "Loading project operations…"),
          Boolean(s.error),
        );
        if (!s.data) continue;
        const signature = JSON.stringify([
          s.data,
          getProject(s.name)?.readiness,
          isLocked(),
        ]);
        if (v.signature === signature) continue;
        v.signature = signature;
        if (tab === "limits") {
          v.limits.update();
          continue;
        }
        if (tab === "review") {
          v.reviewSummary.replaceChildren(reviewView(s));
          paintReview(s);
          continue;
        }
        if (tab === "delivery") {
          v.deliverySummary.replaceChildren(deliveryView(s));
          if (s.data?.delivery?.mode === "promotion" && !v.deliveryMounted) {
            deliveryWorkflow?.mount(v.deliveryHost, getProject(s.name));
            v.deliveryMounted = true;
          }
          v.chooseDelivery(v.deliverySection);
          continue;
        }
        if (tab === "knowledge") {
          v.knowledgeMap.replaceChildren(knowledgeBody(s));
          v.notes.update();
        } else
          v.content.replaceChildren(
            tab === "overview"
              ? overviewView(s)
              : tab === "review"
                ? reviewView(s)
                : deliveryView(s),
          );
      }
    }
    async function refresh(name, force = false) {
      const s = state(name);
      if (s.request) {
        await s.request;
        if (force) return refresh(name, true);
        return;
      }
      if (!force && Date.now() - s.loadedAt < 12000) return;
      s.request = (async () => {
        try {
          s.data = await api(
            `/api/projects/${encodeURIComponent(name)}/operations`,
          );
          s.error = "";
          s.loadedAt = Date.now();
        } catch (error) {
          s.error = `Project operations could not refresh. ${error.message}`;
        } finally {
          s.request = null;
          paint(s);
        }
      })();
      return s.request;
    }
    function paintInbox() {
      if (!inbox) return;
      const signature = JSON.stringify([
        globalProjects,
        globalError,
        globalBusy,
        filter,
        globalProjects.map((project) => [
          getProject(project.project)?.foundation,
          getCodingAction?.(project.project),
        ]),
        getJobs?.(),
      ]);
      if (signature === inboxSignature) return;
      inboxSignature = signature;
      const items = globalProjects.flatMap((project) =>
        (project.inbox || []).map((item) => ({
          item,
          project: project.project,
        })),
      );
      const count = document.getElementById("inbox-count");
      if (count) count.textContent = String(items.length);
      const overview = document.getElementById("workspace-projects-list");
      if (overview) {
        overview.replaceChildren();
        for (const project of globalProjects) {
          const card = el("article", "workspace-project-summary"),
            identity = el("div"),
            status = getProject(project.project),
            pmCount =
              status?.areas?.length ?? project.knowledge?.areas?.length ?? 0;
          identity.append(
            anchor(
              project.project,
              route(project.project),
              "workspace-project-name",
            ),
            el(
              "p",
              "",
              getProject(project.project)?.repo || "Project repository",
            ),
          );
          const detail = el("div", "workspace-project-signals");
          detail.append(
            el(
              "span",
              project.inbox?.length ? "has-reviews" : "",
              `${project.inbox?.length || 0} to review`,
            ),
            el("span", "", `${pmCount} ${pmCount === 1 ? "PM" : "PMs"}`),
            anchor("Open project →", route(project.project)),
          );
          card.append(identity, detail);
          if (status && (status.foundation?.needed || status.areas?.length))
            card.append(
              status.foundation?.needed
                ? window.renderFoundationLauncher(status)
                : window.renderCodingLauncher(status, {
                    locked: isLocked(),
                    compact: true,
                    jobs: getJobs?.() || [],
                    operation: getCodingAction?.(project.project),
                  }),
            );
          overview.append(card);
        }
        if (!globalProjects.length)
          overview.append(
            empty(
              !globalLoadedAt
                ? "Loading your projects…"
                : "Start with one product",
              !globalLoadedAt
                ? "Checking the workspace and current work."
                : "Bring an idea or connect an existing app. We’ll help you build the foundation and grow your crew.",
              anchor("Add a project", "/projects#project-form"),
            ),
          );
      }
      inbox.replaceChildren();
      const toolbar = el("div", "inbox-toolbar"),
        label = el("label", "", "Project"),
        select = el("select");
      select.id = "inbox-project-filter";
      label.htmlFor = select.id;
      select.append(el("option", "", "All projects"));
      select.firstElementChild.value = "";
      for (const project of globalProjects) {
        const option = el("option", "", project.project);
        option.value = project.project;
        select.append(option);
      }
      select.value = filter;
      select.addEventListener("change", () => {
        filter = select.value;
        paintInbox();
        document.getElementById("inbox-project-filter")?.focus();
      });
      toolbar.append(
        label,
        select,
        el(
          "span",
          "",
          `${items.length} ${items.length === 1 ? "item" : "items"} to review`,
        ),
      );
      inbox.append(toolbar);
      if (globalError) inbox.append(message(globalError, true));
      const visible = items.filter(
        (entry) => !filter || entry.project === filter,
      );
      if (!visible.length)
        inbox.append(
          empty(
            globalBusy
              ? "Checking for decisions…"
              : "Your review queue is clear",
            "Setup blockers, delivery reviews, and product decisions will appear here. Your crew never treats silence as approval.",
          ),
        );
      else {
        const list = el("div", "review-items");
        for (const entry of visible)
          list.append(itemCard(entry.item, entry.project));
        inbox.append(list);
      }
    }
    async function refreshInbox() {
      if (globalBusy || isLocked()) return;
      globalBusy = true;
      try {
        const data = await api("/api/operations");
        globalProjects = Array.isArray(data.projects) ? data.projects : [];
        globalError = "";
        globalLoadedAt = Date.now();
      } catch (error) {
        globalError = `The review inbox could not refresh. ${error.message}`;
      } finally {
        globalBusy = false;
        paintInbox();
      }
    }
    function schedule() {
      clearTimeout(timer);
      for (const s of states.values()) paint(s);
      deliveryWorkflow?.resume();
      if (document.hidden || isLocked()) return;
      if (pages.current === "project" && pages.tab === "review" && !pages.pm) {
        const current = state(pages.project);
        if (current.review === null && !current.reviewError)
          refreshReview(current);
      }
      if (pages.current === "inbox") refreshInbox();
      else if (
        !globalLoadedAt ||
        (pages.current === "overview" && Date.now() - globalLoadedAt > 15000)
      )
        refreshInbox();
      else if (pages.current === "project" && pages.project)
        refresh(pages.project);
      timer = setTimeout(schedule, 15000);
    }
    window.addEventListener("dashboard:pagechange", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => clearTimeout(timer));
    document
      .getElementById("refresh-inbox")
      ?.addEventListener("click", refreshInbox);
    return {
      mount(root, project, tab) {
        const s = state(project.name),
          v = view(s, tab);
        root.append(v.node);
        paint(s);
        refresh(project.name);
        if (tab === "review") refreshReview(s);
      },
      refresh,
      refreshInbox,
      renderOverview: paintInbox,
      forget(name) {
        states.delete(name);
        deliveryWorkflow?.forget(name);
        globalProjects = globalProjects.filter(
          (project) => project.project !== name,
        );
        globalLoadedAt = 0;
        clearTimeout(timer);
        paintInbox();
      },
      protectFocus: (root) =>
        Boolean(
          root.contains(document.activeElement) &&
          document.activeElement?.closest?.(".operations-view"),
        ),
      resume: schedule,
      isDirty: () =>
        Boolean(deliveryWorkflow?.isDirty()) ||
        [...states.values()].some(
          (s) =>
            Boolean(s.note.trim()) ||
            (s.limitDraft !== null &&
              JSON.stringify(s.limitDraft) !== s.limitBase),
        ),
      isBusy: () =>
        Boolean(deliveryWorkflow?.isBusy()) ||
        [...states.values()].some((s) => s.busy || s.approving),
    };
  };
})();
