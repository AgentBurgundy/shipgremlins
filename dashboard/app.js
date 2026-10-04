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

  function message(element, text, error = false) {
    element.replaceChildren();
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle("error", error);
    element.setAttribute("role", error ? "alert" : "status");
  }

  function lockForms(locked) {
    $("connections-fields").disabled = locked;
    $("project-fields").disabled = locked;
  }

  function restoreButton(id, label, symbol) {
    const button = $(id);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;
    button.replaceChildren(document.createTextNode(label + " "), icon);
  }

  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
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
            "This dashboard session has expired. Run shipgremlins dashboard to open a fresh session.",
          );
        }
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "The request could not be completed. Please try again.",
        );
      }
      return result;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error(
          "The local server took too long to respond. Check that ShipGremlins is still running and try again.",
        );
      if (error instanceof TypeError)
        throw new Error(
          "Cannot reach the local dashboard. Keep the CLI running, then try again.",
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
      badge.textContent = "Configured locally";
      row.append(name, badge);
      list.append(row);
    }
    const exampleProject = projects.find((project) =>
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name),
    );
    $("doctor-command").textContent =
      `shipgremlins doctor ${exampleProject ? exampleProject.name : "PROJECT"}`;
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
        "Open this dashboard from your CLI with shipgremlins dashboard. The launch link creates a private session for this tab.",
        true,
      );
      $("connections-summary").textContent = "Session required";
      $("projects-summary").textContent = "Session required";
      $("config-directory").textContent = "Session required";
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
    } catch (error) {
      message($("global-message"), error.message, true);
      $("connections-summary").textContent = "Unable to load";
      $("projects-summary").textContent = "Unable to load";
      $("config-directory").textContent = "Unavailable";
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
        "Connections saved on your machine. Blank fields were left unchanged. Verify access with the doctor command below.",
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
        `${data.project} is configured locally.${created === 0 ? " Existing files were kept." : ""} Complete the project settings and run the verification command below before enabling agents.`,
      );
      try {
        await refreshStatus();
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

  $("copy-command").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("doctor-command").textContent);
      $("copy-command").textContent = "Copied";
      $("copy-status").textContent = "Verification command copied.";
      setTimeout(() => {
        $("copy-command").textContent = "Copy";
      }, 2000);
    } catch {
      $("copy-status").textContent =
        "Copy is unavailable. Select the verification command to copy it manually.";
    }
  });

  window.addEventListener("pagehide", () => {
    for (const input of document.querySelectorAll(".password-wrap input"))
      input.value = "";
  });
  initialize();
})();
