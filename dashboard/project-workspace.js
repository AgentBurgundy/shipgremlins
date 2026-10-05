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
  window.renderKnowledgeDocument = (content) => {
    const root = node("div", "knowledge-document");
    const lines = String(content || "").split(/\r?\n/);
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
    const { api, pages, onSaved, onJob, onCreatePm, getJobs } = options;
    const setupSuggestions = window.createSetupSuggestions?.({
      api,
      onSaved,
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
            ? Number(input.value)
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
            rows = 3,
            required = false,
            max = 4000,
          } = {},
        ) => {
          const field = node("div", "field");
          const caption = node("label", "", label);
          caption.htmlFor = `edit-brief-${key}`;
          const input = node(number ? "input" : "textarea");
          input.id = caption.htmlFor;
          input.required = required;
          if (number) {
            input.type = "number";
            input.min = "1";
            input.max = "20";
          } else {
            input.rows = rows;
            input.maxLength = max;
          }
          input.value = list
            ? (brief[key] || []).join("\n")
            : String(brief[key] ?? "");
          fields.set(key, { input, list, number });
          field.append(caption, input);
          return field;
        };
        form.append(
          addField("name", "PM name", { rows: 1, required: true, max: 100 }),
          addField("mandate", "Mandate", {
            rows: 6,
            required: true,
            max: 12000,
          }),
        );
        const charterRoot = node("div");
        form.append(charterRoot);
        editor.charter = window.createPmCharter(
          charterRoot,
          "edit-charter",
          brief.charter || {},
        );
        const advanced = node("details", "charter-group");
        advanced.append(
          node("summary", "", "Ownership, schedule & work limits"),
        );
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
        );
        form.append(advanced);
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
        "+ PM",
        () => onCreatePm(project.name),
        "button button-dark",
      );
      add.setAttribute("aria-label", `Create a PM for ${project.name}`);
      add.disabled = locked;
      actions.append(settings, add);
      return actions;
    }
    function activityList(project, area, limit = 12) {
      const list = node("div");
      const jobs = (getJobs?.() || [])
        .filter(
          (job) =>
            job.project === project.name &&
            (job.projectInstanceId ?? null) === (project.instanceId ?? null) &&
            (!area || job.area === area.key),
        )
        .slice()
        .sort((a, b) => b.runId - a.runId)
        .slice(0, limit);
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
          node(
            "strong",
            "",
            `${job.pmMode === "discovery" ? "Discovery" : job.type === "pm" ? "PM patrol" : "Coding run"} · ${job.area || job.ticket || ""}`,
          ),
          node(
            "span",
            "",
            `Run ${job.runId} · ${job.status} · ${when(job.createdAt)}`,
          ),
        );
        list.append(row);
      }
      return list;
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
    function home(project) {
      root.append(window.renderPatrolPlan(project, { compact: true }));
      if (project.verification?.mode !== "browser" && !project.areas?.length) {
        const setup = node("section", "onboarding-setup-callout"),
          copy = node("div");
        copy.append(
          node("strong", "", "Give your crew a safe place to test."),
          node(
            "p",
            "",
            "Analyze the repository or connect a test URL. You can also keep this project repository-only.",
          ),
        );
        setup.append(
          copy,
          link(
            "Set up environment",
            path(project.name, "", "environment"),
            "small-button",
          ),
        );
        root.append(setup);
      }
      const crew = node("section", "project-crew-section");
      const title = node("div", "project-section-title");
      title.append(
        node("h2", "", "PM Gremlins"),
        node("span", "project-crew-count", String(project.areas?.length || 0)),
      );
      crew.append(title);
      const cards = node("div", "project-crew-list");
      for (const area of project.areas || []) {
        const card = node("article", "project-pm-row"),
          image = node("img");
        image.src = "/assets/gremlin-security.webp";
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
          window.renderPmControls(project, area, {
            locked,
            jobs: getJobs?.() || [],
            operation: options.getAreaAction?.(project.name, area.key),
          }),
        );
        cards.append(card);
      }
      if (!project.areas?.length) {
        const empty = node("div", "project-crew-empty");
        empty.append(
          node("h3", "", "What should your first PM investigate?"),
          node(
            "p",
            "",
            "Give it a mandate. You can run it once before turning on automation.",
          ),
        );
        const add = button(
          "Create your first PM",
          () => onCreatePm(project.name),
          "button button-dark",
        );
        add.disabled = locked;
        empty.append(add);
        cards.append(empty);
      }
      crew.append(cards);
      root.append(crew);
      const coding = node("section", "project-coding-section"),
        codingImage = node("img"),
        codingCopy = node("div", "project-coding-copy");
      codingImage.src = "/assets/gremlin-coding.webp";
      codingImage.alt = "";
      codingImage.width = codingImage.height = 40;
      codingCopy.append(
        node("h2", "", "Coding Gremlins"),
        node("p", "", "Turn an approved ticket into a tested draft PR."),
      );
      coding.append(
        codingImage,
        codingCopy,
        action("Run coding", {
          launchProject: project.name,
          launchCrew: "developer",
        }),
      );
      root.append(coding);
      const recent = node("section", "project-recent-activity");
      recent.append(
        node("h2", "", "Recent activity"),
        activityList(project, null, 4),
      );
      root.append(recent);
      const context = disclosure(
        "details",
        "Project details",
        "project-details workspace-disclosure",
      );
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
      const guidance = disclosure(
        "guidance",
        "Setup & next steps",
        "project-guidance workspace-disclosure",
      );
      options.operations?.mount(guidance, project, "overview");
      context.append(guidance);
      root.append(context);
    }
    function pmWorkspace(project, area) {
      const layout = node("div", "pm-workspace-layout"),
        navigation = node("nav", "pm-workspace-nav");
      navigation.setAttribute("aria-label", "Project PMs");
      navigation.append(
        link("← Project overview", path(project.name), "pm-back"),
      );
      for (const pm of project.areas?.length > 1 ? project.areas : []) {
        const item = link(pm.name || pm.key, path(project.name, pm.key));
        if (pm.key === area.key) item.setAttribute("aria-current", "page");
        navigation.append(item);
      }
      const main = node("div", "pm-workspace-body"),
        heading = node("div", "pm-workspace-heading"),
        image = node("img");
      image.src = "/assets/gremlin-security.webp";
      image.alt = "";
      const title = node("div");
      title.append(
        node("span", "eyebrow muted", "PM GREMLIN"),
        node("h2", "", area.name || area.key),
      );
      heading.append(image, title);
      main.append(heading);
      main.append(
        window.renderPmControls(project, area, {
          locked,
          jobs: getJobs?.() || [],
          operation: options.getAreaAction?.(project.name, area.key),
        }),
      );
      const tab = tabs.some(([key]) => key === pages.tab) ? pages.tab : "brief";
      if (tab === "brief") main.append(window.renderPatrolPlan(project));
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
        const advanced = disclosure(
          "brief-details",
          "Product brief & schedule",
          "pm-brief-details workspace-disclosure",
        );
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
          content.append(window.renderKnowledgeDocument(file.content));
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
      layout.append(navigation, main);
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
        locked,
        launching,
        options.getCheck?.(project?.name),
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
          options.onboarding?.protectFocus(root))
      )
        return;
      renderedRoute = currentRoute;
      signature = next;
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
        link("← All projects", "/projects", "project-back"),
        node("h1", "", project.name),
      );
      header.append(identity, projectActions(project));
      root.append(header);
      if (!pages.pm) {
        const navigation = node("nav", "project-top-tabs");
        navigation.setAttribute("aria-label", "Project sections");
        for (const [key, label] of [
          ["overview", "Overview"],
          ["environment", "Environment"],
          ["review", "Review"],
          ["knowledge", "Knowledge"],
          ["delivery", "Delivery"],
          ["limits", "Run limits"],
        ]) {
          const item = link(label, path(project.name, "", key));
          if ((pages.tab === "brief" ? "overview" : pages.tab) === key)
            item.setAttribute("aria-current", "page");
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
      else if (pages.tab === "environment")
        options.onboarding?.mount(root, project);
      else if (
        ["review", "knowledge", "delivery", "limits"].includes(pages.tab)
      )
        options.operations?.mount(root, project, pages.tab);
      else home(project);
    }
    function routeChanged() {
      const key = activeKey();
      if (key !== contextKey) {
        stopKnowledge();
        contextKey = key;
      }
      render();
      if (key) refreshKnowledge();
    }
    window.addEventListener("dashboard:pagechange", routeChanged);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopKnowledge();
      else routeChanged();
    });
    window.addEventListener("pagehide", stopKnowledge);
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
      isBusy: () => editor.busy || launching || setupSuggestions?.isBusy(),
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
