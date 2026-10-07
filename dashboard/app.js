"use strict";

(() => {
  const sessionKey = "shipgremlins.dashboard.session";
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let sessionToken = fragment.get("session") || "";
  let slackEnvelope = fragment.get("slack") || "";
  const serviceEnvelopes = {
    linear: fragment.get("linear") || "",
    vercel: fragment.get("vercel") || "",
  };
  if (
    sessionToken ||
    slackEnvelope ||
    serviceEnvelopes.linear ||
    serviceEnvelopes.vercel
  ) {
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
  const pages = window.createDashboardPages({
    initialPage:
      slackEnvelope || serviceEnvelopes.linear || serviceEnvelopes.vercel
        ? "connections"
        : undefined,
  });
  let currentStatus = null;
  let projectOperations = null;
  let projectOnboarding = null;
  let remoteWorkers = null;
  let workspaceDeletion = null;
  let deletedResources = null;
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
  let jobActionBusy = false;
  let jobDetailTrigger = null;
  let jobOutputTimer = null;
  let jobOutputSuspended = false;
  const outputErrors = new Map();
  const outputNotices = new Map();
  const outputCompleted = new Set();
  let patrolOutput = {
    activity: {},
    artifacts: [],
    activityState: "loading",
    artifactState: "loading",
  };
  const artifactBlobs = new Set();
  const projectChecks = new Map();
  let activityFilter = "all";
  let slackStatus = null;
  let slackBusy = false;
  const serviceProviders = {
    linear: { name: "Linear", token: "LINEAR_API_KEY" },
    vercel: { name: "Vercel", token: "VERCEL_TOKEN" },
  };
  const serviceStatuses = new Map();
  const serviceBusy = new Set();
  const serviceSelection = { linear: "default", vercel: "default" };
  const profileControls = new Map();
  const connectionReturn = window.createProjectConnectionReturn();
  let linearOnboarding = null;
  let serviceProfiles = [];
  const linearResourceCache = new Map();
  let linearResourcesQueued = false;
  const validProfileId = (value) =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(value);
  for (const provider of Object.keys(serviceSelection)) {
    try {
      const saved = sessionStorage.getItem(
        serviceEnvelopes[provider]
          ? "gremlins-pending-" + provider
          : "gremlins-selected-" + provider,
      );
      if (validProfileId(saved)) serviceSelection[provider] = saved;
    } catch {
      /* Default remains available when browser storage is disabled. */
    }
  }
  const serviceUrl = (provider, action = "", id = serviceSelection[provider]) =>
    "/api/" +
    provider +
    (action ? "/" + action : "") +
    "?connection=" +
    encodeURIComponent(id || "default");
  function rememberService(provider, id) {
    serviceSelection[provider] = id;
    try {
      sessionStorage.setItem("gremlins-selected-" + provider, id);
    } catch {
      /* Optional preference. */
    }
  }
  function rememberServiceStatus(provider, status) {
    serviceStatuses.set(provider, status);
    const profile = serviceProfiles.find(
      (item) =>
        item.provider === provider && item.id === serviceSelection[provider],
    );
    if (profile) Object.assign(profile, status);
    profileControls
      .get(provider)
      ?.setConnections(serviceProfiles, serviceSelection[provider]);
  }
  async function refreshProfileCatalog() {
    const result = await api("/api/service-connections");
    serviceProfiles = Array.isArray(result.connections)
      ? result.connections
      : [];
    for (const [provider, control] of profileControls)
      control.setConnections(serviceProfiles, serviceSelection[provider]);
    const select = $("project-linear-connection");
    const selected = select.value || "default";
    const profiles = serviceProfiles.filter(
      (item) => item.provider === "linear",
    );
    if (!profiles.some((item) => item.id === selected))
      profiles.push({
        id: selected,
        label:
          selected === "default"
            ? "Default connection"
            : selected + " · unavailable",
      });
    select.replaceChildren(
      ...profiles.map((item) => new Option(item.label || item.id, item.id)),
    );
    select.value = selected;
    newProjectSettings.setConnections?.(serviceProfiles);
    projectEditor.form?.setConnections?.(serviceProfiles);
    renderLinearSetup();
  }
  let linearResources = { teams: [], projects: [] };
  let linearResourcesLoading = false;
  let linearModeEdited = false;
  let pmKeyEdited = false;
  let pmLinearContext = "";
  let pmCreating = false;
  let pmPlanning = false;
  let pmDraft = null;
  let pmAdoption = null;
  const pmCreateDialog = $("pm-create-drawer");
  document.body.append(pmCreateDialog);
  let pmCreateTrigger = null;
  let adoptionSignalReturn = null;
  let pendingPmCreate = location.hash === "#pm-create-drawer";
  const areaActions = new Map();
  let pmActions;
  let codingActions;
  let projectLayoutInitialized = false;
  let projectWorkspace = null;
  const pmCharter = window.createPmCharter(
    $("pm-charter-fields"),
    "new-charter",
  );
  let newProjectSettings = window.createProjectSettings(
    $("new-project-settings"),
    "new-settings",
  );
  const projectEditor = {
    name: "",
    path: "",
    revision: "",
    config: null,
    form: null,
    busy: false,
    loading: false,
    generation: 0,
    pending: null,
    trigger: null,
  };
  function adoptLinearProjectSnapshot(projectName, document) {
    if (projectEditor.name !== projectName) return false;
    if (
      !document ||
      document.path !== projectEditor.path ||
      typeof document.content !== "string" ||
      typeof document.revision !== "string"
    )
      return false;
    const next = JSON.parse(document.content);
    const unrelated = (value) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value || {}).filter(
            ([key]) => !["linear", "verified"].includes(key),
          ),
        ),
      );
    if (unrelated(projectEditor.config) !== unrelated(next)) {
      message(
        $("project-settings-message"),
        "Linear mappings were saved, but other project settings changed. Your form draft is kept. Reload saved settings before saving it so newer changes are not overwritten.",
        true,
      );
      return false;
    }
    projectEditor.config = next;
    projectEditor.revision = document.revision;
    return true;
  }
  let projectLinearSettings = null;
  if (window.createProjectLinearSettings && $("edit-linear-settings")) {
    projectLinearSettings = window.createProjectLinearSettings(
      $("edit-linear-settings"),
      {
        api,
        onBusy: () => updateProjectEditorControls(),
        onError: (error) =>
          message(
            $("project-settings-message"),
            error?.message || String(error),
            true,
          ),
        onSaved: async ({ projectName, projectChanged, project }) => {
          if (projectChanged && projectEditor.name === projectName) {
            adoptLinearProjectSnapshot(projectName, project);
            // The Linear panel changes separate fields. Preserve unsaved hosting,
            // command, and signal edits while updating the main form's revision.
          }
          projectChecks.delete(projectName);
          await refreshStatus();
        },
      },
    );
  }
  for (const provider of Object.keys(serviceProviders)) {
    const container = document.createElement("div");
    $(provider + "-connection")
      .querySelector(".service-actions")
      .before(container);
    profileControls.set(
      provider,
      window.createConnectionProfiles(container, {
        provider,
        api,
        onChange: async (id) => {
          $(provider + "-disconnect-prompt").hidden = true;
          rememberService(provider, id);
          serviceStatuses.delete(provider);
          await refreshService(provider);
        },
        onCreated: async (id) => {
          rememberService(provider, id);
          await refreshProfileCatalog();
          await refreshService(provider);
          message(
            $(provider + "-message"),
            "Connection created. Connect this account below, then select it in your project's settings.",
          );
          $(provider + "-connect").focus();
        },
        onRemoved: async () => {
          rememberService(provider, "default");
          serviceStatuses.delete(provider);
          await refreshProfileCatalog();
          await refreshService(provider);
          await refreshStatus();
        },
      }),
    );
  }
  const mappingBusy = new Set();
  const mappingTeamSelections = new Map();
  const mappingMessages = new Map();
  const projectDetailsState = new Map();
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

  const connectionsView = window.createConnectionsView({
    api,
    message,
    onSaved: async () => {
      await refreshStatus();
      await refreshRunners();
    },
    onConfigure: async (provider, project, trigger) => {
      await openProjectSettings(project, trigger, {
        section: "signals",
        provider,
      });
    },
  });
  const updateBanner = window.createUpdateBanner($("global-update-banner"), {
    onApply: () => runUpdateAction("apply"),
    onRestart: () => restartDashboard(),
    onDetails: () => pages.navigate("/settings#updates"),
    onCheck: () => runUpdateAction("check"),
  });
  const mixpanelReports = window.createMixpanelReports?.(
    $("mixpanel-reports"),
    {
      api,
      onSaved: async (project) => {
        projectChecks.delete(project);
        await refreshStatus();
      },
    },
  );

  function message(element, text, error = false) {
    element.replaceChildren();
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle("error", error);
    element.setAttribute("role", error ? "alert" : "status");
  }

  function lockForms(locked) {
    formsLocked = locked;
    workspaceDeletion?.sync();
    deletedResources?.sync();
    $("connections-fields").disabled = locked;
    connectionsView.setLocked(locked);
    $("source-token-fields").disabled = locked;
    $("railway-token-fields").disabled = locked;
    $("cloud-run-token-fields").disabled = locked;
    renderSourceControls();
    $("project-fields").disabled = locked;
    updateEditorControls();
    updateRunnerControls();
    renderSlackControls();
    renderServiceControls();
    renderLinearSetup();
    renderProjectProvider();
    updateProjectEditorControls();
    pmDraft?.setLocked(locked || pmCreating);
    if (currentStatus) renderStatus(currentStatus);
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
    signal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
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
      signal?.removeEventListener("abort", abort);
    }
  }

  function renderConnectionSummary() {
    if (!currentStatus) return;
    const services = new Set();
    for (const profile of serviceProfiles)
      if (profile.connected && !profile.needsReconnect)
        services.add(profile.provider);
    const providerFor = {
      GITHUB_TOKEN: "github",
      GITLAB_TOKEN: "gitlab",
      LINEAR_API_KEY: "linear",
      VERCEL_TOKEN: "vercel",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
      RAILWAY_TOKEN: "railway",
      GCP_SERVICE_ACCOUNT_JSON: "cloud-run",
    };
    for (const item of currentStatus.connections || [])
      if (item.configured) {
        const provider = item.provider || providerFor[item.name];
        if (provider) services.add(provider);
      }
    for (const item of currentStatus.sourceConnections || sourceConnections)
      if (item.connected && !item.needsReconnect) services.add(item.provider);
    for (const provider of Object.keys(serviceProviders)) {
      const item =
        serviceStatuses.get(provider) ||
        currentStatus.serviceConnections?.find(
          (item) => item.provider === provider,
        );
      if (item?.connected && !item.needsReconnect) services.add(provider);
    }
    if (slackStatus?.connected || slackStatus?.webhookConfigured)
      services.add("slack");
    const count = services.size;
    $("connection-count").textContent = String(count);
    $("connections-summary").textContent =
      `${count} ${count === 1 ? "connection" : "connections"} configured`;
  }
  function renderOverview() {
    const projects = Array.isArray(currentStatus?.projects)
      ? currentStatus.projects
      : [];
    const workers = Array.isArray(runnerStatus?.runners)
      ? runnerStatus.runners
      : [];
    const verified = workers.filter(
      (worker) =>
        worker.verifiedAt && ["ready", "busy"].includes(worker.status),
    );
    const busy = verified.filter((worker) => worker.status === "busy").length;
    const jobs = Array.isArray(runnerStatus?.jobs) ? runnerStatus.jobs : [];
    const queued = jobs.filter((job) => job.status === "queued").length;
    const running = jobs.filter((job) => job.status === "running").length;
    const text = (id, value) => {
      const node = $(id);
      if (node) node.textContent = value;
    };
    text(
      "overview-project-count",
      currentStatus ? String(projects.length) : "—",
    );
    text(
      "overview-pm-count",
      currentStatus
        ? String(
            projects.reduce(
              (total, project) =>
                total +
                (Array.isArray(project.areas) ? project.areas.length : 0),
              0,
            ),
          )
        : "—",
    );
    text("overview-worker-count", runnerStatus ? String(verified.length) : "—");
    text(
      "overview-worker-note",
      !runnerStatus
        ? "Worker status has not loaded."
        : verified.length
          ? `${verified.length - busy} idle · ${busy} busy · browser verified`
          : workers.length
            ? `${workers.length} configured · none currently verified and available`
            : "Create a worker to run jobs.",
    );
    text("overview-job-count", runnerStatus ? String(queued + running) : "—");
    text(
      "overview-job-note",
      runnerStatus
        ? `${running} running · ${queued} queued`
        : "Current job status has not loaded.",
    );
    window.renderFirstRunOverview?.(currentStatus, runnerStatus, {
      locked: formsLocked,
    });
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
    renderConnectionSummary();
    $("project-count").textContent = String(projects.length);
    $("projects-summary").textContent = projects.length
      ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} configured`
      : "No projects yet";
    $("connection-step").classList.toggle(
      "complete",
      sourceSaved &&
        connections.some(
          (connection) =>
            connection.name === "CLAUDE_CODE_OAUTH_TOKEN" &&
            connection.configured,
        ),
    );
    $("project-step").classList.toggle("complete", projects.length > 0);
    renderOverview();
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
    connectionsView.render(connections, projects, {
      locked: formsLocked,
      slackConnected: Boolean(
        slackStatus?.connected || slackStatus?.webhookConfigured,
      ),
    });
    mixpanelReports?.setProjects(projects);
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
          : "Not connected";
      badge.classList.toggle("configured", configured);
      const input = document.querySelector(
        `[name="${badge.dataset.connection}"]`,
      );
      if (input)
        input.placeholder = browserConnected
          ? "Personal token optional"
          : configured
            ? "Saved — leave blank to keep"
            : input.dataset.originalPlaceholder || input.placeholder;
    }
    const list = $("project-list");
    const focused = list.contains(document.activeElement)
      ? document.activeElement
      : null;
    const focusedProject = focused?.closest("[data-project-name]")?.dataset
      .projectName;
    const focusedControl = focused?.dataset.projectControl;
    for (const card of list.querySelectorAll("[data-project-name]")) {
      projectDetailsState.set(card.dataset.projectName, {
        open: card.querySelector(".project-linear-drawer")?.open === true,
        pmsOpen: card.querySelector(".project-pms")?.open === true,
      });
      const mapping = card.querySelector("[data-mapping-project]");
      if (mapping)
        mappingTeamSelections.set(card.dataset.projectName, mapping.value);
    }
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
      const title = element("div", "project-title-line");
      const projectLink = element("a", "project-title", project.name);
      projectLink.href = `/projects/${encodeURIComponent(project.name)}`;
      title.append(projectLink);
      const repo = document.createElement("span");
      repo.className = "project-row-repo";
      repo.textContent = `${project.provider === "gitlab" ? "GitLab" : "GitHub"} · ${project.repo}`;
      const badge = document.createElement("span");
      badge.className = "project-row-badge";
      badge.textContent = project.foundation?.needed
        ? "Build foundation"
        : project.readiness?.canRun
          ? "Ready to run"
          : project.readiness?.blockers?.[0]?.action === "worker"
            ? "Needs a worker"
            : "Finish setup";
      title.append(badge);
      name.append(title, repo);
      const actions = element("div", "project-actions");
      const open = element(
        "a",
        "button button-dark",
        project.foundation?.needed ? "Build foundation" : "Open project",
      );
      open.href = `/projects/${encodeURIComponent(project.name)}${project.foundation?.needed ? "?tab=environment" : ""}`;
      open.dataset.projectControl = "open";
      const edit = element("button", "small-button", "Settings");
      edit.type = "button";
      edit.dataset.editProject = project.name;
      edit.dataset.projectControl = "edit";
      actions.append(open, edit);
      row.append(name, actions);
      const card = element("div", "project-card");
      card.dataset.projectName = project.name;
      card.append(row);
      const pmCount = project.areas?.length || 0;
      card.append(
        element(
          "p",
          "project-capabilities",
          `${pmCount} ${pmCount === 1 ? "PM" : "PMs"}`,
        ),
      );
      list.append(card);
    }
    if (focusedProject && focusedControl) {
      const card = [...list.querySelectorAll("[data-project-name]")].find(
        (item) => item.dataset.projectName === focusedProject,
      );
      [...(card?.querySelectorAll("[data-project-control]") || [])]
        .find((item) => item.dataset.projectControl === focusedControl)
        ?.focus({ preventScroll: true });
    }
    const exampleProject = projects.find((project) =>
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name),
    );
    $("doctor-command").textContent =
      `gremlins doctor ${exampleProject ? exampleProject.name : "PROJECT"}`;
    renderJobProjects();
    renderPmProjects();
    projectWorkspace?.setStatus(status, formsLocked);
    projectOnboarding?.syncConnections();
    projectOperations?.resume();
    projectOperations?.renderOverview();
    remoteWorkers?.setProjects(projects);
    if (!projectLayoutInitialized) {
      $("new-project-drawer").open =
        projects.length === 0 ||
        ideaCrew.hasDraft() ||
        location.hash === "#new-project-drawer";
      projectLayoutInitialized = true;
    }
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
      try {
        await refreshProfileCatalog();
      } catch (error) {
        message($("linear-message"), error.message, true);
      }
      await Promise.allSettled([
        initializeUpdates(),
        refreshRunners(),
        initializeSlack(),
        initializeService("linear"),
        initializeService("vercel"),
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
      ".password-wrap input, textarea[data-secret-json]",
    )) {
      if (input.value !== "") values[input.name] = input.value;
    }
    if (!Object.keys(values).length) {
      message(
        $("connections-message"),
        "Paste the token from claude setup-token. Your saved token stays unchanged until you save a new one.",
        true,
      );
      $("claude-token").focus();
      return;
    }
    lockForms(true);
    $("save-connections").textContent = "Saving…";
    message($("connections-message"), "");
    try {
      await api("/api/connections", { values });
      for (const input of $("connections-form").querySelectorAll(
        ".password-wrap input, textarea[data-secret-json]",
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
        "Claude token saved on your server for AI setup suggestions, PMs, and coding jobs.",
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
      $("save-connections").textContent = "Save Claude token";
    }
  });

  $("project-name").addEventListener("input", () => {
    projectNameEdited = Boolean($("project-name").value);
    newProjectSettings.setProjectName?.($("project-name").value);
  });
  function suggestProjectName() {
    if (projectNameEdited) return;
    if ($("project-start").value === "idea" && $("project-name").value) return;
    $("project-name").value = $("project-repo")
      .value.trim()
      .split("/")
      .pop()
      .replace(/\.git$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    newProjectSettings.setProjectName?.($("project-name").value);
  }
  $("project-repo").addEventListener("input", suggestProjectName);
  $("project-form").addEventListener(
    "invalid",
    (event) => {
      for (
        let parent = event.target.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent.tagName === "DETAILS") parent.open = true;
      message(
        $("project-message"),
        "Complete the highlighted project setting before continuing.",
        true,
      );
    },
    true,
  );
  let projectWizard;
  const ideaCrew = window.createIdeaCrew({
    container: $("idea-crew-panel"),
    previewContainer: $("idea-crew-review"),
    api,
    onChange: () => {
      if ($("project-start").value === "idea")
        $("add-project").disabled = ideaCrew.busy;
      projectWizard?.update();
    },
    suggestName: (name) => {
      if (!projectNameEdited && /^[a-z][a-z0-9-]*$/.test(name))
        $("project-name").value = name;
    },
    onRestore: (destination) => {
      $("project-start").value = "idea";
      $("new-project-drawer").open = true;
      if (destination) {
        $("project-provider").value = destination.provider;
        $("project-name").value = destination.project;
        $("project-repo").value = destination.repo;
        $("manual-repository").checked = true;
        if (destination.serverUrl)
          $("gitlab-server").value = destination.serverUrl;
        $("project-linear-connection").value = destination.connectionId;
        projectNameEdited = true;
        renderProjectProvider();
      }
      renderStartingPoint();
      projectWizard?.restore(destination);
    },
  });
  function renderStartingPoint() {
    const idea = $("project-start").value === "idea";
    $("idea-crew-panel").hidden = !idea;
    $("new-project-advanced").hidden = idea;
    $("add-project").textContent = idea ? "Create my crew" : "Add project";
    $("add-project").disabled = idea && ideaCrew.busy;
    $("project-create-explanation").textContent = idea
      ? "Creates the reviewed PM crew and shared brief. Empty repositories get a README. PM schedules start paused; app code is built through approved tickets."
      : "A Setup Gremlin reads the repository and suggests a setup for your review. Then adopt your first PM and let it learn the app. Coding waits for your approval of a specific change.";
    projectWizard?.update();
  }
  projectWizard = window.createProjectWizard({
    api,
    crew: () => ideaCrew,
    onProviderChange: () => refreshRepositories(),
  });
  $("project-start").addEventListener("change", renderStartingPoint);
  if (sessionToken) void ideaCrew.restore();
  $("project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fromIdea = $("project-start").value === "idea";
    if (fromIdea && !ideaCrew.ready()) {
      message(
        $("project-message"),
        "Describe your idea and review its crew plan before creating the project.",
        true,
      );
      return;
    }
    if (
      !fromIdea &&
      !$("manual-repository").checked &&
      !$("repository-select").value
    ) {
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
      onboarding: true,
      linearMode: $("project-linear-mode").value,
      linear: {
        connectionId: $("project-linear-connection").value || "default",
      },
    };
    if (fromIdea) Object.assign(data, projectWizard.destination());
    try {
      if (!fromIdea) Object.assign(data, newProjectSettings.read());
    } catch (error) {
      message($("project-message"), error.message, true);
      return;
    }
    if (data.linearMode === "reuse") {
      data.linearTeamId = $("project-linear-team").value;
      if (!data.linearTeamId) {
        message(
          $("project-message"),
          "Choose an existing Linear team, or create a new one for this app.",
          true,
        );
        $("project-linear-team").focus();
        return;
      }
    }
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
    $("add-project").textContent = "Setting up…";
    message(
      $("project-message"),
      data.linearMode === "later"
        ? "Saving your app configuration…"
        : "Saving your app and its selected Linear team…",
    );
    try {
      const result = fromIdea
        ? await ideaCrew.create({
            project: data.project,
            repo: data.repo,
            provider: data.provider,
            ...(data.serverUrl ? { serverUrl: data.serverUrl } : {}),
            ...(data.newRepository
              ? { newRepository: data.newRepository }
              : {}),
            connectionId: data.linear.connectionId,
            linearMode: data.linearMode,
            ...(data.linearTeamId ? { linearTeamId: data.linearTeamId } : {}),
          })
        : await api("/api/projects", data, "POST", 90000);
      if (fromIdea) ideaCrew.clear();
      $("project-form").reset();
      projectWizard.reset();
      newProjectSettings = window.createProjectSettings(
        $("new-project-settings"),
        "new-settings",
        {},
        { connections: serviceProfiles },
      );
      projectNameEdited = false;
      linearModeEdited = false;
      renderProjectProvider();
      renderLinearSetup();
      await refreshRepositories().catch(() => {});
      const created = Array.isArray(result.result?.created)
        ? result.result.created.length
        : null;
      message(
        $("project-message"),
        fromIdea
          ? `${result.message} ${linearResultMessage(result.linear)}`
          : `${data.project} is configured on your server.${created === 0 ? " Existing files were kept." : ""} ${linearResultMessage(result.linear)} Review the repository setup, then meet your first gremlin.`,
        result.linear?.status === "error",
      );
      try {
        await refreshStatus();
        await refreshConfigFiles();
        pages.navigate(
          `/projects/${encodeURIComponent(data.project)}${fromIdea ? "?tab=environment" : ""}`,
        );
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
      renderStartingPoint();
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
      const mark = element("span", "source-provider-mark");
      mark.setAttribute("aria-hidden", "true");
      const logo = element("img", "");
      logo.src = `/assets/brands/${provider}.svg`;
      logo.width = 26;
      logo.height = 26;
      logo.alt = "";
      mark.append(logo);
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
      $(`source-${provider}`).classList.toggle(
        "is-connected",
        Boolean(connected && !flow),
      );
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
    $("gitlab-options").hidden = !gitlab;
    $("gitlab-server").disabled = !gitlab;
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
    newProjectSettings.setDefaultBranch(
      repositories.find(
        (item) => item.fullName === $("repository-select").value,
      )?.defaultBranch,
    );
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
  document.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-project]");
    if (edit && !formsLocked) {
      await openProjectSettings(edit.dataset.editProject, edit);
      if (edit.dataset.editLinear) focusProjectSection("linear");
      return;
    }
    const launch = event.target.closest("[data-launch-project]");
    if (launch && !launch.disabled && !formsLocked) {
      if (launch.dataset.launchCrew === "pm") {
        const project = currentStatus?.projects?.find(
          (item) => item.name === launch.dataset.launchProject,
        );
        const area =
          launch.dataset.launchArea ||
          (project?.areas?.length === 1 ? project.areas[0].key : "");
        if (!area) {
          pages.navigate(
            `/projects/${encodeURIComponent(launch.dataset.launchProject)}`,
          );
          return;
        }
        await (
          launch.dataset.pmMode === "exploration"
            ? pmActions.explore
            : pmActions.run
        )(launch.dataset.launchProject, area, launch);
        return;
      }
      if (launch.dataset.launchCrew === "developer") {
        await codingActions.run(launch.dataset.launchProject);
        return;
      }
      $("job-project").value = launch.dataset.launchProject;
      $("job-type").value = launch.dataset.launchCrew;
      if (launch.dataset.launchCrew === "developer") {
        $("job-ticket").value = "";
        $("job-ticket-field").open = false;
      }
      renderJobAreas();
      if (launch.dataset.launchArea)
        $("job-area").value = launch.dataset.launchArea;
      updateRunnerControls();
      pages.navigate("/runners#job-form");
      if (launch.dataset.launchCrew === "developer")
        await queueManualJob({
          type: "developer",
          project: launch.dataset.launchProject,
        });
      else $("job-area").focus({ preventScroll: true });
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
      await refreshStatus();
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
  function openRunnerManagement(runner, trigger) {
    const dialog = element("dialog", "runner-management-dialog");
    const header = element("header", "surface-dialog-header");
    const title = element("h2", "", runner.name);
    title.id = "runner-management-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const close = element("button", "small-button", "Close");
    close.type = "button";
    const finish = () => {
      dialog.close();
      dialog.remove();
      trigger.focus();
    };
    close.addEventListener("click", finish);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    header.append(title, close);
    const body = element("div", "surface-dialog-body");
    body.append(
      element(
        "p",
        "runner-guidance",
        runner.message || "Manage this runner’s browser and local environment.",
      ),
    );
    for (const [label, action, description] of [
      [
        "Verify browser",
        "verify",
        "Run a browser check to confirm the worker is ready.",
      ],
      [
        "Repair worker",
        "repair",
        "Rebuild and verify this worker’s local environment.",
      ],
      [
        "Remove worker",
        "remove",
        "Disconnect this local worker. You’ll review this action first.",
      ],
    ]) {
      const row = element("section", "runner-management-action");
      const button = actionButton(
        label,
        action,
        runner.id,
        Boolean(runner.busy),
      );
      button.addEventListener("click", () => {
        dialog.close();
        setTimeout(() => dialog.remove(), 0);
      });
      row.append(element("p", "", description), button);
      body.append(row);
    }
    dialog.append(header, body);
    document.body.append(dialog);
    dialog.showModal();
    updateRunnerControls();
    close.focus();
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
    const selected = currentStatus?.projects?.find(
      (item) => item.name === project,
    );
    const area = selected?.readiness?.areas?.find(
      (item) => item.key === $("job-area").value,
    );
    const pm = $("job-type").value === "pm";
    const pmCanPrepare =
      area?.canRun === true ||
      (area?.blockers?.length > 0 &&
        area.blockers.every((blocker) =>
          ["linear_mapping", "verification"].includes(blocker.id),
        ));
    $("run-job").disabled =
      locked ||
      runnerRequestBusy ||
      !workersAvailable ||
      !project ||
      Boolean(selected?.foundation?.needed) ||
      (pm
        ? !$("job-area").value || !pmCanPrepare
        : !selected?.readiness?.canRun);
    $("job-ticket").required = false;
    $("job-ticket").disabled = pm;
    $("job-area").disabled = !pm;
    $("job-area-field").hidden = !pm;
    $("job-ticket-field").hidden = pm;
    $("run-job").textContent = runnerRequestBusy
      ? "Queuing…"
      : pm
        ? "Run PM once ↗"
        : $("job-ticket").value.trim()
          ? "Run this ticket ↗"
          : "Start coding ↗";
    for (const button of document.querySelectorAll("[data-crew-type]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.crewType === $("job-type").value),
      );
    const blockers = pm
      ? area?.blockers || selected?.readiness?.blockers
      : selected?.readiness?.blockers;
    $("job-guidance").textContent = selected?.foundation?.needed
      ? "Build the first milestone from this project’s Environment tab. Your PMs can explore once there is an app."
      : !project
        ? "Add a project in Projects to get started."
        : pm && !area?.canRun && pmCanPrepare
          ? "Prepares this PM’s Linear mapping and verifies connections, then runs it once. Automation stays as it is."
          : blockers?.length
            ? "Finish the setup steps below to start this run."
            : pm && !$("job-area").value
              ? "Create a PM mandate in Projects first."
              : pm
                ? "Investigates this mandate once. Automation stays as it is."
                : $("job-ticket").value.trim()
                  ? "Checks this ticket’s approval and ownership, then starts one coding run. Automation stays as it is."
                  : "Finds the next ready, approved ticket in this project’s Linear queue and starts one coding run. It does not approve tickets or change automation.";
    $("job-setup-guide").replaceChildren(
      ...(selected &&
      (selected.foundation?.needed ||
        (blockers?.length && !(pm && pmCanPrepare)))
        ? [
            selected.foundation?.needed
              ? window.renderFoundationLauncher(selected)
              : window.renderCrewSetup(selected, { blockers, compact: true }),
          ]
        : []),
    );
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
    for (const button of document.querySelectorAll(
      '[data-launch-crew="developer"]',
    ))
      button.disabled =
        locked ||
        runnerRequestBusy ||
        Boolean(codingActions?.getState(button.dataset.launchProject)?.busy);
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
    const areas = project?.areas || [];
    select.replaceChildren();
    for (const area of areas)
      select.append(
        new Option(
          `${area.name || area.key}${area.enabled ? " · investigations on" : ""}${(area.codingEnabled ?? area.enabled) ? " · coding pickup on" : ""}`,
          area.key,
        ),
      );
    if (!areas.length) select.append(new Option("Create a PM first", ""));
    if (areas.some((area) => area.key === chosen)) select.value = chosen;
    updateRunnerControls();
  }

  function renderRunners(status) {
    const workersChanged =
      JSON.stringify(runnerStatus?.runners) !== JSON.stringify(status.runners);
    runnerStatus = status;
    if (workersChanged && currentStatus && !loading)
      refreshStatus().catch(() => {});
    renderOverview();
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
    $("runner-credentials").hidden = !missing.length;
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
        if (runner.message && !["ready", "busy"].includes(state))
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
        const manage = element("button", "small-button", "Manage");
        manage.type = "button";
        manage.addEventListener("click", () =>
          openRunnerManagement(runner, manage),
        );
        actions.append(
          actionButton(
            runner.status === "paused" ? "Resume" : "Pause",
            runner.status === "paused" ? "resume" : "pause",
            runner.id,
          ),
          manage,
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
    projectWorkspace?.render();
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
    if (pages.run && !selectedJobId && jobs.some((job) => job.id === pages.run))
      selectJob(pages.run);
    renderRunIdentity();
    renderJobControls();
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
            : "No matching activity yet. Start a run from a project or Your gremlins to see its progress here.",
        ),
      );
    for (const job of [...visible].reverse()) {
      const row = element("article", "job-row");
      const text = element("div", "job-row-copy");
      text.append(
        element(
          "h4",
          "",
          `${job.grumblin ? `AI customer simulation · ${job.grumblin.name}` : job.type === "pm" ? (job.pmMode === "discovery" ? "PM Gremlin · Discovery" : job.pmMode === "exploration" ? "PM Gremlin · Product exploration" : "PM Gremlin · Patrol") : job.type === "developer" ? "Coding Gremlin" : "Browser verification"}${job.project ? ` · ${job.project}` : ""}`,
        ),
      );
      text.append(
        element(
          "p",
          "",
          [
            job.type === "developer" ? job.ticket || job.area : job.area,
            timestamp(job.createdAt),
            job.message,
          ]
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
  $("job-project").addEventListener("change", () => {
    $("job-ticket").value = "";
    $("job-ticket-field").open = false;
    renderJobAreas();
  });
  $("job-area").addEventListener("change", updateRunnerControls);
  $("job-ticket").addEventListener("input", updateRunnerControls);
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
  async function queueManualJob(input) {
    if (formsLocked || runnerRequestBusy || !sessionToken) return;
    const { type, project } = input;
    const body = { type, project };
    if (type === "pm") body.area = input.area;
    else if (input.ticket?.trim()) body.ticket = input.ticket.trim();
    runnerRequestBusy = true;
    updateRunnerControls();
    message(
      $("job-message"),
      type === "developer" && !body.ticket
        ? "Looking for the next ready, approved ticket in this project’s Linear queue…"
        : "Queuing your job…",
    );
    try {
      const result = await (type === "pm" ||
      (type === "developer" && !body.ticket)
        ? api("/api/jobs", body, "POST", 90000)
        : api("/api/jobs", body));
      const promotion =
        currentStatus?.projects?.find((item) => item.name === project)?.workflow
          ?.kind === "promotion";
      message(
        $("job-message"),
        result.reused
          ? `${result.job?.ticket || "This ticket"} ${result.job?.status === "succeeded" ? (promotion ? "already has completed coding work. Opening its activity; follow checks, PM QA and the promotion batch in Changes." : "already has completed work. Opening its existing run so you can review the changes and any draft pull request.") : "is already queued or running. Opening its progress."} No duplicate run was started.`
          : `${type === "developer" && result.job?.ticket ? `${result.job.ticket} queued for coding.` : "Job queued."} Opening Activity so you can follow its progress. Automation is unchanged.`,
      );
      if (type === "developer") {
        $("job-ticket").value = "";
        $("job-ticket-field").open = false;
      }
      if (result.job?.id) {
        jobHistory = [
          ...jobHistory.filter((job) => job.id !== result.job.id),
          result.job,
        ];
        selectJob(result.job.id);
      }
      // Acceptance is durable even if the follow-up status request fails.
      await refreshRunners().catch(() => {});
    } catch (error) {
      message($("job-message"), error.message, true);
      if (
        type === "developer" &&
        /No approved tickets are ready/i.test(error.message)
      ) {
        const actions = element("div", "button-row coding-queue-actions");
        const review = element("a", "small-button", "Review PM proposals");
        review.href = `/projects/${encodeURIComponent(project)}?tab=review`;
        const patrol = element("a", "small-button", "Open PM crew");
        patrol.href = `/projects/${encodeURIComponent(project)}`;
        actions.append(review, patrol);
        $("job-message").append(actions);
      }
    } finally {
      runnerRequestBusy = false;
      updateRunnerControls();
      scheduleRunnerPoll();
    }
  }
  $("job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await queueManualJob({
      type: $("job-type").value,
      project: $("job-project").value,
      area: $("job-area").value,
      ticket: $("job-ticket").value,
    });
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
  async function fetchArtifact(jobId, file, signal) {
    const url = artifactUrl(jobId, file.url);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
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
      signal?.removeEventListener("abort", abort);
    }
  }
  async function renderArtifacts(jobId, files, context) {
    const cards = [];
    const previews = new Set();
    let committed = false;
    try {
      for (const file of files) {
        if (!context.isCurrent()) return;
        artifactUrl(jobId, file.url);
        const card = element("article", "artifact-card");
        card.append(element("h4", "", file.name));
        if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
          const blob = await fetchArtifact(jobId, file, context.signal);
          if (!context.isCurrent()) return;
          if (["image/png", "image/jpeg", "image/webp"].includes(blob.type)) {
            const url = URL.createObjectURL(blob);
            previews.add(url);
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
          if (selectedJobId !== jobId || !sessionToken) return;
          download.disabled = true;
          try {
            const blob = await fetchArtifact(jobId, file);
            if (selectedJobId !== jobId) return;
            const url = URL.createObjectURL(blob);
            artifactBlobs.add(url);
            const link = element("a", "");
            link.href = url;
            link.download = file.name;
            link.click();
          } catch (error) {
            if (selectedJobId === jobId)
              message($("job-artifact-message"), error.message, true);
          } finally {
            download.disabled = false;
          }
        });
        card.append(download);
        cards.push(card);
      }
      if (!context.isCurrent()) return;
      clearArtifactBlobs();
      for (const url of previews) artifactBlobs.add(url);
      $("job-artifacts").replaceChildren(...cards);
      $("run-artifact-empty").hidden = cards.length > 0;
      committed = true;
    } finally {
      if (!committed) for (const url of previews) URL.revokeObjectURL(url);
    }
  }
  function renderActivity(activity) {
    const events = Array.isArray(activity.events) ? activity.events : [];
    const latest = events[events.length - 1];
    $("activity-live-status").textContent = latest
      ? `${events.length} visible ${events.length === 1 ? "event" : "events"} · Latest: ${latest.title}${latest.timestamp ? ` · ${timestamp(latest.timestamp)}` : ""}`
      : "No visible actions yet. Check Output for worker progress.";
    const summary =
      typeof activity.summary === "string" ? activity.summary : "";
    if ($("activity-summary").textContent !== summary)
      $("activity-summary").textContent = summary;
    $("activity-summary").hidden = !$("activity-summary").textContent;
    $("run-summary-empty").hidden = Boolean(summary);
    const checks = Array.isArray(activity.checks) ? activity.checks : [];
    const checkSignature = JSON.stringify(checks);
    if ($("activity-checks").dataset.signature !== checkSignature) {
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
      $("activity-checks").dataset.signature = checkSignature;
    }
    $("activity-checks").hidden = !checks.length;
    const timeline = $("activity-timeline");
    const existing = new Map(
      [...timeline.children].map((row) => [row.dataset.eventKey, row]),
    );
    const rows = [];
    for (const [index, event] of (activity.events || []).entries()) {
      const key = `${event.id || index}`;
      const signature = JSON.stringify(event);
      const previous = existing.get(key);
      if (previous?.dataset.signature === signature) {
        rows.push(previous);
        continue;
      }
      const row = element("li", `activity-event event-${event.type}`);
      row.dataset.eventKey = key;
      row.dataset.signature = signature;
      const kind = element(
        "span",
        "activity-event-kind",
        event.type === "tool" ? "Tool call" : event.type,
      );
      const heading = element("div", "activity-event-heading");
      heading.append(kind, element("time", "", timestamp(event.timestamp)));
      row.append(heading, element("h4", "", event.title));
      if (event.detail) {
        if (event.detail.length > 240 || event.detail.includes("\n")) {
          const detail = element("details", "activity-event-detail");
          detail.open = Boolean(previous?.querySelector("details")?.open);
          detail.append(
            element("summary", "", "Details"),
            element("pre", "", event.detail),
          );
          row.append(detail);
        } else row.append(element("p", "", event.detail));
      }
      if (event.status)
        row.append(
          element("span", `runtime-badge state-${event.status}`, event.status),
        );
      rows.push(row);
    }
    const retained = new Set(rows);
    for (const row of [...timeline.children])
      if (!retained.has(row)) row.remove();
    rows.forEach((row, index) => {
      if (timeline.children[index] !== row)
        timeline.insertBefore(row, timeline.children[index] || null);
    });
  }
  function jobOutputVisible() {
    return Boolean(
      selectedJobId &&
      sessionToken &&
      !restarting &&
      !jobOutputSuspended &&
      !document.hidden &&
      runViewer.isOpen,
    );
  }
  function setOutputMessage(id, text, error = false) {
    const target = $(id);
    if (target.textContent !== text || target.hidden !== !text)
      message(target, text, error);
  }
  function renderOutputMessages() {
    const activityError = outputErrors.get("activity");
    if (outputCompleted.has("activity"))
      setOutputMessage(
        "activity-message",
        activityError
          ? `Visible activity could not refresh. ${activityError} Any loaded events are kept; use Refresh to try again.`
          : outputNotices.get("activity") || "",
        Boolean(activityError),
      );
    for (const resource of ["logs", "artifacts"]) {
      const error = outputErrors.get(resource);
      setOutputMessage(
        resource === "logs" ? "job-output-message" : "job-artifact-message",
        error || outputNotices.get(resource) || "",
        Boolean(error),
      );
    }
    $("run-artifact-empty").hidden = Boolean(
      $("job-artifacts").children.length ||
      outputErrors.get("artifacts") ||
      outputNotices.get("artifacts"),
    );
    renderPatrolOutput();
  }
  function renderPatrolOutput() {
    const root = $("run-patrol-evidence"),
      job = mergedJobs().find((item) => item.id === selectedJobId);
    root.hidden = job?.type !== "pm";
    if (root.hidden) return;
    const state = {
      ...patrolOutput,
      job,
      activityState: outputErrors.has("activity")
        ? "error"
        : patrolOutput.activityState,
      artifactState: outputErrors.has("artifacts")
        ? "error"
        : patrolOutput.artifactState,
    };
    const signature = JSON.stringify(state);
    if (root.dataset.signature === signature) return;
    // Do not replace a focused evidence button during background polling.
    const focused = root.contains(document.activeElement)
      ? [...root.querySelectorAll("button")].indexOf(document.activeElement)
      : -1;
    root.replaceChildren(
      window.renderPatrolEvidence({
        ...state,
        onTab: (tab) => runViewer.selectTab(tab, { focus: true }),
      }),
    );
    root.dataset.signature = signature;
    if (focused >= 0)
      root.querySelectorAll("button")[focused]?.focus({ preventScroll: true });
  }
  const runViewer = window.createRunViewer($("job-detail"), {
    onClose: () => closeJobDetail(),
  });
  const grumblinReport = window.createGrumblinReport?.({
    root: $("grumblin-report"),
    fetchArtifact,
    renderMarkdown: window.renderKnowledgeDocument,
  });
  const jobOutput = window.createJobOutput({
    load: (resource, id, signal) =>
      api(
        `/api/jobs/${encodeURIComponent(id)}/${resource}`,
        undefined,
        "GET",
        20000,
        signal,
      ),
    render: async (resource, value, context) => {
      const notice =
        (value.partial || value.pending) && typeof value.message === "string"
          ? value.message
          : "";
      if (notice) outputNotices.set(resource, notice);
      else outputNotices.delete(resource);
      if (resource === "activity") {
        patrolOutput.activityState =
          value.partial || value.pending ? "partial" : "ready";
        if (
          !value.partial ||
          value.events?.length ||
          !patrolOutput.activity.events?.length
        )
          patrolOutput.activity = value;
      } else if (resource === "artifacts") {
        patrolOutput.artifactState =
          value.partial || value.pending ? "partial" : "ready";
        if (
          !value.partial ||
          value.files?.length ||
          !patrolOutput.artifacts.length
        )
          patrolOutput.artifacts = value.files || [];
        await grumblinReport?.render(context.id, value.files || [], context);
      }
      renderPatrolOutput();
      if (resource === "logs") {
        $("worker-output-count").textContent = value.lines?.length
          ? ` · ${value.lines.length} ${value.lines.length === 1 ? "line" : "lines"}`
          : "";
        const log = $("job-log");
        if (
          value.partial &&
          !value.lines?.length &&
          log.textContent !== "Loading job output…"
        )
          return;
        const text = value.lines?.length
          ? value.lines.join("\n")
          : "No output yet. Logs will appear when the worker starts.";
        if (log.textContent !== text) {
          const atEnd =
            log.scrollHeight - log.scrollTop - log.clientHeight < 40;
          log.textContent = text;
          if (atEnd) log.scrollTop = log.scrollHeight;
        }
      } else if (resource === "activity") {
        renderActivity(patrolOutput.activity);
      } else if (!(
        value.partial &&
        !value.files?.length &&
        $("job-artifacts").children.length
      ))
        await renderArtifacts(context.id, value.files || [], context);
    },
    onError: (resource, error) => {
      outputCompleted.add(resource);
      if (error) outputErrors.set(resource, error.message);
      else outputErrors.delete(resource);
      if (
        error &&
        resource === "logs" &&
        $("job-log").textContent === "Loading job output…"
      )
        $("job-log").textContent =
          "Job output is not available yet. Use Refresh to try again.";
      renderOutputMessages();
    },
    onBusy: (busy) => {
      $("refresh-job-output").disabled = !sessionToken || !selectedJobId;
      $("job-detail").setAttribute("aria-busy", String(busy));
    },
  });
  function pauseJobOutput() {
    clearTimeout(jobOutputTimer);
    jobOutputTimer = null;
    jobOutput.pause();
  }
  function scheduleJobOutput() {
    clearTimeout(jobOutputTimer);
    if (!jobOutputVisible()) return;
    const job = mergedJobs().find((item) => item.id === selectedJobId);
    jobOutputTimer = setTimeout(
      () => {
        if (!jobOutputVisible()) return;
        jobOutput.refresh();
        scheduleJobOutput();
      },
      ["queued", "running"].includes(job?.status) ? 2000 : 10000,
    );
  }
  function refreshJobOutput() {
    if (!jobOutputVisible()) return;
    const pending = jobOutput.resume();
    scheduleJobOutput();
    return pending;
  }
  function selectJob(id) {
    if (!id) return;
    if (!runViewer.isOpen) jobDetailTrigger = document.activeElement;
    const changed = id !== selectedJobId;
    selectedJobId = id;
    grumblinReport?.select(
      id,
      mergedJobs().find((job) => job.id === id),
    );
    jobOutput.select(id);
    if (changed) {
      $("job-action-confirm").hidden = true;
      message($("job-action-message"), "");
      outputErrors.clear();
      outputNotices.clear();
      outputCompleted.clear();
      patrolOutput = {
        activity: {},
        artifacts: [],
        activityState: "loading",
        artifactState: "loading",
      };
      delete $("run-patrol-evidence").dataset.signature;
      clearArtifactBlobs();
      $("job-artifacts").replaceChildren();
      $("activity-timeline").replaceChildren();
      $("activity-summary").hidden = true;
      $("activity-summary").textContent = "";
      $("run-summary-empty").hidden = false;
      $("activity-checks").hidden = true;
      delete $("activity-checks").dataset.signature;
      setOutputMessage("activity-message", "Loading visible activity…");
      $("activity-live-status").textContent =
        "Loading this run’s visible actions…";
      $("worker-output-count").textContent = "";
      setOutputMessage("job-output-message", "");
      setOutputMessage("job-artifact-message", "");
      $("run-artifact-empty").hidden = false;
      $("job-log").textContent = "Loading job output…";
    }
    if (pages.run !== id)
      pages.navigate(`/activity?run=${encodeURIComponent(id)}`, {
        focus: false,
        scroll: false,
      });
    runViewer.open({ reset: changed });
    renderRunIdentity();
    renderJobs(runnerStatus?.jobs || []);
    refreshJobOutput();
  }
  function renderRunIdentity() {
    if (!selectedJobId) return;
    renderPatrolOutput();
    const job = mergedJobs().find((item) => item.id === selectedJobId);
    grumblinReport?.select(selectedJobId, job);
    const project = currentStatus?.projects?.find(
      (item) =>
        item.name === job?.project &&
        (item.instanceId ?? null) === (job?.projectInstanceId ?? null),
    );
    const area = project?.areas?.find((item) => item.key === job?.area);
    const role = job?.grumblin
      ? `AI customer simulation · ${job.grumblin.name}`
      : job?.type === "verify"
        ? "Worker check"
        : job?.type === "developer"
          ? "Coding"
          : job?.pmMode === "discovery"
            ? "Discovery"
            : job?.pmMode === "exploration"
              ? "Product exploration"
              : "PM patrol";
    $("job-detail-title").textContent =
      `${role}${job?.runId ? ` · Run ${job.runId}` : ""}`;
    $("job-detail-context").textContent = [
      job?.project || "Worker verification",
      area?.name || job?.area,
      job?.ticket,
      currentStatus?.projects && job?.project && !project
        ? "Earlier or removed project"
        : "",
    ]
      .filter(Boolean)
      .join(" / ");
    const status = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ].includes(job?.status)
      ? job.status
      : "loading";
    $("job-detail-status").className = `runtime-badge state-${status}`;
    $("job-detail-status").textContent =
      status === "succeeded" ? "Finished" : status;
    $("run-summary-state").textContent =
      job?.message ||
      {
        queued: "Queued. Waiting for an eligible worker.",
        running:
          "This run is in progress. Follow its visible actions in Activity or its logs in Output.",
        succeeded:
          "The worker finished. Review its summary and evidence for what was verified.",
        failed:
          "The run stopped with a failure. Review its summary and output before retrying.",
        canceled:
          "This run was canceled. Previously completed external actions are not undone.",
        loading: "Loading this run’s saved details…",
      }[status];
    $("run-summary-empty").textContent = [
      "queued",
      "running",
      "loading",
    ].includes(status)
      ? "The worker’s summary will appear here when it is available. You can follow progress in Activity or Output."
      : "No summary was recorded. Activity and Output may contain more detail.";
    $("run-artifact-empty").textContent = [
      "queued",
      "running",
      "loading",
    ].includes(status)
      ? "Evidence will appear here when the run finishes."
      : "No screenshots or files were saved for this run.";
    const metadata = [
      ["Created", job?.createdAt],
      ["Started", job?.startedAt],
      ["Finished", job?.finishedAt],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => [label, timestamp(value)]);
    const signature = JSON.stringify(metadata);
    if ($("run-metadata").dataset.signature !== signature) {
      $("run-metadata").replaceChildren(
        ...metadata.flatMap(([label, value]) => [
          element("dt", "", label),
          element("dd", "", value),
        ]),
      );
      $("run-metadata").dataset.signature = signature;
    }
  }
  function renderJobControls() {
    const root = $("job-run-controls");
    if (!root) return;
    const job = mergedJobs().find((item) => item.id === selectedJobId);
    const signature = JSON.stringify([
      job?.id,
      job?.status,
      job?.cancelRequestedAt,
      job?.nextAttemptAt,
      jobActionBusy,
      formsLocked,
    ]);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature;
    root.replaceChildren();
    if (!job) return;
    if (job.nextAttemptAt)
      root.append(
        element(
          "span",
          "runner-guidance",
          `Infrastructure retry scheduled: ${timestamp(job.nextAttemptAt)}`,
        ),
      );
    if (!["pm", "developer"].includes(job.type)) return;
    const active = ["queued", "running"].includes(job.status);
    if (
      !active &&
      !currentStatus?.projects?.some(
        (project) =>
          project.name === job.project &&
          (project.instanceId ?? null) === (job.projectInstanceId ?? null),
      )
    ) {
      root.append(
        element(
          "p",
          "runner-guidance",
          "This run belongs to a removed or earlier project. Its history is preserved; start new work from the current project.",
        ),
      );
      return;
    }
    if (!active && !["failed", "canceled"].includes(job.status)) return;
    if (!active && (job.grumblin || job.pmMode === "grumblin")) {
      const review = element(
        "a",
        "small-button",
        "Review Grumblin & simulate again",
      );
      review.href = `/projects/${encodeURIComponent(job.project)}?tab=grumblins`;
      root.append(review);
      return;
    }
    const action = element(
      "button",
      "small-button",
      active
        ? job.cancelRequestedAt
          ? "Cancel requested"
          : "Cancel run"
        : "Retry with current settings",
    );
    action.type = "button";
    action.disabled =
      formsLocked || jobActionBusy || Boolean(job.cancelRequestedAt && active);
    action.addEventListener("click", () => {
      const prompt = $("job-action-confirm");
      prompt.replaceChildren();
      prompt.hidden = false;
      prompt.append(
        element(
          "p",
          "",
          active
            ? "Cancel this run? A running worker stays visible until it confirms that execution has stopped. Completed external actions are not undone."
            : "Start a new attempt with the project’s current settings? Readiness and ticket approval will be checked again. The earlier run and its evidence stay in Activity.",
        ),
      );
      const buttons = element("div", "button-row"),
        confirm = element(
          "button",
          "button button-dark",
          active ? "Cancel this run" : "Start new attempt",
        ),
        keep = element("button", "small-button", "Keep viewing");
      confirm.type = keep.type = "button";
      keep.addEventListener("click", () => {
        prompt.hidden = true;
        action.focus();
      });
      confirm.addEventListener("click", async () => {
        if (jobActionBusy || formsLocked) return;
        jobActionBusy = true;
        confirm.disabled = keep.disabled = true;
        renderJobControls();
        message(
          $("job-action-message"),
          active
            ? "Requesting cancellation…"
            : "Checking and queuing a new attempt…",
        );
        try {
          const body = { type: job.type, project: job.project };
          if (job.type === "pm") {
            body.area = job.area;
            if (job.pmMode) body.pmMode = job.pmMode;
          } else body.ticket = job.ticket;
          const result = await api(
            active
              ? `/api/jobs/${encodeURIComponent(job.id)}/cancel`
              : "/api/jobs",
            active ? {} : body,
          );
          if (result.job?.id) {
            jobHistory = [
              ...jobHistory.filter((item) => item.id !== result.job.id),
              result.job,
            ];
            if (runnerStatus?.jobs)
              runnerStatus.jobs = runnerStatus.jobs.map((item) =>
                item.id === result.job.id ? result.job : item,
              );
            if (!active && selectedJobId === job.id) selectJob(result.job.id);
          }
          if (
            selectedJobId === job.id ||
            (!active && selectedJobId === result.job?.id)
          ) {
            prompt.hidden = true;
            message(
              $("job-action-message"),
              active
                ? result.job?.status === "canceled"
                  ? "Run canceled."
                  : "Cancellation requested. Waiting for the worker to confirm it stopped."
                : "New attempt queued; previous evidence was preserved.",
            );
          }
          await refreshRunners();
        } catch (error) {
          if (selectedJobId === job.id)
            message($("job-action-message"), error.message, true);
        } finally {
          jobActionBusy = false;
          confirm.disabled = keep.disabled = false;
          renderJobControls();
        }
      });
      buttons.append(confirm, keep);
      prompt.append(buttons);
      confirm.focus();
    });
    root.append(action);
  }
  $("job-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-job-id]");
    if (!button) return;
    jobDetailTrigger = button;
    selectJob(button.dataset.jobId);
  });
  $("refresh-job-output").addEventListener("click", refreshJobOutput);
  $("show-worker-output").addEventListener("click", () => {
    runViewer.selectTab("output", { focus: true });
  });
  function closeJobDetail({ navigate = true, restoreFocus = true } = {}) {
    selectedJobId = "";
    grumblinReport?.clear();
    clearTimeout(jobOutputTimer);
    jobOutput.close();
    outputErrors.clear();
    outputNotices.clear();
    outputCompleted.clear();
    clearArtifactBlobs();
    runViewer.close({ restoreFocus: false });
    $("job-action-confirm").hidden = true;
    $("job-artifacts").replaceChildren();
    if (navigate) pages.closeRun();
    renderJobs(runnerStatus?.jobs || []);
    const trigger = jobDetailTrigger?.dataset?.jobId;
    const button = [...$("job-list").querySelectorAll("[data-job-id]")].find(
      (item) => item.dataset.jobId === trigger,
    );
    if (restoreFocus) {
      const target = jobDetailTrigger?.isConnected
        ? jobDetailTrigger
        : button ||
          document.querySelector(
            `[data-page="${pages.current}"] h1, [data-page="${pages.current}"] h2`,
          );
      if (target) {
        if (target.matches("h1, h2")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    }
    jobDetailTrigger = null;
  }
  window.addEventListener("dashboard:pagechange", () => {
    if (runViewer.isOpen && !pages.run) {
      closeJobDetail({ navigate: false, restoreFocus: true });
      return;
    }
    if (pages.run && pages.run !== selectedJobId) selectJob(pages.run);
    if (jobOutputVisible()) refreshJobOutput();
    else pauseJobOutput();
  });
  document.addEventListener("visibilitychange", () => {
    if (jobOutputVisible()) refreshJobOutput();
    else pauseJobOutput();
  });
  $("close-job-output").addEventListener("click", () => closeJobDetail());

  function linearConnected(
    id = $("project-linear-connection").value || "default",
  ) {
    const selected =
      serviceSelection.linear === id ? serviceStatuses.get("linear") : null;
    const status =
      selected ||
      serviceProfiles.find(
        (item) => item.provider === "linear" && item.id === id,
      ) ||
      (id === "default"
        ? currentStatus?.serviceConnections?.find(
            (item) => item.provider === "linear",
          )
        : null);
    return Boolean(status?.connected && !status.needsReconnect);
  }
  function linearResultMessage(result) {
    if (!result) return "";
    if (result.message) return result.message;
    if (result.status === "ready")
      return `Linear is ready${result.teamName ? ` in ${result.teamName}` : ""}.`;
    if (result.status === "skipped")
      return "Linear setup can be completed later.";
    if (result.status === "needs-connection")
      return "Connect Linear, then use Set up Linear beside the app.";
    return "Your local configuration was saved. Use Retry Linear setup beside the app to finish the missing mappings.";
  }
  function projectLinearDetails(project) {
    return window.renderProjectCrew(project, {
      jobs: mergedJobs(),
      locked: formsLocked,
      areaActions,
    });
  }
  function renderPmProjects() {
    const select = $("pm-project");
    const previous = select.value;
    select.replaceChildren();
    for (const project of currentStatus?.projects || [])
      select.append(new Option(project.name, project.name));
    if (!select.options.length)
      select.append(new Option("Add an app first", ""));
    else if ([...select.options].some((option) => option.value === previous))
      select.value = previous;
    if (pmCreationProject && pmCreationProject !== select.value)
      changePmCreationProject(select.value);
    renderLinearSetup();
  }
  function renderLinearSetup() {
    const connected = linearConnected();
    $("project-linear-connection").disabled =
      formsLocked || linearResourcesLoading;
    const mode = $("project-linear-mode");
    if (!linearModeEdited) mode.value = "later";
    for (const option of mode.options)
      option.disabled = option.value !== "later" && !connected;
    $("project-linear-team-field").hidden = mode.value !== "reuse";
    $("project-linear-team").required = mode.value === "reuse";
    $("project-linear-team").disabled =
      mode.value !== "reuse" || formsLocked || linearResourcesLoading;
    $("refresh-linear-resources").disabled =
      !connected || formsLocked || linearResourcesLoading;
    $("project-linear-help").textContent = connected
      ? "Optional now. Configure the environment first, then choose or create a team when your PM needs to file tickets."
      : "Connect Linear above to create a team. You can save the app now and finish the mapping later.";
    const teamSelect = $("project-linear-team");
    const previousTeam = teamSelect.value;
    teamSelect.replaceChildren(
      new Option(
        linearResourcesLoading ? "Loading teams…" : "Choose a Linear team",
        "",
      ),
    );
    for (const team of linearResources.teams)
      teamSelect.append(new Option(`${team.name} (${team.key})`, team.id));
    if ([...teamSelect.options].some((option) => option.value === previousTeam))
      teamSelect.value = previousTeam;
    $("pm-create-fields").disabled =
      formsLocked || pmCreating || !(currentStatus?.projects || []).length;
    $("create-pm").disabled = pmPlanning;
    $("close-pm-create").disabled = pmCreating;
    if (pendingPmCreate && !formsLocked && currentStatus?.projects?.length) {
      pendingPmCreate = false;
      openPmCreation(pages.project || "");
    }
    pmDraft?.setLocked(
      formsLocked || pmCreating || !(currentStatus?.projects || []).length,
    );
    const project = (currentStatus?.projects || []).find(
      (item) => item.name === $("pm-project").value,
    );
    const projectSelect = $("pm-linear-project");
    const context = JSON.stringify([
      project?.name,
      project?.linear?.connectionId || "default",
      project?.linear?.teamId,
    ]);
    const previousProject =
      pmLinearContext === context ? projectSelect.value : "";
    pmLinearContext = context;
    projectSelect.replaceChildren(
      new Option("Create a new Linear project for this PM", ""),
    );
    for (const item of (
      linearResourceCache.get(project?.linear?.connectionId || "default")
        ?.projects || []
    ).filter((item) => item.teamIds?.includes(project?.linear?.teamId)))
      projectSelect.append(new Option(`Use existing: ${item.name}`, item.id));
    if (
      [...projectSelect.options].some(
        (option) => option.value === previousProject,
      )
    )
      projectSelect.value = previousProject;
    projectSelect.disabled =
      !project?.linear?.teamId ||
      !linearConnected(project?.linear?.connectionId || "default") ||
      linearResourcesLoading;
    $("pm-linear-help").textContent =
      linearConnected(project?.linear?.connectionId || "default") &&
      project?.linear?.teamId
        ? "Creates a Linear project in this app’s team, or uses the project you select."
        : "The PM is saved locally first. Its first run sets up missing Linear mappings when a connection is available.";
    pmAdoption?.setBusy(pmCreating || pmPlanning);
  }
  async function refreshLinearResources() {
    if (!sessionToken) return;
    if (linearResourcesLoading) {
      linearResourcesQueued = true;
      return;
    }
    linearResourcesLoading = true;
    const selected = $("project-linear-connection").value || "default";
    const project = currentStatus?.projects?.find(
      (item) => item.name === $("pm-project").value,
    );
    const ids = [
      ...new Set([selected, project?.linear?.connectionId || "default"]),
    ];
    renderLinearSetup();
    message($("linear-resources-message"), "Loading teams and projects…");
    try {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const result = await api(serviceUrl("linear", "resources", id));
          const resources = {
            teams: Array.isArray(result.teams) ? result.teams : [],
            projects: Array.isArray(result.projects) ? result.projects : [],
          };
          linearResourceCache.set(id, resources);
          return resources;
        }),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected")
          linearResourceCache.delete(ids[index]);
      });
      linearResources = linearResourceCache.get(selected) || {
        teams: [],
        projects: [],
      };
      const error = results[ids.indexOf(selected)];
      if (error?.status === "rejected")
        message($("linear-resources-message"), error.reason.message, true);
      else
        message(
          $("linear-resources-message"),
          linearResources.teams.length + " teams available in this connection.",
        );
    } finally {
      linearResourcesLoading = false;
      renderLinearSetup();
      if (linearResourcesQueued) {
        linearResourcesQueued = false;
        await refreshLinearResources();
      }
    }
  }
  $("project-linear-connection").addEventListener("change", () => {
    $("project-linear-team").value = "";
    linearResources = { teams: [], projects: [] };
    refreshLinearResources();
  });
  $("project-linear-mode").addEventListener("change", () => {
    linearModeEdited = true;
    renderLinearSetup();
  });
  $("refresh-linear-resources").addEventListener(
    "click",
    refreshLinearResources,
  );
  const pmEditedFields = new Set();
  let pmValidationField = null;
  const pmCreationDrafts = new Map();
  let pmCreationProject = "";
  let pmGeneratedValues = null;
  function changePmCreationProject(project) {
    if (pmCreationProject === project) return;
    if (pmCreationProject && !pmAdoption?.accepted)
      pmCreationDrafts.set(pmCreationProject, {
        ...readPmDraft(),
        keyEdited: pmKeyEdited,
        mixpanelReport: $("pm-mixpanel-report").value,
        linearProject: $("pm-linear-project").value,
        generated: pmGeneratedValues,
      });
    const saved = pmCreationDrafts.get(project);
    for (const [id, key] of Object.entries(pmInputKeys))
      $(id).value =
        saved?.[key] ??
        ({ schedule: "0 13 * * *", metric: "/", wipLimit: "3" }[key] || "");
    $("pm-mandate").value = saved?.mandate || "";
    $("pm-mixpanel-report").value = saved?.mixpanelReport || "";
    $("pm-linear-project").value = saved?.linearProject || "";
    pmCharter.fill(saved?.charter || {});
    pmEditedFields.clear();
    for (const key of saved?.editedFields || []) pmEditedFields.add(key);
    pmKeyEdited = saved?.keyEdited || false;
    pmGeneratedValues = saved?.generated || null;
    pmCreationProject = project;
    $("pm-project").value = project;
    pmDraft?.reset();
    pmAdoption?.contextChanged();
    message($("pm-create-message"), "");
  }
  function openPmCreation(
    project = "",
    trigger = document.activeElement,
    suggestion,
  ) {
    if (formsLocked || pmCreating) return;
    if (!currentStatus?.projects?.length) {
      pages.navigate("/projects#new-project-drawer");
      return;
    }
    changePmCreationProject(project || $("pm-project").value);
    if (suggestion?.name && suggestion?.mandate) {
      pmAdoption?.contextChanged();
      pmDraft?.reset();
      pmGeneratedValues = null;
      $("pm-name").value = suggestion.name;
      $("pm-mandate").value = suggestion.mandate;
      pmKeyEdited = false;
      $("pm-name").dispatchEvent(new Event("input", { bubbles: true }));
      pmEditedFields.add("name");
    }
    pmCreateTrigger = trigger;
    pendingPmCreate = false;
    if (!pmCreateDialog.open) pmCreateDialog.showModal();
    renderLinearSetup();
    updatePmCreationReview();
    if (pmAdoption) pmAdoption.open({ preselected: Boolean(project) });
    else $("pm-mandate").focus();
    refreshLinearResources();
  }
  window.openGremlinAdoption = openPmCreation;
  function closePmCreation() {
    if (pmCreating) return;
    pmCreateDialog.close();
    const visible = (element) =>
      element?.isConnected &&
      element.getClientRects().length &&
      !element.disabled;
    const fallback =
      [...document.querySelectorAll("[data-create-pm-project]")].find(
        (element) =>
          element.dataset.createPmProject === $("pm-project").value &&
          visible(element),
      ) || [...document.querySelectorAll("main h1, main h2")].find(visible);
    const target = visible(pmCreateTrigger) ? pmCreateTrigger : fallback;
    if (target) {
      if (target.matches("h1, h2")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  $("close-pm-create").addEventListener("click", closePmCreation);
  pmCreateDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePmCreation();
  });
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest('a[href$="#pm-create-drawer"]');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      openPmCreation(pages.project || "", link);
    },
    true,
  );
  const pmInputKeys = {
    "pm-name": "name",
    "pm-key": "key",
    "pm-paths": "paths",
    "pm-shared-paths": "sharedTouchpoints",
    "pm-metric": "metric",
    "pm-schedule": "schedule",
    "pm-wip": "wipLimit",
  };
  $("pm-create-form").addEventListener(
    "input",
    (event) => {
      if (pmValidationField === event.target) {
        pmValidationField = null;
        message($("pm-create-message"), "");
      }
      const key = pmInputKeys[event.target.id];
      if (key) pmEditedFields.add(key);
      updatePmCreationReview();
    },
    true,
  );
  function updatePmCreationReview() {
    const missing = [];
    for (const [id, label] of [
      ["pm-project", "app"],
      ["pm-mandate", "mandate"],
      ["pm-name", "name"],
      ["pm-key", "mandate ID"],
    ])
      if (!$(id).value.trim()) missing.push(label);
    $("pm-area-label").textContent = $("pm-key").value
      ? `Area label: pm:${$("pm-key").value}`
      : "The area label is generated from this ID.";
    $("pm-creation-readiness").textContent = missing.length
      ? `Still needed: ${missing.join(", ")}. AI can help turn your goal into a working brief.`
      : "Their brief is ready to review. Daily patrols and approved coding pickup start when project setup is ready.";
    pmAdoption?.refresh();
  }
  const readPmDraft = () => ({
    editedFields: [...pmEditedFields].sort(),
    charter: pmCharter.read(),
    project: $("pm-project").value,
    mandate: $("pm-mandate").value,
    name: $("pm-name").value,
    key: $("pm-key").value,
    paths: $("pm-paths").value,
    sharedTouchpoints: $("pm-shared-paths").value,
    metric: $("pm-metric").value,
    schedule: $("pm-schedule").value,
    wipLimit: $("pm-wip").value,
  });
  pmDraft = window.createPmDraft($("pm-ai-draft"), {
    api,
    getInput: readPmDraft,
    onBusy: (busy) => {
      pmPlanning = busy;
      renderLinearSetup();
    },
    onError: () => message($("pm-create-message"), ""),
    onApply: (draft, snapshot) => {
      if (JSON.stringify(snapshot) !== JSON.stringify(readPmDraft()))
        return false;
      const { values, kept } = window.mergePmDraft(
        snapshot,
        draft,
        pmGeneratedValues,
      );
      for (const [key, id] of Object.entries({
        name: "pm-name",
        key: "pm-key",
        paths: "pm-paths",
        sharedTouchpoints: "pm-shared-paths",
        metric: "pm-metric",
        schedule: "pm-schedule",
        wipLimit: "pm-wip",
      }))
        $(id).value = Array.isArray(values[key])
          ? values[key].join("\n")
          : String(values[key]);
      pmCharter.fill(values.charter);
      pmGeneratedValues = readPmDraft();
      for (const key of kept) {
        if (key.startsWith("charter."))
          delete pmGeneratedValues.charter[key.slice(8)];
        else delete pmGeneratedValues[key];
      }
      pmKeyEdited = true;
      message($("pm-create-message"), "");
      updatePmCreationReview();
      if (pmAdoption) pmAdoption.review();
      else $("pm-name").focus();
      return {
        message: `Brief drafted.${kept.length ? " Your edits were kept." : ""} Review your gremlin before adoption.`,
      };
    },
  });
  pmAdoption = window.createGremlinAdoption?.({
    dialog: pmCreateDialog,
    getInput: readPmDraft,
    getProject: (name) =>
      currentStatus?.projects?.find((project) => project.name === name),
    getJobs: mergedJobs,
    isLocked: () =>
      formsLocked ||
      !sessionToken ||
      restarting ||
      !currentStatus?.projects?.length,
    onDraft: () => {
      message($("pm-create-message"), "");
      return pmDraft.generate();
    },
    onRefreshReadiness: async () => {
      await refreshStatus();
    },
    onSetupHosting: (project) => {
      closePmCreation();
      pages.navigate(
        `/projects/${encodeURIComponent(project)}?tab=environment`,
      );
    },
    onSetupLinear: (project, trigger) => {
      closePmCreation();
      return linearOnboarding.open(project, trigger);
    },
    onOpenHome: (adopted) => {
      closePmCreation();
      pages.navigate(
        `/projects/${encodeURIComponent(adopted.project)}?pm=${encodeURIComponent(adopted.key)}`,
      );
    },
    onOpenSignals: async (adopted, provider, trigger) => {
      const project = currentStatus?.projects?.find(
        (item) => item.name === adopted.project,
      );
      if (!window.isCurrentGremlinAdoption(adopted, project))
        throw new Error("Refresh the project before choosing its signals.");
      adoptionSignalReturn = {
        project: adopted.project,
        key: adopted.key,
        instanceId: project.instanceId ?? null,
        areaInstanceId:
          project.areas.find((area) => area.key === adopted.key)?.instanceId ??
          null,
      };
      closePmCreation();
      await openProjectSettings(adopted.project, trigger, {
        section: "signals",
        provider,
      });
    },
    onFirstTask: async (adopted, trigger) => {
      const project = currentStatus?.projects?.find(
        (item) => item.name === adopted.project,
      );
      if (!window.isCurrentGremlinAdoption(adopted, project)) {
        await refreshStatus();
        return;
      }
      closePmCreation();
      if (project.foundation?.needed) {
        pages.navigate(
          `/projects/${encodeURIComponent(adopted.project)}?tab=environment`,
        );
        return;
      }
      const active = mergedJobs().find(
        (job) =>
          job.type === "pm" &&
          job.project === adopted.project &&
          job.area === adopted.key &&
          (job.projectInstanceId ?? null) === (project.instanceId ?? null) &&
          ["queued", "running"].includes(job.status),
      );
      if (active) {
        selectJob(active.id);
        return;
      }
      pages.navigate(
        `/projects/${encodeURIComponent(adopted.project)}?pm=${encodeURIComponent(adopted.key)}&tab=discovery`,
      );
      const readiness = project.readiness?.areas?.find(
        (area) => area.key === adopted.key,
      )?.discovery;
      if (readiness?.canRun)
        await projectWorkspace.discover(adopted.project, adopted.key, trigger);
    },
  });
  window.gremlinAdoption = pmAdoption;
  $("pm-project").addEventListener("change", () => {
    changePmCreationProject($("pm-project").value);
    refreshLinearResources();
    updatePmCreationReview();
  });
  $("pm-key").addEventListener("input", () => {
    pmKeyEdited = Boolean($("pm-key").value);
  });
  $("pm-name").addEventListener("input", () => {
    if (!pmKeyEdited)
      $("pm-key").value = $("pm-name")
        .value.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    updatePmCreationReview();
  });
  document.addEventListener("change", (event) => {
    if (event.target.dataset.mappingProject)
      mappingTeamSelections.set(
        event.target.dataset.mappingProject,
        event.target.value,
      );
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-setup-action]");
    if (!button || button.disabled || formsLocked) return;
    const project = currentStatus?.projects?.find(
      (item) => item.name === button.dataset.setupProject,
    );
    if (!project) return;
    try {
      const action = button.dataset.setupAction;
      if (["source", "ai", "linear"].includes(action)) {
        if (action === "linear") {
          rememberService("linear", project.linear?.connectionId || "default");
          await refreshService("linear");
        }
        pages.navigate(
          `/connections#${action === "source" ? "source-control" : action === "ai" ? "model-connections" : "linear-connection"}`,
        );
      } else if (action === "worker") {
        pages.navigate("/runners#workers");
        $("create-runner").focus({ preventScroll: true });
      } else if (action === "verify") {
        pages.navigate("/projects");
        [...$("project-list").querySelectorAll("[data-verify-project]")]
          .find((item) => item.dataset.verifyProject === project.name)
          ?.click();
      } else if (
        ["mapping", "mandate"].includes(action) &&
        !project.areas?.length
      ) {
        openPmCreation(project.name, button);
      } else if (action === "mapping") {
        await prepareProjectLinear(project.name);
      } else if (
        action === "mandate" ||
        button.dataset.setupStep === "schedule" ||
        button.dataset.setupStep === "configuration"
      ) {
        if (
          button.dataset.setupArea &&
          button.dataset.setupStep !== "configuration"
        ) {
          await projectWorkspace.openBrief(
            project.name,
            button.dataset.setupArea,
          );
          return;
        }
        pages.navigate("/settings#config-form");
        await requestEditorAction(
          "switch",
          button.dataset.setupStep === "configuration"
            ? "hub.json"
            : `projects/${project.name}/areas.json`,
        );
      } else {
        await openProjectSettings(project.name, button);
      }
    } catch (error) {
      message($("global-message"), error.message, true);
    }
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-toggle-area]");
    if (!button || button.disabled || formsLocked) return;
    const project = currentStatus?.projects?.find(
      (item) => item.name === button.dataset.areaProject,
    );
    if (!project) return;
    await pmActions.toggle(
      project.name,
      button.dataset.toggleArea,
      button,
      button.dataset.automationKind,
    );
  });
  document.addEventListener("click", async (event) => {
    const create = event.target.closest("[data-create-pm-project]");
    if (create) {
      if (formsLocked || pmCreating) return;
      openPmCreation(create.dataset.createPmProject, create);
      return;
    }
    const button = event.target.closest("[data-setup-linear-project]");
    if (!button || button.disabled || formsLocked) return;
    await prepareProjectLinear(button.dataset.setupLinearProject);
  });
  async function prepareProjectLinear(name) {
    if (formsLocked || mappingBusy.has(name)) return;
    mappingBusy.add(name);
    mappingMessages.set(name, {
      text: "Finishing this app’s Linear team and missing PM projects…",
    });
    renderStatus(currentStatus);
    try {
      const teamId = mappingTeamSelections.get(name);
      const result = await api(
        `/api/projects/${encodeURIComponent(name)}/linear`,
        teamId ? { teamId } : {},
        "POST",
        90000,
      );
      mappingMessages.set(name, {
        text: linearResultMessage(result.linear),
        error: result.linear?.status === "error",
      });
      message(
        $("global-message"),
        linearResultMessage(result.linear),
        result.linear?.status === "error",
      );
      await refreshStatus();
      await refreshConfigFiles();
      await refreshLinearResources();
    } catch (error) {
      mappingMessages.set(name, { text: error.message, error: true });
      message($("global-message"), error.message, true);
    } finally {
      mappingBusy.delete(name);
      renderStatus(currentStatus);
    }
  }
  $("pm-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pmCreating || pmPlanning || formsLocked) return;
    if (pmAdoption && !pmAdoption.prepareSubmit()) return;
    const project = $("pm-project").value;
    const input = {
      key: $("pm-key").value.trim(),
      name: $("pm-name").value.trim(),
      mandate: $("pm-mandate").value.trim(),
      charter: pmCharter.read(),
      schedule: $("pm-schedule").value.trim(),
      wipLimit: Number($("pm-wip").value),
      metric: $("pm-metric").value.trim() || "/",
    };
    if (!input.name || !input.mandate) {
      message(
        $("pm-create-message"),
        "Give your PM a name and a mandate before creating it.",
        true,
      );
      return;
    }
    if (input.schedule.split(/\s+/).length !== 5) {
      pmValidationField = $("pm-schedule");
      pmAdoption?.reveal($("pm-schedule"));
      $("pm-schedule").focus();
      message(
        $("pm-create-message"),
        "Use a five-field UTC cron schedule, such as 0 13 * * *.",
        true,
      );
      return;
    }
    for (const [id, key] of [
      ["pm-paths", "paths"],
      ["pm-shared-paths", "sharedTouchpoints"],
    ]) {
      const paths = $(id)
        .value.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (paths.length) input[key] = paths;
    }
    if ($("pm-mixpanel-report").value.trim())
      input.mixpanelReportId = $("pm-mixpanel-report").value.trim();
    if ($("pm-linear-project").value)
      input.linearProjectId = $("pm-linear-project").value;
    pmCreating = true;
    pmValidationField = null;
    renderLinearSetup();
    $("create-pm").textContent = "Adopting…";
    message(
      $("pm-create-message"),
      "Saving the mandate and setting up its Linear project when available…",
    );
    let accepted = false;
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(project)}/areas`,
        input,
        "POST",
        90000,
      );
      accepted = true;
      pmAdoption?.adopted({
        ...input,
        project,
        projectInstanceId: result.projectInstanceId ?? null,
        areaInstanceId: result.areaInstanceId ?? null,
        setupMessage: ["needs-connection", "skipped"].includes(
          result.linear?.status,
        )
          ? "Linear can be connected when you’re ready to propose work."
          : linearResultMessage(result.linear),
      });
      $("pm-create-form").reset();
      pmCharter.reset();
      pmDraft?.reset();
      pmKeyEdited = false;
      pmEditedFields.clear();
      pmCreationDrafts.delete(project);
      pmGeneratedValues = null;
      updatePmCreationReview();
      $("pm-project").value = project;
      message(
        $("pm-create-message"),
        `${input.name} is adopted with automation off. ${linearResultMessage(result.linear)}`,
        result.linear?.status === "error",
      );
      areaActions.set(`${project}/${input.key}`, {
        message: `${input.name} is ready to set up. ${linearResultMessage(result.linear)}`,
        error: result.linear?.status === "error",
      });
      const refreshed = await Promise.allSettled([
        refreshStatus(),
        refreshConfigFiles(),
        refreshLinearResources(),
      ]);
      if (refreshed.some((result) => result.status === "rejected"))
        pmAdoption?.setWelcomeWarning(
          `${input.name} is adopted. Some setup information could not refresh. Refresh readiness before starting their first task.`,
        );
      if (!pmAdoption) {
        pmCreateDialog.close();
        pages.navigate(
          `/projects/${encodeURIComponent(project)}?pm=${encodeURIComponent(input.key)}`,
        );
      }
    } catch (error) {
      if (accepted)
        pmAdoption?.setWelcomeWarning(
          `${input.name} is adopted. ${error.message} Refresh readiness to continue.`,
        );
      else
        message(
          $("pm-create-message"),
          `${error.message} Your draft is still here.`,
          true,
        );
    } finally {
      pmCreating = false;
      renderLinearSetup();
      pmAdoption?.refresh();
      if (accepted) pmAdoption?.focusWelcome();
    }
  });
  $("pm-create-form").addEventListener(
    "invalid",
    (event) => {
      const first = $("pm-create-form").querySelector(
        ":invalid:not(fieldset):not(form)",
      );
      if (first && first !== event.target) return;
      pmValidationField = event.target;
      pmAdoption?.reveal(event.target);
      for (
        let section = event.target.closest("details");
        section;
        section = section.parentElement?.closest("details")
      )
        section.open = true;
      const label =
        document.querySelector(`label[for="${event.target.id}"]`)
          ?.textContent || "the highlighted field";
      message(
        $("pm-create-message"),
        `Review ${label.trim()}: ${event.target.validationMessage}`,
        true,
      );
    },
    true,
  );

  function renderServiceControls() {
    renderConnectionSummary();
    for (const [provider, config] of Object.entries(serviceProviders)) {
      const status = serviceStatuses.get(provider);
      const busy = serviceBusy.has(provider);
      const locked = formsLocked || !sessionToken || busy || restarting;
      const connected = status?.connected && !status.needsReconnect;
      profileControls.get(provider)?.setLocked(locked);
      $(`${provider}-token-form`).closest("details").hidden =
        serviceSelection[provider] !== "default";
      $(`${provider}-connection`).classList.toggle(
        "is-connected",
        Boolean(connected),
      );

      $(`${provider}-connect`).disabled = locked || !status?.available;
      $(`${provider}-connect`).textContent = busy
        ? "Working…"
        : status?.needsReconnect
          ? `Reconnect ${config.name} ↗`
          : connected && status.method === "oauth"
            ? `Change account ↗`
            : `Connect ${config.name} ↗`;
      $(`${provider}-refresh`).disabled = locked;
      $(`${provider}-token-fields`).disabled = locked;
      $(`${provider}-disconnect`).hidden = status?.method !== "oauth";
      $(`${provider}-disconnect`).disabled = locked;
      $(`${provider}-confirm-disconnect`).disabled = locked;
      $(`${provider}-keep`).disabled = locked;
      if (!status) continue;
      const badge = $(`${provider}-state`);
      badge.textContent = status.needsReconnect
        ? "Reconnect needed"
        : connected
          ? status.method === "token"
            ? "Manual token saved"
            : "Connected"
          : status.available
            ? "Not connected"
            : "Browser setup unavailable";
      badge.classList.toggle("ready", Boolean(connected));
      const workspace =
        typeof status.workspace === "string"
          ? status.workspace
          : status.workspace?.name;
      const account =
        typeof status.account === "string"
          ? status.account
          : status.account?.name;
      $(`${provider}-account`).textContent =
        [...new Set([workspace, account].filter(Boolean))].join(" · ") ||
        (connected
          ? `Using your saved ${config.name} connection.`
          : `No ${config.name} account connected yet.`);
      $(`${provider}-guidance`).textContent =
        status.message ||
        (status.needsReconnect
          ? "Reconnect before requesting new work. Existing project settings are kept."
          : provider === "linear"
            ? "Authorize workspace access to create app teams, PM projects, and work with approved tickets. Creating teams may require workspace admin access."
            : "Authorize the Vercel integration for the projects the crew needs. Preview protection and app-specific deployment settings still need verification.");
    }
    renderLinearSetup();
  }
  async function refreshService(provider, refreshAvailability = false) {
    if (!sessionToken || serviceBusy.has(provider)) return;
    serviceBusy.add(provider);
    renderServiceControls();
    try {
      rememberServiceStatus(
        provider,
        await api(
          serviceUrl(provider) +
            (provider === "vercel" && refreshAvailability ? "&refresh=1" : ""),
        ),
      );
      message($(`${provider}-message`), "");
    } catch (error) {
      message($(`${provider}-message`), error.message, true);
      $(`${provider}-state`).textContent = "Unable to check";
      $(`${provider}-account`).textContent = "Use Refresh status to try again.";
    } finally {
      serviceBusy.delete(provider);
      renderServiceControls();
    }
    await resumeProjectConnection(provider);
    if (provider === "linear") await refreshLinearResources();
  }
  async function resumeProjectConnection(provider) {
    const selected = serviceSelection[provider];
    const status = serviceStatuses.get(provider);
    if (
      !connectionReturn.pending(provider, selected) ||
      !status?.connected ||
      status.needsReconnect
    )
      return;
    try {
      await refreshStatus();
      const account = currentStatus?.serviceConnections?.find(
        (item) =>
          item.provider === provider && (item.id || "default") === selected,
      );
      if (!account?.connected || account.needsReconnect)
        throw new Error("The connected account is not ready yet.");
      const destination = connectionReturn.take(
        currentStatus?.projects || [],
        selected,
        provider,
      );
      if (!destination) return;
      pages.navigate(destination.path);
      if (provider === "linear")
        await linearOnboarding.resume(destination.project);
      else await projectOnboarding.resumeHosting(destination.project);
    } catch (error) {
      message(
        $(`${provider}-message`),
        `${serviceProviders[provider].name} connected, but project setup could not resume. ${error.message} Use Refresh status to try again.`,
        true,
      );
    }
  }
  async function initializeService(provider) {
    if (!sessionToken) return;
    const envelope = serviceEnvelopes[provider];
    if (!envelope) {
      await refreshService(provider);
      return;
    }
    serviceEnvelopes[provider] = "";
    serviceBusy.add(provider);
    renderServiceControls();
    try {
      await api(serviceUrl(provider, "complete"), { envelope });
      // Keep confirmed OAuth completion across transient status failures/reloads.
      // A connected account alone does not authorize replaying an abandoned flow.
      connectionReturn.confirmed(provider, serviceSelection[provider]);
      try {
        sessionStorage.removeItem("gremlins-pending-" + provider);
      } catch {
        /* No persisted preference. */
      }
      rememberServiceStatus(provider, await api(serviceUrl(provider)));
      message(
        $(`${provider}-message`),
        `${serviceProviders[provider].name} connected. Review the available account and project settings before running your crew.`,
      );
    } catch (error) {
      message(
        $(`${provider}-message`),
        `${error.message} Refresh status, then start authorization again if needed.`,
        true,
      );
    } finally {
      serviceBusy.delete(provider);
      renderServiceControls();
    }
    await resumeProjectConnection(provider);
    if (provider === "linear") await refreshLinearResources();
  }
  async function connectService(provider, { project, connectionId } = {}) {
    const config = serviceProviders[provider];
    if (serviceBusy.has(provider) || !sessionToken || formsLocked || restarting)
      throw new Error("Wait for the current connection check, then try again.");
    if (hasUnsavedInputs())
      throw new Error(
        `Save or clear unsaved configuration and form entries before opening ${config.name}. Authorization leaves this page and returns to your setup.`,
      );
    const selected = connectionId || serviceSelection[provider];
    if (!validProfileId(selected))
      throw new Error("Choose a valid saved connection.");
    try {
      sessionStorage.setItem(sessionKey, sessionToken);
    } catch {
      throw new Error(
        "This browser cannot retain the dashboard session during authorization. Allow session storage or use the manual-token fallback in Connections.",
      );
    }
    serviceBusy.add(provider);
    renderServiceControls();
    message($(`${provider}-message`), "");
    try {
      const status = await api(
        serviceUrl(provider, "", selected) +
          (provider === "vercel" ? "&refresh=1" : ""),
      );
      if (!status.available) {
        const reason = ["not_configured", "provider_unavailable"].includes(
          status.availabilityReason,
        )
          ? status.availabilityReason
          : undefined;
        const error = new Error(
          provider === "vercel"
            ? reason === "not_configured"
              ? "ShipGremlins’ hosted Vercel sign-in service needs configuration. The ShipGremlins operator must finish that setup; check again after it’s fixed."
              : "We couldn’t reach a working Vercel sign-in service. Retry to check it again and continue to Vercel."
            : status.message ||
                `Browser sign-in is unavailable. Open Connections to configure ${config.name}.`,
        );
        error.code = "oauth_unavailable";
        error.availabilityReason = reason;
        throw error;
      }
      rememberService(provider, selected);
      rememberServiceStatus(provider, status);
      sessionStorage.setItem("gremlins-pending-" + provider, selected);
      connectionReturn.clear();
      if (project) connectionReturn.remember(project, selected, provider);
      const result = await api(serviceUrl(provider, "connect"), {});
      const url = new URL(result.url);
      if (
        url.origin !== "https://shipgremlins.ai" ||
        url.pathname !== `/api/${provider}/authorize` ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error(
          `The server returned an unexpected ${config.name} authorization address.`,
        );
      if (hasUnsavedInputs())
        throw new Error(
          `Your form changed while connecting. Save or clear its edits before opening ${config.name}.`,
        );
      window.location.assign(url.href);
    } catch (error) {
      serviceBusy.delete(provider);
      connectionReturn.clear();
      renderServiceControls();
      throw error;
    }
  }
  for (const [provider, config] of Object.entries(serviceProviders)) {
    $(`${provider}-refresh`).addEventListener("click", () =>
      refreshService(provider, true),
    );
    $(`${provider}-connect`).addEventListener("click", async () => {
      try {
        await connectService(provider);
      } catch (error) {
        message($(`${provider}-message`), error.message, true);
      }
    });
    $(`${provider}-disconnect`).addEventListener("click", () => {
      $(`${provider}-disconnect-prompt`).hidden = false;
      $(`${provider}-keep`).focus();
    });
    $(`${provider}-keep`).addEventListener("click", () => {
      $(`${provider}-disconnect-prompt`).hidden = true;
    });
    $(`${provider}-confirm-disconnect`).addEventListener("click", async () => {
      if (serviceBusy.has(provider) || !sessionToken) return;
      serviceBusy.add(provider);
      renderServiceControls();
      try {
        rememberServiceStatus(
          provider,
          await api(serviceUrl(provider), {}, "DELETE"),
        );
        if (provider === "linear") {
          linearResourceCache.delete(serviceSelection[provider]);
          await refreshLinearResources();
        }
        $(`${provider}-disconnect-prompt`).hidden = true;
        message(
          $(`${provider}-message`),
          `${config.name} browser authorization removed. Existing configuration and any separately saved token are kept.`,
        );
        await refreshStatus();
        await refreshRunners();
      } catch (error) {
        message($(`${provider}-message`), error.message, true);
      } finally {
        serviceBusy.delete(provider);
        renderServiceControls();
      }
    });
    $(`${provider}-token-form`).addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $(`${provider}-token`);
      const value = input.value.trim();
      if (!value) {
        message(
          $(`${provider}-token-message`),
          "Paste a new token to save. Blank fields keep your existing value.",
          true,
        );
        input.focus();
        return;
      }
      serviceBusy.add(provider);
      renderServiceControls();
      try {
        await api("/api/connections", { values: { [config.token]: value } });
        input.value = "";
        input.type = "password";
        const reveal = document.querySelector(
          `[data-reveal="${provider}-token"]`,
        );
        reveal.textContent = "Show";
        reveal.setAttribute("aria-pressed", "false");
        reveal.setAttribute(
          "aria-label",
          reveal.getAttribute("aria-label").replace(/^Hide/, "Show"),
        );
        message(
          $(`${provider}-token-message`),
          `${config.name} token saved on this server. Use Verify connections on your app to check live access.`,
        );
        rememberServiceStatus(provider, await api(serviceUrl(provider)));
        await refreshStatus();
        await refreshRunners();
        if (provider === "linear") await refreshLinearResources();
      } catch (error) {
        message($(`${provider}-token-message`), error.message, true);
      } finally {
        serviceBusy.delete(provider);
        renderServiceControls();
      }
    });
  }

  function renderSlackControls() {
    renderConnectionSummary();
    const locked = formsLocked || !sessionToken || slackBusy || restarting;
    const connected = slackStatus?.connected || slackStatus?.webhookConfigured;
    $("slack-connection").classList.toggle("is-connected", Boolean(connected));
    $("slack-connect").disabled = locked || !slackStatus?.available;
    $("slack-connect").textContent = slackBusy
      ? "Connecting…"
      : connected
        ? "Change channel ↗"
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
    if (currentStatus)
      connectionsView.render(
        currentStatus.connections || [],
        currentStatus.projects || [],
        { locked: formsLocked, slackConnected: Boolean(connected) },
      );
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

  $("copy-claude-command").addEventListener("click", async () => {
    try {
      await copyText("claude setup-token");
      copiedButton($("copy-claude-command"));
      $("claude-copy-status").textContent = "Claude setup command copied.";
    } catch (error) {
      $("claude-copy-status").textContent = error.message;
    }
  });

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
    window.revealDashboardSetting?.($("advanced-settings"));
    if (isEditorDirty()) {
      pendingEditorAction = { action, path };
      $("config-file").value = editor.path;
      $("discard-description").textContent =
        action === "switch"
          ? `You have unsaved changes in ${editor.path}. Save them first, keep editing, or discard them to open ${path}.`
          : "Reloading replaces your draft with the latest file on the server. Save or copy your draft first if you want to keep it.";
      $("discard-prompt").hidden = false;
      pages.navigate("/settings#discard-prompt");
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
      ...document.querySelectorAll(
        ".password-wrap input, textarea[data-secret-json], #gcp-credentials, #slack-webhook",
      ),
    ].find((input) => input.value);
    if (projectOnboarding?.isDirty() && !isEditorDirty()) {
      const project = projectOnboarding.dirtyProject();
      pages.navigate(
        `/projects/${encodeURIComponent(project)}?tab=environment`,
      );
      projectOnboarding.focusDraft(project);
      return;
    }
    const target = isEditorDirty()
      ? $("config-content")
      : pendingToken ||
        (mixpanelReports?.isDirty()
          ? $("mixpanel-reports").querySelector("input")
          : null) ||
        (newProjectSettings.isDirty() ? $("project-name") : null) ||
        ["project-repo", "project-name", "pm-name", "pm-mandate", "job-ticket"]
          .map($)
          .find((input) => input.value) ||
        $("config-content");
    for (
      let parent = target.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (parent.tagName === "DETAILS") parent.open = true;
    const page = target.closest("[data-page]")?.dataset.page;
    if (page)
      pages.navigate(
        `/${page}${target.id ? `#${encodeURIComponent(target.id)}` : ""}`,
      );
    requestAnimationFrame(() => {
      target.focus();
      target.scrollIntoView({ block: "center" });
    });
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
    updateBanner.render(status, {
      busy,
      authenticated: Boolean(sessionToken),
      restarting,
    });
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
    resumeBackgroundChecks();
  }
  function resumeBackgroundChecks() {
    if (!sessionToken || restarting) return;
    updateBanner.startRefresh({
      check: () => runUpdateAction("check"),
      getStatus: () => updateStatus,
      canCheck: () =>
        Boolean(sessionToken) && !updateRequestBusy && !restarting,
    });
    scheduleUpdatePoll();
    scheduleRunnerPoll();
    refreshJobOutput();
  }

  function prepareProjectSections(section = "project") {
    const signals = $("edit-project-settings").querySelector(
      ".project-signals-settings",
    );
    $("edit-signals-settings").replaceChildren(...(signals ? [signals] : []));
    focusProjectSection(section, false);
  }
  function focusProjectSection(section, focus = true) {
    projectEditor.section = section;
    $("edit-project-settings").hidden = section !== "project";
    $("edit-signals-settings").hidden = section !== "signals";
    $("edit-linear-settings").hidden = section !== "linear";
    $("save-project-settings").closest(".form-bottom").hidden =
      section === "linear";
    for (const button of document.querySelectorAll("[data-project-section]"))
      button.setAttribute(
        "aria-current",
        button.dataset.projectSection === section ? "page" : "false",
      );
    const target =
      section === "linear"
        ? $("edit-linear-settings")
        : section === "signals"
          ? $("edit-signals-settings")
          : $("edit-project-settings");
    if (!target) return;
    if (!focus) return;
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  }
  for (const button of document.querySelectorAll("[data-project-section]"))
    button.addEventListener("click", () =>
      focusProjectSection(button.dataset.projectSection),
    );
  $("edit-project-form").addEventListener(
    "invalid",
    (event) => {
      const first = $("edit-project-form").querySelector(
        ":invalid:not(fieldset):not(form)",
      );
      if (first && first !== event.target) return;
      focusProjectSection(
        event.target.closest("#edit-signals-settings")
          ? "signals"
          : event.target.closest("#edit-linear-settings")
            ? "linear"
            : "project",
        false,
      );
    },
    true,
  );

  async function openProjectSettings(
    name,
    trigger,
    { section = "project", provider } = {},
  ) {
    if (projectEditor.busy || projectLinearSettings?.isBusy()) return;
    const generation = ++projectEditor.generation;
    projectLinearSettings?.reset();
    projectEditor.name = name;
    projectEditor.path = `projects/${name}/project.json`;
    projectEditor.trigger = trigger || projectEditor.trigger;
    projectEditor.busy = true;
    projectEditor.loading = true;
    projectEditor.pending = null;
    $("project-settings-discard").hidden = true;
    projectEditor.form = null;
    $("edit-project-settings").replaceChildren();
    $("edit-signals-settings").replaceChildren();
    focusProjectSection("project", false);
    updateProjectEditorControls();
    $("project-settings-title").textContent = `Edit ${name}`;
    if ($("project-settings-name"))
      $("project-settings-name").textContent = name;
    if ($("project-settings-provider"))
      $("project-settings-provider").textContent = "Loading source…";
    $("project-settings-repo").textContent = "Loading repository…";
    if (!$("project-settings-dialog").open)
      $("project-settings-dialog").showModal();
    message($("project-settings-message"), "Loading saved settings…");
    try {
      const file = await api(
        `/api/config?path=${encodeURIComponent(projectEditor.path)}`,
      );
      if (generation !== projectEditor.generation) return;
      projectEditor.config = JSON.parse(file.content);
      projectEditor.revision = file.revision;
      projectEditor.form = window.createProjectSettings(
        $("edit-project-settings"),
        "edit-settings",
        projectEditor.config,
        {
          projectName: projectEditor.name,
          connections: serviceProfiles,
          onReveal: (input) =>
            focusProjectSection(
              input.closest("#edit-signals-settings") ? "signals" : "project",
              false,
            ),
        },
      );
      prepareProjectSections(section);
      if (section === "signals" && provider)
        projectEditor.form.focusProvider(provider);
      $("project-settings-repo").textContent =
        projectEditor.config.repo || "Project configuration";
      if ($("project-settings-provider"))
        $("project-settings-provider").textContent =
          projectEditor.config.provider === "gitlab" ? "GitLab" : "GitHub";
      message($("project-settings-message"), "");
      await projectLinearSettings?.load(name);
    } catch (error) {
      if (generation !== projectEditor.generation) return;
      projectEditor.form = null;
      $("edit-project-settings").replaceChildren();
      $("edit-signals-settings").replaceChildren();
      focusProjectSection("project", false);
      $("project-settings-repo").textContent = "Configuration needs repair";
      if ($("project-settings-provider"))
        $("project-settings-provider").textContent = "Local project";
      message(
        $("project-settings-message"),
        `${error.message} Reload to try again, or use full configuration to repair the file.`,
        true,
      );
    } finally {
      if (generation === projectEditor.generation) {
        projectEditor.loading = false;
        projectEditor.busy = false;
        updateProjectEditorControls();
      }
    }
  }
  function isProjectEditorDirty() {
    return Boolean(
      projectEditor.form?.isDirty() || projectLinearSettings?.isDirty(),
    );
  }
  function updateProjectEditorControls() {
    const busy = projectEditor.busy || projectLinearSettings?.isBusy();
    $("edit-project-fields").disabled = Boolean(
      formsLocked || busy || !projectEditor.form,
    );
    $("close-project-settings").disabled = Boolean(
      (projectEditor.busy && !projectEditor.loading) ||
      projectLinearSettings?.isWriting?.(),
    );
    $("reload-project-settings").disabled = Boolean(formsLocked || busy);
    $("advanced-project-settings").disabled = Boolean(formsLocked || busy);
    $("delete-project").disabled = Boolean(
      formsLocked || busy || !projectEditor.name,
    );
    projectLinearSettings?.setLocked(formsLocked || projectEditor.busy);
  }
  async function projectSettingsAction(action, discard = false) {
    if (
      (projectEditor.busy && !projectEditor.loading) ||
      projectLinearSettings?.isWriting?.() ||
      (action !== "close" &&
        (projectEditor.busy || projectLinearSettings?.isBusy()))
    )
      return;
    if (!discard && isProjectEditorDirty()) {
      projectEditor.pending = action;
      $("project-settings-discard").hidden = false;
      $("project-settings-discard").scrollIntoView?.({ block: "nearest" });
      $("keep-project-settings").focus();
      return;
    }
    $("project-settings-discard").hidden = true;
    projectEditor.pending = null;
    if (action === "reload") {
      await openProjectSettings(projectEditor.name);
      return;
    }
    $("project-settings-dialog").close();
    ++projectEditor.generation;
    projectEditor.busy = false;
    projectEditor.loading = false;
    projectLinearSettings?.reset();
    if (action === "delete") {
      openDeletion({
        project: projectEditor.name,
        trigger: projectEditor.trigger,
      });
      return;
    }
    if (action === "connections") {
      pages.navigate("/connections");
      return;
    }
    if (action === "advanced") {
      pages.navigate("/settings#configuration");
      await requestEditorAction("switch", projectEditor.path);
      return;
    }
    const resume = adoptionSignalReturn;
    adoptionSignalReturn = null;
    if (
      action === "close" &&
      resume?.project === projectEditor.name &&
      pmAdoption?.accepted?.project === resume.project &&
      pmAdoption.accepted.key === resume.key &&
      (pmAdoption.accepted.projectInstanceId ?? null) === resume.instanceId &&
      (pmAdoption.accepted.areaInstanceId ?? null) === resume.areaInstanceId &&
      currentStatus?.projects?.some(
        (project) =>
          project.name === resume.project &&
          (project.instanceId ?? null) === resume.instanceId &&
          project.areas?.some(
            (area) =>
              area.key === resume.key &&
              (area.instanceId ?? null) === resume.areaInstanceId,
          ),
      )
    ) {
      openPmCreation(resume.project);
      return;
    }
    const trigger = [...document.querySelectorAll("[data-edit-project]")].find(
      (item) => item.dataset.editProject === projectEditor.name,
    );
    (trigger || projectEditor.trigger)?.focus();
  }
  $("close-project-settings").addEventListener("click", () =>
    projectSettingsAction("close"),
  );
  $("edit-project-form").addEventListener("click", (event) => {
    if (event.target.closest('a[href="#connections"]')) {
      event.preventDefault();
      projectSettingsAction("connections");
    }
  });
  $("reload-project-settings").addEventListener("click", () =>
    projectSettingsAction("reload"),
  );
  $("advanced-project-settings").addEventListener("click", () =>
    projectSettingsAction("advanced"),
  );
  $("delete-project").addEventListener("click", () =>
    projectSettingsAction("delete"),
  );
  $("project-settings-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    projectSettingsAction("close");
  });
  $("keep-project-settings").addEventListener("click", () => {
    $("project-settings-discard").hidden = true;
    projectEditor.pending = null;
    $("close-project-settings").focus();
  });
  $("discard-project-settings").addEventListener("click", () =>
    projectSettingsAction(projectEditor.pending || "close", true),
  );
  $("edit-project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      formsLocked ||
      projectEditor.busy ||
      projectLinearSettings?.isBusy() ||
      !projectEditor.form
    )
      return;
    let content;
    try {
      content =
        JSON.stringify(
          {
            ...projectEditor.config,
            ...projectEditor.form.read(),
            verified: null,
          },
          null,
          2,
        ) + "\n";
    } catch (error) {
      message($("project-settings-message"), error.message, true);
      return;
    }
    projectEditor.busy = true;
    updateProjectEditorControls();
    message($("project-settings-message"), "Saving project settings…");
    const generation = ++projectEditor.generation;
    try {
      const result = await api(
        "/api/config",
        { path: projectEditor.path, content, revision: projectEditor.revision },
        "PUT",
      );
      projectEditor.revision = result.revision;
      projectEditor.config = JSON.parse(content);
      projectEditor.form = window.createProjectSettings(
        $("edit-project-settings"),
        "edit-settings",
        projectEditor.config,
        {
          projectName: projectEditor.name,
          connections: serviceProfiles,
          onReveal: (input) =>
            focusProjectSection(
              input.closest("#edit-signals-settings") ? "signals" : "project",
              false,
            ),
        },
      );
      prepareProjectSections(projectEditor.section);
      projectEditor.loading = true;
      updateProjectEditorControls();
      if (projectLinearSettings?.isDirty()) {
        // Rebase only against this save's exact content/revision. A later GET
        // could adopt another operator's edit without refreshing our form.
        projectLinearSettings.rebaseProject?.({
          path: projectEditor.path,
          content,
          revision: result.revision,
        });
      } else await projectLinearSettings?.load(projectEditor.name);
      if (generation !== projectEditor.generation) return;
      $("project-settings-discard").hidden = true;
      projectChecks.delete(projectEditor.name);
      message(
        $("project-settings-message"),
        "Settings saved. Run Verify connections beside this project before its next job. Other settings and credentials were kept.",
      );
      try {
        await refreshStatus();
      } catch {
        /* The saved revision remains authoritative. */
      }
    } catch (error) {
      if (generation !== projectEditor.generation) return;
      message(
        $("project-settings-message"),
        error.status === 409
          ? "This project changed on the server. Your draft is kept. Copy any changes you need, then Reload saved settings and reapply them."
          : error.message,
        true,
      );
    } finally {
      if (generation === projectEditor.generation) {
        projectEditor.loading = false;
        projectEditor.busy = false;
        updateProjectEditorControls();
      }
    }
  });
  $("reveal-gcp-credentials").addEventListener("click", () => {
    const showing = $("gcp-credentials").classList.toggle("revealed");
    $("reveal-gcp-credentials").textContent = showing
      ? "Hide JSON"
      : "Show JSON";
    $("reveal-gcp-credentials").setAttribute("aria-pressed", String(showing));
  });
  for (const [provider, id, key] of [
    ["railway", "railway-token", "RAILWAY_TOKEN"],
    ["cloud-run", "gcp-credentials", "GCP_SERVICE_ACCOUNT_JSON"],
  ]) {
    $(`${provider}-token-form`).addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $(id);
      const value = input.value.trim();
      if (!value || formsLocked) return;
      if (provider === "cloud-run") {
        try {
          const credential = JSON.parse(value);
          if (
            credential.type !== "service_account" ||
            !credential.client_email ||
            !credential.private_key
          )
            throw new Error();
        } catch {
          message(
            $(`${provider}-token-message`),
            "Paste a service-account JSON file with type, client_email and private_key. Its contents are kept out of error messages.",
            true,
          );
          return;
        }
      }
      $(`${provider}-token-fields`).disabled = true;
      message($(`${provider}-token-message`), "Saving on your server…");
      try {
        await api("/api/connections", { values: { [key]: value } });
        input.value = "";
        if (provider === "cloud-run") {
          input.classList.remove("revealed");
          $("reveal-gcp-credentials").textContent = "Show JSON";
          $("reveal-gcp-credentials").setAttribute("aria-pressed", "false");
        } else input.type = "password";
        message(
          $(`${provider}-token-message`),
          "Credential saved locally. Verify connections for the project to check access to its selected environment.",
        );
        await refreshStatus();
      } catch (error) {
        message($(`${provider}-token-message`), error.message, true);
      } finally {
        $(`${provider}-token-fields`).disabled = formsLocked;
      }
    });
  }

  function hasUnsavedInputs() {
    return (
      ideaCrew.busy ||
      ideaCrew.hasDraft() ||
      pmPlanning ||
      pmCreating ||
      pmActions?.isBusy() ||
      projectWorkspace?.isDirty() ||
      projectWorkspace?.isBusy() ||
      workspaceDeletion?.isBusy() ||
      connectionsView?.isBusy() ||
      [...profileControls.values()].some((control) => control.isBusy?.()) ||
      projectOperations?.isDirty() ||
      projectOperations?.isBusy() ||
      projectOnboarding?.isDirty() ||
      projectOnboarding?.isBusy() ||
      linearOnboarding?.isBusy() ||
      remoteWorkers?.isBusy() ||
      Object.keys(pmCharter.read()).length > 0 ||
      pmDraft?.hasDraft() ||
      isEditorDirty() ||
      [...profileControls.values()].some((control) => control.isDirty()) ||
      Boolean(mixpanelReports?.isDirty()) ||
      newProjectSettings.isDirty() ||
      (isProjectEditorDirty() && $("project-settings-dialog").open) ||
      Boolean($("gcp-credentials").value) ||
      [
        ...document.querySelectorAll(
          ".password-wrap input, textarea[data-secret-json]",
        ),
      ].some((input) => input.value) ||
      [
        "project-repo",
        "project-name",
        "gitlab-server",
        "job-ticket",
        "slack-webhook",
        "pm-name",
        "pm-key",
        "pm-mandate",
        "pm-paths",
        "pm-shared-paths",
        "pm-mixpanel-report",
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
      window.revealDashboardSetting?.($("advanced-settings"));
      pages.navigate("/settings#discard-prompt");
      $("keep-editing").focus();
      return;
    }
    restarting = true;
    pauseJobOutput();
    updateBanner.stopRefresh();
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
      resumeBackgroundChecks();
    }
  }

  $("update-check").addEventListener("click", () => runUpdateAction("check"));
  $("update-apply").addEventListener("click", () => runUpdateAction("apply"));
  $("update-rollback").addEventListener("click", () =>
    runUpdateAction("rollback"),
  );
  $("update-restart").addEventListener("click", () => restartDashboard());

  window.addEventListener("beforeunload", (event) => {
    if (
      restartReloadApproved ||
      !(
        isEditorDirty() ||
        projectWorkspace?.isDirty() ||
        projectOperations?.isDirty() ||
        projectOnboarding?.isDirty() ||
        projectOnboarding?.isBusy() ||
        workspaceDeletion?.isBusy() ||
        pmActions?.isBusy() ||
        connectionsView?.isBusy() ||
        [...profileControls.values()].some((control) => control.isBusy?.()) ||
        Boolean(mixpanelReports?.isDirty()) ||
        newProjectSettings.isDirty() ||
        (isProjectEditorDirty() && $("project-settings-dialog").open)
      )
    )
      return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("pagehide", () => {
    jobOutputSuspended = true;
    pauseJobOutput();
    jobOutput.invalidate("artifacts");
    updateBanner.stopRefresh();
    clearTimeout(updatePollTimer);
    clearTimeout(runnerPollTimer);
    clearArtifactBlobs();
    for (const timer of sourceTimers.values()) clearTimeout(timer);
    sourceFlows.clear();
    $("slack-webhook").value = "";
    $("gcp-credentials").value = "";
    for (const input of document.querySelectorAll(
      ".password-wrap input, textarea[data-secret-json]",
    ))
      input.value = "";
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !sessionToken || restarting) return;
    jobOutputSuspended = false;
    resumeBackgroundChecks();
    Promise.allSettled([
      refreshStatus(),
      refreshRunners(),
      refreshSources(),
      refreshSlack(),
      ...Object.keys(serviceProviders).map(refreshService),
    ]);
  });
  function openDeletion(target) {
    const scope = `projects/${target.project}/`;
    const affectsEditor = target.area
      ? editor.path === `${scope}areas.json`
      : editor.path.startsWith(scope);
    if (affectsEditor && isEditorDirty()) {
      pages.navigate("/settings#configuration");
      message(
        $("config-message"),
        "Save or discard your configuration draft before deleting this item. The draft has been kept.",
        true,
      );
      return;
    }
    workspaceDeletion.open(target);
  }
  workspaceDeletion = window.createWorkspaceDeletion({
    api,
    isLocked: () => formsLocked || !sessionToken || restarting,
    onDeleted: async (result) => {
      projectChecks.delete(result.project);
      mappingMessages.delete(result.project);
      projectDetailsState.delete(result.project);
      for (const key of areaActions.keys())
        if (
          key === `${result.project}/${result.area}` ||
          (!result.area && key.startsWith(`${result.project}/`))
        )
          areaActions.delete(key);
      projectWorkspace?.forget(result.project, result.area);
      projectOperations?.forget(result.project);
      const prefix = `projects/${result.project}/`;
      if (
        editor.path.startsWith(prefix) &&
        (!result.area || editor.path === `${prefix}areas.json`)
      ) {
        editor.path = "";
        editor.revision = "";
        editor.original = "";
        $("config-content").value = "";
        clearDiscardPrompt();
      }
      if (projectEditor.name === result.project) {
        projectEditor.form = null;
        projectEditor.name = "";
        projectEditor.config = null;
        $("project-settings-dialog").close();
        projectLinearSettings?.reset();
      }
      pages.navigate(
        result.area
          ? `/projects/${encodeURIComponent(result.project)}`
          : "/projects",
        { replace: true },
      );
      await refreshStatus();
      await Promise.allSettled([
        refreshConfigFiles(),
        projectOperations?.refreshInbox(),
        deletedResources?.refresh(),
      ]);
    },
    onRestored: async (result) => {
      projectChecks.delete(result.project);
      projectWorkspace?.forget(result.project, result.area);
      projectOperations?.forget(result.project);
      await refreshStatus();
      pages.navigate(`/projects/${encodeURIComponent(result.project)}`, {
        replace: true,
      });
      await Promise.allSettled([
        refreshConfigFiles(),
        projectOperations?.refreshInbox(),
        deletedResources?.refresh(),
      ]);
    },
  });
  deletedResources = window.createDeletedResources($("deleted-resources"), {
    api,
    pages,
    isLocked: () => formsLocked || !sessionToken || restarting,
    onRestore: (target) => openDeletion(target),
  });
  window.createWorkspaceUsage?.($("usage"), {
    api,
    pages,
    canRead: () => Boolean(sessionToken) && !restarting,
  });
  projectOperations = window.createProjectOperations({
    getCodingAction: (name) => codingActions?.getState(name),
    getJobs: mergedJobs,
    api,
    pages,
    inbox: $("inbox-content"),
    getProject: (name) =>
      currentStatus?.projects?.find((project) => project.name === name),
    isLocked: () => formsLocked || !sessionToken || restarting,
    onChanged: refreshStatus,
    onDiscover: (project, area) =>
      projectWorkspace.discover(project, area).catch(() => {}),
    onCreatePm: (project) =>
      document.dispatchEvent(
        new CustomEvent("gremlins:create-pm", { detail: { project } }),
      ),
    onActivity: (id) => {
      selectJob(id);
    },
  });
  remoteWorkers = window.createRemoteWorkers($("remote-workers"), {
    api,
    pages,
    isLocked: () => formsLocked || !sessionToken || restarting,
  });
  document.addEventListener("gremlins:create-pm", (event) => {
    if (formsLocked || pmCreating) return;
    openPmCreation(event.detail.project);
  });
  linearOnboarding = window.createLinearOnboarding({
    api,
    getStatus: () => currentStatus,
    isLocked: () => formsLocked || !sessionToken || restarting,
    onConnect: (project, connectionId) =>
      connectProjectService("linear", project, connectionId),
    onSaved: refreshStatus,
    onReady: (project) =>
      pages.navigate(
        `/projects/${encodeURIComponent(project)}?tab=environment`,
      ),
  });
  async function connectProjectService(
    provider,
    project,
    connectionId = "default",
  ) {
    const current = currentStatus?.projects?.find(
      (item) => item.name === project.name,
    );
    if (
      !current ||
      (current.instanceId ?? null) !== (project.instanceId ?? null) ||
      current.repo !== project.repo ||
      (current.provider || "github") !== (project.provider || "github") ||
      (current.serverUrl ?? null) !== (project.serverUrl ?? null)
    )
      throw new Error(
        "This project changed. Reload its setup before connecting an account.",
      );
    await connectService(provider, { project: current, connectionId });
  }
  projectOnboarding = window.createProjectOnboarding({
    api,
    getStatus: () => currentStatus,
    isLocked: () => formsLocked || !sessionToken || restarting,
    onConnectHosting: (project, connectionId) =>
      connectProjectService("vercel", project, connectionId),
    onSaved: async (project) => {
      projectChecks.delete(project);
      await refreshStatus();
      await refreshConfigFiles();
    },
    onCreatePm: (project) => openPmCreation(project),
    loadImage: async (path) => {
      const url = new URL(path, window.location.origin);
      if (
        url.origin !== window.location.origin ||
        !/^\/api\/projects\/[^/]+\/onboarding\/screenshot$/.test(
          url.pathname,
        ) ||
        url.search ||
        url.username ||
        url.password
      )
        throw new Error("The environment screenshot address is invalid.");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/")
      )
        throw new Error(
          "The browser screenshot could not be loaded. Test the environment again.",
        );
      return response.blob();
    },
  });
  projectWorkspace = window.createProjectWorkspace($("project-workspace"), {
    api,
    pages,
    operations: projectOperations,
    onboarding: projectOnboarding,
    getJobs: () => mergedJobs(),
    onDelete: openDeletion,
    getCheck: (name) => projectChecks.get(name),
    getAreaAction: (project, area) => areaActions.get(`${project}/${area}`),
    getCodingAction: (project) => codingActions?.getState(project),
    onSaved: refreshStatus,
    onCreatePm: (project, suggestion) => {
      openPmCreation(project, document.activeElement, suggestion);
    },
    onSetupHosting: (project) =>
      pages.navigate(
        `/projects/${encodeURIComponent(project)}?tab=environment`,
      ),
    onSetupLinear: (project, trigger) =>
      linearOnboarding.open(project, trigger),
    onJob: (job) => {
      jobHistory = [...jobHistory.filter((item) => item.id !== job.id), job];
      renderJobs(runnerStatus?.jobs || []);
      refreshRunners();
    },
    onActivity: (id) => {
      selectJob(id);
    },
  });
  pmActions = window.createPmActions({
    api,
    states: areaActions,
    getProject: (name) =>
      currentStatus?.projects?.find((project) => project.name === name),
    getJobs: mergedJobs,
    isLocked: () => formsLocked || !sessionToken || restarting,
    onState: () => renderStatus(currentStatus),
    onFinished: (project, area, mode) => {
      if (
        !["automation", "coding-automation"].includes(mode) ||
        pages.current !== "project" ||
        pages.project !== project ||
        (pages.pm && pages.pm !== area)
      )
        return;
      [...$("project-workspace").querySelectorAll("[data-toggle-area]")]
        .find(
          (button) =>
            button.dataset.toggleArea === area &&
            (button.dataset.automationKind === "coding") ===
              (mode === "coding-automation"),
        )
        ?.focus({ preventScroll: true });
    },
    onChanged: refreshStatus,
    onJob: (job) => {
      jobHistory = [...jobHistory.filter((item) => item.id !== job.id), job];
      selectJob(job.id);
      refreshRunners();
    },
  });
  codingActions = window.createCodingActions({
    api,
    getProject: (name) =>
      currentStatus?.projects?.find((project) => project.name === name),
    isLocked: () => formsLocked || !sessionToken || restarting,
    onState: () => renderStatus(currentStatus),
    onChanged: refreshRunners,
    onJob: (job) => {
      jobHistory = [...jobHistory.filter((item) => item.id !== job.id), job];
      selectJob(job.id);
    },
    onFinished: scheduleRunnerPoll,
  });
  initialize();
})();
