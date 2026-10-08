"use strict";
(() => {
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (text, action, className = "small-button") => {
    const result = node("button", className, text);
    result.type = "button";
    result.addEventListener("click", action);
    return result;
  };
  const link = (text, href, className = "") => {
    const result = node("a", className, text);
    result.href = href;
    return result;
  };
  const path = (project, pm = "", tab = "brief") => {
    const query = new URLSearchParams();
    if (pm) query.set("pm", pm);
    if (tab !== "brief" && tab !== "overview") query.set("tab", tab);
    return `/projects/${encodeURIComponent(project)}${query.size ? `?${query}` : ""}`;
  };
  const when = (value) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString()
      : "Not yet";
  const briefLabels = {
    ambition: "Product ambition",
    goal: "Goal",
    users: "Who it serves",
    expectedToBuild: "Expected capabilities",
    nonGoals: "Out of scope",
    guardrails: "Guardrails",
    standingPriorities: "Standing priorities",
    metricDefinition: "Success definition",
  };
  const tabs = [
    ["brief", "Product brief"],
    ["discovery", "Learning"],
    ["features", "Features"],
    ["queue", "Ranked queue"],
    ["memory", "Memory"],
    ["activity", "Activity"],
  ];
  // The knowledge files are data, never executable HTML or instructions to this UI.
  function appendInline(root, value) {
    const text = String(value);
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      root.append(document.createTextNode(text.slice(cursor, match.index)));
      const part = match[0];
      if (part.startsWith("`"))
        root.append(node("code", "", part.slice(1, -1)));
      else if (part.startsWith("**"))
        root.append(node("strong", "", part.slice(2, -2)));
      else {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        let safe = false;
        try {
          const url = new URL(parts[2]);
          safe =
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            ![...url.searchParams.keys()].some((key) =>
              /token|secret|password|api[_-]?key|code|signature|credential/i.test(
                key,
              ),
            );
        } catch {
          /* Unknown links remain readable text. */
        }
        if (safe) {
          const anchor = link(parts[1], parts[2]);
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          root.append(anchor);
        } else root.append(document.createTextNode(parts[1]));
      }
      cursor = match.index + part.length;
    }
    root.append(document.createTextNode(text.slice(cursor)));
  }
  function withoutReviewedSetup(content, proposal) {
    if (!proposal) return content;
    const blocks = [
      ...content.matchAll(
        /^```shipgremlins-setup[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?$)/gm,
      ),
    ];
    // Only hide the one machine block represented by the structured review.
    // Invalid, ambiguous, or changed discovery remains visible for diagnosis.
    if (blocks.length !== 1) return content;
    const canonical = (value) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      );
    try {
      if (canonical(JSON.parse(blocks[0][1])) === canonical(proposal))
        return (
          content.slice(0, blocks[0].index) +
          content.slice(blocks[0].index + blocks[0][0].length)
        );
    } catch {
      // Keep malformed source readable; it has not been reviewed successfully.
    }
    return content;
  }
  window.renderKnowledgeDocument = (content, { setupProposal } = {}) => {
    const root = node("div", "knowledge-document");
    const lines = withoutReviewedSetup(
      String(content || ""),
      setupProposal,
    ).split(/\r?\n/);
    const cells = (line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
    let list = null,
      code = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("```")) {
        if (code) code = null;
        else {
          code = node("pre");
          root.append(code);
        }
        list = null;
        continue;
      }
      if (code) {
        code.textContent += `${line}\n`;
        continue;
      }
      if (!line.trim()) {
        list = null;
        continue;
      }
      if (
        line.includes("|") &&
        lines[index + 1]?.includes("|") &&
        cells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))
      ) {
        const wrapper = node("div", "knowledge-table-wrap");
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute(
          "aria-label",
          "Knowledge table, scroll horizontally for more columns",
        );
        const table = node("table", "knowledge-table"),
          head = node("thead"),
          heading = node("tr"),
          body = node("tbody");
        for (const value of cells(line)) {
          const cell = node("th");
          cell.scope = "col";
          appendInline(cell, value);
          heading.append(cell);
        }
        head.append(heading);
        index += 2;
        while (
          index < lines.length &&
          lines[index].includes("|") &&
          lines[index].trim()
        ) {
          const row = node("tr");
          for (const value of cells(lines[index])) {
            const cell = node("td");
            appendInline(cell, value);
            row.append(cell);
          }
          body.append(row);
          index += 1;
        }
        index -= 1;
        table.append(head, body);
        wrapper.append(table);
        root.append(wrapper);
        list = null;
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
      if (heading) {
        const title = node(heading[1].length < 3 ? "h3" : "h4");
        appendInline(title, heading[2]);
        root.append(title);
        list = null;
      } else if (bullet) {
        const ordered = /^\s*\d+\./.test(line);
        if (!list || list.tagName !== (ordered ? "OL" : "UL")) {
          list = node(ordered ? "ol" : "ul");
          root.append(list);
        }
        const item = node("li");
        appendInline(item, bullet[1]);
        list.append(item);
      } else {
        list = null;
        const paragraph = node(line.startsWith("> ") ? "blockquote" : "p");
        appendInline(paragraph, line.replace(/^> /, ""));
        root.append(paragraph);
      }
    }
    return root;
  };
  window.createProjectWorkspace = (root, options) => {
    const {
      api,
      pages,
      onSaved,
      onJob,
      onCreatePm,
      onSetupLinear,
      onSetupHosting,
      getJobs,
    } = options;
    const setupSuggestions = window.createSetupSuggestions?.({
      api,
      onSaved,
      onChanged: () => {
        signature = "";
        render();
      },
      isLocked: () => locked,
    });
    let status = null,
      locked = true,
      signature = "",
      renderedRoute = "",
      sidebarSignature = "";
    let request = null,
      generation = 0,
      timer = null,
      contextKey = "";
    let launching = false;
    const welcome = window.createProjectWelcome?.({
      api,
      pages,
      onCreatePm,
      onSetupLinear,
      onSaved,
      isLocked: () => locked,
    });
    const crewRecommendations = window.createCrewRecommendations?.({
      api,
      getProject: (name) =>
        status?.projects?.find((project) => project.name === name),
      onAdopt: (name, suggestion) => onCreatePm?.(name, suggestion),
      onSaved,
      isLocked: () => locked,
    });
    const missions = window.createProjectMissions?.({
      api,
      pages,
      onJob,
      onSaved,
      isLocked: () => locked,
    });
    const grumblins = window.createGrumblins?.({
      api,
      pages,
      getJobs,
      onJob,
      isLocked: () => locked,
    });
    const knowledge = new Map(),
      notices = new Map(),
      disclosures = new Map();
    function disclosure(key, label, className = "workspace-disclosure") {
      const details = node("details", className);
      const id = `${pages.project}/${pages.pm || ""}/${key}`;
      details.open = disclosures.get(id) === true;
      details.append(node("summary", "", label));
      details.addEventListener("toggle", () =>
        disclosures.set(id, details.open),
      );
      return details;
    }
    const sidebar = document.getElementById("project-navigation");
    const editor = {
      project: "",
      area: "",
      revision: "",
      original: "",
      busy: false,
      generation: 0,
      form: null,
      charter: null,
    };
    const dialog = node("dialog", "pm-brief-dialog");
    dialog.setAttribute("aria-labelledby", "pm-brief-title");
    document.body.append(dialog);
    const header = node("div", "pm-brief-dialog-header");
    const identity = node("div");
    const editorTitle = node("h2", "", "Edit product brief");
    editorTitle.id = "pm-brief-title";
    const editorScope = node("p");
    identity.append(
      node("span", "eyebrow muted", "PM PRODUCT BRIEF"),
      editorTitle,
      editorScope,
    );
    const close = button("Close ×", () => requestClose());
    header.append(identity, close);
    const body = node("div", "pm-brief-dialog-body");
    const editorMessage = node("p", "project-workspace-notice");
    editorMessage.hidden = true;
    editorMessage.setAttribute("role", "status");
    const discard = node("div", "project-workspace-notice pm-brief-discard");
    discard.hidden = true;
    const discardActions = node("div", "button-row");
    discardActions.append(
      button("Keep editing", () => {
        discard.hidden = true;
        close.focus();
      }),
      button("Discard edits", () => finishClose()),
    );
    discard.append(
      node("p", "", "You have unsaved changes to this PM’s brief."),
      discardActions,
    );
    const footer = node("div", "pm-brief-dialog-footer");
    const save = button("Save product brief", saveBrief, "button button-dark");
    const reload = button("Reload saved brief", () => {
      if (isDirty()) {
        showEditorMessage(
          "Save or discard your current edits before reloading.",
          true,
        );
        return;
      }
      openBrief(editor.project, editor.area);
    });
    const footerActions = node("div", "button-row");
    const removePm = button(
      "Delete PM",
      () => {
        if (editor.busy || locked) return;
        if (isDirty()) {
          showEditorMessage(
            "Save or discard your brief edits before deleting this PM.",
            true,
          );
          return;
        }
        const target = { project: editor.project, area: editor.area };
        finishClose();
        options.onDelete?.(target);
      },
      "small-button danger-button",
    );
    footerActions.append(removePm, reload, save);
    footer.append(
      node(
        "p",
        "",
        "Saves context for future runs. Automation stays unchanged.",
      ),
      footerActions,
    );
    dialog.append(header, body, discard, footer);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestClose();
    });
    const fields = new Map();
    function showEditorMessage(text, error = false) {
      editorMessage.textContent = text;
      editorMessage.hidden = !text;
      editorMessage.classList.toggle("error", error);
    }
    function readBrief() {
      const value = {};
      for (const [key, { input, list, number }] of fields)
        value[key] = list
          ? input.value
              .split(/\r?\n/)
              .map((part) => part.trim())
              .filter(Boolean)
          : number
            ? key === "promotionBatchSize" && !input.value.trim()
              ? null
              : Number(input.value)
            : input.value.trim();
      value.charter = editor.charter?.read() || {};
      return value;
    }
    function isDirty() {
      return (
        dialog.open &&
        Boolean(editor.original) &&
        JSON.stringify(readBrief()) !== editor.original
      );
    }
    function finishClose() {
      editor.generation += 1;
      editorLock(false);
      dialog.close();
      discard.hidden = true;
    }
    function requestClose() {
      if (editor.busy && editor.original) return;
      if (isDirty()) {
        discard.hidden = false;
        discardActions.firstElementChild.focus();
      } else finishClose();
    }
    function editorLock(value) {
      editor.busy = value;
      save.disabled = value || locked;
      reload.disabled = value || locked;
      removePm.disabled = value || locked || !editor.original;
      close.disabled = value && Boolean(editor.original);
      if (editor.form) editor.form.disabled = value || locked;
    }
    async function openBrief(projectName, areaKey) {
      if (editor.busy || (dialog.open && isDirty())) return;
      editor.project = projectName;
      editor.area = areaKey;
      editor.original = "";
      const current = ++editor.generation;
      editorTitle.textContent = "Loading product brief…";
      const project = status?.projects?.find(
        (item) => item.name === projectName,
      );
      editorScope.textContent = `${projectName} · ${project?.repo || ""} · ${areaKey}`;
      body.replaceChildren(editorMessage);
      fields.clear();
      editor.charter = null;
      editor.form = null;
      showEditorMessage("");
      discard.hidden = true;
      if (!dialog.open) dialog.showModal();
      editorLock(true);
      try {
        const result = await api(
          `/api/projects/${encodeURIComponent(projectName)}/pms/${encodeURIComponent(areaKey)}/brief`,
        );
        if (current !== editor.generation) return;
        editor.revision = result.revision;
        const brief = result.brief;
        editorTitle.textContent = brief.name || areaKey;
        const form = node("fieldset");
        form.className = "pm-brief-fields";
        editor.form = form;
        const addField = (
          key,
          label,
          {
            list = false,
            number = false,
            numberMax = 20,
            rows = 3,
            required = false,
            max = 4000,
          } = {},
        ) => {
          const field = node("div", "field");
          const caption = node("label", "", label);
          caption.htmlFor = `edit-brief-${key}`;
          const input = node(number || rows === 1 ? "input" : "textarea");
          input.id = caption.htmlFor;
          input.required = required;
          if (number) {
            input.type = "number";
            input.min = "1";
            input.max = String(numberMax);
          } else {
            if (rows === 1) input.type = "text";
            else input.rows = rows;
            input.maxLength = max;
          }
          input.value = list
            ? (brief[key] || []).join("\n")
            : String(brief[key] ?? "");
          fields.set(key, { input, list, number });
          field.append(caption, input);
          return field;
        };
        const direction = node("section", "pm-editor-direction");
        direction.append(
          addField("name", "PM name", { rows: 1, required: true, max: 100 }),
          addField("mandate", "Mandate", {
            rows: 4,
            required: true,
            max: 12000,
          }),
        );
        const charterRoot = node("div");
        direction.append(charterRoot);
        editor.charter = window.createPmCharter(
          charterRoot,
          "edit-charter",
          brief.charter || {},
        );
        const advanced = node("section", "pm-editor-execution");
        advanced.append(node("h3", "", "Ownership, schedule & work limits"));
        advanced.append(
          addField("paths", "Owned paths · one per line", { list: true }),
          addField("sharedTouchpoints", "Shared touchpoints · one per line", {
            list: true,
          }),
          addField("metric", "Metric or route", { rows: 1 }),
          addField("schedule", "Schedule · five-field UTC cron", {
            rows: 1,
            required: true,
          }),
          addField("wipLimit", "Work-in-progress limit", {
            number: true,
            required: true,
          }),
          addField(
            "promotionBatchSize",
            "Tickets per promotion · empty uses project default",
            {
              number: true,
              numberMax: 100,
            },
          ),
        );
        const navigation = node("nav", "surface-tabs settings-navigation");
        navigation.setAttribute("aria-label", "Edit PM settings");
        const panels = [
          ["Mission & brief", direction],
          ["Ownership & schedule", advanced],
        ];
        const select = (selected) =>
          panels.forEach(([, panel], index) => {
            panel.hidden = index !== selected;
            navigation.children[index].setAttribute(
              "aria-current",
              index === selected ? "page" : "false",
            );
          });
        panels.forEach(([label], index) =>
          navigation.append(button(label, () => select(index))),
        );
        select(0);
        form.append(navigation, direction, advanced);
        form.addEventListener(
          "invalid",
          (event) => {
            const first = form.querySelector(":invalid");
            if (first && first !== event.target) return;
            select(advanced.contains(event.target) ? 1 : 0);
          },
          true,
        );
        body.replaceChildren(form, editorMessage);
        editor.original = JSON.stringify(readBrief());
      } catch (error) {
        showEditorMessage(error.message, true);
        editorTitle.textContent = "Could not load this PM";
      } finally {
        if (current === editor.generation) editorLock(false);
      }
    }
    async function saveBrief() {
      if (
        locked ||
        editor.busy ||
        !editor.form ||
        ![...editor.form.querySelectorAll("input,textarea")].every((input) =>
          input.reportValidity(),
        )
      )
        return;
      editorLock(true);
      showEditorMessage("Saving product brief…");
      try {
        const result = await api(
          `/api/projects/${encodeURIComponent(editor.project)}/pms/${encodeURIComponent(editor.area)}/brief`,
          { revision: editor.revision, brief: readBrief() },
        );
        editor.revision = result.revision;
        editor.original = JSON.stringify(readBrief());
        showEditorMessage(
          "Product brief saved. Future runs will use this context.",
        );
        await onSaved?.();
        signature = "";
        render();
      } catch (error) {
        showEditorMessage(error.message, true);
      } finally {
        editorLock(false);
      }
    }
    function selected() {
      const project = status?.projects?.find(
        (item) => item.name === pages.project,
      );
      return {
        project,
        area: project?.areas?.find((item) => item.key === pages.pm),
      };
    }
    function activeKey() {
      const { project, area } = selected();
      return pages.current === "project" && project && area
        ? `${project.name}/${area.key}`
        : "";
    }
    function stopKnowledge() {
      clearTimeout(timer);
      request?.abort();
      request = null;
      generation += 1;
    }
    async function refreshKnowledge() {
      const key = activeKey();
      if (!key || locked || request || document.hidden) return;
      const { project, area } = selected();
      const revision = generation;
      const controller = new AbortController();
      request = controller;
      try {
        const value = await api(
          `/api/projects/${encodeURIComponent(project.name)}/pms/${encodeURIComponent(area.key)}/knowledge`,
          undefined,
          "GET",
          20000,
          controller.signal,
        );
        if (activeKey() !== key || revision !== generation) return;
        const previous = knowledge.get(key);
        knowledge.set(key, value);
        if (
          JSON.stringify(previous?.provenance) !==
            JSON.stringify(value.provenance) ||
          previous?.stale !== value.stale
        )
          setupSuggestions?.refresh(project.name, area.key);
        notices.delete(key);
        render();
      } catch (error) {
        if (activeKey() !== key || revision !== generation) return;
        notices.set(key, error.message);
        render();
      } finally {
        if (request === controller) request = null;
        if (activeKey() === key && revision === generation) {
          clearTimeout(timer);
          timer = setTimeout(
            refreshKnowledge,
            knowledge.get(key)?.state === "refreshing" ? 3000 : 15000,
          );
        }
      }
    }
    async function discover(projectName, areaKey) {
      if (locked || launching) return;
      const key = `${projectName}/${areaKey}`;
      launching = true;
      notices.set(key, "Queuing discovery…");
      render();
      try {
        const result = await api("/api/jobs", {
          type: "pm",
          project: projectName,
          area: areaKey,
          pmMode: "discovery",
        });
        notices.set(
          key,
          "Discovery queued. Review its visible activity while it maps the product.",
        );
        if (result.job) onJob?.(result.job);
        options.operations?.refresh(projectName, true);
        await refreshKnowledge();
        return result;
      } catch (error) {
        notices.set(key, `Discovery could not start: ${error.message}`);
        throw error;
      } finally {
        launching = false;
        render();
      }
    }
    function action(text, data, className = "small-button") {
      const result = button(text, () => {}, className);
      Object.assign(result.dataset, data);
      result.disabled = locked;
      return result;
    }
    function discoveryButton(project, area) {
      const readiness = project.readiness?.areas?.find(
        (item) => item.key === area.key,
      )?.discovery;
      const state = (getJobs?.() || []).some(
        (job) =>
          job.project === project.name &&
          (job.projectInstanceId ?? null) === (project.instanceId ?? null) &&
          job.area === area.key &&
          job.pmMode === "discovery" &&
          (!area.discoveryRevision ||
            job.discoveryRevision === area.discoveryRevision) &&
          ["queued", "running"].includes(job.status),
      )
        ? "refreshing"
        : knowledge.get(`${project.name}/${area.key}`)?.state;
      const result = button(
        state === "refreshing" ? "Discovery running…" : "Run discovery",
        () => discover(project.name, area.key).catch(() => {}),
        "small-button",
      );
      result.disabled =
        locked ||
        launching ||
        state === "refreshing" ||
        readiness?.canRun === false;
      result.title =
        "Read-only discovery maps the repository and records product knowledge. It does not create coding tickets.";
      return result;
    }
    function projectActions(project) {
      const actions = node("div", "project-header-actions");
      const settings = action("Settings", { editProject: project.name });
      settings.setAttribute("aria-label", `Settings for ${project.name}`);
      const add = button(
        "Adopt a gremlin",
        () => onCreatePm(project.name),
        "small-button",
      );
      add.setAttribute("aria-label", `Adopt a PM Gremlin for ${project.name}`);
      add.disabled = locked;
      actions.append(settings);
      if (
        (pages.tab === "crew" || pages.pm) &&
        (project.areas?.length || !crewRecommendations)
      )
        actions.append(add);
      return actions;
    }
    function projectJobs(project, area) {
      return (getJobs?.() || [])
        .filter(
          (job) =>
            job.project === project.name &&
            (job.projectInstanceId ?? null) === (project.instanceId ?? null) &&
            (!area || job.area === area.key),
        )
        .slice()
        .sort((a, b) => b.runId - a.runId);
    }
    const activeJob = (job) => ["running", "queued"].includes(job.status);
    const runLabel = (job) =>
      job.grumblin
        ? `Customer simulation · ${job.grumblin.name}`
        : job.pmMode === "discovery"
          ? "Discovery"
          : job.pmMode === "exploration"
            ? "Product exploration"
            : job.type === "pm"
              ? "PM patrol"
              : "Coding run";
    const runState = (job) =>
      ({
        running: "Working",
        queued: "Queued",
        succeeded: "Run finished",
        failed: "Stopped",
        canceled: "Canceled",
      })[job?.status] ||
      job?.status ||
      "Not run yet";
    function statusChip(label, status = "idle") {
      const chip = node("span", "workspace-status", label);
      chip.dataset.state = status;
      return chip;
    }
    function activityList(project, area, limit = 12) {
      const list = node("div", "workspace-activity-list");
      const jobs = projectJobs(project, area).slice(0, limit);
      if (!jobs.length)
        list.append(
          node(
            "p",
            "runner-guidance",
            "No runs yet. Your crew’s activity will appear here.",
          ),
        );
      for (const job of jobs) {
        const row = button(
          "",
          () => options.onActivity(job.id),
          "project-run-row",
        );
        row.append(
          statusChip(runState(job), job.status),
          node(
            "strong",
            "",
            `${runLabel(job)}${job.ticket ? ` · ${job.ticket}` : ""}`,
          ),
          node(
            "span",
            "project-run-meta",
            `Run ${job.runId} · ${when(job.createdAt)}`,
          ),
        );
        list.append(row);
      }
      return list;
    }
    function crewPulse(project) {
      const jobs = projectJobs(project),
        active = jobs.filter(activeJob),
        running = active.filter((job) => job.status === "running"),
        pulse = node("section", "crew-pulse"),
        copy = node("div", "crew-pulse-copy"),
        title = node(
          "h2",
          "",
          running.length
            ? `${running.length} ${running.length === 1 ? "gremlin is" : "gremlins are"} working`
            : active.length
              ? "Your crew has work queued"
              : "Your crew at a glance",
        );
      pulse.setAttribute("aria-label", "Current crew activity");
      copy.append(
        title,
        node(
          "p",
          "",
          running.length || active.length
            ? "Open a run to follow its recorded activity, output, and evidence."
            : "See each PM’s assignment, latest run, and automation below.",
        ),
      );
      const counts = node("div", "crew-pulse-counts");
      for (const [value, label] of [
        [project.areas?.length || 0, "PMs"],
        [running.length, "Working"],
        [active.length - running.length, "Queued"],
      ]) {
        const item = node("div");
        item.append(node("strong", "", String(value)), node("span", "", label));
        counts.append(item);
      }
      pulse.append(copy, counts);
      return pulse;
    }
    function pmLiveState(project, area, { compact = false } = {}) {
      const jobs = projectJobs(project, area),
        current =
          jobs.find((job) => job.status === "running") || jobs.find(activeJob),
        latest = current || jobs[0],
        panel = node("div", compact ? "pm-run-snapshot" : "pm-current-run"),
        copy = node("div", "pm-current-run-copy");
      panel.dataset.state = latest?.status || "idle";
      if (!compact)
        copy.append(
          node("span", "eyebrow muted", current ? "CURRENT RUN" : "LATEST RUN"),
        );
      copy.append(
        statusChip(
          latest ? `${runLabel(latest)} · ${runState(latest)}` : "No runs yet",
          latest?.status,
        ),
      );
      copy.append(
        node(
          "p",
          "",
          latest
            ? `${latest.ticket ? `${latest.ticket} · ` : ""}Run ${latest.runId} · ${when(latest.startedAt || latest.createdAt)}`
            : area.enabled
              ? "Daily patrols are enabled. A run will appear here when it is queued."
              : "Start a patrol when you’re ready, or enable daily investigations.",
        ),
      );
      panel.append(copy);
      if (latest && (!current || current.type !== "pm"))
        panel.append(
          button(
            current ? "Follow run →" : "View last run →",
            () => options.onActivity?.(latest.id),
            "workspace-run-link",
          ),
        );
      return panel;
    }
    function renderSidebar() {
      if (!sidebar) return;
      const names = (status?.projects || []).map((project) => project.name);
      const next = JSON.stringify([names, pages.project]);
      if (sidebarSignature === next) return;
      sidebarSignature = next;
      sidebar.replaceChildren();
      for (const name of names) {
        const item = link("", path(name), "nav-item");
        item.title = name;
        item.append(
          node("span", "project-nav-dot"),
          node("span", "project-nav-name", name),
        );
        if (pages.project === name) item.setAttribute("aria-current", "page");
        sidebar.append(item);
      }
      if (!names.length)
        sidebar.append(
          link(
            "+ Add your first project",
            "/projects#project-form",
            "nav-item",
          ),
        );
    }
    const needsHosting = (project) =>
      Boolean(onSetupHosting) &&
      project.areas?.length > 0 &&
      !project.foundation?.needed &&
      !(
        project.verification?.mode === "browser" &&
        project.environments?.[project.verification.environment]
      );
    const linearSetupLabel = (project) => {
      if (!project?.areas?.length || project.foundation?.needed) return "";
      const steps = project.readiness?.steps || [];
      if (
        steps.some(
          (step) => step.id === "linear_connection" && step.ready === false,
        )
      )
        return "Connect Linear";
      return steps.some(
        (step) => step.id === "linear_mapping" && step.ready === false,
      ) ||
        project.areas.some(
          (area) =>
            !area.linearProjectId?.trim() ||
            /^(?:PASTE_|CHANGE_|<)/i.test(area.linearProjectId),
        )
        ? "Set up Linear"
        : "";
    };
    const nextSetup = (project) =>
      onSetupLinear && linearSetupLabel(project)
        ? "linear"
        : needsHosting(project)
          ? "hosting"
          : "";
    function hostingAction(project) {
      const setup = nextSetup(project);
      const identity = JSON.stringify([
        project.instanceId ?? null,
        project.provider || "github",
        project.serverUrl ?? null,
        project.repo,
      ]);
      const connect = button(
        setup === "linear"
          ? linearSetupLabel(project)
          : "Connect a test environment",
        async () => {
          const current = status?.projects?.find(
            (item) => item.name === project.name,
          );
          if (
            locked ||
            !current ||
            nextSetup(current) !== setup ||
            JSON.stringify([
              current.instanceId ?? null,
              current.provider || "github",
              current.serverUrl ?? null,
              current.repo,
            ]) !== identity
          )
            return;
          await (setup === "linear" ? onSetupLinear : onSetupHosting)(
            project.name,
            connect,
          );
        },
        "button button-dark",
      );
      connect.disabled = locked;
      return connect;
    }
    function hostingInvitation(project) {
      const card = node("section", "project-hosting-invitation"),
        copy = node("div");
      copy.append(
        node(
          "h2",
          "",
          nextSetup(project) === "linear"
            ? "Give your crew a home for its work."
            : "Let your crew see the app, too.",
        ),
        node(
          "p",
          "",
          nextSetup(project) === "linear"
            ? "Set up Linear so your gremlins can organize improvements and hand tickets to coding agents. Code-only investigations can continue while you set it up."
            : "Connect a test environment for real browser walkthroughs. You can keep investigating the code while you set it up.",
        ),
      );
      card.append(copy, hostingAction(project));
      root.append(card);
    }
    function home(project) {
      const step =
        window.projectFirstStep?.(project, getJobs?.() || []) ||
        (project.foundation?.needed ? "foundation" : "mission");
      if (project.areas?.length) root.append(crewPulse(project));
      if (project.areas?.length)
        crewRecommendations?.mount(root, project, {
          compact: true,
          hideWhenEmpty: true,
        });
      if (step === "foundation")
        root.append(window.renderFoundationLauncher(project));
      else if (step === "welcome" && crewRecommendations) {
        welcome?.deactivate?.();
        crewRecommendations.mount(root, project);
      } else if (step === "welcome" && welcome) welcome.mount(root, project);
      else if (step === "discovery") firstInvestigation(project);
      else if (missions) missions.mount(root, project);
      else if (project.areas?.length)
        root.append(
          window.renderCodingLauncher(project, {
            locked,
            jobs: getJobs?.() || [],
            operation: options.getCodingAction?.(project.name),
          }),
        );
      if (step === "mission" && nextSetup(project)) hostingInvitation(project);
      const recent = node("section", "project-recent-activity");
      recent.append(
        node("h2", "", "Recent work"),
        activityList(project, null, 3),
      );
      root.append(recent);
    }
    function firstInvestigation(project) {
      const area =
        project.areas.find(
          (item) => item.key === project.onboardingProgress?.area,
        ) || project.areas[0];
      const jobs = (getJobs?.() || [])
        .filter(
          (job) =>
            job.type === "pm" &&
            job.project === project.name &&
            (job.projectInstanceId ?? null) === (project.instanceId ?? null) &&
            job.area === area.key,
        )
        .filter(
          (job) =>
            job.pmMode !== "discovery" ||
            !area.discoveryRevision ||
            job.discoveryRevision === area.discoveryRevision,
        )
        .sort((a, b) => b.runId - a.runId);
      const active = jobs.find((job) =>
        ["queued", "running"].includes(job.status),
      );
      const previous = jobs.find((job) => job.pmMode === "discovery");
      const failed =
        previous && ["failed", "canceled"].includes(previous.status);
      const readiness = project.readiness?.areas?.find(
        (item) => item.key === area.key,
      )?.discovery;
      const setup = nextSetup(project),
        offerHosting = Boolean(setup);
      const card = node(
          "section",
          "project-first-investigation mission-current",
        ),
        heading = node("div", "mission-heading"),
        image = node("img", "first-investigation-creature"),
        actions = node("div", "mission-actions");
      image.src = "/assets/gremlin-investigating.webp";
      image.alt = "";
      image.width = image.height = 120;
      heading.append(
        node("span", "eyebrow muted", "YOUR FIRST INVESTIGATION"),
        node(
          "h2",
          "",
          active
            ? `${area.name || "Your gremlin"} is ${active.status === "queued" ? "ready to get started" : "learning the app"}.`
            : failed
              ? "Let’s finish getting to know your app."
              : `Give ${area.name || "your gremlin"} a first look.`,
        ),
        node(
          "p",
          "",
          setup === "linear"
            ? "First, give your gremlin a home for its work in Linear. We’ll connect the account and prepare its project. A code-only investigation can start without Linear or a test environment."
            : offerHosting
              ? "Connect a test environment so your gremlin can walk through the app like a user. A code-only investigation can start now; it maps the repository without opening the app."
              : "Discovery reads the code and brings back a map of the product, its important journeys, and the gaps worth investigating. Then you can choose what should get better.",
        ),
      );
      card.append(image, heading);
      if (offerHosting) actions.append(hostingAction(project));
      if (active) {
        card.append(
          node(
            "p",
            "mission-note",
            active.status === "queued"
              ? "Queued for your runner. Opening this page does not queue another investigation."
              : "The investigation is running. You can leave this page and return to its findings.",
          ),
        );
        actions.append(
          button(
            "Follow the investigation",
            () => options.onActivity?.(active.id),
            offerHosting ? "small-button" : "button button-dark",
          ),
        );
      } else {
        if (failed)
          card.append(
            node(
              "p",
              "project-workspace-notice",
              previous.message ||
                "The last Discovery did not finish. Review the run before trying again.",
            ),
          );
        if (readiness?.canRun) {
          const start = button(
            launching
              ? "Starting investigation…"
              : failed
                ? "Retry the investigation"
                : offerHosting
                  ? "Start with code only"
                  : "Explore the codebase",
            () => discover(project.name, area.key).catch(() => {}),
            offerHosting ? "small-button" : "button button-dark",
          );
          start.disabled = locked || launching;
          actions.append(start);
        } else {
          const blocker = readiness?.blockers?.[0];
          card.append(
            node(
              "p",
              "project-workspace-notice",
              blocker?.message ||
                "Checking what this gremlin needs for its first investigation…",
            ),
          );
          if (blocker?.action)
            actions.append(
              action(
                "Prepare first mission",
                {
                  setupAction: blocker.action,
                  setupProject: project.name,
                  setupStep: blocker.id,
                  setupArea: area.key,
                },
                offerHosting ? "small-button" : "button button-dark",
              ),
            );
        }
        if (previous)
          actions.append(
            button("Review the last run", () =>
              options.onActivity?.(previous.id),
            ),
          );
      }
      actions.append(
        link(
          "Their brief & findings",
          path(project.name, area.key, "discovery"),
          "small-button",
        ),
      );
      const notice = notices.get(`${project.name}/${area.key}`);
      if (notice) {
        const status = node("p", "project-workspace-notice", notice);
        status.setAttribute("role", "status");
        card.append(status);
      }
      card.append(
        actions,
        node(
          "p",
          "mission-note",
          "Connecting an environment does not start a run. Code-only discovery does not file tickets or start coding.",
        ),
      );
      root.append(card);
    }
    function crewWorkspace(project) {
      if (!project.areas?.length && crewRecommendations) {
        welcome?.deactivate?.();
        crewRecommendations.mount(root, project);
        return;
      }
      if (project.areas?.length) root.append(crewPulse(project));
      const setupIncomplete =
        !project.areas?.length ||
        project.areas.some((area) => {
          const state = project.readiness?.areas?.find(
            (item) => item.key === area.key,
          );
          return (
            !area.enabled ||
            !(area.codingEnabled ?? area.enabled) ||
            !state?.canRun ||
            !state.canEnable ||
            !state.coding?.canEnable
          );
        });
      if (setupIncomplete)
        welcome?.mount(root, project, {
          suggestionsOnly: true,
          setupOnly: Boolean(crewRecommendations),
        });
      const crew = node("section", "project-crew-section");
      const title = node("div", "project-section-title");
      title.append(
        node("h2", "", "PM Gremlins"),
        node("span", "project-crew-count", String(project.areas?.length || 0)),
      );
      crew.append(title);
      if (project.areas?.length && window.renderPatrolPlan)
        crew.append(window.renderPatrolPlan(project, { compact: true }));
      const cards = node("div", "project-crew-list");
      for (const area of project.areas || []) {
        const card = node("article", "project-pm-row"),
          image = node("img");
        image.src =
          window.gremlinIdentity?.(area)?.image || "/assets/gremlin.webp";
        image.alt = "";
        image.width = image.height = 48;
        const copy = node("div", "project-pm-copy"),
          heading = node("h3");
        heading.append(
          link(area.name || area.key, path(project.name, area.key)),
        );
        copy.append(
          heading,
          node(
            "p",
            "project-pm-mandate",
            area.charter?.goal ||
              area.mandate ||
              "Add a mandate to give this PM direction.",
          ),
        );
        card.append(
          image,
          copy,
          pmLiveState(project, area, { compact: true }),
          window.renderPmControls(project, area, {
            locked,
            jobs: getJobs?.() || [],
            operation: options.getAreaAction?.(project.name, area.key),
          }),
        );
        cards.append(card);
      }
      if (!project.areas?.length) {
        const empty = node("div", "project-crew-empty adoption-project-empty"),
          portrait = node("img"),
          invitation = node("div");
        portrait.src = "/assets/gremlin.webp";
        portrait.alt =
          "A green gremlin holding a checked report, ready for its first assignment";
        portrait.width = 132;
        portrait.height = 148;
        invitation.append(
          node("span", "eyebrow muted", "A LITTLE CREATURE. A REAL JOB."),
          node("h3", "", "Who will be your first gremlin?"),
          node(
            "p",
            "",
            "Choose something you want taken care of. We’ll help you give your PM a name, a focused job, and a first assignment.",
          ),
        );
        const add = button(
          "Adopt your first gremlin",
          () => onCreatePm(project.name),
          "button button-dark",
        );
        add.disabled = locked;
        invitation.append(add);
        empty.append(portrait, invitation);
        cards.append(empty);
      }
      crew.append(cards);
      root.append(crew);
      if (!setupIncomplete)
        welcome?.mount(root, project, {
          suggestionsOnly: true,
          setupOnly: Boolean(crewRecommendations),
        });
      crewRecommendations?.mount(root, project, { hideWhenEmpty: true });
      const tools = node("section", "project-tools");
      for (const [title, description, tab, label] of [
        [
          "What your crew knows",
          "Saved findings, feature maps, and your product decisions.",
          "knowledge",
          "Open product knowledge",
        ],
        [
          "Try a customer perspective",
          "Grumblins simulate a customer journey. Their profiles are hypotheses, not actual customer research.",
          "grumblins",
          "Open Grumblins",
        ],
      ]) {
        const card = node("article", "project-tool");
        card.append(
          node("h3", "", title),
          node("p", "", description),
          link(label, path(project.name, "", tab), "small-button"),
        );
        tools.append(card);
      }
      root.append(tools);
      if (project.areas?.length)
        root.append(
          window.renderCodingLauncher(project, {
            locked,
            jobs: getJobs?.() || [],
            operation: options.getCodingAction?.(project.name),
          }),
        );
    }
    function settingsWorkspace(project) {
      const tools = node("section", "project-tools");
      for (const [title, description, tab, label] of [
        [
          "Test environment",
          "Prepare browser access only when the work needs a running app.",
          "environment",
          "Manage environment",
        ],
        [
          "Work limits",
          "Bound concurrent runs and the time your crew can spend.",
          "limits",
          "Manage run limits",
        ],
      ]) {
        const card = node("article", "project-tool");
        card.append(
          node("h3", "", title),
          node("p", "", description),
          link(label, path(project.name, "", tab), "small-button"),
        );
        tools.append(card);
      }
      root.append(tools);
      const context = node("section", "project-details project-reference");
      context.append(node("h2", "", "Project details"));
      const contextBody = node("div", "project-details-body");
      const facts = [
        ["Repository", project.repo],
        [
          "Delivery",
          project.workflow?.kind === "promotion"
            ? "Staged promotion workflow"
            : `Draft PR / MR → ${project.workflow?.baseBranch || "main"}`,
        ],
        [
          "Verification",
          project.verification?.mode === "browser"
            ? project.verification.environment
            : "Repository checks",
        ],
        [
          "Linear team",
          project.linear?.teamName ||
            (project.linear?.teamId ? "Team mapped" : "Not connected yet"),
        ],
      ];
      for (const [label, value] of facts) {
        const item = node("dl", "project-fact");
        item.append(node("dt", "", label), node("dd", "", value));
        contextBody.append(item);
      }
      const setup = node("div", "project-pm-actions");
      const check = options.getCheck?.(project.name);
      const verify = action(check?.busy ? "Verifying…" : "Verify connections", {
        verifyProject: project.name,
      });
      verify.disabled = locked || check?.busy === true;
      setup.append(
        verify,
        action("Linear mappings", {
          editProject: project.name,
          editLinear: "true",
        }),
      );
      contextBody.append(setup);
      if (check?.message) {
        const result = node(
          "div",
          `project-workspace-notice${check.error ? " error" : ""}`,
        );
        result.setAttribute("role", "status");
        result.append(node("p", "", check.message));
        if (check.checks?.length) {
          const details = node("details");
          details.append(node("summary", "", "Connection checks"));
          for (const item of check.checks)
            details.append(
              node(
                "p",
                "",
                `${item.ok ? "✓" : "!"} ${item.name}: ${item.detail}`,
              ),
            );
          result.append(details);
        }
        contextBody.append(result);
      }
      const blocker = project.readiness?.blockers?.[0];
      if (blocker) {
        contextBody.append(
          node("p", "project-workspace-notice", blocker.message),
        );
        if (blocker.action)
          contextBody.append(
            action("Finish setup", {
              setupAction: blocker.action,
              setupProject: project.name,
              setupStep: blocker.id,
            }),
          );
      }
      context.append(contextBody);
      root.append(context);
    }
    function pmWorkspace(project, area) {
      const layout = node("div", "pm-workspace-layout");
      const main = node("div", "pm-workspace-body"),
        heading = node("div", "pm-workspace-heading"),
        image = node("img");
      image.src =
        window.gremlinIdentity?.(area)?.image || "/assets/gremlin.webp";
      image.alt = "";
      const title = node("div");
      title.append(
        node("span", "eyebrow muted", "PM GREMLIN"),
        node("h1", "", area.name || area.key),
        node(
          "p",
          "pm-heading-purpose",
          area.charter?.goal ||
            area.mandate ||
            "Give this gremlin a focused product area.",
        ),
      );
      heading.append(image, title, projectActions(project));
      main.append(heading);
      if (project.areas?.length > 1) {
        const navigation = node("nav", "pm-crew-switcher");
        navigation.setAttribute("aria-label", "Project PMs");
        for (const pm of project.areas) {
          const item = link(pm.name || pm.key, path(project.name, pm.key));
          if (pm.key === area.key) item.setAttribute("aria-current", "page");
          navigation.append(item);
        }
        main.append(navigation);
      }
      main.append(pmLiveState(project, area));
      if (window.renderPatrolPlan)
        main.append(window.renderPatrolPlan(project, { compact: true }));
      main.append(
        window.renderPmControls(project, area, {
          locked,
          jobs: getJobs?.() || [],
          operation: options.getAreaAction?.(project.name, area.key),
        }),
      );
      const tab = tabs.some(([key]) => key === pages.tab) ? pages.tab : "brief";
      let exploration;
      if (tab === "brief" && !project.foundation?.needed) {
        const explore = node("section", "product-exploration-card"),
          copy = node("div");
        copy.append(
          node("h3", "", "What could this product become?"),
          node(
            "p",
            "",
            "Explore unmet needs, new workflows, and ideas beyond the current app. Get a reasoned proposal with evidence, assumptions, and a small experiment to try.",
          ),
        );
        const launch = action("Explore product ideas", {
          launchProject: project.name,
          launchCrew: "pm",
          launchArea: area.key,
          pmMode: "exploration",
        });
        launch.disabled =
          locked ||
          Boolean(options.getAreaAction?.(project.name, area.key)?.busy);
        explore.append(copy, launch);
        exploration = explore;
      }
      const nav = node("nav", "pm-workspace-tabs");
      nav.setAttribute("aria-label", "PM workspace sections");
      for (const [key, label] of tabs) {
        const item = link(label, path(project.name, area.key, key));
        if (key === tab) item.setAttribute("aria-current", "page");
        nav.append(item);
      }
      main.append(nav);
      const discoveryReadiness = project.readiness?.areas?.find(
        (item) => item.key === area.key,
      )?.discovery;
      if (tab === "discovery" && discoveryReadiness?.canRun === false) {
        const blocker = discoveryReadiness.blockers?.[0];
        const setup = node("div", "project-workspace-notice");
        setup.append(
          node(
            "p",
            "",
            blocker?.message ||
              "Connect source control, Claude, and a verified worker to run discovery.",
          ),
        );
        if (blocker?.action)
          setup.append(
            action("Set up discovery", {
              setupAction: blocker.action,
              setupProject: project.name,
              setupStep: blocker.id,
              setupArea: area.key,
            }),
          );
        main.append(setup);
      }
      const data = knowledge.get(`${project.name}/${area.key}`),
        notice = notices.get(`${project.name}/${area.key}`);
      if (notice) main.append(node("p", "project-workspace-notice", notice));
      const content = node("section", "pm-workspace-content");
      content.setAttribute("aria-label", tabs.find(([key]) => key === tab)[1]);
      if (tab === "brief") {
        const briefHeading = node("div", "pm-brief-heading");
        briefHeading.append(
          node("h3", "", "Mandate"),
          button("Edit brief", () => openBrief(project.name, area.key)),
        );
        content.append(
          briefHeading,
          node(
            "p",
            "pm-mandate-copy",
            area.mandate ||
              "No mandate saved yet. Edit the brief to define this PM’s purpose.",
          ),
        );
        const advanced = node("section", "pm-brief-details");
        advanced.append(node("h3", "", "Product brief & schedule"));
        const charter = node("div", "pm-charter-grid");
        for (const [key, label] of Object.entries(briefLabels)) {
          const value = area.charter?.[key];
          if (!value?.length) continue;
          const section = node("section", "pm-charter-section");
          section.append(node("h4", "", label));
          if (Array.isArray(value)) {
            const list = node("ul");
            for (const text of value) list.append(node("li", "", text));
            section.append(list);
          } else section.append(node("p", "", value));
          charter.append(section);
        }
        if (!charter.children.length)
          advanced.append(
            node(
              "p",
              "runner-guidance",
              "Add product ambition, audiences, expected capabilities, and guardrails in Edit brief. A clear charter helps the PM judge what is missing.",
            ),
          );
        else advanced.append(charter);
        advanced.append(
          node("h4", "", "Work rhythm"),
          node(
            "p",
            "",
            `${area.schedule || "No schedule"} UTC · Up to ${area.wipLimit || 1} open work items`,
          ),
        );
        advanced.append(
          node(
            "p",
            "runner-guidance",
            "Discovery maps the product. Patrols investigate it. Automation adds scheduled patrols and approved-ticket pickup; it never approves its own tickets.",
          ),
        );
        content.append(advanced);
      } else if (tab === "activity")
        content.append(
          node("h3", "", "This PM’s runs"),
          activityList(project, area),
        );
      else {
        if (tab === "discovery") {
          const learning = node("div", "pm-learning-actions");
          learning.append(
            node(
              "div",
              "",
              "Discovery reads code and saves knowledge. It does not open the app or file tickets. Use Run now for a patrol.",
            ),
            discoveryButton(project, area),
          );
          content.append(learning);
        }
        const statusRow = node("div", "knowledge-status");
        const state = !data
          ? notice
            ? "Saved knowledge is unavailable. Use Refresh to try again."
            : "Loading saved knowledge…"
          : data.state === "refreshing"
            ? "Discovery is running. Previous knowledge stays available."
            : data.state === "failed"
              ? "The latest discovery did not finish. Previous knowledge is retained."
              : data.stale
                ? "This knowledge predates the current settings. Run discovery to refresh it."
                : data.provenance
                  ? `Updated ${when(data.provenance.completedAt)} · run ${data.provenance.runId}`
                  : "No discovery saved yet.";
        statusRow.append(
          node("p", "", state),
          button("Refresh", refreshKnowledge),
        );
        content.append(statusRow);
        if (tab === "discovery")
          setupSuggestions?.mount(content, project.name, area.key);
        const file = data?.documents?.find((item) => item.name === `${tab}.md`);
        if (file?.content)
          content.append(
            window.renderKnowledgeDocument(file.content, {
              setupProposal:
                tab === "discovery"
                  ? setupSuggestions?.proposal(project.name, area.key)
                  : undefined,
            }),
          );
        else {
          const empty = node("div", "workspace-empty"),
            art = node("img");
          art.src = "/assets/gremlin-security.webp";
          art.alt = "";
          const descriptions = {
            discovery:
              "A grounded map of the product, its users, flows, and gaps.",
            features:
              "An inventory of what exists, what is partial, and what the brief expects.",
            queue:
              "Ranked opportunities with evidence and rationale. Proposals still need your approval before coding.",
            memory:
              "Durable observations and lessons for future investigations.",
          };
          empty.append(
            art,
            node(
              "h3",
              "",
              `Build this PM’s ${tab === "queue" ? "ranked queue" : tab}`,
            ),
            node("p", "", descriptions[tab]),
          );
          if (tab !== "discovery")
            empty.append(
              link(
                "Open Learning →",
                path(project.name, area.key, "discovery"),
                "small-button",
              ),
            );
          content.append(empty);
        }
        if (data?.provenance)
          content.append(
            node(
              "p",
              "runner-guidance",
              `${data.provenance.repository || project.repo} · ${data.provenance.branch || "repository"}${data.provenance.commitSha ? ` · ${data.provenance.commitSha.slice(0, 12)}` : ""}`,
            ),
          );
        if (data?.latestRun?.id)
          content.append(
            button("View discovery activity →", () =>
              options.onActivity(data.latestRun.id),
            ),
          );
      }
      main.append(content);
      if (exploration) main.append(exploration);
      const deletion = disclosure(
        "manage-pm",
        "Manage PM",
        "pm-delete-action workspace-disclosure",
      );
      const remove = button(
        "Delete PM",
        () =>
          options.onDelete?.({
            project: project.name,
            area: area.key,
            trigger: remove,
          }),
        "small-button danger-button",
      );
      remove.disabled = locked;
      deletion.append(remove);
      main.append(deletion);
      layout.append(main);
      root.append(layout);
    }
    function render() {
      renderSidebar();
      if (pages.current !== "project") return;
      const { project, area } = selected();
      const next = JSON.stringify([
        project,
        pages.pm,
        pages.tab,
        knowledge.get(activeKey()),
        notices.get(activeKey()),
        project?.areas?.map((item) =>
          notices.get(`${project.name}/${item.key}`),
        ),
        locked,
        launching,
        options.getCheck?.(project?.name),
        options.getCodingAction?.(project?.name),
        options.getAreaAction?.(project?.name, area?.key),
        project?.areas?.map((item) =>
          options.getAreaAction?.(project.name, item.key),
        ),
        (getJobs?.() || []).filter(
          (job) =>
            job.project === project?.name &&
            (job.projectInstanceId ?? null) === (project?.instanceId ?? null),
        ),
      ]);
      if (signature === next) return;
      const currentRoute = `${pages.project}/${pages.pm}/${pages.tab}`;
      if (
        renderedRoute === currentRoute &&
        (options.operations?.protectFocus(root) ||
          options.onboarding?.protectFocus(root) ||
          grumblins?.protectFocus() ||
          missions?.protectFocus() ||
          welcome?.protectFocus() ||
          crewRecommendations?.protectFocus?.() ||
          setupSuggestions?.protectFocus())
      )
        return;
      renderedRoute = currentRoute;
      signature = next;
      // Live job and knowledge updates replace this subtree. Preserve route
      // focus only if its heading already owned focus; polling must not take
      // focus away from inputs, controls, or another part of the dashboard.
      const restoreHeadingFocus =
        document.activeElement?.tagName === "H1" &&
        root.contains?.(document.activeElement);
      root.replaceChildren();
      if (!status) {
        root.append(node("p", "runner-guidance", "Loading project…"));
        return;
      }
      if (!project) {
        root.append(
          node("h1", "", "Project not found"),
          node(
            "p",
            "runner-guidance",
            "This project is not configured on this server.",
          ),
          link("Back to projects", "/projects", "small-button"),
        );
        return;
      }
      const header = node("header", "workspace-project-header"),
        identity = node("div");
      identity.append(
        node("span", "eyebrow muted", "PROJECT"),
        node("h1", "", project.name),
        node(
          "p",
          "project-repository",
          project.repo || "Repository not connected",
        ),
      );
      header.append(identity, projectActions(project));
      if (!area) root.append(header);
      if (!pages.pm) {
        const navigation = node("nav", "project-top-tabs");
        navigation.setAttribute("aria-label", "Project sections");
        for (const [key, label] of [
          ["overview", "Overview"],
          ["review", "Proposals"],
          ["changes", "Changes"],
          ["crew", "Your crew"],
          ["settings", "Settings"],
        ]) {
          const item = link(label, path(project.name, "", key));
          const activeTab = ["brief", "overview"].includes(pages.tab)
            ? "overview"
            : ["knowledge", "grumblins", "setup"].includes(pages.tab)
              ? "crew"
              : ["environment", "limits"].includes(pages.tab)
                ? "settings"
                : pages.tab === "delivery"
                  ? "changes"
                  : pages.tab;
          if (activeTab === key) item.setAttribute("aria-current", "page");
          navigation.append(item);
        }
        root.append(navigation);
      }
      if (pages.pm && !area)
        root.append(
          node(
            "p",
            "project-workspace-notice",
            "This PM no longer exists. Choose a PM from the project overview.",
          ),
          link("Project overview", path(project.name), "small-button"),
        );
      else if (area) pmWorkspace(project, area);
      else if (pages.tab === "crew") crewWorkspace(project);
      else if (pages.tab === "setup") welcome?.mount(root, project);
      else if (pages.tab === "settings") settingsWorkspace(project);
      else if (pages.tab === "changes")
        missions?.mount(root, project, "changes");
      else if (pages.tab === "environment")
        options.onboarding?.mount(root, project);
      else if (pages.tab === "grumblins") grumblins?.mount(root, project);
      else if (
        ["review", "knowledge", "delivery", "limits"].includes(pages.tab)
      )
        options.operations?.mount(root, project, pages.tab);
      else home(project);
      if (restoreHeadingFocus) {
        const heading = root.querySelector("h1");
        heading?.setAttribute("tabindex", "-1");
        heading?.focus({ preventScroll: true });
      }
    }
    function routeChanged() {
      const project = selected().project;
      const recommendationsVisible =
        pages.current === "project" &&
        !pages.pm &&
        project &&
        (pages.tab === "crew" ||
          ["", "brief", "overview"].includes(pages.tab || ""));
      if (!recommendationsVisible) crewRecommendations?.deactivate?.();
      setupSuggestions?.setActive(
        pages.current === "project" && pages.tab === "discovery"
          ? `${pages.project}/${pages.pm}`
          : "",
      );
      const key = activeKey();
      if (key !== contextKey) {
        stopKnowledge();
        contextKey = key;
      }
      render();
      grumblins?.resume(status?.projects || []);
      welcome?.resume(status?.projects || []);
      crewRecommendations?.resume?.(status?.projects || []);
      if (key) refreshKnowledge();
    }
    window.addEventListener("dashboard:pagechange", routeChanged);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopKnowledge();
      else routeChanged();
    });
    window.addEventListener("pagehide", stopKnowledge);
    window.addEventListener("pagehide", () =>
      crewRecommendations?.deactivate?.(),
    );
    return {
      setStatus(value, disabled) {
        for (const previous of status?.projects || []) {
          const next = value.projects?.find(
            (project) => project.name === previous.name,
          );
          if (
            !next ||
            (previous.instanceId ?? null) !== (next.instanceId ?? null)
          )
            this.forget(previous.name);
        }
        status = value;
        locked = disabled;
        editorLock(editor.busy);
        routeChanged();
      },
      render,
      discover,
      openBrief,
      isDirty,
      isBusy: () =>
        editor.busy ||
        launching ||
        missions?.isBusy() ||
        welcome?.isBusy() ||
        crewRecommendations?.isBusy?.() ||
        setupSuggestions?.isBusy() ||
        grumblins?.isBusy(),
      refresh: refreshKnowledge,
      forget(project, area) {
        stopKnowledge();
        for (const key of knowledge.keys())
          if (
            key.startsWith(`${project}/`) &&
            (!area || key === `${project}/${area}`)
          ) {
            knowledge.delete(key);
            notices.delete(key);
          }
        setupSuggestions?.forget(project, area);
        if (!area) options.onboarding?.forget(project);
        if (!area) options.operations?.forget(project);
        if (!area) grumblins?.forget(project);
        if (!area) missions?.forget(project);
        if (!area) welcome?.forget(project);
        if (!area) crewRecommendations?.forget?.(project);
        if (editor.project === project && (!area || editor.area === area)) {
          finishClose();
          editor.original = "";
          editor.form = null;
        }
        signature = "";
        sidebarSignature = "";
        contextKey = "";
      },
    };
  };
})();
