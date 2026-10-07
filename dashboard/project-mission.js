"use strict";
(() => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const el = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (text, fn, primary = false) => {
    const value = el(
      "button",
      text,
      primary ? "button button-dark" : "small-button",
    );
    value.type = "button";
    value.addEventListener("click", fn);
    return value;
  };
  const safeLink = (text, href, primary = false) => {
    if (typeof href !== "string" || !href.trim()) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /token|secret|password|credential/i.test(key),
        )
      )
        return null;
      const link = el(
        "a",
        text,
        primary ? "button button-dark" : "small-button",
      );
      link.href = url.href;
      if (url.origin !== window.location.origin) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      return link;
    } catch {
      return null;
    }
  };
  const path = (project) =>
    `/api/projects/${encodeURIComponent(project)}/missions`;
  const requestId = () => {
    if (window.crypto.randomUUID) return window.crypto.randomUUID();
    // randomUUID is unavailable on HTTP LAN origins; getRandomValues still is.
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const projectPath = (project) => `/projects/${encodeURIComponent(project)}`;
  const active = (mission) =>
    ["investigating", "building", "following-up"].includes(mission?.status);
  const labels = {
    investigating: "Investigating your outcome",
    "needs-review": "Your decision is next",
    building: "Building the approved change",
    "review-changes": "Changes ready for your review",
    "following-up": "Checking the experience",
    blocked: "This mission needs your help",
    paused: "Mission paused",
  };
  const promotionWorkflow = (s) =>
    (s.data?.workflow || s.project.workflow)?.kind === "promotion";
  const promotionStage = (change) => {
    const delivery = change.delivery;
    if (delivery?.integrationRepair) {
      if (delivery.integrationRepair.phase === "queued")
        return "integration-repair-queued";
      if (delivery.integrationRepair.phase === "running")
        return "integration-repair-running";
      if (delivery.integrationRepair.phase === "stopped")
        return "integration-repair-stopped";
      if (delivery.integrationRepair.phase === "replaced")
        return "integration-repair-replaced";
    }
    if (!delivery && change.migration?.phase === "blocked") return "blocked";
    if (!delivery && ["waiting", "busy"].includes(change.migration?.phase))
      return "migration-waiting";
    if (delivery?.status === "blocked") return "blocked";
    if (delivery?.status === "failed" && delivery.rework?.phase === "stopped")
      return "rework-stopped";
    if (delivery?.status === "failed" && delivery.rework?.phase === "queued")
      return "rework-queued";
    if (delivery?.status === "failed" && delivery.rework?.phase === "running")
      return "rework";
    if (
      delivery?.status === "failed" &&
      delivery.rework?.phase === "awaiting-review"
    )
      return "rework-review";
    if (delivery?.status === "failed") return "failed";
    if (delivery?.status === "promoted") return "promotion";
    if (["released", "done"].includes(delivery?.status)) return "released";
    if (delivery?.status === "verified") return "verified";
    if (delivery?.status === "awaiting-review") return "qa";
    if (delivery?.status === "awaiting-deployment") return "deployment";
    if (delivery?.status === "awaiting-merge") return "checks";
    if (["failed", "canceled"].includes(change.status)) return "blocked";
    if (["queued", "running"].includes(change.status)) return "building";
    if (change.noChanges) return "unchanged";
    return "unconfirmed";
  };
  window.createProjectMissions = ({ api, pages, onJob, onSaved, isLocked }) => {
    const states = new Map();
    let timer;
    const keyFor = (project) =>
      `${project.name}/${project.instanceId || "legacy"}`;
    function state(project) {
      const key = keyFor(project);
      if (!states.has(key))
        states.set(key, {
          key,
          project,
          root: el("section", undefined, "project-missions"),
          data: null,
          detail: null,
          selected: "",
          draft: "",
          area: "",
          busy: false,
          fetching: false,
          error: "",
          notice: "",
          loadedAt: 0,
          request: 0,
          proposal: "",
          review: false,
          newMission: false,
        });
      const s = states.get(key);
      s.project = project;
      return s;
    }
    function visible(s) {
      return (
        pages.current === "project" &&
        pages.project === s.project.name &&
        !pages.pm &&
        ["brief", "overview", "changes"].includes(pages.tab) &&
        !document.hidden
      );
    }
    function focused(s) {
      return Boolean(
        s.root.contains(document.activeElement) &&
        ["TEXTAREA", "INPUT", "SELECT"].includes(
          document.activeElement?.tagName,
        ),
      );
    }
    function schedule() {
      clearTimeout(timer);
      const s = [...states.values()].find(visible);
      if (s && !isLocked())
        timer = setTimeout(() => {
          void refresh(s, true);
        }, 10000);
    }
    async function refresh(s, force = false) {
      if (
        s.fetching ||
        s.busy ||
        isLocked() ||
        (!force && Date.now() - s.loadedAt < 10000)
      )
        return;
      const request = ++s.request;
      s.fetching = true;
      try {
        const data = await api(path(s.project.name), undefined, "GET", 30000);
        if (states.get(s.key) !== s || request !== s.request) return;
        s.data = data;
        if (!list(data.missions).some((item) => item.id === s.selected)) {
          s.selected = list(data.missions)[0]?.id || "";
          s.detail = null;
          s.proposal = "";
          s.review = false;
        }
        if (s.selected) {
          const detail = await api(
            `${path(s.project.name)}/${encodeURIComponent(s.selected)}`,
            undefined,
            "GET",
            30000,
          );
          if (states.get(s.key) !== s || request !== s.request) return;
          // Approval is bound to exactly the revision the owner reviewed.
          if (
            s.review &&
            (s.detail?.mission?.revision !== detail.mission?.revision ||
              list(s.detail?.candidates).find((item) => item.id === s.proposal)
                ?.revision !==
                list(detail.candidates).find((item) => item.id === s.proposal)
                  ?.revision)
          ) {
            s.review = false;
            s.proposal = "";
            s.notice =
              "This mission changed. Review the current proposal before approving.";
          }
          s.detail = detail;
        }
        s.error = "";
        s.loadedAt = Date.now();
      } catch (error) {
        if (states.get(s.key) === s && request === s.request)
          s.error = error.message;
      } finally {
        if (states.get(s.key) === s && request === s.request) {
          s.fetching = false;
          if (!focused(s)) paint(s);
          schedule();
        }
      }
    }
    async function mutate(s, suffix, body) {
      if (s.busy || isLocked()) return;
      // A read begun before an explicit action must never overwrite its result.
      s.request++;
      s.fetching = false;
      if (!suffix) {
        if (!s.clientRequestId || s.requestOutcome !== body.outcome) {
          s.clientRequestId = requestId();
          s.requestOutcome = body.outcome;
        }
        body = { ...body, clientRequestId: s.clientRequestId };
      }
      s.busy = true;
      s.error = "";
      s.notice = "";
      paint(s);
      let accepted = false;
      try {
        const result = await api(
          `${path(s.project.name)}${suffix}`,
          body,
          "POST",
          90000,
        );
        if (states.get(s.key) !== s) return;
        accepted = true;
        if (result.mission) {
          s.selected = result.mission.id;
          s.detail = { ...s.detail, mission: result.mission };
          s.data = {
            ...s.data,
            missions: [
              result.mission,
              ...list(s.data?.missions).filter(
                (item) => item.id !== result.mission.id,
              ),
            ],
          };
        }
        if (result.job) onJob?.(result.job);
        s.review = false;
        s.newMission = false;
        if (!suffix) s.draft = "";
        s.notice =
          "Saved. The mission below reflects the work accepted by your server.";
        await onSaved?.();
      } catch (error) {
        if (states.get(s.key) === s)
          s.error = accepted
            ? "Your action was saved, but the dashboard could not refresh. Check the mission before starting anything again."
            : error.message;
      } finally {
        if (states.get(s.key) === s) {
          s.busy = false;
          paint(s);
          if (!s.error) await refresh(s, true);
        }
      }
    }
    function heading(eyebrow, title, detail) {
      const root = el("div", undefined, "mission-heading");
      root.append(el("span", eyebrow, "eyebrow muted"), el("h2", title));
      if (detail) root.append(el("p", detail));
      return root;
    }
    function renderPromotionChanges(s, changes) {
      const stageLabels = {
        blocked: "Blocked",
        failed: "PM QA failed",
        "rework-stopped": "Follow-up stopped",
        rework: "Coder fixing QA feedback",
        "rework-queued": "Coding follow-up queued",
        "rework-review": "Fix moving through delivery",
        building: "Coding",
        checks: "Integration checks",
        deployment: "Waiting for deployment",
        qa: "PM QA pending",
        verified: "PM QA passed",
        promotion: "Included in promotion",
        "batch-stale": "Batch inclusion needs refresh",
        "batch-unknown": "Batch inclusion unconfirmed",
        "earlier-promotion": "Earlier promotion",
        "migration-waiting": "Preparing existing draft",
        "integration-repair-queued": "Integration repair queued",
        "integration-repair-running": "Coder repairing integration",
        "integration-repair-stopped": "Integration repair stopped",
        "integration-repair-replaced": "Replacement draft registered",
        released: "Released",
        unconfirmed: "Awaiting delivery admission",
        unchanged: "No code change",
      };
      const recordedUrls = [
        ...new Set(
          changes
            .map((change) => change.delivery?.promotion?.url)
            .filter(Boolean),
        ),
      ];
      const batch =
        s.data?.promotionBatch ||
        (recordedUrls.length === 1
          ? { url: recordedUrls[0], state: "unknown" }
          : null);
      const stageFor = (change) => {
        const stage = promotionStage(change);
        if (stage !== "promotion") return stage;
        const recorded = change.delivery.promotion;
        if (!batch || batch.state === "unknown") return "batch-unknown";
        if (
          batch.state !== "open" ||
          recorded?.url !== batch.url ||
          recorded?.number !== batch.number
        )
          return "earlier-promotion";
        return recorded.headSha &&
          batch.headSha &&
          recorded.headSha === batch.headSha
          ? "promotion"
          : "batch-stale";
      };
      const passing = changes.filter((change) =>
        ["verified", "promotion"].includes(stageFor(change)),
      );
      const earlier = changes.filter(
        (change) => stageFor(change) === "earlier-promotion",
      );
      const working = changes.filter(
        (change) =>
          !["verified", "promotion", "earlier-promotion", "released"].includes(
            stageFor(change),
          ),
      );
      const attention = (change) =>
        [
          "blocked",
          "failed",
          "rework-stopped",
          "integration-repair-stopped",
          "unchanged",
        ].includes(stageFor(change));
      const needsAttention = working.filter(attention);
      const batchCard = el("section", undefined, "promotion-batch");
      const batchHeader = el("header", undefined, "promotion-batch-header");
      const titles = el("div");
      titles.append(
        el("span", "NEXT STAGING RELEASE", "eyebrow muted"),
        el("h2", "Your promotion batch"),
      );
      const batchLink =
        batch &&
        safeLink(
          batch.state === "open"
            ? "Review promotion batch"
            : "Open recorded batch",
          batch.url,
          batch.state === "open",
        );
      batchHeader.append(titles);
      if (batchLink) batchHeader.append(batchLink);
      batchCard.append(
        batchHeader,
        el(
          "p",
          "Your PMs test each ticket on the app. Passing work collects into one PR for you to review.",
          "promotion-batch-intro",
        ),
      );
      const totals = el("div", undefined, "promotion-batch-totals");
      for (const [count, label] of [
        [passing.length, "Passed PM QA"],
        [working.length - needsAttention.length, "With the crew"],
        [needsAttention.length, "Need attention"],
      ]) {
        const stat = el("div");
        stat.append(el("strong", count), el("span", label));
        totals.append(stat);
      }
      batchCard.append(totals);
      if (s.data?.promotionBatchError)
        batchCard.append(
          el("p", s.data.promotionBatchError, "promotion-batch-notice is-held"),
        );
      const operation = s.data?.deliveryOperation;
      const held =
        operation?.phase === "error" ||
        list(operation?.rows).some((row) => row.needsYou || row.pending);
      if (operation?.message && (held || operation.phase === "running")) {
        const notice = el(
          "p",
          operation.message,
          held ? "promotion-batch-notice is-held" : "promotion-batch-notice",
        );
        notice.setAttribute("role", held ? "alert" : "status");
        batchCard.append(notice);
      } else if (!batchLink) {
        batchCard.append(
          el(
            "p",
            passing.length
              ? "PM QA has passed. The controller is collecting and checking these changes for the promotion PR."
              : "The batch starts when the first ticket passes PM QA. Your crew keeps working while more tickets are added.",
            "promotion-batch-notice",
          ),
        );
      } else if (batch.state !== "open") {
        batchCard.append(
          el(
            "p",
            batch.state === "merged"
              ? "This recorded batch has merged. New passing work will form the next batch."
              : batch.state === "closed"
                ? "This recorded batch is closed. Delivery shows the next promotion or its blocker."
                : "The batch link is recorded; its current source-control state has not been confirmed.",
            "promotion-batch-notice",
          ),
        );
      }
      const sync = s.data?.stagingSync;
      if (
        sync?.message &&
        [
          "blocked",
          "repairing",
          "waiting-checks",
          "waiting-merge",
          "waiting-deployment",
        ].includes(sync.phase)
      ) {
        const notice = el(
          "p",
          sync.message,
          sync.phase === "blocked"
            ? "promotion-batch-notice is-held"
            : "promotion-batch-notice",
        );
        notice.setAttribute("role", "status");
        batchCard.append(notice);
      }
      function ticketRow(change, included) {
        const stage = stageFor(change),
          delivery = change.delivery;
        const row = el("li", undefined, "promotion-ticket");
        row.dataset.state = stage;
        const content = el("div", undefined, "promotion-ticket-content");
        const label = el("div", undefined, "promotion-ticket-title");
        const identifier = delivery?.ticket?.identifier || change.ticket;
        if (identifier)
          label.append(el("span", identifier, "promotion-ticket-id"));
        label.append(
          el(
            "strong",
            delivery?.ticket?.title ||
              change.pullRequests?.[0]?.title ||
              "Coding change",
          ),
        );
        const statusLabel =
          stage === "building" && change.status === "queued"
            ? "Coding queued"
            : stageLabels[stage];
        const badge = el(
          "span",
          statusLabel,
          `promotion-ticket-status${attention(change) ? " needs-attention" : included ? " passed" : ""}`,
        );
        content.append(label);
        const message =
          stage === "batch-stale"
            ? "The promotion PR changed. The controller must refresh this ticket’s inclusion evidence."
            : stage === "batch-unknown"
              ? "The recorded promotion could not be matched to a current batch revision."
              : delivery?.integrationRepair?.message ||
                delivery?.rework?.message ||
                delivery?.message ||
                change.migration?.message ||
                change.message;
        if (message && !["promotion", "earlier-promotion"].includes(stage))
          content.append(el("p", message));
        if (
          (delivery?.rework || delivery?.integrationRepair) &&
          delivery?.message &&
          delivery.message !== message
        )
          content.append(
            el("p", delivery.message, "promotion-ticket-evidence"),
          );
        if (
          ["checks", "unconfirmed"].includes(stage) &&
          change.checks?.headSha &&
          list(change.pullRequests).some(
            (pr) =>
              pr.currentHeadSha && pr.currentHeadSha !== change.checks.headSha,
          )
        )
          content.append(
            el(
              "p",
              "Recorded worker checks cover an earlier revision. Current integration checks and PM QA are tracked separately in Delivery.",
              "promotion-ticket-evidence",
            ),
          );
        const jobId =
          delivery?.integrationRepair?.jobId ||
          delivery?.rework?.jobId ||
          delivery?.review?.jobId ||
          change.jobId;
        const attempts = list(change.previousAttempts).length + 1;
        const activity = safeLink(
          attempts > 1 ? `Activity · ${attempts} attempts` : "Activity",
          jobId
            ? `/activity?run=${encodeURIComponent(jobId)}`
            : change.activityUrl,
        );
        const side = el("div", undefined, "promotion-ticket-meta");
        side.append(badge);
        if (activity) {
          activity.className = "promotion-ticket-activity";
          side.append(activity);
        }
        row.append(content, side);
        return row;
      }
      if (passing.length) {
        const tickets = el("ul", undefined, "promotion-ticket-list");
        for (const change of passing) tickets.append(ticketRow(change, true));
        batchCard.append(tickets);
      }
      s.root.append(batchCard);
      if (working.length) {
        const section = el("section", undefined, "promotion-work");
        const header = el("header", undefined, "promotion-work-header");
        header.append(
          el("h2", "Still with the crew"),
          el("span", `${working.length} tickets`, "promotion-work-count"),
        );
        section.append(header);
        const rows = el("ul", undefined, "promotion-ticket-list");
        for (const change of [
          ...needsAttention,
          ...working.filter((change) => !attention(change)),
        ])
          rows.append(ticketRow(change, false));
        section.append(rows);
        s.root.append(section);
      }
      if (earlier.length) {
        const section = el("section", undefined, "promotion-work");
        const header = el("header", undefined, "promotion-work-header");
        header.append(
          el("h2", "Earlier promotions"),
          el("span", `${earlier.length} tickets`, "promotion-work-count"),
        );
        const rows = el("ul", undefined, "promotion-ticket-list");
        for (const change of earlier) rows.append(ticketRow(change, false));
        section.append(header, rows);
        s.root.append(section);
      }
      const history = el("p", undefined, "promotion-history");
      history.append(
        el("span", "One current state per ticket. Earlier attempts stay in "),
      );
      const historyLink = safeLink("Activity history", "/activity");
      if (historyLink) {
        historyLink.className = "promotion-ticket-activity";
        history.append(historyLink);
      }
      s.root.append(history);
    }
    function renderChanges(s) {
      const changes = list(s.data?.changes);
      if (promotionWorkflow(s)) return renderPromotionChanges(s, changes);
      if (!changes.length) return;
      const pending = changes.filter(
        (change) => !["promoted", "done"].includes(change.delivery?.status),
      );
      const hasOpen = (change) =>
        list(change.pullRequests).some((pr) => pr.state === "open");
      const recorded = (change) =>
        change.status === "succeeded" &&
        !change.noChanges &&
        (!list(change.pullRequests).length ||
          list(change.pullRequests).some(
            (pr) => !pr.state || pr.state === "unknown",
          ));
      const buckets = [
        [
          "YOUR REVIEW",
          "Changes ready for review",
          pending.filter(
            (change) => change.status === "succeeded" && hasOpen(change),
          ),
        ],
        [
          "NEEDS ATTENTION",
          "Unblock your work",
          pending.filter((change) =>
            ["failed", "canceled"].includes(change.status),
          ),
        ],
        [
          "IN PROGRESS",
          "Your crew is working",
          pending.filter((change) =>
            ["queued", "running"].includes(change.status),
          ),
        ],
        [
          "RECORDED OUTPUT",
          "Check these recorded results",
          pending.filter((change) => recorded(change) && !hasOpen(change)),
        ],
        [
          "NO CHANGE PUBLISHED",
          "Investigations without a code change",
          pending.filter(
            (change) => change.status === "succeeded" && change.noChanges,
          ),
        ],
      ];
      if (s.view === "changes")
        buckets.push([
          "PREVIOUS WORK",
          "Merged or closed",
          changes.filter(
            (change) =>
              list(change.pullRequests).length &&
              list(change.pullRequests).every((pr) =>
                ["merged", "closed"].includes(pr.state),
              ),
          ),
        ]);
      for (const [eyebrow, title, items] of buckets) {
        if (!items.length) continue;
        const group = el("section", undefined, "mission-changes");
        group.append(
          heading(
            eyebrow,
            title,
            eyebrow === "YOUR REVIEW"
              ? "Inspect the draft, checks, and evidence before merging. A successful run alone does not prove the product improved."
              : "Follow the actual run and its latest result.",
          ),
        );
        for (const change of items.slice(0, s.view === "changes" ? 30 : 1)) {
          const card = el("article", undefined, "mission-change-card");
          card.append(
            el(
              "h3",
              change.pullRequests?.[0]?.title ||
                change.ticket ||
                "Coding change",
            ),
          );
          if (change.message) card.append(el("p", change.message));
          const actions = el("div", undefined, "mission-actions");
          const prs = list(change.pullRequests)
            .map((pr) =>
              safeLink(
                `${pr.state === "open" ? "Review" : "Open recorded"} ${change.pullRequests.length > 1 ? `#${pr.number}` : "pull request"}`,
                pr.url,
                pr.state === "open",
              ),
            )
            .filter(Boolean);
          actions.append(...prs);
          if (recorded(change))
            card.append(
              el(
                "p",
                "Recorded draft · status unavailable. Check source control for its current merge state.",
                "mission-note",
              ),
            );
          if (change.noChanges)
            card.append(
              el(
                "p",
                "The coding run reported no code changes. Read its explanation; no new pull request is implied.",
                "mission-note",
              ),
            );
          const activity = safeLink(
            "Checks & evidence",
            change.jobId
              ? `/activity?run=${encodeURIComponent(change.jobId)}`
              : change.activityUrl,
          );
          if (activity) actions.append(activity);
          if (list(change.checks?.commands).length) {
            if (
              change.checks.headSha &&
              list(change.pullRequests).some(
                (pr) =>
                  pr.currentHeadSha &&
                  pr.currentHeadSha !== change.checks.headSha,
              )
            )
              card.append(
                el(
                  "p",
                  "These recorded checks cover an older revision. Open the pull request to inspect checks for its current code.",
                  "mission-note",
                ),
              );
            const checks = el("ul", undefined, "mission-checks");
            for (const check of change.checks.commands)
              checks.append(el("li", `Recorded check: ${check}`));
            card.append(checks);
          }
          if (!prs.length && change.status === "succeeded" && !change.noChanges)
            card.append(
              el(
                "p",
                "No pull request link has been confirmed. Review the run output before considering this complete.",
                "mission-note",
              ),
            );
          if (change.delivery)
            card.append(
              el(
                "p",
                change.delivery.message || change.delivery.status,
                "mission-note",
              ),
            );
          card.append(actions);
          group.append(card);
        }
        if (s.view !== "changes" && items.length > 1)
          group.append(
            safeLink(
              `View all ${items.length} ${eyebrow === "YOUR REVIEW" ? "waiting changes" : "results"}`,
              `${projectPath(s.project.name)}?tab=changes`,
            ),
          );
        s.root.append(group);
      }
      const completed = changes.filter(
        (change) =>
          list(change.pullRequests).length &&
          list(change.pullRequests).every((pr) =>
            ["merged", "closed"].includes(pr.state),
          ),
      );
      if (completed.length && s.view !== "changes") {
        const history = el("p", undefined, "mission-note");
        history.append(
          el(
            "span",
            `${completed.length} earlier ${completed.length === 1 ? "change is" : "changes are"} merged or closed. `,
          ),
        );
        const link = safeLink(
          "View recorded work",
          `${projectPath(s.project.name)}?tab=changes`,
        );
        if (link) history.append(link);
        s.root.append(history);
      }
    }
    function form(s) {
      const form = el("form", undefined, "mission-form");
      form.append(
        heading(
          "NEXT USEFUL CHANGE",
          "What should get better?",
          "Describe a user outcome. Your gremlin will inspect the app and propose a bounded change before any coding starts.",
        ),
      );
      const label = el("label", "The outcome you want"),
        input = el("textarea");
      input.id = `mission-outcome-${s.project.name}`;
      label.htmlFor = input.id;
      input.rows = 3;
      input.maxLength = 4000;
      input.minLength = 15;
      input.required = true;
      input.value = s.draft;
      input.placeholder =
        "Help new users finish their first useful task without getting lost.";
      input.disabled = s.busy || isLocked();
      input.addEventListener("input", () => {
        s.draft = input.value;
        submit.disabled = s.busy || isLocked() || s.draft.trim().length < 15;
      });
      form.append(label, input);
      const areas = list(s.data?.areas);
      if (areas.length > 1) {
        const areaLabel = el("label", "Who should investigate?"),
          select = el("select");
        select.id = `mission-area-${s.project.name}`;
        areaLabel.htmlFor = select.id;
        select.append(
          Object.assign(el("option", "Choose the product area"), { value: "" }),
        );
        for (const area of areas)
          select.append(
            Object.assign(el("option", area.name || area.key), {
              value: area.key,
            }),
          );
        select.value = s.area;
        select.required = true;
        select.disabled = s.busy || isLocked();
        select.addEventListener("change", () => {
          s.area = select.value;
        });
        form.append(areaLabel, select);
      }
      const submit = el(
        "button",
        s.busy ? "Starting investigation…" : "Investigate this improvement",
        "button button-dark",
      );
      submit.type = "submit";
      submit.disabled = s.busy || isLocked() || s.draft.trim().length < 15;
      const actions = el("div", undefined, "mission-actions");
      actions.append(submit);
      if (s.selected)
        actions.append(
          button("Back to current mission", () => {
            s.newMission = false;
            paint(s);
          }),
        );
      form.append(
        el(
          "p",
          areas.length
            ? "Uses your selected PM and saved connections. Coding waits for your approval."
            : "We’ll prepare a focused PM for this outcome. Automatic work stays off.",
          "mission-note",
        ),
        actions,
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (s.draft.trim().length < 15 || (areas.length > 1 && !s.area)) return;
        void mutate(s, "", {
          outcome: s.draft.trim(),
          ...(s.area ? { area: s.area } : {}),
        });
      });
      s.root.append(form);
    }
    function proposal(s, candidate, rank) {
      const card = el("article", undefined, "mission-proposal");
      const title = el("h3", candidate.title);
      title.tabIndex = -1;
      card.append(
        el(
          "span",
          candidate.related === false
            ? "OTHER BACKLOG WORK"
            : `OPTION ${rank + 1}`,
          "eyebrow muted",
        ),
        title,
        el("p", candidate.identifier, "mission-note"),
      );
      if (s.proposal === candidate.id) {
        s.reviewHeading = title;
        if (window.renderKnowledgeDocument)
          card.append(
            window.renderKnowledgeDocument(candidate.description || ""),
          );
        else
          card.append(
            el("p", candidate.description || "No description was supplied."),
          );
        if (
          list(candidate.acceptanceCriteria).length &&
          !/^\s*(?:#{1,6}\s+|\*\*)(?:\d+[.)]\s*)?acceptance criteria\b/im.test(
            candidate.description || "",
          )
        ) {
          const criteria = el("ul");
          for (const item of candidate.acceptanceCriteria)
            criteria.append(el("li", item));
          card.append(el("h4", "What this change must do"), criteria);
        }
        card.append(
          el(
            "p",
            promotionWorkflow(s)
              ? "Approving this scope starts a Coding Gremlin. The controller checks and integrates its change, then the owning PM tests the app before promotion. Delivery shows any blocker."
              : "Approving this exact scope starts one Coding Gremlin on your runners. It opens a draft change; you review the result before merging.",
            "mission-note",
          ),
        );
        const approve = button(
          s.busy ? "Approving & starting…" : "Approve & build this change",
          () => {
            const mission = s.detail?.mission;
            if (
              !mission ||
              !s.review ||
              !candidate.revision ||
              s.error ||
              candidate.canApprove === false
            )
              return;
            void mutate(s, `/${encodeURIComponent(mission.id)}/plan`, {
              revision: mission.revision,
              steps: [
                {
                  ticketId: candidate.id,
                  revision: candidate.revision,
                  dependsOn: [],
                },
              ],
            });
          },
          true,
        );
        approve.disabled =
          s.busy ||
          isLocked() ||
          !s.review ||
          !candidate.revision ||
          Boolean(s.error) ||
          candidate.canApprove === false;
        card.append(approve);
      } else {
        const review = button("Review proposed change", () => {
          s.proposal = candidate.id;
          s.review = true;
          paint(s);
          s.reviewHeading?.focus?.({ preventScroll: true });
        });
        review.disabled = s.busy || isLocked();
        card.append(review);
      }
      return card;
    }
    function mission(s) {
      const item =
        s.detail?.mission ||
        list(s.data?.missions).find((entry) => entry.id === s.selected);
      if (!item) return;
      const section = el("section", undefined, "mission-current");
      section.dataset.state = item.status;
      section.append(
        heading(
          "YOUR IMPROVEMENT MISSION",
          promotionWorkflow(s) && item.status === "review-changes"
            ? "Follow your change through PM QA"
            : labels[item.status] || "Review this mission",
          item.outcome,
        ),
      );
      if (item.message)
        section.append(
          el(
            "p",
            promotionWorkflow(s) && item.status === "review-changes"
              ? "Coding has finished. Delivery above shows the integration checks, PM QA result and promotion progress; any blocker remains visible."
              : item.message,
            "mission-note",
          ),
        );
      const actions = el("div", undefined, "mission-actions");
      if (item.investigation?.jobId)
        actions.append(
          safeLink(
            "Investigation & evidence",
            `/activity?run=${encodeURIComponent(item.investigation.jobId)}`,
          ),
        );
      if (item.status === "needs-review" && !item.plan) {
        const candidates = list(s.detail?.candidates);
        if (s.detail?.candidateError) {
          const error = el("p", s.detail.candidateError, "mission-error");
          error.setAttribute("role", "alert");
          section.append(
            error,
            button("Check proposals again", () => void refresh(s, true)),
          );
        }
        if (candidates.length) {
          section.append(
            el(
              "p",
              "Choose one useful change. Read its evidence and acceptance criteria before approving.",
            ),
          );
          candidates.forEach((candidate, index) =>
            section.append(proposal(s, candidate, index)),
          );
        } else if (!s.detail?.candidateError)
          section.append(
            el(
              "p",
              "No implementation proposal is ready yet. Read the investigation’s findings before choosing the next direction.",
              "mission-note",
            ),
          );
      }
      for (const step of list(item.plan?.steps)) {
        const row = el("article", undefined, "mission-plan-step");
        row.append(
          el("h3", step.title),
          el(
            "p",
            `${step.identifier} · ${step.status || "Approved; waiting for admission"}`,
            "mission-note",
          ),
        );
        if (step.jobId)
          row.append(
            safeLink(
              "View coding work",
              `/activity?run=${encodeURIComponent(step.jobId)}`,
            ),
          );
        section.append(row);
      }
      if (item.status === "blocked" || item.status === "paused") {
        const advance = button(
          s.busy
            ? "Checking…"
            : item.status === "paused"
              ? "Resume mission"
              : "Check next step",
          () =>
            void mutate(
              s,
              `/${encodeURIComponent(item.id)}/${item.status === "paused" ? "resume" : "advance"}`,
              item.status === "paused" ? { revision: item.revision } : {},
            ),
        );
        advance.disabled = s.busy || isLocked();
        actions.append(advance);
      }
      if (active(item)) {
        const pause = button(
          "Pause future steps",
          () =>
            void mutate(s, `/${encodeURIComponent(item.id)}/pause`, {
              revision: item.revision,
            }),
        );
        pause.disabled = s.busy || isLocked();
        actions.append(pause);
      }
      if (!active(item))
        actions.append(
          button("Choose another outcome", () => {
            s.newMission = true;
            paint(s);
          }),
        );
      section.append(actions);
      s.root.append(section);
    }
    function paint(s) {
      if (focused(s)) return;
      const signature = JSON.stringify([
        s.data,
        s.detail,
        s.selected,
        s.busy,
        s.error,
        s.notice,
        s.proposal,
        s.review,
        s.newMission,
        s.view,
        s.draft,
        s.area,
        isLocked(),
      ]);
      if (s.paintSignature === signature) return;
      s.paintSignature = signature;
      s.root.replaceChildren();
      s.root.setAttribute("aria-busy", String(s.busy));
      if (!s.data && !s.error) {
        const loading = el(
          "p",
          isLocked()
            ? "Open an active dashboard session to review this project’s work."
            : "Loading your next useful change…",
          "mission-note",
        );
        loading.setAttribute("role", "status");
        s.root.append(loading);
        return;
      }
      if (s.error) {
        const error = el("div", undefined, "mission-error");
        error.setAttribute("role", "alert");
        error.append(
          el("p", s.error),
          button("Refresh mission", () => void refresh(s, true)),
          safeLink(
            "Project setup",
            `${projectPath(s.project.name)}?tab=settings`,
          ),
        );
        s.root.append(error);
      }
      if (!s.data) return;
      if (s.notice) {
        const notice = el("p", s.notice, "mission-note");
        notice.setAttribute("role", "status");
        s.root.append(notice);
      }
      renderChanges(s);
      if (s.view === "changes") {
        if (!list(s.data?.changes).length && !promotionWorkflow(s))
          s.root.append(
            heading(
              "YOUR CHANGES",
              "No code changes yet",
              "Approved work appears here with its actual pull request, checks, and evidence.",
            ),
          );
        s.root.append(
          safeLink(
            "Advanced delivery workflow",
            `${projectPath(s.project.name)}?tab=delivery`,
          ),
        );
        return;
      }
      if (s.newMission || !s.selected) form(s);
      else mission(s);
      if (list(s.data?.missions).length > 1) {
        const label = el("label", "Other missions"),
          select = el("select");
        select.id = `mission-history-${s.project.name}`;
        label.htmlFor = select.id;
        for (const item of s.data.missions)
          select.append(
            Object.assign(el("option", item.outcome), { value: item.id }),
          );
        select.value = s.selected;
        select.disabled = s.busy;
        select.addEventListener("change", () => {
          s.request++;
          s.fetching = false;
          s.selected = select.value;
          s.detail = null;
          s.proposal = "";
          s.review = false;
          s.newMission = false;
          document.activeElement?.blur?.();
          void refresh(s, true);
        });
        const history = el("div", undefined, "mission-history");
        history.append(label, select);
        s.root.append(history);
      }
    }
    window.addEventListener("dashboard:pagechange", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => clearTimeout(timer));
    return {
      mount(root, project, view = "overview") {
        const s = state(project);
        s.view = view;
        root.append(s.root);
        paint(s);
        void refresh(s);
        schedule();
      },
      protectFocus: () => [...states.values()].some(focused),
      isBusy: () => [...states.values()].some((s) => s.busy),
      forget(name) {
        for (const [key, s] of states)
          if (s.project.name === name) {
            s.request++;
            states.delete(key);
          }
        schedule();
      },
    };
  };
})();
