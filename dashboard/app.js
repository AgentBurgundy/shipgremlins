"use strict";

(() => {
  const sessionKey = "shipgremlins.dashboard.session";
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let sessionToken = fragment.get("session") || "";
  let slackEnvelope = fragment.get("slack") || "";
  if (sessionToken || slackEnvelope) {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  if (sessionToken) {
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
  let runnerStatus = null;
  let runnerPollTimer = null;
  let runnerLoading = false;
  let runnerRequestBusy = false;
  let removeRunnerId = "";
  let selectedJobId = "";
  let outputLoading = false;
  let outputRevision = 0;
  let artifactSignature = "";
  const artifactBlobs = new Set();
  const projectChecks = new Map();
  let activityFilter = "all";
  let slackStatus = null;
  let slackBusy = false;
  let jobHistory = [];
  let historyCursor = null;
  let historyLoading = false;
  let olderHistoryLoaded = false;

  const sourceProviders = {
    github: { name: "GitHub", origin: "https://github.com", icon: "GH" },
    gitlab: { name: "GitLab", origin: "https://gitlab.com", icon: "GL" },
  };
  let sourceConnections = [];
  let sourceLoading = false;
  const sourceBusy = new Set();
  const sourceFlows = new Map();
  const sourceTimers = new Map();
  let repositories = [];
  let repositoryLoading = false;
  let repositoryRevision = 0;

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
    $("source-token-fields").disabled = locked;
    renderSourceControls();
    $("project-fields").disabled = locked;
    updateEditorControls();
    updateRunnerControls();
    renderSlackControls();
    renderProjectProvider();
  }

  function restoreButton(id, label, symbol) {
    const button = $(id);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;
    button.replaceChildren(document.createTextNode(label + " "), icon);
  }

  async function api(
    path,
    body,
    method = body ? "POST" : "GET",
    timeoutMs = 20000,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    const sourceSaved =
      (status.sourceConnections || sourceConnections).some(
        (connection) => connection.connected && !connection.needsReconnect,
      ) ||
      connections.some(
        (connection) =>
          ["GITHUB_TOKEN", "GITLAB_TOKEN"].includes(connection.name) &&
          connection.configured,
      );
    const savedCount = connections.filter(
      (connection) => connection.configured,
    ).length;
    $("connection-count").textContent = String(savedCount);
    $("project-count").textContent = String(projects.length);
    $("connections-summary").textContent =
      `${savedCount} ${savedCount === 1 ? "connection" : "connections"} saved`;
    $("projects-summary").textContent = projects.length
      ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} configured`
      : "No projects yet";
    $("connection-step").classList.toggle("complete", sourceSaved);
    $("project-step").classList.toggle("complete", projects.length > 0);
    $("setup-title").textContent =
      sourceSaved && projects.length
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
    const telemetryFields = $("telemetry-connections");
    const telemetryNames = new Set(
      connections.map((connection) => connection.name),
    );
    for (const field of [...telemetryFields.children]) {
      if (!telemetryNames.has(field.dataset.secret)) field.remove();
    }
    for (const connection of connections.filter((connection) =>
      /^(SENTRY_AUTH_TOKEN|DD_API_KEY|DD_APP_KEY|MIXPANEL_USERNAME|MIXPANEL_PASSWORD)_/.test(
        connection.name,
      ),
    )) {
      if (document.getElementById(`telemetry-${connection.name}`)) continue;
      const field = document.createElement("div");
      field.className = "token-field";
      field.dataset.secret = connection.name;
      const heading = document.createElement("div");
      heading.className = "field-heading";
      const label = document.createElement("label");
      label.htmlFor = `telemetry-${connection.name}`;
      label.textContent = connection.label;
      const badge = document.createElement("span");
      badge.className = "saved-state";
      badge.dataset.connection = connection.name;
      const help = document.createElement("p");
      help.id = `help-${connection.name}`;
      help.textContent = connection.description;
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.name = connection.name;
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Paste credential (optional)";
      input.setAttribute("aria-describedby", help.id);
      heading.append(label, badge);
      const wrap = document.createElement("div");
      wrap.className = "password-wrap";
      wrap.append(input);
      field.append(heading, help, wrap);
      telemetryFields.append(field);
    }
    for (const badge of document.querySelectorAll("[data-connection]")) {
      const configured = connections.some(
        (connection) =>
          connection.name === badge.dataset.connection && connection.configured,
      );
      const sourceProvider =
        badge.dataset.connection === "GITHUB_TOKEN"
          ? "github"
          : badge.dataset.connection === "GITLAB_TOKEN"
            ? "gitlab"
            : null;
      const browserConnected =
        sourceProvider &&
        (status.sourceConnections || sourceConnections).some(
          (item) =>
            item.provider === sourceProvider &&
            item.method === "oauth" &&
            item.connected &&
            !item.needsReconnect,
        );
      badge.textContent = browserConnected
        ? "Browser connected"
        : configured
          ? "✓ Saved"
          : "Not configured";
      badge.classList.toggle("configured", configured);
      const input = document.querySelector(
        `input[name="${badge.dataset.connection}"]`,
      );
      if (input)
        input.placeholder = browserConnected
          ? "Personal token optional"
          : configured
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
      repo.textContent = `${project.provider === "gitlab" ? "GitLab" : "GitHub"} · ${project.repo}`;
      name.append(repo);
      const badge = document.createElement("span");
      badge.className = "project-row-badge";
      badge.textContent = "Configured on server";
      const actions = element("div", "project-actions");
      const verify = element("button", "small-button", "Verify connections");
      verify.type = "button";
      verify.dataset.verifyProject = project.name;
      const check = projectChecks.get(project.name);
      verify.disabled = check?.busy === true;
      if (check?.busy) verify.textContent = "Verifying…";
      actions.append(badge, verify);
      const launch = element("div", "button-row project-launch");
      for (const [type, label] of [
        ["pm", "Run PM"],
        ["developer", "Run Coding"],
      ]) {
        const button = element("button", `small-button launch-${type}`, label);
        button.type = "button";
        button.dataset.launchProject = project.name;
        button.dataset.launchCrew = type;
        launch.append(button);
      }
      actions.append(launch);
      row.append(name, actions);
      const card = element("div", "project-card");
      card.append(row);
      if (check) {
        const result = element("div", "project-checks");
        result.setAttribute("role", check.error ? "alert" : "status");
        result.classList.toggle("error", Boolean(check.error));
        result.append(element("p", "", check.message));
        for (const item of check.checks || [])
          result.append(
            element(
              "p",
              "",
              `${item.ok ? "✓" : "!"} ${item.name}: ${item.detail}`,
            ),
          );
        card.append(result);
      }
      list.append(card);
    }
    const exampleProject = projects.find((project) =>
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name),
    );
    $("doctor-command").textContent =
      `gremlins doctor ${exampleProject ? exampleProject.name : "PROJECT"}`;
    renderJobProjects();
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
      await Promise.allSettled([
        initializeUpdates(),
        refreshRunners(),
        initializeSlack(),
        refreshSources(),
      ]);
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
    for (const input of $("connections-form").querySelectorAll(
      ".password-wrap input",
    )) {
      if (input.value.trim()) values[input.name] = input.value.trim();
    }
    if (!Object.keys(values).length) {
      message(
        $("connections-message"),
        "Paste at least one new token to save. Existing connections stay as they are.",
        true,
      );
      $("linear-token").focus();
      return;
    }
    lockForms(true);
    $("save-connections").textContent = "Saving…";
    message($("connections-message"), "");
    try {
      await api("/api/connections", { values });
      for (const input of $("connections-form").querySelectorAll(
        ".password-wrap input",
      ))
        input.value = "";
      for (const button of $("connections-form").querySelectorAll(
        "[data-reveal]",
      )) {
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
        "Connections saved on your ShipGremlins server. Blank fields were left unchanged. Use Verify connections on your project to check live access.",
      );
      try {
        await refreshStatus();
        await refreshRunners();
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
  function suggestProjectName() {
    if (projectNameEdited) return;
    $("project-name").value = $("project-repo")
      .value.trim()
      .split("/")
      .pop()
      .replace(/\.git$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  $("project-repo").addEventListener("input", suggestProjectName);
  $("project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!$("manual-repository").checked && !$("repository-select").value) {
      message(
        $("project-message"),
        "Choose a repository from your connection, or use manual entry with a saved token.",
        true,
      );
      $("repository-select").focus();
      return;
    }
    const data = {
      project: $("project-name").value.trim(),
      repo: $("project-repo").value.trim(),
      provider: $("project-provider").value,
    };
    if (data.provider === "gitlab" && $("gitlab-server").value.trim()) {
      try {
        const server = new URL($("gitlab-server").value.trim());
        if (
          server.protocol !== "https:" ||
          server.username ||
          server.password ||
          server.pathname !== "/" ||
          server.search ||
          server.hash
        )
          throw new Error();
        data.serverUrl = server.origin;
      } catch {
        message(
          $("project-message"),
          "Enter an HTTPS GitLab server address without credentials, a project path, query, or fragment.",
          true,
        );
        $("gitlab-server").focus();
        return;
      }
    }
    lockForms(true);
    $("add-project").textContent = "Adding…";
    message($("project-message"), "");
    try {
      const result = await api("/api/projects", data);
      $("project-form").reset();
      projectNameEdited = false;
      renderProjectProvider();
      await refreshRepositories();
      const created = Array.isArray(result.result?.created)
        ? result.result.created.length
        : null;
      message(
        $("project-message"),
        `${data.project} is configured on your server.${created === 0 ? " Existing files were kept." : ""} Complete its settings in Configuration, then use Verify connections before running agents.`,
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

  function sourceConnection(provider) {
    return sourceConnections.find(
      (connection) =>
        connection.provider === provider &&
        connection.serverUrl?.replace(/\/$/, "") ===
          sourceProviders[provider].origin,
    );
  }
  function sourceLink(provider, value, installation = false) {
    try {
      const url = new URL(value);
      if (
        url.origin !== sourceProviders[provider].origin ||
        url.username ||
        url.password
      )
        return null;
      if (
        installation &&
        (provider !== "github" || !url.pathname.startsWith("/apps/"))
      )
        return null;
      return url.href;
    } catch {
      return null;
    }
  }
  function sourceButton(label, action, provider, className = "small-button") {
    const button = element("button", className, label);
    button.type = "button";
    button.dataset.sourceAction = action;
    button.dataset.provider = provider;
    return button;
  }
  function createSourceCards() {
    for (const [provider, config] of Object.entries(sourceProviders)) {
      const card = element("article", `source-card source-${provider}`);
      card.id = `source-${provider}`;
      const heading = element("div", "source-card-heading");
      const mark = element("span", "source-provider-mark", config.icon);
      mark.setAttribute("aria-hidden", "true");
      const title = element("div", "");
      const h3 = element("h3", "", config.name);
      h3.id = `source-${provider}-title`;
      card.setAttribute("aria-labelledby", h3.id);
      title.append(
        h3,
        element(
          "p",
          "",
          provider === "github"
            ? "Repositories & pull requests"
            : "Repositories & merge requests",
        ),
      );
      heading.append(mark, title);
      const badge = element("span", "runtime-badge", "Checking…");
      badge.id = `${provider}-source-state`;
      const account = element(
        "p",
        "source-account",
        "Loading connection status.",
      );
      account.id = `${provider}-source-account`;
      const guidance = element("p", "runner-guidance", "");
      guidance.id = `${provider}-source-guidance`;
      const actions = element("div", "button-row source-actions");
      const connect = sourceButton(
        `Connect ${config.name}`,
        "connect",
        provider,
        "button button-dark",
      );
      connect.id = `${provider}-source-connect`;
      connect.disabled = true;
      const install = element(
        "a",
        "small-button",
        "Manage repository access ↗",
      );
      install.id = `${provider}-source-install`;
      install.hidden = true;
      install.target = "_blank";
      install.rel = "noreferrer noopener";
      const disconnect = sourceButton("Disconnect", "disconnect", provider);
      disconnect.id = `${provider}-source-disconnect`;
      disconnect.hidden = true;
      actions.append(connect, install, disconnect);
      const flow = element("div", "source-device");
      flow.id = `${provider}-device`;
      flow.hidden = true;
      const step = element(
        "p",
        "eyebrow muted",
        "1. COPY YOUR VERIFICATION CODE",
      );
      const codeRow = element("div", "device-code-row");
      const code = element("code", "device-code");
      code.id = `${provider}-device-code`;
      code.tabIndex = 0;
      code.setAttribute("aria-label", `${config.name} verification code`);
      codeRow.append(code, sourceButton("Copy code", "copy", provider));
      const open = element(
        "a",
        "button button-dark",
        `2. Open ${config.name} to approve ↗`,
      );
      open.id = `${provider}-device-link`;
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      const instructions = element(
        "p",
        "runner-guidance",
        "Approve only this connection request. Return to this tab when finished; connection status updates automatically.",
      );
      const pending = element("p", "device-pending");
      pending.id = `${provider}-device-pending`;
      pending.setAttribute("role", "status");
      const tools = element("div", "button-row");
      tools.append(
        sourceButton("Retry status", "poll", provider),
        sourceButton("Cancel sign-in", "cancel", provider),
      );
      flow.append(step, codeRow, open, instructions, pending, tools);
      const prompt = element("div", "source-disconnect-prompt");
      prompt.id = `${provider}-disconnect-prompt`;
      prompt.hidden = true;
      prompt.append(
        element(
          "p",
          "runner-guidance",
          "Disconnect browser sign-in? New jobs may need you to reconnect. A separately saved personal token is kept.",
        ),
      );
      const promptActions = element("div", "button-row");
      promptActions.append(
        sourceButton("Keep connected", "keep", provider),
        sourceButton(
          "Disconnect",
          "confirm-disconnect",
          provider,
          "small-button danger-button",
        ),
      );
      prompt.append(promptActions);
      const feedback = element("div", "form-message");
      feedback.id = `${provider}-source-message`;
      feedback.hidden = true;
      feedback.setAttribute("role", "status");
      card.append(
        heading,
        badge,
        account,
        guidance,
        actions,
        flow,
        prompt,
        feedback,
      );
      $("source-cards").append(card);
    }
  }
  function renderSourceControls() {
    if (!$("github-source-connect")) return;
    let connectedCount = 0;
    for (const [provider, config] of Object.entries(sourceProviders)) {
      const status = sourceConnection(provider);
      const flow = sourceFlows.get(provider);
      const busy = sourceBusy.has(provider);
      const connected = status?.connected && !status.needsReconnect;
      if (connected) connectedCount += 1;
      const badge = $(`${provider}-source-state`);
      badge.textContent = !sessionToken
        ? "Session required"
        : sourceLoading && !status
          ? "Checking…"
          : status?.needsReconnect
            ? "Reconnect needed"
            : connected
              ? status.method === "token"
                ? "Token saved"
                : "Connected"
              : flow
                ? "Waiting for approval"
                : status?.available === false
                  ? "Manual token available"
                  : "Not connected";
      badge.classList.toggle("ready", Boolean(connected));
      const account = status?.account;
      $(`${provider}-source-account`).textContent = account
        ? [account.name, account.login ? `@${account.login}` : ""]
            .filter(Boolean)
            .join(" · ")
        : connected
          ? status.method === "token"
            ? "Using a saved personal access token"
            : "Account connected"
          : `${config.name} access has not been connected.`;
      $(`${provider}-source-guidance`).textContent =
        status?.message ||
        (connected
          ? provider === "github" && status.method === "oauth"
            ? "Install the ShipGremlins GitHub App on your chosen repositories, then refresh the repository picker below."
            : "Choose a repository below. Jobs use this connection on your server."
          : "Sign in through your provider. You never paste your account password here.");
      const connect = $(`${provider}-source-connect`);
      connect.textContent =
        busy && !flow
          ? "Connecting…"
          : status?.needsReconnect
            ? `Reconnect ${config.name}`
            : connected && status.method === "oauth"
              ? "Connect another account"
              : `Connect ${config.name}`;
      connect.disabled =
        formsLocked ||
        sourceLoading ||
        busy ||
        Boolean(flow) ||
        !status?.available;
      const installUrl = sourceLink(
        provider,
        flow?.installationUrl || status?.installationUrl,
        true,
      );
      const install = $(`${provider}-source-install`);
      install.hidden = !installUrl;
      if (installUrl) install.href = installUrl;
      const disconnect = $(`${provider}-source-disconnect`);
      disconnect.hidden = status?.method !== "oauth";
      disconnect.disabled = formsLocked || busy || Boolean(flow);
      $(`${provider}-device`).hidden = !flow;
      if (flow) {
        $(`${provider}-device-code`).textContent = flow.userCode;
        $(`${provider}-device-link`).href = flow.safeVerificationUrl;
        const seconds = Math.max(
          0,
          Math.ceil((Date.parse(flow.expiresAt) - Date.now()) / 1000),
        );
        $(`${provider}-device-pending`).textContent = flow.paused
          ? "Status check paused. Use Retry status to try again."
          : `Waiting for approval · code expires in ${Math.max(1, Math.ceil(seconds / 60))} min`;
      }
      for (const button of $(`source-${provider}`).querySelectorAll(
        "[data-source-action]",
      )) {
        if (
          ["poll", "confirm-disconnect"].includes(button.dataset.sourceAction)
        )
          button.disabled = formsLocked || busy;
        if (button.dataset.sourceAction === "poll")
          button.hidden = !flow?.paused;
        if (["copy", "cancel", "keep"].includes(button.dataset.sourceAction))
          button.disabled = formsLocked;
      }
    }
    $("source-count").textContent = String(connectedCount);
    $("source-refresh").disabled = formsLocked || sourceLoading;
  }
  async function refreshSources() {
    if (!sessionToken || sourceLoading) return;
    sourceLoading = true;
    renderSourceControls();
    message($("source-message"), "");
    try {
      const result = await api("/api/source-control");
      sourceConnections = Array.isArray(result.connections)
        ? result.connections
        : [];
      if (currentStatus) {
        currentStatus.sourceConnections = sourceConnections;
        renderStatus(currentStatus);
      }
    } catch (error) {
      message(
        $("source-message"),
        `${error.message} Manual source tokens remain available below.`,
        true,
      );
    } finally {
      sourceLoading = false;
      renderSourceControls();
    }
    await refreshRepositories();
  }
  function endSourceFlow(provider) {
    clearTimeout(sourceTimers.get(provider));
    sourceTimers.delete(provider);
    sourceFlows.delete(provider);
    renderSourceControls();
  }
  function scheduleSourcePoll(provider, seconds) {
    clearTimeout(sourceTimers.get(provider));
    sourceTimers.set(
      provider,
      setTimeout(() => pollSource(provider), Math.max(1, seconds) * 1000),
    );
  }
  async function pollSource(provider) {
    const flow = sourceFlows.get(provider);
    if (!flow || sourceBusy.has(provider) || !sessionToken) return;
    clearTimeout(sourceTimers.get(provider));
    if (Date.parse(flow.expiresAt) <= Date.now()) {
      endSourceFlow(provider);
      message(
        $(`${provider}-source-message`),
        "This verification code expired. Start a new connection to try again.",
        true,
      );
      return;
    }
    sourceBusy.add(provider);
    flow.paused = false;
    renderSourceControls();
    try {
      const result = await api(`/api/source-control/${provider}/poll`, {
        id: flow.id,
      });
      if (sourceFlows.get(provider) !== flow) return;
      if (result.status === "pending") {
        message($(`${provider}-source-message`), "");
        scheduleSourcePoll(
          provider,
          Math.max(
            flow.intervalSeconds,
            result.retryAfterSeconds || 0,
            document.hidden ? 15 : 1,
          ),
        );
      } else if (result.status === "connected") {
        endSourceFlow(provider);
        message(
          $(`${provider}-source-message`),
          `${sourceProviders[provider].name} connected. Choose your app repository below.`,
        );
        await refreshSources();
        await refreshRunners();
      } else if (["expired", "denied"].includes(result.status)) {
        endSourceFlow(provider);
        message(
          $(`${provider}-source-message`),
          result.status === "denied"
            ? "The connection was not approved. You can start again whenever you’re ready."
            : "This verification code expired. Start a new connection to try again.",
          true,
        );
      } else {
        throw new Error("Unexpected connection status. Try checking again.");
      }
    } catch (error) {
      if (sourceFlows.get(provider) === flow) {
        flow.paused = true;
        message($(`${provider}-source-message`), error.message, true);
      }
    } finally {
      sourceBusy.delete(provider);
      renderSourceControls();
    }
  }
  $("source-refresh").addEventListener("click", refreshSources);
  $("source-cards").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-source-action]");
    if (!button || formsLocked) return;
    const { provider, sourceAction: action } = button.dataset;
    if (!sourceProviders[provider]) return;
    const feedback = $(`${provider}-source-message`);
    if (action === "copy") {
      try {
        await copyText(sourceFlows.get(provider)?.userCode || "");
        copiedButton(button);
      } catch (error) {
        message(feedback, error.message, true);
      }
      return;
    }
    if (action === "poll") {
      if (!sourceFlows.get(provider)?.paused) return;
      await pollSource(provider);
      return;
    }
    if (action === "cancel") {
      endSourceFlow(provider);
      message(
        feedback,
        "Sign-in canceled in this dashboard. The unused provider code will expire automatically.",
      );
      return;
    }
    if (action === "disconnect") {
      $(`${provider}-disconnect-prompt`).hidden = false;
      return;
    }
    if (action === "keep") {
      $(`${provider}-disconnect-prompt`).hidden = true;
      return;
    }
    if (sourceBusy.has(provider)) return;
    sourceBusy.add(provider);
    message(feedback, "");
    renderSourceControls();
    try {
      if (action === "connect") {
        const flow = await api(`/api/source-control/${provider}/connect`, {});
        const safeVerificationUrl = sourceLink(
          provider,
          flow.verificationUriComplete || flow.verificationUri,
        );
        if (
          !safeVerificationUrl ||
          !flow.id ||
          !flow.userCode ||
          !Number.isFinite(Date.parse(flow.expiresAt))
        )
          throw new Error(
            "The provider returned an unexpected sign-in link or code. Refresh the connection and try again.",
          );
        sourceFlows.set(provider, {
          ...flow,
          safeVerificationUrl,
          intervalSeconds: Math.max(1, Number(flow.intervalSeconds) || 5),
        });
        renderSourceControls();
        $(`${provider}-device-code`).focus();
        scheduleSourcePoll(
          provider,
          Math.max(1, Number(flow.intervalSeconds) || 5),
        );
      } else if (action === "confirm-disconnect") {
        await api(`/api/source-control/${provider}`, {}, "DELETE");
        $(`${provider}-disconnect-prompt`).hidden = true;
        message(
          feedback,
          "Browser connection removed. Your project files and any separately saved token are kept.",
        );
        await refreshSources();
        await refreshRunners();
      }
    } catch (error) {
      message(feedback, error.message, true);
    } finally {
      sourceBusy.delete(provider);
      renderSourceControls();
    }
  });
  $("source-token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = $("source-token-form");
    const values = Object.fromEntries(
      [...form.querySelectorAll("input")]
        .filter((input) => input.value.trim())
        .map((input) => [input.name, input.value.trim()]),
    );
    if (!Object.keys(values).length) {
      message(
        $("source-token-message"),
        "Paste at least one new source token. Blank fields keep saved values.",
        true,
      );
      $("github-token").focus();
      return;
    }
    lockForms(true);
    $("save-source-tokens").textContent = "Saving…";
    try {
      await api("/api/connections", { values });
      for (const input of form.querySelectorAll("input")) {
        input.value = "";
        input.type = "password";
      }
      for (const button of form.querySelectorAll("[data-reveal]")) {
        button.textContent = "Show";
        button.setAttribute("aria-pressed", "false");
        button.setAttribute(
          "aria-label",
          button.getAttribute("aria-label").replace(/^Hide/, "Show"),
        );
      }
      message(
        $("source-token-message"),
        "Source tokens saved on this server. Choose a repository below, then verify your project’s connections.",
      );
      await refreshStatus();
      await refreshSources();
      await refreshRunners();
    } catch (error) {
      message($("source-token-message"), error.message, true);
    } finally {
      for (const key of Object.keys(values)) delete values[key];
      lockForms(!sessionToken);
      $("save-source-tokens").textContent = "Save source tokens";
    }
  });
  function renderRepositoryDetail() {
    const repository = repositories.find(
      (item) => item.fullName === $("repository-select").value,
    );
    $("repository-detail").hidden = !repository;
    $("repository-detail").textContent = repository
      ? `${repository.private ? "Private" : "Public"} · ${repository.defaultBranch || "Default branch unavailable"} · ${repository.canPush ? "Write access" : "Read-only access"}`
      : "";
  }
  async function refreshRepositories() {
    const provider = $("project-provider").value;
    const manual = $("manual-repository").checked;
    if (!sessionToken || manual) return;
    const revision = ++repositoryRevision;
    const select = $("repository-select");
    const previous = select.value;
    const connected = sourceConnection(provider);
    if (
      !connected?.connected ||
      connected.needsReconnect ||
      (provider === "gitlab" && connected.method === "token")
    ) {
      repositories = [];
      repositoryLoading = false;
      select.replaceChildren(
        new Option(`Connect ${sourceProviders[provider].name} first`, ""),
      );
      $("project-repo").value = "";
      renderRepositoryDetail();
      message(
        $("repository-status"),
        provider === "gitlab" && connected?.method === "token"
          ? "Use browser sign-in for the GitLab.com repository picker. Saved GitLab tokens use manual repository entry so you can choose the correct server."
          : `Connect ${sourceProviders[provider].name} under Source control, or use a saved token with manual entry.`,
      );
      renderProjectProvider();
      return;
    }
    repositoryLoading = true;
    renderProjectProvider();
    message($("repository-status"), "Loading repositories from your provider…");
    try {
      const search = $("repository-search").value.trim();
      const result = await api(
        `/api/source-control/${provider}/repositories${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      );
      if (
        revision !== repositoryRevision ||
        provider !== $("project-provider").value
      )
        return;
      repositories = Array.isArray(result.repositories)
        ? result.repositories.filter(
            (repository) =>
              repository.provider === provider &&
              typeof repository.fullName === "string",
          )
        : [];
      const options = [
        new Option(
          repositories.length
            ? "Choose your app repository"
            : "No repositories available",
          "",
        ),
      ];
      for (const repository of repositories) {
        const option = new Option(
          `${repository.fullName}${repository.canPush ? "" : " · read only"}`,
          repository.fullName,
        );
        option.disabled = !repository.canPush;
        options.push(option);
      }
      select.replaceChildren(...options);
      if (
        repositories.some(
          (repository) =>
            repository.fullName === previous && repository.canPush,
        )
      )
        select.value = previous;
      if (!$("manual-repository").checked)
        $("project-repo").value = select.value;
      renderRepositoryDetail();
      message(
        $("repository-status"),
        repositories.length
          ? `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"} found.${result.truncated ? " More are available; narrow your search." : ""} Write access is needed to create branches and PRs/MRs.`
          : "No repositories found. Check your search, account permissions, or GitHub App repository access, then refresh.",
      );
    } catch (error) {
      if (revision === repositoryRevision)
        message(
          $("repository-status"),
          `${error.message} Use Search / refresh to retry, or enter a repository manually with a saved token.`,
          true,
        );
    } finally {
      if (revision === repositoryRevision) {
        repositoryLoading = false;
        renderProjectProvider();
      }
    }
  }

  function renderProjectProvider() {
    const gitlab = $("project-provider").value === "gitlab";
    const manual = $("manual-repository").checked;
    $("gitlab-options").hidden = !gitlab || !manual;
    $("gitlab-server").disabled = !gitlab || !manual;
    $("repository-picker").hidden = manual;
    $("repository-search").disabled = manual || formsLocked;
    $("repository-refresh").disabled =
      manual || repositoryLoading || formsLocked;
    $("manual-repository-field").hidden = !manual;
    $("project-repo").required = manual;
    $("repository-select").required = !manual;
    $("repository-select").disabled =
      manual || repositoryLoading || formsLocked;
    $("project-repo-label").textContent =
      `${gitlab ? "GitLab" : "GitHub"} repository`;
    $("project-repo").pattern = gitlab
      ? "[^/\\s]+(?:/[^/\\s]+)+"
      : "[^/\\s]+/[^/\\s]+";
    $("project-repo").placeholder = gitlab
      ? "your-group/your-app"
      : "your-team/your-app";
    $("repo-help").textContent = gitlab
      ? "Use group/project or group/subgroup/project. Save a GitLab token under Source control first."
      : "Use owner/repository. Save a GitHub token under Source control first.";
  }
  $("project-provider").addEventListener("change", () => {
    $("project-repo").value = "";
    $("repository-search").value = "";
    $("gitlab-server").value = "";
    suggestProjectName();
    renderProjectProvider();
    refreshRepositories();
  });
  $("manual-repository").addEventListener("change", () => {
    if (!$("manual-repository").checked) {
      $("gitlab-server").value = "";
      $("project-repo").value = $("repository-select").value;
      suggestProjectName();
    }
    renderProjectProvider();
  });
  $("repository-select").addEventListener("change", () => {
    $("project-repo").value = $("repository-select").value;
    suggestProjectName();
    renderRepositoryDetail();
  });
  $("repository-refresh").addEventListener("click", refreshRepositories);
  $("repository-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      refreshRepositories();
    }
  });
  createSourceCards();
  renderProjectProvider();
  $("project-list").addEventListener("click", async (event) => {
    const launch = event.target.closest("[data-launch-project]");
    if (launch && !formsLocked) {
      $("job-project").value = launch.dataset.launchProject;
      $("job-type").value = launch.dataset.launchCrew;
      renderJobAreas();
      $("job-form").scrollIntoView({ behavior: "smooth", block: "center" });
      (launch.dataset.launchCrew === "pm"
        ? $("job-area")
        : $("job-ticket")
      ).focus({ preventScroll: true });
      return;
    }
    const button = event.target.closest("[data-verify-project]");
    if (!button || button.disabled || formsLocked || !sessionToken) return;
    const name = button.dataset.verifyProject;
    projectChecks.set(name, {
      busy: true,
      message: "Checking live provider access and project configuration…",
    });
    renderStatus(currentStatus);
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(name)}/verify`,
        {},
        "POST",
        90000,
      );
      projectChecks.set(name, {
        message: result.ok
          ? "Connections verified. Review the checks below before running your first PM."
          : "Some checks need attention. Update the settings or credentials below, then verify again.",
        error: !result.ok,
        checks: result.checks || [],
      });
    } catch (error) {
      projectChecks.set(name, { error: true, message: error.message });
    } finally {
      renderStatus(currentStatus);
    }
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function actionButton(label, action, id, disabled = false) {
    const button = element("button", "small-button", label);
    button.type = "button";
    button.dataset.runnerAction = action;
    button.dataset.runnerId = id;
    button.disabled = disabled;
    return button;
  }
  function timestamp(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }
  function runnerOperationBusy() {
    return runnerRequestBusy || runnerStatus?.operation?.phase === "working";
  }
  function updateRunnerControls() {
    const locked = formsLocked || !sessionToken || restarting;
    $("refresh-runners").disabled = locked || runnerLoading;
    $("create-runner").disabled =
      locked ||
      !runnerStatus?.machine?.docker?.available ||
      runnerLoading ||
      runnerOperationBusy();
    $("create-runner").textContent = runnerOperationBusy()
      ? "Working…"
      : "Create local worker +";
    $("job-fields").disabled = locked || runnerRequestBusy;
    const workersAvailable = runnerStatus?.runners?.some(
      (runner) =>
        runner.status === "ready" ||
        (runner.status === "busy" && runner.verifiedAt),
    );
    const project = $("job-project").value;
    const pm = $("job-type").value === "pm";
    $("run-job").disabled =
      !workersAvailable || !project || (pm && !$("job-area").value);
    $("job-ticket").required = !pm;
    $("job-ticket").disabled = pm;
    $("job-area").disabled = !pm;
    $("job-area-field").hidden = !pm;
    $("job-ticket-field").hidden = pm;
    $("run-job").textContent = pm ? "Run PM Gremlin ↗" : "Run Coding Gremlin ↗";
    for (const button of document.querySelectorAll("[data-crew-type]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.crewType === $("job-type").value),
      );
    $("job-guidance").textContent = !workersAvailable
      ? "Create or resume a verified worker before queuing a job."
      : !project
        ? "Add a project above, then complete its settings in Configuration."
        : pm && !$("job-area").value
          ? "Enable a PM mandate in this project’s areas.json before running it."
          : "Uses saved settings on this server. Unsaved configuration drafts are not included.";
    for (const button of document.querySelectorAll("[data-runner-action]")) {
      const runner = runnerStatus?.runners?.find(
        (item) => item.id === button.dataset.runnerId,
      );
      button.disabled =
        locked ||
        runnerOperationBusy() ||
        !runner ||
        runner.busy ||
        runner.status === "provisioning";
    }
    const remove = runnerStatus?.runners?.find(
      (runner) => runner.id === removeRunnerId,
    );
    $("confirm-remove-runner").disabled =
      locked || runnerOperationBusy() || !remove || remove.busy;
  }
  function renderJobProjects() {
    const select = $("job-project");
    const chosen = select.value;
    const projects = currentStatus?.projects || [];
    select.replaceChildren();
    for (const project of projects)
      select.append(new Option(project.name, project.name));
    if (!projects.length) select.append(new Option("Add a project first", ""));
    if (projects.some((project) => project.name === chosen))
      select.value = chosen;
    const activityProject = $("activity-project").value;
    $("activity-project").replaceChildren(new Option("All projects", ""));
    for (const project of projects)
      $("activity-project").append(new Option(project.name, project.name));
    if (projects.some((project) => project.name === activityProject))
      $("activity-project").value = activityProject;
    renderJobAreas();
  }
  function renderJobAreas() {
    const select = $("job-area");
    const chosen = select.value;
    const project = currentStatus?.projects?.find(
      (item) => item.name === $("job-project").value,
    );
    const areas = (project?.areas || []).filter((area) => area.enabled);
    select.replaceChildren();
    for (const area of areas)
      select.append(new Option(area.name || area.key, area.key));
    if (!areas.length) select.append(new Option("No enabled PM mandates", ""));
    if (areas.some((area) => area.key === chosen)) select.value = chosen;
    updateRunnerControls();
  }

  function renderRunners(status) {
    runnerStatus = status;
    const runners = Array.isArray(status.runners) ? status.runners : [];
    const jobs = Array.isArray(status.jobs) ? status.jobs : [];
    const docker = status.machine?.docker;
    $("machine-name").textContent =
      status.machine?.name || "Your ShipGremlins server";
    $("machine-description").textContent = [
      status.machine?.platform,
      docker?.architecture,
      "1 job at a time per worker",
    ]
      .filter(Boolean)
      .join(" · ");
    $("docker-state").textContent = docker?.available
      ? "Docker available"
      : "Docker needs attention";
    $("docker-state").classList.toggle("error", !docker?.available);
    $("docker-guidance").textContent = docker?.available
      ? "Workers run on this machine, even when you open the dashboard from another device. Credentials stay on your server and are passed to jobs when needed."
      : `${docker?.message || "Docker could not be reached."} Install and start Docker with Linux containers on this machine, check docker info, then refresh.`;
    const ready = runners.filter(
      (runner) =>
        runner.status === "ready" ||
        (runner.status === "busy" && runner.verifiedAt),
    );
    $("runner-count").textContent = String(runners.length);
    $("runners-summary").textContent = ready.length
      ? `${ready.length} verified ${ready.length === 1 ? "worker" : "workers"}`
      : runners.length
        ? "Worker needs attention"
        : "No workers yet";
    $("runner-step").classList.toggle("complete", ready.length > 0);
    message(
      $("runner-operation"),
      status.operation?.phase !== "idle"
        ? status.operation?.message || "Working on your local worker…"
        : "",
      status.operation?.phase === "error",
    );
    $("runner-operation").classList.toggle(
      "working",
      status.operation?.phase === "working",
    );
    const missing = status.credentials?.missing || [];
    $("runner-credentials").textContent = missing.length
      ? `Some jobs need additional connections: ${missing.join(", ")}. Save the credentials for your project above before running it.`
      : "Project credentials are loaded from this server for each job. Saving credentials does not start work.";
    $("runner-limitations").replaceChildren(
      ...(status.limitations || []).map((text) => element("li", "", text)),
    );
    $("runner-limitations").hidden = !status.limitations?.length;
    const list = $("runner-list");
    const signature = JSON.stringify(runners);
    if (list.dataset.signature !== signature) {
      const focused = document.activeElement?.dataset;
      const focusId = focused?.runnerId;
      const focusAction = focused?.runnerAction;
      list.dataset.signature = signature;
      list.replaceChildren();
      if (!runners.length)
        list.append(
          element(
            "p",
            "worker-empty",
            "No workers yet. A little Docker, a little gremlin, and a real browser check.",
          ),
        );
      for (const runner of runners) {
        const card = element("article", "worker-card");
        const heading = element("div", "worker-heading");
        const identity = element("div", "");
        identity.append(
          element("h3", "", runner.name),
          element("p", "", "Local Docker worker · capacity 1"),
        );
        const state = runner.busy ? "busy" : runner.status;
        heading.append(
          identity,
          element(
            "span",
            `runtime-badge state-${state}`,
            state.charAt(0).toUpperCase() + state.slice(1),
          ),
        );
        card.append(heading);
        if (runner.message)
          card.append(element("p", "runner-guidance", runner.message));
        if (runner.verifiedAt)
          card.append(
            element(
              "p",
              "verified-note",
              `Browser verified ${timestamp(runner.verifiedAt)}`,
            ),
          );
        const actions = element("div", "button-row worker-actions");
        actions.append(
          actionButton("Verify browser job", "verify", runner.id),
          actionButton("Repair", "repair", runner.id),
          actionButton(
            runner.status === "paused" ? "Resume" : "Pause",
            runner.status === "paused" ? "resume" : "pause",
            runner.id,
          ),
          actionButton("Remove", "remove", runner.id),
        );
        card.append(actions);
        if (runner.busy)
          card.append(
            element(
              "p",
              "runner-guidance",
              "This worker is busy. Its current job must finish before it can be paused, repaired, or removed.",
            ),
          );
        list.append(card);
      }
      if (focusId)
        [...list.querySelectorAll("button")]
          .find(
            (button) =>
              button.dataset.runnerId === focusId &&
              button.dataset.runnerAction === focusAction,
          )
          ?.focus({ preventScroll: true });
    }
    if (
      removeRunnerId &&
      !runners.some((runner) => runner.id === removeRunnerId)
    ) {
      removeRunnerId = "";
      $("remove-runner-prompt").hidden = true;
    }
    renderJobs(jobs);
    updateRunnerControls();
  }
  function mergedJobs(jobs = runnerStatus?.jobs || []) {
    return [
      ...new Map([...jobHistory, ...jobs].map((job) => [job.id, job])).values(),
    ].sort((a, b) => a.runId - b.runId);
  }
  async function refreshHistory(earlier = false) {
    if (historyLoading || !sessionToken) return;
    historyLoading = true;
    $("load-history").disabled = true;
    try {
      const result = await api(
        `/api/jobs?limit=100${earlier && historyCursor ? `&beforeRunId=${historyCursor}` : ""}`,
      );
      jobHistory = [
        ...new Map(
          [...jobHistory, ...(result.jobs || [])].map((job) => [job.id, job]),
        ).values(),
      ];
      if (earlier) olderHistoryLoaded = true;
      if (earlier || !olderHistoryLoaded)
        historyCursor = result.nextBeforeRunId;
      $("load-history").hidden = !historyCursor;
      $("history-message").textContent =
        result.historyAvailable === false
          ? "Saved history is unavailable. Recent worker activity is still shown; check your server’s history service."
          : "Activity includes saved runs and current worker jobs.";
      renderJobs(runnerStatus?.jobs || []);
    } catch (error) {
      $("history-message").textContent =
        `Saved history could not load. ${error.message}`;
    } finally {
      historyLoading = false;
      $("load-history").disabled = !sessionToken;
    }
  }
  $("load-history").addEventListener("click", () => refreshHistory(true));
  function renderJobs(jobs) {
    jobs = mergedJobs(jobs);
    $("job-count").textContent =
      `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;
    const list = $("job-list");
    const signature = JSON.stringify([
      jobs,
      selectedJobId,
      activityFilter,
      $("activity-project").value,
    ]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    const visible = jobs.filter((job) => {
      const active = ["queued", "running"].includes(job.status);
      return (
        (activityFilter === "all" ||
          (activityFilter === "running" ? active : !active)) &&
        (!$("activity-project").value ||
          job.project === $("activity-project").value)
      );
    });
    if (!visible.length)
      list.append(
        element(
          "p",
          "worker-empty",
          activityFilter === "running"
            ? "Nothing running right now. Your crew’s next job will appear here."
            : "No matching activity yet. Run a gremlin above to start its trail of actions and evidence.",
        ),
      );
    for (const job of [...visible].reverse()) {
      const row = element("article", "job-row");
      const text = element("div", "job-row-copy");
      text.append(
        element(
          "h4",
          "",
          `${job.type === "pm" ? "PM Gremlin" : job.type === "developer" ? "Coding Gremlin" : "Browser verification"}${job.project ? ` · ${job.project}` : ""}`,
        ),
      );
      text.append(
        element(
          "p",
          "",
          [job.area || job.ticket, timestamp(job.createdAt), job.message]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      const action = element("div", "job-row-action");
      const badge = element(
        "span",
        `runtime-badge state-${job.status}`,
        job.status,
      );
      const button = element(
        "button",
        "small-button",
        selectedJobId === job.id ? "Viewing activity" : "View activity",
      );
      button.type = "button";
      button.dataset.jobId = job.id;
      button.setAttribute("aria-pressed", String(selectedJobId === job.id));
      action.append(badge, button);
      if (["pm", "developer"].includes(job.type)) {
        const avatar = element(
          "img",
          `activity-avatar ${job.type === "pm" ? "pm-avatar" : "coding-avatar"}`,
        );
        avatar.src =
          job.type === "pm"
            ? "/assets/gremlin-security.webp"
            : "/assets/gremlin-coding.webp";
        avatar.alt = "";
        avatar.width = 44;
        avatar.height = 44;
        avatar.loading = "lazy";
        row.append(avatar);
      }
      row.append(text, action);
      list.append(row);
    }
  }
  function scheduleRunnerPoll() {
    clearTimeout(runnerPollTimer);
    if (!sessionToken || restarting) return;
    const active =
      runnerStatus?.operation?.phase === "working" ||
      runnerStatus?.jobs?.some((job) =>
        ["queued", "running"].includes(job.status),
      );
    runnerPollTimer = setTimeout(
      refreshRunners,
      document.hidden ? 30000 : active ? 2000 : 10000,
    );
  }
  async function refreshRunners() {
    if (!sessionToken || runnerLoading || restarting) return;
    runnerLoading = true;
    updateRunnerControls();
    try {
      renderRunners(await api("/api/runners"));
      await refreshHistory();
      message($("runner-message"), "");
      if (selectedJobId) await refreshJobOutput();
    } catch (error) {
      message(
        $("runner-message"),
        `${error.message} Your other dashboard settings are still available. Use Refresh to try again.`,
        true,
      );
      // Do not silently retry forever if the worker service is unavailable.
      clearTimeout(runnerPollTimer);
      return;
    } finally {
      runnerLoading = false;
      updateRunnerControls();
    }
    scheduleRunnerPoll();
  }
  async function runWorkerAction(action, id = "") {
    if (!sessionToken || runnerOperationBusy() || formsLocked) return;
    const runner = runnerStatus?.runners?.find((item) => item.id === id);
    if (id && (!runner || runner.busy)) return;
    runnerRequestBusy = true;
    clearTimeout(runnerPollTimer);
    updateRunnerControls();
    message($("runner-message"), "");
    try {
      await api(
        id
          ? `/api/runners/${encodeURIComponent(id)}/${action}`
          : "/api/runners",
        {},
      );
      await refreshRunners();
    } catch (error) {
      message($("runner-message"), error.message, true);
    } finally {
      runnerRequestBusy = false;
      updateRunnerControls();
      scheduleRunnerPoll();
    }
  }
  $("refresh-runners").addEventListener("click", refreshRunners);
  $("create-runner").addEventListener("click", () => runWorkerAction("create"));
  $("runner-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-runner-action]");
    if (!button || button.disabled) return;
    if (button.dataset.runnerAction === "remove") {
      const runner = runnerStatus?.runners?.find(
        (item) => item.id === button.dataset.runnerId,
      );
      if (!runner || runner.busy) return;
      removeRunnerId = runner.id;
      $("remove-runner-description").textContent =
        `Remove ${runner.name}? This removes the local worker. Project configuration, saved credentials, and job history are kept. A busy worker cannot be removed.`;
      $("remove-runner-prompt").hidden = false;
      updateRunnerControls();
      $("keep-runner").focus();
    } else
      runWorkerAction(button.dataset.runnerAction, button.dataset.runnerId);
  });
  $("keep-runner").addEventListener("click", () => {
    removeRunnerId = "";
    $("remove-runner-prompt").hidden = true;
  });
  $("confirm-remove-runner").addEventListener("click", async () => {
    const id = removeRunnerId;
    if (!id) return;
    removeRunnerId = "";
    $("remove-runner-prompt").hidden = true;
    await runWorkerAction("remove", id);
  });
  $("job-project").addEventListener("change", renderJobAreas);
  $("job-type").addEventListener("change", updateRunnerControls);
  for (const button of document.querySelectorAll("[data-crew-type]"))
    button.addEventListener("click", () => {
      $("job-type").value = button.dataset.crewType;
      updateRunnerControls();
    });
  for (const button of document.querySelectorAll("[data-activity-filter]"))
    button.addEventListener("click", () => {
      activityFilter = button.dataset.activityFilter;
      for (const option of document.querySelectorAll("[data-activity-filter]"))
        option.setAttribute("aria-pressed", String(option === button));
      renderJobs(runnerStatus?.jobs || []);
    });
  $("activity-project").addEventListener("change", () =>
    renderJobs(runnerStatus?.jobs || []),
  );
  $("job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (formsLocked || runnerRequestBusy || !sessionToken) return;
    const type = $("job-type").value;
    const body = { type, project: $("job-project").value };
    if (type === "pm") body.area = $("job-area").value;
    else body.ticket = $("job-ticket").value.trim();
    runnerRequestBusy = true;
    updateRunnerControls();
    message($("job-message"), "Queuing your job…");
    try {
      const result = await api("/api/jobs", body);
      message(
        $("job-message"),
        "Job queued. Follow its output below; it will use the saved configuration on your server.",
      );
      if (type === "developer") $("job-ticket").value = "";
      await refreshRunners();
      if (result.job?.id) selectJob(result.job.id);
    } catch (error) {
      message($("job-message"), error.message, true);
    } finally {
      runnerRequestBusy = false;
      updateRunnerControls();
      scheduleRunnerPoll();
    }
  });

  function clearArtifactBlobs() {
    for (const url of artifactBlobs) URL.revokeObjectURL(url);
    artifactBlobs.clear();
  }
  function artifactUrl(jobId, value) {
    const url = new URL(value, window.location.origin);
    const prefix = `/api/jobs/${encodeURIComponent(jobId)}/artifacts/`;
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith(prefix) ||
      url.username ||
      url.password
    )
      throw new Error("The server returned an unsupported artifact address.");
    return url;
  }
  async function fetchArtifact(jobId, file) {
    const url = artifactUrl(jobId, file.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `Could not load ${file.name}. Refresh the job output to try again.`,
        );
      return await response.blob();
    } finally {
      clearTimeout(timeout);
    }
  }
  async function renderArtifacts(jobId, files, revision) {
    const signature = JSON.stringify([jobId, files]);
    if (artifactSignature === signature) return;
    clearArtifactBlobs();
    $("job-artifacts").replaceChildren();
    if (!files.length) return;
    for (const file of files) {
      if (revision !== outputRevision) return;
      artifactUrl(jobId, file.url);
      const card = element("article", "artifact-card");
      card.append(element("h4", "", file.name));
      if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
        const blob = await fetchArtifact(jobId, file);
        if (revision !== outputRevision) return;
        if (["image/png", "image/jpeg", "image/webp"].includes(blob.type)) {
          const url = URL.createObjectURL(blob);
          artifactBlobs.add(url);
          const preview = element("img", "artifact-preview");
          preview.src = url;
          preview.alt = `Browser evidence: ${file.name}`;
          preview.loading = "lazy";
          card.append(preview);
        }
      }
      const download = element("button", "small-button", "Download artifact");
      download.type = "button";
      download.addEventListener("click", async () => {
        download.disabled = true;
        try {
          const blob = await fetchArtifact(jobId, file);
          const url = URL.createObjectURL(blob);
          artifactBlobs.add(url);
          const link = element("a", "");
          link.href = url;
          link.download = file.name;
          link.click();
        } catch (error) {
          message($("job-output-message"), error.message, true);
        } finally {
          download.disabled = false;
        }
      });
      card.append(download);
      $("job-artifacts").append(card);
    }
    artifactSignature = signature;
  }
  function renderActivity(activity) {
    $("activity-summary").textContent =
      typeof activity.summary === "string" ? activity.summary : "";
    $("activity-summary").hidden = !$("activity-summary").textContent;
    const checks = Array.isArray(activity.checks) ? activity.checks : [];
    $("activity-checks").replaceChildren();
    for (const check of checks) {
      const card = element("div", `activity-check check-${check.status}`);
      card.append(
        element(
          "strong",
          "",
          `${check.status === "succeeded" ? "✓" : check.status === "failed" ? "!" : "◌"} ${check.name}`,
        ),
      );
      if (check.detail) card.append(element("p", "", check.detail));
      $("activity-checks").append(card);
    }
    $("activity-checks").hidden = !checks.length;
    $("activity-timeline").replaceChildren();
    for (const event of activity.events || []) {
      const row = element("li", `activity-event event-${event.type}`);
      const kind = element(
        "span",
        "activity-event-kind",
        event.type === "tool" ? "Tool call" : event.type,
      );
      const heading = element("div", "activity-event-heading");
      heading.append(kind, element("time", "", timestamp(event.timestamp)));
      row.append(heading, element("h4", "", event.title));
      if (event.detail) row.append(element("p", "", event.detail));
      if (event.status)
        row.append(
          element("span", `runtime-badge state-${event.status}`, event.status),
        );
      $("activity-timeline").append(row);
    }
    if (!activity.events?.length)
      $("activity-timeline").append(
        element(
          "li",
          "activity-empty",
          "No structured activity yet. Actions appear here as the worker reports them.",
        ),
      );
  }
  async function refreshJobOutput() {
    if (!selectedJobId || outputLoading || !sessionToken) return;
    const id = selectedJobId;
    const revision = outputRevision;
    outputLoading = true;
    $("refresh-job-output").disabled = true;
    try {
      const [logs, artifacts, activity] = await Promise.all([
        api(`/api/jobs/${encodeURIComponent(id)}/logs`),
        api(`/api/jobs/${encodeURIComponent(id)}/artifacts`),
        api(`/api/jobs/${encodeURIComponent(id)}/activity`).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      ]);
      if (revision !== outputRevision) return;
      const log = $("job-log");
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.textContent = logs.lines?.length
        ? logs.lines.join("\n")
        : "No output yet. Logs will appear when the worker starts.";
      if (atEnd) log.scrollTop = log.scrollHeight;
      if (activity.error)
        message(
          $("activity-message"),
          `Structured activity is unavailable. ${activity.error.message} Raw output and artifacts are still shown below.`,
          true,
        );
      else {
        renderActivity(activity.value);
        message($("activity-message"), "");
      }
      await renderArtifacts(id, artifacts.files || [], revision);
      if (revision === outputRevision) message($("job-output-message"), "");
    } catch (error) {
      if (revision === outputRevision)
        message($("job-output-message"), error.message, true);
    } finally {
      outputLoading = false;
      $("refresh-job-output").disabled = !sessionToken;
      if (revision !== outputRevision && selectedJobId) refreshJobOutput();
    }
  }
  function selectJob(id) {
    selectedJobId = id;
    outputRevision += 1;
    artifactSignature = "";
    clearArtifactBlobs();
    $("job-artifacts").replaceChildren();
    $("activity-timeline").replaceChildren();
    $("activity-summary").hidden = true;
    $("activity-checks").hidden = true;
    message($("activity-message"), "Loading visible activity…");
    $("job-detail").hidden = false;
    const job = mergedJobs().find((item) => item.id === selectedJobId);
    $("job-detail-title").textContent =
      `${job?.project || "Browser verification"}${job?.runId ? ` · run ${job.runId}` : ""}`;
    $("job-log").textContent = "Loading job output…";
    renderJobs(runnerStatus?.jobs || []);
    refreshJobOutput();
  }
  $("job-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-job-id]");
    if (!button) return;
    selectJob(button.dataset.jobId);
    $("job-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("refresh-job-output").addEventListener("click", refreshJobOutput);

  function renderSlackControls() {
    const locked = formsLocked || !sessionToken || slackBusy || restarting;
    const connected = slackStatus?.connected || slackStatus?.webhookConfigured;
    $("slack-connect").disabled = locked || !slackStatus?.available;
    $("slack-connect").textContent = slackBusy
      ? "Connecting…"
      : connected
        ? "Change Slack connection ↗"
        : "Add to Slack ↗";
    $("slack-refresh").disabled = locked;
    $("slack-webhook-fields").disabled = locked;
    $("slack-disconnect").hidden = !connected;
    $("slack-disconnect").disabled = locked;
    $("slack-confirm-disconnect").disabled = locked;
    if (!slackStatus) return;
    $("slack-state").textContent = connected
      ? slackStatus.webhookConfigured && !slackStatus.workspace
        ? "Webhook saved"
        : "Connected"
      : slackStatus.available
        ? "Not connected"
        : "Setup unavailable";
    const workspace =
      typeof slackStatus.workspace === "string"
        ? slackStatus.workspace
        : slackStatus.workspace?.name;
    const channel =
      typeof slackStatus.channel === "string"
        ? slackStatus.channel
        : slackStatus.channel?.name;
    $("slack-workspace").textContent =
      [workspace, channel ? `#${channel.replace(/^#/, "")}` : ""]
        .filter(Boolean)
        .join(" · ") ||
      (connected
        ? "Notifications use your saved incoming webhook."
        : "No Slack workspace connected yet.");
    $("slack-guidance").textContent =
      slackStatus.message ||
      (slackStatus.available
        ? "Choose a workspace and channel on Slack’s installation screen. ShipGremlins posts updates; it does not request channel history access."
        : "One-click Slack installation is not available for this instance yet. You can still connect an incoming webhook below.");
  }
  async function refreshSlack() {
    if (!sessionToken || slackBusy) return;
    slackBusy = true;
    renderSlackControls();
    try {
      slackStatus = await api("/api/slack");
      message($("slack-message"), "");
    } catch (error) {
      message($("slack-message"), error.message, true);
      $("slack-state").textContent = "Unable to check";
      $("slack-workspace").textContent = "Use Refresh status to try again.";
    } finally {
      slackBusy = false;
      renderSlackControls();
    }
  }
  async function initializeSlack() {
    if (!sessionToken) return;
    if (slackEnvelope) {
      slackBusy = true;
      renderSlackControls();
      const envelope = slackEnvelope;
      slackEnvelope = "";
      try {
        await api("/api/slack/complete", { envelope });
        slackStatus = await api("/api/slack");
        message(
          $("slack-message"),
          "Slack connected. Your crew’s updates will go to the selected channel.",
        );
      } catch (error) {
        message(
          $("slack-message"),
          `${error.message} Your saved projects and credentials are unchanged. Refresh status, then reconnect if needed.`,
          true,
        );
      } finally {
        slackBusy = false;
        renderSlackControls();
      }
    } else await refreshSlack();
  }
  $("slack-refresh").addEventListener("click", refreshSlack);
  $("slack-connect").addEventListener("click", async () => {
    if (slackBusy || !sessionToken || !slackStatus?.available) return;
    if (hasUnsavedInputs()) {
      message(
        $("slack-message"),
        "Save or clear your unsaved configuration and form entries before opening Slack. Connecting leaves this page and returns to the same dashboard tab.",
        true,
      );
      return;
    }
    try {
      sessionStorage.setItem(sessionKey, sessionToken);
    } catch {
      message(
        $("slack-message"),
        "This browser cannot retain your dashboard session during Slack authorization. Allow session storage for this dashboard or use the webhook option below.",
        true,
      );
      return;
    }
    slackBusy = true;
    renderSlackControls();
    try {
      const result = await api("/api/slack/connect", {});
      const url = new URL(result.url);
      if (
        url.origin !== "https://shipgremlins.ai" ||
        url.pathname !== "/api/slack/authorize" ||
        url.username ||
        url.password
      )
        throw new Error(
          "The server returned an unexpected Slack authorization address.",
        );
      window.location.assign(url.href);
    } catch (error) {
      slackBusy = false;
      renderSlackControls();
      message($("slack-message"), error.message, true);
    }
  });
  $("slack-disconnect").addEventListener("click", () => {
    $("slack-disconnect-prompt").hidden = false;
    $("slack-keep").focus();
  });
  $("slack-keep").addEventListener("click", () => {
    $("slack-disconnect-prompt").hidden = true;
  });
  $("slack-confirm-disconnect").addEventListener("click", async () => {
    if (slackBusy || !sessionToken) return;
    slackBusy = true;
    renderSlackControls();
    try {
      slackStatus = await api("/api/slack", {}, "DELETE");
      $("slack-disconnect-prompt").hidden = true;
      message(
        $("slack-message"),
        "Slack disconnected. Your projects and jobs are unchanged.",
      );
    } catch (error) {
      message($("slack-message"), error.message, true);
    } finally {
      slackBusy = false;
      renderSlackControls();
    }
  });
  $("slack-webhook-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (slackBusy || !sessionToken) return;
    const url = $("slack-webhook").value.trim();
    if (!url) return;
    slackBusy = true;
    renderSlackControls();
    try {
      slackStatus = await api("/api/slack/webhook", { url });
      $("slack-webhook").value = "";
      message(
        $("slack-message"),
        "Incoming webhook saved on your server. Its value is not stored in this browser.",
      );
    } catch (error) {
      message($("slack-message"), error.message, true);
    } finally {
      slackBusy = false;
      renderSlackControls();
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
        `${editor.path} saved on your server. Future jobs use these settings; enabled mandates follow their configured schedules while the controller is running.`,
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
      ? "Restarting your dashboard. This tab will reconnect automatically; running jobs continue."
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
      [
        "project-repo",
        "project-name",
        "gitlab-server",
        "job-ticket",
        "slack-webhook",
      ].some((id) => $(id).value)
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
    clearTimeout(runnerPollTimer);
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
    clearTimeout(runnerPollTimer);
    clearArtifactBlobs();
    for (const timer of sourceTimers.values()) clearTimeout(timer);
    sourceFlows.clear();
    $("slack-webhook").value = "";
    for (const input of document.querySelectorAll(".password-wrap input"))
      input.value = "";
  });
  initialize();
})();
