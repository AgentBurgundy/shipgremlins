(() => {
  "use strict";
  const PLACEHOLDER = "PASTE_LINEAR_PROJECT_ID";
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const normalizeId = (value) =>
    typeof value === "string" && value !== PLACEHOLDER ? value : "";
  const node = (tag, className = "", text = "") => {
    const result = document.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
  };

  window.createLinearMappingsModel = (
    project,
    areas,
    initialResources = {},
  ) => {
    const entries = Object.entries(areas.areas || {}).filter(([, area]) =>
      object(area),
    );
    const originalTeam = normalizeId(project.linear?.teamId);
    let connectionId = project.linear?.connectionId || "default";
    let teamId = originalTeam;
    const selections = new Map(
      entries.map(([key, area]) => [key, normalizeId(area.linearProjectId)]),
    );
    const original = JSON.stringify([connectionId, teamId, [...selections]]);
    let resources = initialResources;
    const teams = () => (Array.isArray(resources.teams) ? resources.teams : []);
    const projects = () =>
      Array.isArray(resources.projects) ? resources.projects : [];
    function rows() {
      return entries.map(([key, area]) => {
        const selected = selections.get(key);
        const resource = projects().find((item) => item.id === selected);
        let warning = "";
        if (!selected)
          warning = area.enabled
            ? "No Linear project selected. Saving this mapping will pause this PM."
            : "Not mapped. This PM remains paused until its mapping is ready.";
        else if (!resource)
          warning =
            "The saved Linear project is unavailable to this connection. Choose an accessible project, or leave this PM unmapped.";
        else if (teamId && !resource.teamIds?.includes(teamId))
          warning =
            "This Linear project belongs to a different team. Choose a project from the selected team.";
        return {
          key,
          name: area.name || key,
          enabled: Boolean(area.enabled),
          selected,
          resource,
          warning,
        };
      });
    }
    return {
      get connectionId() {
        return connectionId;
      },
      setConnection(id) {
        if (connectionId === id) return;
        connectionId = id;
        teamId = "";
        for (const key of selections.keys()) selections.set(key, "");
        resources = {};
      },
      get teamId() {
        return teamId;
      },
      get savedTeamName() {
        return project.linear?.teamName || "Saved team";
      },
      teams,
      rows,
      setTeam(id) {
        teamId = id;
      },
      setProject(key, id) {
        if (!selections.has(key))
          throw new Error("This PM is no longer in the loaded project.");
        selections.set(key, id);
      },
      setResources(next) {
        resources = next || {};
      },
      availableProjects() {
        return projects().filter((item) => item.teamIds?.includes(teamId));
      },
      isDirty() {
        return (
          JSON.stringify([connectionId, teamId, [...selections]]) !== original
        );
      },
      read() {
        if (!teams().some((item) => item.id === teamId))
          throw new Error(
            "Choose an accessible Linear team before saving mappings.",
          );
        const used = new Set();
        const areaProjects = {};
        for (const row of rows()) {
          if (row.selected) {
            if (!row.resource || !row.resource.teamIds?.includes(teamId))
              throw new Error(
                `Choose a Linear project in this team for ${row.name}, or leave that PM unmapped.`,
              );
            if (used.has(row.selected))
              throw new Error(
                "Each PM needs its own Linear project. Choose a different project for the duplicate mapping.",
              );
            used.add(row.selected);
          }
          Object.defineProperty(areaProjects, row.key, {
            value: row.selected || null,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return { connectionId, teamId, areaProjects };
      },
    };
  };

  window.createProjectLinearSettings = (
    container,
    { api, onSaved, onError, onBusy } = {},
  ) => {
    let generation = 0;
    let resourceGeneration = 0;
    let projectName = "";
    let projectFile = null;
    let areasFile = null;
    let model = null;
    let resources = { teams: [], projects: [] };
    let profiles = [];
    let resourcesReady = false;
    let externalLocked = false;
    let loading = false;
    let saving = false;
    let resourcesLoading = false;
    let lastBusy = false;
    const rows = new Map();
    const root = node("section", "linear-repair");
    const heading = node("div", "linear-repair-heading");
    const title = node("h3", "linear-repair-title", "Linear mappings");
    title.id = "project-linear-settings-title";
    root.setAttribute("aria-labelledby", title.id);
    const intro = node(
      "p",
      "linear-repair-intro",
      "Choose the existing Linear team for this app and a project for each PM. Saving changes only local bindings; it never moves or deletes Linear resources.",
    );
    heading.append(title, intro);
    const controls = node("div", "linear-repair-controls");
    const reload = node("button", "small-button", "Reload saved mappings");
    reload.type = "button";
    const refresh = node(
      "button",
      "small-button",
      "Refresh Linear teams & projects",
    );
    refresh.type = "button";
    controls.append(reload, refresh);
    const connectionField = node("div", "field linear-connection-field");
    const connectionLabel = node("label", "", "Linear connection");
    const connection = node("select");
    connection.id = "edit-linear-connection";
    connectionLabel.htmlFor = connection.id;
    const connectionNote = node("p", "linear-mapping-note");
    connectionNote.id = "edit-linear-connection-note";
    connection.setAttribute("aria-describedby", connectionNote.id);
    connectionField.append(connectionLabel, connection, connectionNote);
    const fields = node("fieldset", "linear-repair-fields");
    fields.append(node("legend", "sr-only", "Linear team and PM mappings"));
    const teamField = node("div", "field linear-team-field");
    const teamLabel = node("label", "", "Linear team for this app");
    const team = node("select");
    team.id = "edit-linear-team";
    teamLabel.htmlFor = team.id;
    const teamNote = node("p", "linear-mapping-note");
    teamNote.id = "edit-linear-team-note";
    team.setAttribute("aria-describedby", teamNote.id);
    teamField.append(teamLabel, team, teamNote);
    const list = node("div", "linear-mapping-list");
    const actions = node("div", "linear-repair-actions");
    const save = node("button", "button button-dark", "Save Linear mappings");
    save.type = "button";
    const state = node("span", "linear-mapping-note", "No changes");
    actions.append(save, state);
    fields.append(teamField, list, actions);
    const status = node("p", "form-message linear-repair-status");
    status.hidden = true;
    status.setAttribute("role", "status");
    const discard = node("div", "linear-repair-discard");
    discard.hidden = true;
    const keep = node("button", "small-button", "Keep editing");
    keep.type = "button";
    const confirmReload = node(
      "button",
      "small-button",
      "Discard mapping edits and reload",
    );
    confirmReload.type = "button";
    discard.append(
      node(
        "p",
        "",
        "Reloading replaces your unsaved Linear mapping edits. Other project settings are not changed.",
      ),
      keep,
      confirmReload,
    );
    const provisioning = node("details", "linear-provision-details");
    provisioning.append(node("summary", "", "Create missing Linear projects"));
    provisioning.append(
      node(
        "p",
        "linear-mapping-note",
        "After saving the team and any existing mappings above, you can explicitly create a Linear project for every unmapped PM. Existing mapped projects stay as they are. Newly mapped PMs remain disabled until you enable them.",
      ),
    );
    const provision = node(
      "button",
      "small-button",
      "Create missing projects in Linear",
    );
    provision.type = "button";
    const provisionConfirm = node("div", "linear-repair-discard");
    provisionConfirm.hidden = true;
    const provisionYes = node("button", "small-button", "Create projects now");
    provisionYes.type = "button";
    const provisionNo = node("button", "small-button", "Cancel");
    provisionNo.type = "button";
    provisionConfirm.append(
      node(
        "p",
        "",
        "This creates missing PM projects in your connected Linear workspace. It does not enable PMs or delete existing projects.",
      ),
      provisionNo,
      provisionYes,
    );
    provisioning.append(provision, provisionConfirm);
    root.append(
      heading,
      controls,
      connectionField,
      fields,
      status,
      discard,
      provisioning,
    );
    container.replaceChildren(root);

    const isBusy = () => loading || saving || resourcesLoading;
    const isDirty = () => Boolean(model?.isDirty());
    function show(text, error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle("error", error);
      status.setAttribute("role", error ? "alert" : "status");
      if (error) onError?.(text);
    }
    function updateLocks() {
      const busy = isBusy();
      const locked = externalLocked || busy;
      fields.disabled = locked || !model || !resourcesReady;
      connection.disabled = externalLocked || loading || saving || !model;
      reload.disabled = externalLocked || busy || !projectName;
      refresh.disabled = externalLocked || busy || !projectName;
      save.disabled = locked || !resourcesReady || !model || !isDirty();
      keep.disabled = locked;
      confirmReload.disabled = locked;
      provision.disabled =
        locked || !resourcesReady || !model?.teamId || isDirty();
      provisionYes.disabled = locked;
      provisionNo.disabled = locked;
      state.textContent = isDirty()
        ? "Unsaved mappings"
        : "Matches saved mappings";
      save.textContent = saving ? "Saving mappings…" : "Save Linear mappings";
      root.setAttribute("aria-busy", String(busy));
      if (lastBusy !== busy) {
        lastBusy = busy;
        onBusy?.(busy);
      }
    }
    function option(text, value, disabled = false) {
      const result = node("option", "", text);
      result.value = value;
      result.disabled = disabled;
      return result;
    }
    function safeProjectUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" &&
          (url.hostname === "linear.app" ||
            url.hostname.endsWith(".linear.app")) &&
          !url.username &&
          !url.password
          ? url.href
          : null;
      } catch {
        return null;
      }
    }
    function render() {
      if (!model) {
        connectionField.hidden = true;
        fields.hidden = true;
        provisioning.hidden = true;
        updateLocks();
        return;
      }
      fields.hidden = false;
      connectionField.hidden = false;
      connection.replaceChildren(
        ...profiles.map((item) =>
          option(
            `${item.label}${item.workspace?.name ? ` · ${item.workspace.name}` : ""}${item.connected ? "" : " · not connected"}`,
            item.id,
          ),
        ),
      );
      const profile = profiles.find((item) => item.id === model.connectionId);
      if (!profile)
        connection.append(
          option(
            `Saved connection (${model.connectionId}) · unavailable`,
            model.connectionId,
          ),
        );
      connection.value = model.connectionId;
      connectionNote.textContent = !profile
        ? "This saved connection is unavailable. Restore it in Connections or explicitly choose another account; no default account will be substituted."
        : !profile.connected
          ? "Connect this account in Connections, then refresh the choices here. Your saved mappings stay unchanged."
          : "Teams and PM projects come only from this account. Choosing another connection clears these draft selections; save after choosing its team and projects.";
      connectionNote.classList.toggle(
        "linear-mapping-warning",
        !profile || !profile.connected,
      );
      team.replaceChildren(
        option("Choose an existing team", ""),
        ...model
          .teams()
          .map((item) => option(`${item.name} · ${item.key}`, item.id)),
      );
      if (
        model.teamId &&
        !model.teams().some((item) => item.id === model.teamId)
      )
        team.append(
          option(`${model.savedTeamName} · unavailable`, model.teamId),
        );
      team.value = model.teamId;
      const found = model.teams().find((item) => item.id === model.teamId);
      teamNote.textContent = found
        ? `PM project choices are filtered to ${found.name}. Changing the team does not move projects in Linear.`
        : model.teamId
          ? "This team is unavailable to your current Linear connection. Choose the correct team or reconnect its workspace, then refresh."
          : "No Linear team is mapped yet. Choose the team that should own this app’s PM work.";
      teamNote.classList.toggle(
        "linear-mapping-warning",
        Boolean(model.teamId && !found),
      );
      for (const data of model.rows()) {
        let row = rows.get(data.key);
        if (!row) {
          const wrapper = node("div", "linear-mapping-row");
          const name = node("strong", "linear-mapping-name");
          const label = node("label", "field");
          const labelText = node("span", "", "Linear project");
          const input = node("select");
          input.id = `linear-pm-${data.key}`;
          label.htmlFor = input.id;
          input.dataset.linearArea = data.key;
          label.append(labelText, input);
          const note = node("p", "linear-mapping-note");
          note.id = `${input.id}-note`;
          input.setAttribute("aria-describedby", note.id);
          const open = node(
            "a",
            "linear-project-link",
            "Open Linear project ↗",
          );
          open.target = "_blank";
          open.rel = "noreferrer";
          wrapper.append(name, label, note, open);
          list.append(wrapper);
          row = { wrapper, name, input, note, open };
          rows.set(data.key, row);
          input.addEventListener("change", () => {
            model?.setProject(data.key, input.value);
            discard.hidden = true;
            provisionConfirm.hidden = true;
            render();
          });
        }
        row.name.textContent = `${data.name} · ${data.enabled ? "Enabled PM" : "Paused PM"}`;
        const choices = model.availableProjects();
        row.input.replaceChildren(
          option("Unmapped · keep this PM paused", ""),
          ...choices.map((item) => option(item.name, item.id)),
        );
        if (data.selected && !choices.some((item) => item.id === data.selected))
          row.input.append(
            option(
              data.resource
                ? `${data.resource.name} · different team`
                : "Saved project · unavailable",
              data.selected,
            ),
          );
        row.input.value = data.selected;
        row.note.textContent =
          data.warning ||
          "Mapped to a project in the selected team. Its enabled state is unchanged.";
        row.note.classList.toggle(
          "linear-mapping-warning",
          Boolean(data.warning),
        );
        row.input.setAttribute(
          "aria-invalid",
          String(Boolean(data.selected && data.warning)),
        );
        const url = safeProjectUrl(data.resource?.url);
        row.open.hidden = !url;
        if (url) row.open.href = url;
        else row.open.removeAttribute("href");
      }
      if (!model.rows().length && !list.children.length)
        list.append(
          node(
            "p",
            "linear-mapping-note",
            "This app has no PM mandates yet. You can save its team now and map PMs when you create them.",
          ),
        );
      provisioning.hidden = !model.rows().some((row) => !row.selected);
      updateLocks();
    }
    const resourcePath = (id) =>
      `/api/linear/resources${id === "default" ? "" : `?connection=${encodeURIComponent(id)}`}`;
    async function refreshResources(changedConnection = false) {
      if (!projectName || externalLocked || saving || loading) return false;
      const current = generation;
      const request = ++resourceGeneration;
      resourcesLoading = true;
      updateLocks();
      show("Loading accessible Linear teams and projects…");
      try {
        const catalog = await api("/api/service-connections");
        if (current !== generation || request !== resourceGeneration)
          return false;
        profiles = (catalog.connections || []).filter(
          (item) => item.provider === "linear",
        );
        if (!profiles.some((item) => item.id === model?.connectionId))
          throw new Error("missing-profile");
        const result = await api(resourcePath(model.connectionId));
        if (current !== generation || request !== resourceGeneration)
          return false;
        resources = result;
        resourcesReady = true;
        model?.setResources(result);
        render();
        show(
          changedConnection === true
            ? "Connection changed in this draft. Choose its team and PM projects, then save the mappings together. Nothing has been saved yet."
            : "Linear choices refreshed. Your mapping edits are kept.",
        );
        return true;
      } catch {
        if (current === generation && request === resourceGeneration) {
          resourcesReady = false;
          render();
          show(
            "Linear teams and projects could not be loaded. Connect Linear or restore access, then refresh. Your saved mappings and draft are kept.",
            true,
          );
        }
        return false;
      } finally {
        if (current === generation && request === resourceGeneration) {
          resourcesLoading = false;
          updateLocks();
        }
      }
    }
    async function load(name) {
      const current = ++generation;
      ++resourceGeneration;
      projectName = name;
      loading = true;
      saving = false;
      resourcesLoading = false;
      model = null;
      projectFile = null;
      areasFile = null;
      resourcesReady = false;
      profiles = [];
      rows.clear();
      list.replaceChildren();
      discard.hidden = true;
      provisionConfirm.hidden = true;
      title.textContent = `Linear mappings · ${name}`;
      render();
      show("Loading saved team and PM project mappings…");
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || "")) {
        loading = false;
        updateLocks();
        show("Choose a valid project before editing Linear mappings.", true);
        return false;
      }
      const [projectResult, areasResult, catalogResult] =
        await Promise.allSettled([
          api(
            `/api/config?path=${encodeURIComponent(`projects/${name}/project.json`)}`,
          ),
          api(
            `/api/config?path=${encodeURIComponent(`projects/${name}/areas.json`)}`,
          ),
          api("/api/service-connections"),
        ]);
      if (current !== generation) return false;
      try {
        if (
          projectResult.status !== "fulfilled" ||
          areasResult.status !== "fulfilled"
        )
          throw new Error(
            "Saved mappings could not be loaded. Reload to try again. No configuration was changed.",
          );
        projectFile = projectResult.value;
        areasFile = areasResult.value;
        const project = JSON.parse(projectFile.content);
        const areas = JSON.parse(areasFile.content);
        profiles =
          catalogResult.status === "fulfilled"
            ? (catalogResult.value.connections || []).filter(
                (item) => item.provider === "linear",
              )
            : [];
        const selectedId = project.linear?.connectionId || "default";
        resources = { teams: [], projects: [] };
        if (profiles.some((item) => item.id === selectedId)) {
          try {
            const result = await api(resourcePath(selectedId));
            if (current !== generation) return false;
            resources = result;
            resourcesReady = true;
          } catch {
            if (current !== generation) return false;
            resourcesReady = false;
          }
        }
        model = window.createLinearMappingsModel(project, areas, resources);
        render();
        show(
          resourcesReady
            ? ""
            : "Your saved mappings are shown, but Linear choices could not be loaded. Connect Linear or restore workspace access, then refresh teams and projects.",
          !resourcesReady,
        );
        return true;
      } catch (error) {
        model = null;
        render();
        show(error.message || "Saved mappings could not be loaded.", true);
        return false;
      } finally {
        if (current === generation) {
          loading = false;
          updateLocks();
        }
      }
    }
    team.addEventListener("change", () => {
      model?.setTeam(team.value);
      discard.hidden = true;
      provisionConfirm.hidden = true;
      render();
    });
    connection.addEventListener("change", async () => {
      if (!model || externalLocked || loading || saving) return;
      ++resourceGeneration;
      model.setConnection(connection.value);
      resources = { teams: [], projects: [] };
      resourcesReady = false;
      discard.hidden = true;
      provisionConfirm.hidden = true;
      render();
      await refreshResources(true);
    });
    refresh.addEventListener("click", refreshResources);
    reload.addEventListener("click", () => {
      if (isDirty()) {
        discard.hidden = false;
        keep.focus();
        return;
      }
      void load(projectName);
    });
    keep.addEventListener("click", () => {
      discard.hidden = true;
      team.focus();
    });
    confirmReload.addEventListener("click", () => void load(projectName));
    save.addEventListener("click", async () => {
      if (externalLocked || isBusy() || !model || !resourcesReady || !isDirty())
        return;
      let value;
      try {
        value = model.read();
      } catch (error) {
        show(error.message, true);
        return;
      }
      const current = generation;
      const name = projectName;
      saving = true;
      updateLocks();
      show("Saving the team and all PM mappings together…");
      try {
        const result = await api(
          `/api/projects/${encodeURIComponent(name)}/linear/mappings`,
          {
            projectRevision: projectFile.revision,
            areasRevision: areasFile.revision,
            ...value,
          },
        );
        if (current !== generation) return;
        projectFile = result.project;
        areasFile = result.areas;
        if (!projectFile?.content || !areasFile?.content)
          throw new Error(
            "Mappings were saved, but the updated files were not returned. Reload saved mappings before making further changes.",
          );
        model = window.createLinearMappingsModel(
          JSON.parse(projectFile.content),
          JSON.parse(areasFile.content),
          resources,
        );
        render();
        show(
          result.message ||
            "Linear mappings saved together. Other settings were kept. Unmapped PMs are paused; mapped PMs keep their prior enabled state. Verify this app before its next job.",
        );
        try {
          await onSaved?.({
            projectName: name,
            projectChanged: true,
            areasChanged: true,
            project: projectFile,
          });
        } catch {
          /* A successful save stays successful if the outer status refresh fails. */
        }
      } catch (error) {
        if (current === generation)
          show(
            error.status === 409
              ? "This project changed while you were editing. Your choices are kept. Reload saved mappings to review the latest team and PMs before saving again."
              : error.message ||
                  "Mappings could not be saved. Your choices are kept.",
            true,
          );
      } finally {
        if (current === generation) {
          saving = false;
          updateLocks();
        }
      }
    });
    provision.addEventListener("click", () => {
      provisionConfirm.hidden = false;
      provisionNo.focus();
    });
    provisionNo.addEventListener("click", () => {
      provisionConfirm.hidden = true;
      provision.focus();
    });
    provisionYes.addEventListener("click", async () => {
      if (externalLocked || isBusy() || isDirty() || !model?.teamId) return;
      const current = generation;
      const name = projectName;
      saving = true;
      updateLocks();
      show(
        "Creating missing PM projects in Linear. Existing mapped resources stay in place…",
      );
      try {
        const result = await api(
          `/api/projects/${encodeURIComponent(name)}/linear`,
          { teamId: model.teamId },
          "POST",
          90000,
        );
        if (current !== generation) return;
        const failed = result.linear?.status === "error";
        const reloadRequest = load(name);
        const reloadGeneration = generation;
        await reloadRequest;
        if (reloadGeneration !== generation) return;
        show(
          result.linear?.message ||
            (failed
              ? "Linear setup is incomplete. Review the mappings and retry when access is restored."
              : "Linear setup finished. Review the mappings before enabling paused PMs."),
          failed,
        );
        try {
          await onSaved?.({
            projectName: name,
            projectChanged: true,
            areasChanged: true,
            project: projectFile,
          });
        } catch {
          /* Provider/config save is already recorded. */
        }
      } catch (error) {
        if (current === generation)
          show(
            error.message ||
              "Linear setup did not finish. Existing mappings were kept.",
            true,
          );
      } finally {
        if (current === generation) {
          saving = false;
          updateLocks();
        }
      }
    });
    render();
    return {
      load,
      isDirty,
      isBusy,
      rebaseProject(document) {
        if (
          !projectFile ||
          !model ||
          saving ||
          !document ||
          document.path !== projectFile.path
        )
          return false;
        try {
          const previous = JSON.parse(projectFile.content).linear;
          const next = JSON.parse(document.content).linear;
          const signature = (value) =>
            JSON.stringify(
              value
                ? [
                    value.teamId,
                    value.workspaceId || null,
                    value.teamName || null,
                    value.connectionId || "default",
                  ]
                : null,
            );
          if (signature(previous) !== signature(next)) return false;
          projectFile = document;
          return true;
        } catch {
          return false;
        }
      },
      setLocked(value) {
        externalLocked = Boolean(value);
        updateLocks();
      },
      reset() {
        ++generation;
        ++resourceGeneration;
        projectName = "";
        projectFile = null;
        areasFile = null;
        model = null;
        rows.clear();
        list.replaceChildren();
        loading = false;
        saving = false;
        resourcesLoading = false;
        resourcesReady = false;
        discard.hidden = true;
        provisionConfirm.hidden = true;
        title.textContent = "Linear mappings";
        show("");
        render();
      },
    };
  };
})();
