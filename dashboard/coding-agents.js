"use strict";
(() => {
  const names = { claude: "Claude Code", codex: "Codex" };
  const node = (tag, cls = "", text) => {
    const value = document.createElement(tag);
    value.className = cls;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const button = (text, action, cls = "small-button") => {
    const value = node("button", cls, text);
    value.type = "button";
    value.addEventListener("click", action);
    return value;
  };
  const inputAgent = (agent) => ({
    key: agent.key,
    ...(agent.instanceId ? { instanceId: agent.instanceId } : {}),
    name: agent.name,
    enabled: agent.enabled === true,
    areas: [...agent.areas],
    maxConcurrent: agent.maxConcurrent,
    ...(agent.ai ? { ai: { ...agent.ai } } : {}),
  });
  const identity = (project) =>
    `${project.name}/${project.instanceId || "legacy"}`;
  window.createCodingAgents = ({
    api,
    getJobs,
    isLocked,
    onChanged,
    onJob,
  }) => {
    const states = new Map();
    const models = window.createAiModelChoices({ api });
    const dialog = node("dialog", "coder-editor");
    dialog.setAttribute("aria-labelledby", "coder-editor-title");
    const header = node("header", "coder-editor-header"),
      heading = node("div"),
      title = node("h2", "", "Add a coding agent"),
      subtitle = node("p"),
      close = button("Close ×", requestClose),
      form = node("form", "coder-editor-form"),
      fields = node("fieldset", "coder-editor-fields"),
      footer = node("footer", "coder-editor-footer"),
      notice = node("p", "form-message coder-editor-notice"),
      save = node("button", "button button-dark", "Save coding agent"),
      discard = node("div", "coder-editor-discard"),
      deletePrompt = node("div", "coder-editor-discard");
    title.id = "coder-editor-title";
    heading.append(
      node("span", "mission-kicker", "CODING AGENT"),
      title,
      subtitle,
    );
    header.append(heading, close);
    fields.append(node("legend", "sr-only", "Coding agent settings"));
    const field = (label, input, hint) => {
      const root = node("div", "field"),
        caption = node("label", "", label);
      caption.htmlFor = input.id;
      root.append(caption, input);
      if (hint) root.append(node("p", "setup-help", hint));
      return root;
    };
    const name = node("input"),
      capacity = node("select"),
      provider = node("select"),
      model = node("select"),
      modelHint = node("p", "setup-help"),
      queues = node("fieldset", "coder-queue-fields"),
      enabled = node("input"),
      enabledLabel = node("label", "coder-enabled-field"),
      effective = node("p", "coder-effective"),
      selection = node("div", "coder-ai-fields");
    name.id = "coder-name";
    name.type = "text";
    name.required = true;
    name.maxLength = 100;
    capacity.id = "coder-capacity";
    for (const count of [1, 2, 3, 4]) {
      const option = node(
        "option",
        "",
        `${count} ${count === 1 ? "run" : "runs"} at a time`,
      );
      option.value = String(count);
      capacity.append(option);
    }
    provider.id = "coder-provider";
    for (const [value, label] of [
      ["", "Inherit project coding choice"],
      ["claude", "Claude Code"],
      ["codex", "Codex"],
    ]) {
      const option = node("option", "", label);
      option.value = value;
      provider.append(option);
    }
    model.id = "coder-model";
    modelHint.id = "coder-model-catalog";
    model.setAttribute("aria-describedby", modelHint.id);
    const modelChoice = models.bind(model, modelHint);
    selection.append(
      field("AI provider", provider),
      field("Model", model),
      modelHint,
      effective,
    );
    enabled.type = "checkbox";
    enabled.id = "coder-enabled";
    enabledLabel.htmlFor = enabled.id;
    enabledLabel.append(
      enabled,
      node("span", "", "Automatically pick up approved work"),
    );
    fields.append(
      field("Agent name", name),
      queues,
      field(
        "Capacity",
        capacity,
        "Project run limits still apply. Each run implements one approved ticket.",
      ),
      selection,
      enabledLabel,
      node(
        "p",
        "setup-help",
        "This agent implements approved tickets from its assigned PM queues. It does not investigate, approve tickets, or change PM schedules. You can run it once while automatic pickup is paused.",
      ),
    );
    notice.hidden = true;
    notice.setAttribute("role", "status");
    save.type = "submit";
    const reload = button("Reload saved agent", () =>
        openEditor(editor.state, editor.key, editor.trigger, true),
      ),
      remove = button(
        "Delete agent",
        () => {
          if (!editor || editor.busy || isLocked()) return;
          if (dirty())
            return announce(
              "Save or discard your draft before deleting this agent.",
              true,
            );
          deletePrompt.hidden = false;
          deletePrompt.querySelector("button")?.focus();
        },
        "small-button danger-button",
      ),
      keep = button("Keep editing", () => {
        discard.hidden = true;
        close.focus();
      }),
      discardChanges = button("Discard edits", finishClose),
      cancelDelete = button("Keep agent", () => {
        deletePrompt.hidden = true;
        remove.focus();
      }),
      confirmDelete = button(
        "Delete this agent",
        deleteAgent,
        "small-button danger-button",
      );
    discard.hidden = deletePrompt.hidden = true;
    discard.append(
      node("p", "", "You have unsaved changes to this coding agent."),
      keep,
      discardChanges,
    );
    deletePrompt.append(
      node(
        "p",
        "",
        "Delete this coding agent? Current runs keep their recorded identity and can finish. Other agents and PMs are kept.",
      ),
      cancelDelete,
      confirmDelete,
    );
    const actions = node("div", "button-row");
    actions.append(remove, reload, save);
    footer.append(notice, actions);
    form.append(fields, discard, deletePrompt, footer);
    dialog.append(header, form);
    document.body.append(dialog);
    let editor = null;
    const announce = (message, error = false) => {
      notice.textContent = message;
      notice.hidden = !message;
      notice.classList.toggle("error", error);
      notice.setAttribute("role", error ? "alert" : "status");
    };
    function stateFor(project) {
      const key = identity(project);
      let state = states.get(key);
      if (!state) {
        state = {
          project,
          root: node("section", "coding-agents"),
          saved: null,
          busy: false,
          loaded: false,
          error: "",
          message: "",
          launches: new Map(),
        };
        state.root.setAttribute(
          "aria-label",
          `Coding agents for ${project.name}`,
        );
        states.set(key, state);
      }
      state.project = project;
      if (
        project.coders &&
        !state.busy &&
        editor?.state !== state &&
        (!state.saved || project.coders.revision !== state.observedRevision)
      ) {
        state.saved = project.coders;
        state.observedRevision = project.coders.revision;
        state.loaded = true;
      }
      return state;
    }
    function currentJobs(state, agent) {
      return (getJobs?.() || []).filter(
        (job) =>
          job.type === "developer" &&
          job.project === state.project.name &&
          (job.projectInstanceId ?? null) ===
            (state.project.instanceId ?? null) &&
          job.coderKey === agent.key &&
          (!agent.instanceId || job.coderInstanceId === agent.instanceId),
      );
    }
    function draw(state) {
      const project = state.project,
        view = state.saved;
      state.root.replaceChildren();
      const heading = node("div", "coding-agents-heading"),
        copy = node("div");
      copy.append(
        node("span", "mission-kicker", `IMPLEMENTATION · ${project.name}`),
        node("h2", "", "Coding agents"),
        node(
          "p",
          "",
          "Named agents with their own queues, capacity, and AI choice.",
        ),
      );
      const add = button(
        "Add coding agent",
        () => openEditor(state, null, add),
        "button button-dark",
      );
      add.dataset.coderAction = "add";
      const unreadable =
        Boolean(view?.error) || (view && typeof view.revision !== "string");
      add.disabled = isLocked() || state.busy || !view || unreadable;
      if (view?.agents?.length >= 20) {
        add.disabled = true;
        add.title = "This project already has the maximum of 20 coding agents.";
      }
      heading.append(copy, add);
      state.root.append(heading);
      if (state.message || state.error) {
        const message = node(
          "p",
          `form-message${state.error ? " error" : ""}`,
          state.error || state.message,
        );
        message.setAttribute("role", state.error ? "alert" : "status");
        state.root.append(message);
      }
      if (!view || unreadable) {
        const unavailable = node(
          "p",
          "coder-empty",
          unreadable
            ? view.error ||
                "Coding agents could not be read safely. Refresh to try again."
            : state.loaded
              ? "Coding agents could not load. Refresh to try again."
              : "Loading coding agents…",
        );
        if (unreadable) unavailable.setAttribute("role", "alert");
        state.root.append(unavailable);
        const refresh = button("Refresh coding agents", () => load(state));
        refresh.disabled = isLocked() || state.busy;
        state.root.append(refresh);
        return;
      }
      if (view.legacy)
        state.root.append(
          node(
            "p",
            "coder-legacy-note",
            "These agents preserve your previous approved-coding settings. Save an agent to manage coding independently from PMs.",
          ),
        );
      if (project.autonomy?.projectPaused)
        state.root.append(
          node(
            "p",
            "coder-legacy-note",
            "Project automation is paused. Agent pickup settings are kept. Ready agents can still run once.",
          ),
        );
      const cards = node("div", "coder-cards");
      for (const agent of view.agents || []) {
        const card = node("article", "coder-card"),
          title = node("div", "coder-card-title"),
          copy = node("div"),
          jobs = currentJobs(state, agent),
          active = jobs.filter((job) =>
            ["queued", "running"].includes(job.status),
          ),
          operation = state.launches.get(
            `${agent.key}/${agent.instanceId || "legacy"}`,
          ),
          accepted =
            operation?.job && !jobs.some((job) => job.id === operation.job.id)
              ? operation.job
              : null,
          latest =
            active.find((job) => job.status === "running") ||
            active[0] ||
            accepted;
        copy.append(
          node("h3", "", agent.name || agent.key),
          node(
            "p",
            "coder-card-role",
            "Coding agent · approved implementation",
          ),
        );
        const badge = node(
          "span",
          `coder-state${latest ? " is-working" : agent.enabled ? " is-ready" : ""}`,
          latest
            ? latest.status === "running"
              ? "Working"
              : "Queued"
            : agent.enabled
              ? "Automatic pickup on"
              : "Paused",
        );
        title.append(copy, badge);
        const queueNames = agent.areas.map(
          (key) => project.areas?.find((area) => area.key === key)?.name || key,
        );
        const scope = node(
          "p",
          "coder-card-scope",
          queueNames.length
            ? `Queues: ${queueNames.join(" · ")}`
            : "No PM queues assigned",
        );
        const ai = agent.effectiveAi || agent.ai;
        const model = ai?.model ? ` · ${ai.model}` : " · Provider default";
        const aiLabel = node(
          "p",
          "coder-card-ai",
          ai?.provider
            ? `${names[ai.provider] || "AI"}${model}${ai.configured === false ? " · Connection needed" : ""}`
            : "Inherits project coding choice",
        );
        const capacity = node(
          "p",
          "coder-card-capacity",
          `${active.length}/${agent.maxConcurrent} active · ${agent.maxConcurrent === 1 ? "One ticket at a time" : `Up to ${agent.maxConcurrent} tickets at a time`}`,
        );
        const actions = node("div", "coder-card-actions");
        const run = button(
            operation?.busy ? "Starting…" : latest ? "View run" : "Run once",
            () => (latest ? onJob?.(latest) : launch(state, agent)),
            "button button-dark",
          ),
          toggle = button(
            agent.enabled ? "Pause pickup" : "Enable pickup",
            () => toggleAgent(state, agent),
          ),
          edit = button("Edit agent", () => openEditor(state, agent.key, edit));
        run.disabled =
          isLocked() ||
          state.busy ||
          operation?.busy === true ||
          (!latest && agent.readiness?.canEnable === false) ||
          Boolean(operation?.uncertain && !latest);
        toggle.disabled = edit.disabled =
          isLocked() || state.busy || operation?.busy === true;
        if (!agent.enabled && agent.readiness?.canEnable === false) {
          toggle.disabled = true;
          toggle.title =
            "Review the setup steps above before enabling automatic pickup.";
        }
        if (!latest && agent.readiness?.canEnable === false)
          run.title =
            "Review the setup steps above before starting a coding run.";
        run.setAttribute(
          "aria-label",
          `${latest ? "View run for" : "Run"} ${agent.name || agent.key}${latest ? "" : " once"}`,
        );
        toggle.setAttribute(
          "aria-label",
          `${agent.enabled ? "Pause" : "Enable"} automatic pickup for ${agent.name || agent.key}`,
        );
        toggle.setAttribute("aria-pressed", String(agent.enabled));
        edit.setAttribute("aria-label", `Edit ${agent.name || agent.key}`);
        edit.dataset.coderAction = "edit";
        edit.dataset.coderKey = agent.key;
        actions.append(run, toggle, edit);
        card.append(title, scope, aiLabel, capacity);
        if (agent.readiness?.canEnable === false) {
          const blockers = node("div", "coder-blockers");
          for (const blocker of agent.readiness.blockers || [])
            blockers.append(node("p", "", blocker.message));
          const setup = node("a", "coder-setup-link", "Review project setup →");
          setup.href = `/projects/${encodeURIComponent(project.name)}?tab=settings`;
          blockers.append(setup);
          card.append(blockers);
        }
        if (operation?.message) {
          const notice = node(
            "p",
            `form-message${operation.error ? " error" : ""}`,
            operation.message,
          );
          notice.setAttribute("role", operation.error ? "alert" : "status");
          card.append(notice);
        }
        if (operation?.uncertain && !latest) {
          const review = node(
            "a",
            "coder-setup-link",
            "Review Runs before starting again →",
          );
          review.href = "/activity";
          card.append(review);
        }
        card.append(actions);
        cards.append(card);
      }
      if (!view.agents?.length)
        cards.append(
          node(
            "p",
            "coder-empty",
            "No coding agents yet. Add one, assign its PM queues, and choose when it picks up approved work.",
          ),
        );
      state.root.append(cards);
      state.root.setAttribute("aria-busy", String(state.busy));
    }
    async function load(state) {
      if (state.busy || isLocked()) return;
      state.busy = true;
      draw(state);
      try {
        state.saved = await api(
          `/api/projects/${encodeURIComponent(state.project.name)}/coders`,
        );
        state.error = "";
      } catch {
        state.error =
          "Coding agents could not refresh. Existing settings are kept.";
      } finally {
        state.loaded = true;
        state.busy = false;
        draw(state);
      }
    }
    async function persist(state, agents, message) {
      state.saved = await api(
        `/api/projects/${encodeURIComponent(state.project.name)}/coders`,
        { revision: state.saved.revision, agents: agents.map(inputAgent) },
        "PUT",
      );
      state.message = message;
      state.error = "";
      try {
        await onChanged?.();
      } catch {
        state.message +=
          " The dashboard could not refresh; your settings were saved.";
      }
    }
    async function toggleAgent(state, agent) {
      if (state.busy || isLocked() || (editor?.state === state && dirty()))
        return;
      state.busy = true;
      state.error = "";
      draw(state);
      try {
        await persist(
          state,
          state.saved.agents.map((item) =>
            item.key === agent.key
              ? { ...item, enabled: !agent.enabled }
              : item,
          ),
          agent.enabled
            ? "Automatic pickup paused. Current runs can finish."
            : "Automatic pickup enabled for this coding agent.",
        );
      } catch (error) {
        state.error =
          error?.status === 409
            ? error.message ||
              "Settings changed. Refresh coding agents before trying again."
            : "Coding agent could not be updated. Its saved setting is unchanged.";
      } finally {
        state.busy = false;
        draw(state);
      }
    }
    async function launch(state, agent) {
      const key = `${agent.key}/${agent.instanceId || "legacy"}`;
      if (state.busy || isLocked() || state.launches.get(key)?.busy) return;
      const operation = { busy: true };
      state.launches.set(key, operation);
      draw(state);
      try {
        const result = await api(
          "/api/jobs",
          {
            type: "developer",
            project: state.project.name,
            coderKey: agent.key,
            runOnce: true,
          },
          "POST",
          90000,
        );
        if (!result?.job?.id) throw new Error("No confirmed run");
        operation.job = result.job;
        operation.message = result.reused
          ? "Opened the existing run. No duplicate work was started."
          : "Run queued. This agent’s automatic pickup setting is unchanged.";
        try {
          await onChanged?.();
        } catch {
          operation.message += " Open the run to follow progress.";
        }
        try {
          onJob?.(result.job);
        } catch {
          /* The accepted run remains visible on its agent. */
        }
      } catch (error) {
        operation.error = true;
        operation.uncertain = !error?.status;
        operation.message = error?.status
          ? error.message
          : "The server did not confirm whether a run started. Review Runs before trying again.";
      } finally {
        operation.busy = false;
        draw(state);
      }
    }
    function readDraft() {
      return {
        name: name.value.trim(),
        enabled: enabled.checked,
        areas: [...queues.querySelectorAll("input")]
          .filter((input) => input.checked)
          .map((input) => input.value),
        maxConcurrent: Number(capacity.value),
        ...(provider.value
          ? {
              ai: {
                provider: provider.value,
                ...(model.value ? { model: model.value } : {}),
              },
            }
          : {}),
      };
    }
    function dirty() {
      return Boolean(
        editor?.original && JSON.stringify(readDraft()) !== editor.original,
      );
    }
    function syncEditor() {
      const unavailable = !editor || editor.busy || isLocked();
      fields.disabled = save.disabled = reload.disabled = unavailable;
      fields.disabled = save.disabled = unavailable || !editor?.original;
      close.disabled = Boolean(editor?.busy);
      remove.hidden = !editor?.key;
      remove.disabled = unavailable || !editor?.original;
      model.disabled = unavailable || !provider.value;
      dialog.setAttribute("aria-busy", String(Boolean(editor?.busy)));
      save.textContent = editor?.busy ? "Saving…" : "Save coding agent";
    }
    function fill(agent) {
      name.value = agent?.name || "";
      enabled.checked = agent?.enabled === true;
      capacity.value = String(agent?.maxConcurrent || 1);
      provider.value = agent?.ai?.provider || "";
      modelChoice.set(provider.value, agent?.ai?.model || "");
      const effectiveAi = agent?.effectiveAi;
      effective.textContent = effectiveAi
        ? `Current choice: ${names[effectiveAi.provider] || "AI"}${effectiveAi.model ? ` · ${effectiveAi.model}` : " · Provider default"}${effectiveAi.configured === false ? " · Connection needed" : ""}`
        : "Inherits the project’s coding provider and model unless you choose an override.";
      for (const option of [...provider.children].slice(1)) {
        const connection = editor.state.saved.providers?.find(
          (item) => item.id === option.value,
        );
        option.textContent = `${names[option.value]}${connection ? (connection.configured ? " · Connected" : " · Not connected") : ""}`;
      }
      queues.replaceChildren(
        node("legend", "", "PM queues"),
        node(
          "p",
          "setup-help",
          "Choose whose approved tickets this agent can implement.",
        ),
      );
      for (const area of editor.state.project.areas || []) {
        const input = node("input"),
          label = node("label", "coder-queue-choice");
        input.type = "checkbox";
        input.id = `coder-queue-${area.key}`;
        input.value = area.key;
        input.checked = agent?.areas?.includes(area.key) || false;
        label.htmlFor = input.id;
        label.append(input, node("span", "", area.name || area.key));
        queues.append(label);
      }
      for (const key of agent?.areas || [])
        if (!editor.state.project.areas?.some((area) => area.key === key)) {
          const input = node("input"),
            label = node("label", "coder-queue-choice");
          input.type = "checkbox";
          input.value = key;
          input.checked = true;
          label.append(
            input,
            node("span", "", `${key} · PM no longer available`),
          );
          queues.append(label);
        }
      if (!editor.state.project.areas?.length)
        queues.append(
          node(
            "p",
            "setup-help",
            "Adopt a PM to create an approved-ticket queue for this agent.",
          ),
        );
      editor.original = JSON.stringify(readDraft());
    }
    async function openEditor(state, key, trigger, reloadSaved = false) {
      if (!state || state.busy || isLocked() || editor?.busy) return;
      if (editor && dirty())
        return announce(
          "Save or discard your draft before reloading or changing agents.",
          true,
        );
      editor = {
        state,
        key,
        trigger,
        busy: true,
        original: "",
        revision: state.saved?.revision,
      };
      title.textContent = key ? "Edit coding agent" : "Add a coding agent";
      subtitle.textContent = state.project.name;
      discard.hidden = deletePrompt.hidden = true;
      announce("Loading saved coding agents…");
      if (!dialog.open) dialog.showModal();
      syncEditor();
      const current = editor;
      try {
        state.saved = await api(
          `/api/projects/${encodeURIComponent(state.project.name)}/coders`,
        );
        if (editor !== current) return;
        const agent = key
          ? state.saved.agents.find((item) => item.key === key)
          : null;
        if (key && !agent) {
          announce(
            "This coding agent no longer exists. Close the editor and refresh the project.",
            true,
          );
          return;
        }
        editor.revision = state.saved.revision;
        fill(agent);
        if (reloadSaved) modelChoice.refresh();
        announce("");
        name.focus();
      } catch {
        announce(
          "Coding agents could not load. Close and try again; saved settings are kept.",
          true,
        );
      } finally {
        if (editor === current) {
          editor.busy = false;
          syncEditor();
        }
      }
    }
    function finishClose() {
      if (editor?.busy) return;
      const trigger = editor?.trigger;
      const state = editor?.state;
      editor = null;
      dialog.close();
      discard.hidden = deletePrompt.hidden = true;
      if (state) {
        draw(state);
        const controls = [...state.root.querySelectorAll("button")];
        const restored =
          controls.find(
            (control) =>
              control.dataset.coderAction === trigger?.dataset.coderAction &&
              control.dataset.coderKey === trigger?.dataset.coderKey,
          ) ||
          controls.find((control) => control.dataset.coderAction === "add");
        restored?.focus?.();
      } else trigger?.focus?.();
    }
    function requestClose() {
      if (editor?.busy) return;
      if (dirty()) {
        discard.hidden = false;
        keep.focus();
      } else finishClose();
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestClose();
    });
    provider.addEventListener("change", () => {
      modelChoice.set(provider.value, "");
      model.disabled = !provider.value;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!editor || editor.busy || isLocked() || !editor.original) return;
      const draft = readDraft();
      if (
        !draft.name ||
        draft.name.length > 100 ||
        (draft.enabled && !draft.areas.length) ||
        ![1, 2, 3, 4].includes(draft.maxConcurrent) ||
        !["", "claude", "codex"].includes(provider.value) ||
        !modelChoice.allowed(model.value)
      ) {
        announce(
          "Give this agent a name, choose at least one PM queue before enabling pickup, and select a valid capacity and model.",
          true,
        );
        return;
      }
      const current = editor,
        state = current.state;
      const previous = state.saved.agents.find(
        (item) => item.key === current.key,
      );
      let key =
        current.key ||
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 50) ||
        "coder";
      if (!/^[a-z]/.test(key)) key = `coder-${key}`;
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(key))
        key = `coder-${key}`;
      if (!current.key) {
        const base = key;
        let suffix = 2;
        while (state.saved.agents.some((item) => item.key === key))
          key = `${base}-${suffix++}`;
      }
      const replacement = {
        key,
        ...(previous?.instanceId ? { instanceId: previous.instanceId } : {}),
        ...draft,
      };
      const agents = current.key
        ? state.saved.agents.map((item) =>
            item.key === current.key ? replacement : item,
          )
        : [...state.saved.agents, replacement];
      current.busy = state.busy = true;
      syncEditor();
      try {
        await persist(
          state,
          agents,
          "Coding agent saved. Future runs use its queue and AI choices.",
        );
        if (editor === current) {
          current.key = key;
          fill(state.saved.agents.find((item) => item.key === key));
          announce(state.message);
        }
      } catch (error) {
        announce(
          error?.status === 409
            ? `${error.message || "Coding agents changed while you were editing."} Your draft is kept. Reload saved choices after saving or discarding your draft.`
            : "Coding agent could not be saved. Your draft is kept; check the settings and try again.",
          true,
        );
      } finally {
        current.busy = state.busy = false;
        syncEditor();
        draw(state);
      }
    });
    async function deleteAgent() {
      if (!editor?.key || editor.busy || isLocked() || dirty()) return;
      const current = editor,
        state = current.state;
      current.busy = state.busy = true;
      syncEditor();
      try {
        await persist(
          state,
          state.saved.agents.filter((item) => item.key !== current.key),
          "Coding agent deleted. Current runs can finish.",
        );
        current.busy = false;
        finishClose();
      } catch (error) {
        announce(
          error?.status === 409
            ? error.message ||
                "Settings changed. Reload before deleting this agent."
            : "Coding agent could not be deleted. Its saved settings are kept.",
          true,
        );
      } finally {
        current.busy = state.busy = false;
        syncEditor();
        draw(state);
      }
    }
    return {
      mount(root, project) {
        const state = stateFor(project);
        draw(state);
        root.append(state.root);
        if (!state.loaded && !state.busy && !isLocked()) void load(state);
        if (editor) syncEditor();
      },
      render(project) {
        const state = stateFor(project);
        draw(state);
        return state.root;
      },
      isDirty: dirty,
      isBusy: () =>
        Boolean(editor?.busy) ||
        [...states.values()].some(
          (state) =>
            state.busy ||
            [...state.launches.values()].some((operation) => operation.busy),
        ),
      protectFocus: (root) =>
        Boolean(editor && (dialog.open || dirty())) ||
        [...states.values()].some(
          (state) =>
            root.contains(state.root) &&
            state.root.contains(document.activeElement),
        ),
      forget(project) {
        for (const [key, state] of states)
          if (state.project.name === project) {
            states.delete(key);
            if (editor?.state === state && !editor.busy) {
              editor.original = "";
              finishClose();
            }
          }
      },
    };
  };
})();
