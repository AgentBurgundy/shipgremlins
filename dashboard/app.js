"use strict";

(() => {
  const sessionKey = "shipgremlins.dashboard.session";
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let sessionToken = fragment.get("session") || "";
  if (sessionToken) {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    try {
      sessionStorage.setItem(sessionKey, sessionToken);
    } catch {
      /* Memory-only sessions still work. */
    }
  } else {
    try {
      sessionToken = sessionStorage.getItem(sessionKey) || "";
    } catch {
      /* Storage may be unavailable. */
    }
  }

  const $ = (id) => document.getElementById(id);
  let currentStatus = null;
  let projectNameEdited = false;
  let loading = false;
  let formsLocked = true;
  const editor = { path: "", revision: "", original: "", busy: false };
  let pendingEditorAction = null;
  let updateStatus = null;
  let updatePollTimer = null;
  let updatesStarted = false;
  let updateRequestBusy = false;
  let restarting = false;
  let restartReloadApproved = false;

  function message(element, text, error = false) {
    element.replaceChildren();
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle("error", error);
    element.setAttribute("role", error ? "alert" : "status");
  }

  function lockForms(locked) {
    formsLocked = locked;
    $("connections-fields").disabled = locked;
    $("project-fields").disabled = locked;
    updateEditorControls();
  }

  function restoreButton(id, label, symbol) {
    const button = $(id);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;
    button.replaceChildren(document.createTextNode(label + " "), icon);
  }

  async function api(path, body, method = body ? "POST" : "GET") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error(
          "The dashboard received an unexpected response. Check the CLI server and try again.",
        );
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          sessionToken = "";
          try {
            sessionStorage.removeItem(sessionKey);
          } catch {
            /* Nothing persisted. */
          }
          lockForms(true);
          throw new Error(
            "This dashboard session has expired. Run gremlins dashboard to open a fresh session.",
          );
        }
        const error = new Error(
          typeof result.error === "string"
            ? result.error
            : "The request could not be completed. Please try again.",
        );
        error.status = response.status;
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error(
          "The server took too long to respond. Check that ShipGremlins is still running and try again.",
        );
      if (error instanceof TypeError)
        throw new Error(
          "Cannot reach the dashboard. Keep the CLI running on your server, then try again.",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderStatus(status) {
    currentStatus = status;
    const connections = Array.isArray(status.connections)
      ? status.connections
      : [];
    const projects = Array.isArray(status.projects) ? status.projects : [];
    const requiredNames = ["GITHUB_TOKEN", "LINEAR_API_KEY", "VERCEL_TOKEN"];
    const requiredSaved = requiredNames.filter((name) =>
      connections.some(
        (connection) => connection.name === name && connection.configured,
      ),
    ).length;
    const savedCount = connections.filter(
      (connection) => connection.configured,
    ).length;
    $("connection-count").textContent = String(savedCount);
    $("project-count").textContent = String(projects.length);
    $("connections-summary").textContent =
      `${requiredSaved} of 3 required tokens saved`;
    $("projects-summary").textContent = projects.length
      ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} configured`
      : "No projects yet";
    $("connection-step").classList.toggle(
      "complete",
      requiredSaved === requiredNames.length,
    );
    $("project-step").classList.toggle("complete", projects.length > 0);
    $("setup-title").textContent =
      requiredSaved === 3 && projects.length
        ? "Your workspace is taking shape."
        : "Make yourself at home.";
    $("config-directory").textContent =
      status.configDirectory || "Not available";
    renderFolders(status);
    const warnings = Array.isArray(status.configWarnings)
      ? status.configWarnings.filter((warning) => typeof warning === "string")
      : [];
    message(
      $("config-warnings"),
      warnings.length
        ? `Some settings need attention. You can repair them in the editor below. ${warnings.join(" ")}`
        : "",
    );
    $("hub-options").hidden = Boolean(status.hubRepo);
    $("hub-repo").required = !status.hubRepo;
    for (const badge of document.querySelectorAll("[data-connection]")) {
      const configured = connections.some(
        (connection) =>
          connection.name === badge.dataset.connection && connection.configured,
      );
      badge.textContent = configured ? "✓ Saved" : "Not configured";
      badge.classList.toggle("configured", configured);
      const input = document.querySelector(
        `input[name="${badge.dataset.connection}"]`,
      );
      if (input)
        input.placeholder = configured
          ? "Saved — leave blank to keep"
          : input.dataset.originalPlaceholder || input.placeholder;
    }
    const list = $("project-list");
    list.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement("p");
      empty.className = "empty-projects";
      empty.textContent =
        "No apps in the playground yet. Add your first one below.";
      list.append(empty);
    }
    for (const project of projects) {
      const row = document.createElement("div");
      row.className = "project-row";
      const name = document.createElement("div");
      name.className = "project-row-name";
      name.textContent = project.name;
      const repo = document.createElement("span");
      repo.className = "project-row-repo";
      repo.textContent = project.repo;
      name.append(repo);
      const badge = document.createElement("span");
      badge.className = "project-row-badge";
      badge.textContent = "Configured on server";
      row.append(name, badge);
      list.append(row);
    }
    const exampleProject = projects.find((project) =>
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name),
    );
    $("doctor-command").textContent =
      `gremlins doctor ${exampleProject ? exampleProject.name : "PROJECT"}`;
  }

  async function refreshStatus() {
    const status = await api("/api/status");
    renderStatus(status);
    return status;
  }

  async function initialize() {
    if (loading) return;
    if (!sessionToken) {
      message(
        $("global-message"),
        "Open this dashboard from your CLI with gremlins dashboard. The launch link creates a private session for this tab.",
        true,
      );
      $("connections-summary").textContent = "Session required";
      $("projects-summary").textContent = "Session required";
      $("config-directory").textContent = "Session required";
      $("configuration-path").textContent = "Session required";
      $("installation-path").textContent = "Session required";
      $("config-file").replaceChildren(new Option("Session required", ""));
      for (const badge of document.querySelectorAll("[data-connection]"))
        badge.textContent = "Session required";
      return;
    }
    loading = true;
    lockForms(true);
    message($("global-message"), "");
    try {
      await refreshStatus();
      lockForms(false);
      try {
        await refreshConfigFiles();
      } catch (error) {
        message(
          $("config-message"),
          `The configuration files could not load. ${error.message} Use Reload to try again.`,
          true,
        );
      }
      await initializeUpdates();
    } catch (error) {
      message($("global-message"), error.message, true);
      $("connections-summary").textContent = "Unable to load";
      $("projects-summary").textContent = "Unable to load";
      $("config-directory").textContent = "Unavailable";
      $("configuration-path").textContent = "Unavailable";
      $("installation-path").textContent = "Unavailable";
      for (const badge of document.querySelectorAll("[data-connection]"))
        badge.textContent = "Unavailable";
      if (sessionToken) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Try again";
        retry.addEventListener("click", initialize);
        $("global-message").append(retry);
      }
    } finally {
      loading = false;
    }
  }

  for (const input of document.querySelectorAll(".password-wrap input"))
    input.dataset.originalPlaceholder = input.placeholder;
  for (const button of document.querySelectorAll("[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.reveal);
      const showing = input.type === "password";
      input.type = showing ? "text" : "password";
      button.textContent = showing ? "Hide" : "Show";
      button.setAttribute("aria-pressed", String(showing));
      button.setAttribute(
        "aria-label",
        button
          .getAttribute("aria-label")
          .replace(/^(Show|Hide)/, showing ? "Hide" : "Show"),
      );
    });
  }

  $("connections-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    for (const input of document.querySelectorAll(".password-wrap input")) {
      if (input.value.trim()) values[input.name] = input.value.trim();
    }
    if (!Object.keys(values).length) {
      message(
        $("connections-message"),
        "Paste at least one new token to save. Existing connections stay as they are.",
        true,
      );
      $("github-token").focus();
      return;
    }
    lockForms(true);
    $("save-connections").textContent = "Saving…";
    message($("connections-message"), "");
    try {
      await api("/api/connections", { values });
      for (const input of document.querySelectorAll(".password-wrap input"))
        input.value = "";
      for (const button of document.querySelectorAll("[data-reveal]")) {
        $(button.dataset.reveal).type = "password";
        button.textContent = "Show";
        button.setAttribute("aria-pressed", "false");
        button.setAttribute(
          "aria-label",
          button.getAttribute("aria-label").replace(/^Hide/, "Show"),
        );
      }
      message(
        $("connections-message"),
        "Connections saved on your ShipGremlins server. Blank fields were left unchanged. Verify access with the doctor command below.",
      );
      try {
        await refreshStatus();
      } catch {
        message(
          $("global-message"),
          "Your tokens were saved, but the status could not refresh. Reload this page to check configuration.",
          true,
        );
      }
    } catch (error) {
      message($("connections-message"), error.message, true);
    } finally {
      for (const key of Object.keys(values)) delete values[key];
      lockForms(!sessionToken);
      restoreButton("save-connections", "Save connections", "↗");
    }
  });

  $("project-name").addEventListener("input", () => {
    projectNameEdited = Boolean($("project-name").value);
  });
  $("project-repo").addEventListener("input", () => {
    if (!projectNameEdited) {
      $("project-name").value = $("project-repo")
        .value.trim()
        .split("/")
        .slice(1)
        .join("-")
        .replace(/\.git$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }
  });
  $("project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = {
      project: $("project-name").value.trim(),
      repo: $("project-repo").value.trim(),
    };
    const hubRepo = $("hub-repo").value.trim();
    if (!currentStatus?.hubRepo && hubRepo) data.hubRepo = hubRepo;
    lockForms(true);
    $("add-project").textContent = "Adding…";
    message($("project-message"), "");
    try {
      const result = await api("/api/projects", data);
      $("project-form").reset();
      projectNameEdited = false;
      const created = Array.isArray(result.result?.created)
        ? result.result.created.length
        : null;
      message(
        $("project-message"),
        `${data.project} is configured on your server.${created === 0 ? " Existing files were kept." : ""} Complete the project settings in Configuration and run the verification command below before enabling agents.`,
      );
      try {
        await refreshStatus();
        await refreshConfigFiles();
      } catch {
        message(
          $("global-message"),
          "Your project was added, but the status could not refresh. Reload this page to check configuration.",
          true,
        );
      }
    } catch (error) {
      message($("project-message"), error.message, true);
    } finally {
      lockForms(!sessionToken);
      restoreButton("add-project", "Add project", "+");
    }
  });

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* Plain HTTP homelabs may need the selection-based fallback. */
      }
    }
    const previousFocus = document.activeElement;
    const buffer = document.createElement("textarea");
    buffer.className = "copy-buffer";
    buffer.value = text;
    buffer.setAttribute("aria-hidden", "true");
    buffer.setAttribute("tabindex", "-1");
    document.body.append(buffer);
    let copied = false;
    try {
      buffer.select();
      copied = document.execCommand("copy");
    } finally {
      buffer.remove();
      previousFocus?.focus({ preventScroll: true });
    }
    if (!copied)
      throw new Error(
        "Your browser could not copy this text. Select it and copy manually.",
      );
  }

  function copiedButton(button) {
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = label;
    }, 2000);
  }

  $("copy-command").addEventListener("click", async () => {
    try {
      await copyText($("doctor-command").textContent);
      copiedButton($("copy-command"));
      $("copy-status").textContent = "Verification command copied.";
    } catch {
      $("copy-status").classList.remove("sr-only");
      $("copy-status").textContent =
        "Copy is unavailable. Select the verification command to copy it manually.";
    }
  });

  function renderFolders(status) {
    const paths = {
      configuration: status.configDirectory,
      installation: status.installationDirectory,
    };
    $("configuration-path").textContent =
      paths.configuration || "Not available";
    $("installation-path").textContent = paths.installation || "Not available";
    const canOpen = status.runtime?.canOpenFolders === true;
    $("folder-guidance").textContent = canOpen
      ? "These folders are on this computer. Open them in your file manager, or edit configuration below."
      : "These folders are on your ShipGremlins server. Edit configuration below from this browser, or copy a path to use while connected to your server.";
    for (const button of document.querySelectorAll("[data-copy-path]"))
      button.disabled = !paths[button.dataset.copyPath];
    for (const button of document.querySelectorAll("[data-open-folder]"))
      button.hidden = !canOpen || !paths[button.dataset.openFolder];
  }

  function updateNavigation() {
    const section = window.location.hash || "#overview";
    for (const link of document.querySelectorAll(".navigation a")) {
      if (link.getAttribute("href") === section)
        link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }
  window.addEventListener("hashchange", updateNavigation);
  updateNavigation();

  for (const button of document.querySelectorAll("[data-copy-path]")) {
    button.addEventListener("click", async () => {
      const target = button.dataset.copyPath;
      const path =
        target === "installation"
          ? currentStatus?.installationDirectory
          : currentStatus?.configDirectory;
      if (!path) return;
      try {
        await copyText(path);
        copiedButton(button);
        message(
          $("folder-message"),
          `${target === "installation" ? "Installation" : "Configuration"} folder path copied.`,
        );
      } catch (error) {
        message($("folder-message"), error.message, true);
      }
    });
  }

  for (const button of document.querySelectorAll("[data-open-folder]")) {
    button.addEventListener("click", async () => {
      const target = button.dataset.openFolder;
      button.disabled = true;
      try {
        await api("/api/open-folder", { target });
        message(
          $("folder-message"),
          `Opened the ${target} folder in your file manager.`,
        );
      } catch (error) {
        message($("folder-message"), error.message, true);
      } finally {
        button.disabled = !sessionToken;
      }
    });
  }

  function isEditorDirty() {
    return Boolean(
      editor.path && $("config-content").value !== editor.original,
    );
  }

  function updateEditorControls() {
    const dirty = isEditorDirty();
    $("connections-fields").disabled = formsLocked || editor.busy;
    $("project-fields").disabled = formsLocked || editor.busy;
    $("config-fields").disabled = formsLocked || !sessionToken || editor.busy;
    $("config-content").disabled = !editor.path;
    $("config-save").disabled = !editor.path || !dirty;
    $("copy-draft").disabled = !editor.path || editor.busy;
    $("editor-state").textContent = editor.busy
      ? "Working…"
      : !editor.path
        ? "No file loaded"
        : dirty
          ? "Unsaved changes"
          : "Matches saved file";
    $("editor-state").classList.toggle("unsaved", dirty);
    const lineCount = editor.path
      ? $("config-content").value.split("\n").length
      : 0;
    $("editor-lines").textContent =
      `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
    $("keep-editing").disabled = editor.busy;
    $("discard-changes").disabled = editor.busy;
  }

  function clearDiscardPrompt() {
    pendingEditorAction = null;
    $("discard-prompt").hidden = true;
    $("discard-changes").textContent = "Discard changes";
  }

  async function loadConfigFile(path) {
    editor.busy = true;
    updateEditorControls();
    message($("config-message"), "");
    try {
      const file = await api(`/api/config?path=${encodeURIComponent(path)}`);
      editor.path = file.path;
      editor.revision = file.revision;
      editor.original = file.content;
      $("config-content").value = file.content;
      $("config-file").value = file.path;
      $("editor-file-label").textContent = file.path;
      clearDiscardPrompt();
    } catch (error) {
      $("config-file").value = editor.path;
      message(
        $("config-message"),
        `${error.message}${editor.path ? " The text in your editor has been kept." : ""}`,
        true,
      );
    } finally {
      editor.busy = false;
      updateEditorControls();
    }
  }

  async function refreshConfigFiles() {
    editor.busy = true;
    updateEditorControls();
    let files;
    try {
      const result = await api("/api/config");
      files = Array.isArray(result.files) ? result.files : [];
      const select = $("config-file");
      select.replaceChildren();
      for (const file of files)
        select.append(new Option(file.label || file.path, file.path));
      if (editor.path && !files.some((file) => file.path === editor.path))
        select.append(
          new Option(`${editor.path} (not on server)`, editor.path),
        );
      if (!files.length && !editor.path)
        select.append(new Option("No configuration files yet", ""));
      if (editor.path) select.value = editor.path;
    } finally {
      editor.busy = false;
      updateEditorControls();
    }
    if (!editor.path && files.length) await loadConfigFile(files[0].path);
    if (!editor.path && !files.length)
      message(
        $("config-message"),
        "Add your first project above to create your workspace configuration.",
      );
  }

  async function requestEditorAction(action, path = editor.path) {
    if (editor.busy || formsLocked || !sessionToken) return;
    if (isEditorDirty()) {
      pendingEditorAction = { action, path };
      $("config-file").value = editor.path;
      $("discard-description").textContent =
        action === "switch"
          ? `You have unsaved changes in ${editor.path}. Save them first, keep editing, or discard them to open ${path}.`
          : "Reloading replaces your draft with the latest file on the server. Save or copy your draft first if you want to keep it.";
      $("discard-prompt").hidden = false;
      $("keep-editing").focus();
      return;
    }
    clearDiscardPrompt();
    if (path) await loadConfigFile(path);
    else {
      try {
        await refreshConfigFiles();
      } catch (error) {
        message($("config-message"), error.message, true);
      }
    }
  }

  $("config-content").addEventListener("input", () => {
    if (!isEditorDirty()) clearDiscardPrompt();
    updateEditorControls();
  });
  $("config-file").addEventListener("change", () => {
    const path = $("config-file").value;
    if (path && path !== editor.path) requestEditorAction("switch", path);
  });
  $("config-reload").addEventListener("click", () =>
    requestEditorAction("reload"),
  );
  $("keep-editing").addEventListener("click", () => {
    clearDiscardPrompt();
    const pendingToken = [
      ...document.querySelectorAll(".password-wrap input"),
    ].find((input) => input.value);
    if (isEditorDirty()) $("config-content").focus();
    else if (pendingToken) pendingToken.focus();
    else if ($("project-repo").value) $("project-repo").focus();
    else $("config-content").focus();
  });
  $("discard-changes").addEventListener("click", async () => {
    const action = pendingEditorAction;
    if (!action) return;
    clearDiscardPrompt();
    if (action.action === "restart") await restartDashboard(true);
    else if (action.path) await loadConfigFile(action.path);
  });
  $("copy-draft").addEventListener("click", async () => {
    try {
      await copyText($("config-content").value);
      copiedButton($("copy-draft"));
      $("config-copy-status").textContent = "Your current draft was copied.";
    } catch (error) {
      message(
        $("config-message"),
        `${error.message} Your draft is still in the editor.`,
        true,
      );
      $("config-content").focus();
      $("config-content").select();
    }
  });

  $("config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editor.path || !isEditorDirty() || editor.busy) return;
    const content = $("config-content").value;
    try {
      JSON.parse(content);
    } catch (error) {
      message(
        $("config-message"),
        `This file is not valid JSON. ${error.message} Nothing was saved.`,
        true,
      );
      $("config-content").focus();
      return;
    }
    editor.busy = true;
    updateEditorControls();
    $("config-save").textContent = "Saving…";
    message($("config-message"), "");
    try {
      const result = await api(
        "/api/config",
        { path: editor.path, content, revision: editor.revision },
        "PUT",
      );
      editor.original = content;
      editor.revision = result.revision;
      clearDiscardPrompt();
      message(
        $("config-message"),
        `${editor.path} saved on your server. Saving configuration does not automatically enable agents.`,
      );
      try {
        await refreshStatus();
      } catch {
        message(
          $("config-message"),
          "Your file was saved, but the workspace status could not refresh. Reload the dashboard after preserving any other changes.",
        );
      }
    } catch (error) {
      message(
        $("config-message"),
        error.status === 409
          ? "This file changed on the server after you opened it. Nothing was overwritten, and your draft is still here. Copy your draft, then use Reload to review the latest file before reapplying your changes."
          : `${error.message} Your draft has been kept; nothing was saved.`,
        true,
      );
    } finally {
      editor.busy = false;
      updateEditorControls();
      restoreButton("config-save", "Save changes", "↗");
    }
  });

  function versionLabel(version, sha) {
    if (!version) return "Not checked";
    return `${version}${sha ? ` · ${String(sha).slice(0, 7)}` : ""}`;
  }

  function renderUpdates(status) {
    updateStatus = status;
    const busy =
      restarting ||
      updateRequestBusy ||
      ["checking", "installing"].includes(status.phase);
    const labels = {
      idle: "Ready",
      checking: "Checking…",
      available: "Update available",
      installing: "Installing…",
      ready: "Ready",
      error: "Needs attention",
    };
    $("update-phase").textContent = restarting
      ? "Restarting…"
      : status.restartRequired
        ? "Restart needed"
        : labels[status.phase] || "Status";
    $("update-phase").classList.toggle("busy", busy);
    $("update-phase").classList.toggle("error", status.phase === "error");
    $("updates").setAttribute("aria-busy", String(busy));
    $("running-version").textContent = versionLabel(
      status.currentVersion,
      status.currentSha,
    );
    $("latest-version").textContent = versionLabel(
      status.latestVersion,
      status.latestSha,
    );
    $("update-message").textContent = restarting
      ? "Restarting your dashboard. This tab will reconnect automatically; running cloud jobs continue."
      : status.message || "Check for the latest ShipGremlins release.";
    $("update-message").classList.toggle(
      "error",
      status.phase === "error" && !restarting,
    );
    $("update-check").disabled =
      busy || !sessionToken || status.restartRequired;
    $("update-apply").hidden =
      status.phase !== "available" || status.restartRequired;
    $("update-apply").disabled = busy || !sessionToken;
    $("update-rollback").hidden = !status.canRollback;
    $("update-rollback").disabled = busy || !sessionToken;
    $("update-restart").hidden = !status.restartRequired || !status.canRestart;
    $("update-restart").disabled = busy || !sessionToken;
    $("update-restart-note").hidden = !status.restartRequired;
    $("update-restart-note").textContent = status.canRestart
      ? "The staged runtime is ready. Restart this dashboard to use it. Your saved configuration and credentials stay in place."
      : "The staged runtime is ready. Restart the ShipGremlins process on your server to use it. For a CLI session, stop the current process and run gremlins dashboard again.";
  }

  function updateFailure(error) {
    clearTimeout(updatePollTimer);
    updatePollTimer = null;
    renderUpdates({
      ...updateStatus,
      phase: "error",
      message: `${error.message} ${updateStatus?.restartRequired ? "Your saved workspace is unchanged." : "Your workspace remains available. Try checking again."}`,
    });
  }

  function scheduleUpdatePoll() {
    clearTimeout(updatePollTimer);
    updatePollTimer = null;
    if (
      !sessionToken ||
      restarting ||
      !["checking", "installing"].includes(updateStatus?.phase)
    )
      return;
    updatePollTimer = setTimeout(async () => {
      try {
        renderUpdates(await api("/api/updates"));
        scheduleUpdatePoll();
      } catch (error) {
        updateFailure(error);
      }
    }, 1500);
  }

  async function runUpdateAction(action) {
    if (!sessionToken || updateRequestBusy || restarting) return;
    clearTimeout(updatePollTimer);
    updateRequestBusy = true;
    renderUpdates(
      updateStatus || { phase: "idle", message: "Checking update service…" },
    );
    try {
      if (action === "check") {
        const current = await api("/api/updates");
        if (
          ["checking", "installing"].includes(current.phase) ||
          current.restartRequired
        ) {
          renderUpdates(current);
          return;
        }
      }
      renderUpdates(await api(`/api/updates/${action}`, {}));
    } catch (error) {
      updateFailure(error);
    } finally {
      updateRequestBusy = false;
      if (updateStatus) renderUpdates(updateStatus);
      scheduleUpdatePoll();
    }
  }

  async function initializeUpdates() {
    if (updatesStarted || !sessionToken) return;
    updatesStarted = true;
    try {
      const status = await api("/api/updates");
      renderUpdates(status);
      if (["checking", "installing"].includes(status.phase))
        scheduleUpdatePoll();
      else if (!status.restartRequired) await runUpdateAction("check");
    } catch (error) {
      updateFailure(error);
    }
  }

  function hasUnsavedInputs() {
    return (
      isEditorDirty() ||
      [...document.querySelectorAll(".password-wrap input")].some(
        (input) => input.value,
      ) ||
      ["project-repo", "project-name", "hub-repo"].some((id) => $(id).value)
    );
  }

  async function restartDashboard(discardConfirmed = false) {
    if (
      !sessionToken ||
      restarting ||
      !updateStatus?.canRestart ||
      !updateStatus?.restartRequired
    )
      return;
    if (!discardConfirmed && hasUnsavedInputs()) {
      pendingEditorAction = { action: "restart" };
      $("discard-description").textContent =
        "Restarting reloads this page and clears unsaved configuration and form entries. Save your changes or copy your draft before restarting.";
      $("discard-changes").textContent = "Restart and discard";
      $("discard-prompt").hidden = false;
      $("keep-editing").focus();
      return;
    }
    restarting = true;
    clearTimeout(updatePollTimer);
    lockForms(true);
    renderUpdates(updateStatus);
    try {
      await api("/api/updates/restart", {});
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          await api("/api/status");
          const status = await api("/api/updates");
          if (!status.restartRequired) {
            restartReloadApproved = true;
            window.location.reload();
            return;
          }
        } catch {
          if (!sessionToken)
            throw new Error(
              "The new dashboard needs a fresh session. Run gremlins dashboard on your server to open it.",
            );
          // A short connection gap is expected while the supervisor restarts.
        }
      }
      throw new Error(
        "The dashboard has not reconnected yet. Check the ShipGremlins process on your server, then reload this tab. Your unsaved text is still here.",
      );
    } catch (error) {
      restarting = false;
      lockForms(!sessionToken);
      updateFailure(error);
    }
  }

  $("update-check").addEventListener("click", () => runUpdateAction("check"));
  $("update-apply").addEventListener("click", () => runUpdateAction("apply"));
  $("update-rollback").addEventListener("click", () =>
    runUpdateAction("rollback"),
  );
  $("update-restart").addEventListener("click", () => restartDashboard());

  window.addEventListener("beforeunload", (event) => {
    if (restartReloadApproved || !isEditorDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(updatePollTimer);
    for (const input of document.querySelectorAll(".password-wrap input"))
      input.value = "";
  });
  initialize();
})();
