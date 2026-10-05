"use strict";

(() => {
  const fixed = new Set([
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "LINEAR_API_KEY",
    "VERCEL_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "RAILWAY_TOKEN",
    "GCP_SERVICE_ACCOUNT_JSON",
  ]);
  const titles = {
    vercel: "Vercel",
    railway: "Railway",
    "cloud-run": "Google Cloud Run",
    sentry: "Sentry",
    datadog: "Datadog",
    mixpanel: "Mixpanel",
  };
  const $ = (id) => document.getElementById(id);
  const node = (tag, cls, text) => {
    const item = document.createElement(tag);
    if (cls) item.className = cls;
    if (text) item.textContent = text;
    return item;
  };
  function link(text, href) {
    const item = node("a", "setup-doc-link", text);
    item.href = href;
    item.target = "_blank";
    item.rel = "noreferrer";
    return item;
  }
  window.createConnectionsView = ({ api, message, onSaved, onConfigure }) => {
    const rows = new Map();
    const clearRows = new Map();
    let locked = true;
    // Secondary management controls stay available without filling the directory with buttons.
    for (const provider of ["linear", "vercel", "slack"]) {
      const card = $(`${provider}-connection`);
      const management = node("details", "connection-management");
      management.append(node("summary", "", "Manage connection"));
      const controls = node("div", "button-row");
      controls.append($(`${provider}-refresh`), $(`${provider}-disconnect`));
      management.append(
        $(`${provider}-guidance`),
        controls,
        $(`${provider}-disconnect-prompt`),
      );
      card
        .querySelector(`.${provider === "slack" ? "slack" : "service"}-actions`)
        .after(management);
    }
    for (const provider of ["vercel", "railway", "cloud-run"]) {
      const host = node("div", "provider-credentials");
      host.dataset.credentialProvider = provider;
      $(`${provider}-connection`).append(host);
    }
    for (const button of document.querySelectorAll("[data-configure-signal]")) {
      button.addEventListener("click", async () => {
        const provider = button.dataset.configureSignal;
        const project = $(`${provider}-scope-project`).value;
        if (!locked && project) await onConfigure(provider, project, button);
      });
    }
    function setLocked(value) {
      locked = value;
      for (const row of rows.values()) row.fields.disabled = locked || row.busy;
      for (const row of clearRows.values())
        for (const button of row.node.querySelectorAll("button"))
          button.disabled = locked || row.busy;
      for (const button of document.querySelectorAll("[data-configure-signal]"))
        button.disabled =
          locked || !$(`${button.dataset.configureSignal}-scope-project`).value;
    }
    function clearControl(connection) {
      const input = [
        ...document.querySelectorAll("input[name],textarea[name]"),
      ].find((value) => value.name === connection.name);
      if (!input) return;
      let row = clearRows.get(connection.name);
      if (!row) {
        const host = node("div", "credential-clear-controls"),
          button = node("button", "small-button danger-button"),
          prompt = node("div", "approval-confirm"),
          notice = node("p", "form-message");
        button.type = "button";
        prompt.hidden = true;
        notice.hidden = true;
        notice.setAttribute("role", "status");
        const copy = node("p"),
          accept = node(
            "button",
            "small-button danger-button",
            "Clear saved value",
          ),
          keep = node("button", "small-button", "Keep credential");
        accept.type = keep.type = "button";
        prompt.append(copy, accept, keep);
        host.append(button, prompt, notice);
        (
          input.closest(".field") ||
          input.closest("fieldset") ||
          input.parentElement
        ).append(host);
        row = {
          node: host,
          button,
          prompt,
          copy,
          notice,
          busy: false,
          connection,
        };
        clearRows.set(connection.name, row);
        button.addEventListener("click", () => {
          prompt.hidden = false;
          copy.textContent = `Clear ${row.connection.label || "this saved credential"} from this server? Exported environment values and browser connections are kept. This does not revoke access at the provider.`;
        });
        keep.addEventListener("click", () => {
          prompt.hidden = true;
        });
        accept.addEventListener("click", async () => {
          if (locked || row.busy) return;
          row.busy = true;
          setLocked(locked);
          message(notice, "Clearing the saved credential…");
          try {
            await api("/api/connections/clear", { names: [connection.name] });
            prompt.hidden = true;
            await onSaved();
            message(
              notice,
              "Saved value cleared. Exported environment access or an OAuth connection may still configure this provider.",
            );
          } catch (error) {
            message(notice, error.message, true);
          } finally {
            row.busy = false;
            setLocked(locked);
          }
        });
      }
      row.connection = connection;
      row.button.textContent = `Clear saved ${connection.label || "credential"}`;
      row.button.hidden = connection.saved !== true;
      row.node.hidden =
        connection.saved !== true && row.notice.hidden && !row.busy;
    }
    function createRow(connection) {
      const details = node("details", "credential-row");
      details.dataset.secret = connection.name;
      const summary = node("summary", "credential-summary");
      const text = node("span", "credential-summary-copy");
      const title = node("strong");
      const context = node("small");
      text.append(title, context);
      const badge = node("span", "saved-state");
      summary.append(text, badge);
      const form = node("form", "credential-form");
      const fields = node("fieldset");
      fields.append(node("legend", "sr-only", "Project credential"));
      const help = node("p", "setup-help");
      const instructions = node("div", "credential-instructions");
      const label = node("label", "credential-input-label");
      const input = node(connection.format === "json" ? "textarea" : "input");
      input.id = `telemetry-${connection.name}`;
      input.name = connection.name;
      label.htmlFor = input.id;
      if (connection.format === "json") {
        input.className = "secret-json";
        input.rows = 4;
        input.dataset.secretJson = "true";
      } else input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      help.id = `help-${connection.name}`;
      input.setAttribute("aria-describedby", help.id);
      const wrap = node("div", "password-wrap");
      const reveal = node(
        "button",
        connection.format === "json" ? "small-button" : "reveal-button",
        "Show",
      );
      reveal.type = "button";
      reveal.setAttribute("aria-pressed", "false");
      reveal.addEventListener("click", () => {
        const show = reveal.getAttribute("aria-pressed") !== "true";
        if (input.tagName === "TEXTAREA")
          input.classList.toggle("revealed", show);
        else input.type = show ? "text" : "password";
        reveal.textContent = show ? "Hide" : "Show";
        reveal.setAttribute("aria-pressed", String(show));
        reveal.setAttribute(
          "aria-label",
          `${show ? "Hide" : "Show"} ${label.textContent}`,
        );
      });
      wrap.append(input, reveal);
      const save = node("button", "small-button", "Save access");
      save.type = "submit";
      const footer = node("div", "credential-footer");
      footer.append(
        node("p", "setup-help", "Blank keeps the saved value."),
        save,
      );
      const reference = node("details", "credential-reference");
      reference.append(
        node("summary", "", "Configuration reference"),
        node("code", "", connection.name),
      );
      fields.append(help, instructions, label, wrap, footer, reference);
      const status = node("div", "form-message");
      status.hidden = true;
      status.setAttribute("role", "status");
      form.append(fields, status);
      details.append(summary, form);
      const row = {
        details,
        title,
        context,
        badge,
        fields,
        help,
        instructions,
        label,
        input,
        reveal,
        save,
        status,
        busy: false,
        connection,
      };
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (locked || row.busy) return;
        const value = input.value.trim();
        if (!value) {
          message(
            status,
            "Paste a new value to save. Your current access is unchanged.",
            true,
          );
          input.focus();
          return;
        }
        row.busy = true;
        fields.disabled = true;
        save.textContent = "Saving…";
        message(status, "");
        try {
          await api("/api/connections", {
            values: { [connection.name]: value },
          });
          input.value = "";
          input.classList.remove("revealed");
          if (input.tagName === "INPUT") input.type = "password";
          reveal.textContent = "Show";
          reveal.setAttribute("aria-pressed", "false");
          message(
            status,
            row.connection.purpose === "slack-override"
              ? "Override saved. This project will use its own channel; other projects keep workspace Slack."
              : "Saved on your server. Verify connections on the project to check live access.",
          );
          await onSaved();
        } catch (error) {
          message(status, error.message, true);
        } finally {
          row.busy = false;
          fields.disabled = locked;
          save.textContent = "Save access";
        }
      });
      return row;
    }
    function render(
      connections,
      projects,
      { slackConnected = false, locked: nextLocked = locked } = {},
    ) {
      const custom = connections.filter((item) => !fixed.has(item.name));
      const names = new Set(custom.map((item) => item.name));
      for (const [name, row] of rows)
        if (!names.has(name) && !row.input.value && !row.busy) {
          row.details.remove();
          rows.delete(name);
          clearRows.delete(name);
        }
      for (const connection of custom) {
        let row = rows.get(connection.name);
        if (!row) {
          row = createRow(connection);
          rows.set(connection.name, row);
        }
        row.connection = connection;
        const notification =
          connection.purpose === "slack-override" ||
          connection.group === "notifications";
        const destination = notification
          ? $("notification-connections")
          : document.querySelector(
              `[data-credential-provider="${connection.provider}"]`,
            ) || $("telemetry-connections");
        if (row.details.parentNode !== destination)
          destination.append(row.details);
        const usages = Array.isArray(connection.usages)
          ? connection.usages
          : [];
        const context =
          [
            ...new Set(
              usages.map(
                (item) =>
                  `${item.project}${item.targetName ? ` · ${item.targetName}` : ""}`,
              ),
            ),
          ].join(" / ") ||
          connection.project ||
          "Project-specific access";
        const friendly =
          connection.label === "Environment connection"
            ? `${titles[connection.provider] || "Project"} access`
            : connection.label;
        row.title.textContent = friendly;
        row.context.textContent = context;
        row.label.textContent = notification
          ? "Incoming webhook for this project"
          : friendly;
        row.help.textContent = connection.description;
        row.badge.textContent = connection.configured
          ? "Saved"
          : notification
            ? slackConnected
              ? "Workspace default"
              : "Optional"
            : connection.optional
              ? "Optional"
              : "Set up";
        row.badge.classList.toggle("configured", connection.configured);
        row.input.placeholder = connection.configured
          ? "Saved — leave blank to keep"
          : notification
            ? "https://hooks.slack.com/services/…"
            : "Paste your credential";
        row.reveal.setAttribute(
          "aria-label",
          `${row.reveal.getAttribute("aria-pressed") === "true" ? "Hide" : "Show"} ${friendly}`,
        );
        row.instructions.replaceChildren();
        if (connection.purpose === "preview-bypass") {
          row.instructions.append(
            node(
              "p",
              "setup-help",
              "In your Vercel project, open Settings → Deployment Protection → Protection Bypass for Automation. Create a secret and paste it here so the browser can open your protected preview.",
            ),
            link(
              "Vercel preview protection guide ↗",
              "https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation",
            ),
          );
        } else if (notification) {
          row.instructions.append(
            node(
              "p",
              "setup-help",
              "Only add this if the project needs a different channel. Otherwise, leave it blank and use workspace Slack.",
            ),
          );
        } else if (connection.provider === "railway") {
          row.instructions.append(
            link(
              "Create a Railway token ↗",
              "https://railway.com/account/tokens",
            ),
            node(
              "p",
              "setup-help",
              "For an environment-scoped project token, use Railway Project settings → Tokens and select Project token in your app’s hosting settings.",
            ),
          );
        }
      }
      const overrideCount = custom.filter(
        (item) =>
          item.purpose === "slack-override" || item.group === "notifications",
      ).length;
      $("slack-overrides").hidden = !overrideCount;
      $("slack-override-count").textContent = overrideCount
        ? `(${overrideCount})`
        : "";
      $("project-access-empty").hidden = Boolean(
        $("telemetry-connections").children.length,
      );
      for (const provider of ["sentry", "datadog", "mixpanel"]) {
        const projectNames = new Set(
          custom
            .filter((item) => item.provider === provider)
            .flatMap(
              (item) =>
                item.usages?.map((usage) => usage.project) ||
                (item.project ? [item.project] : []),
            ),
        );
        $(`${provider}-scope-state`).textContent = projectNames.size
          ? `${projectNames.size} ${projectNames.size === 1 ? "project" : "projects"} configured`
          : "Not used by a project yet";
        const select = $(`${provider}-scope-project`);
        const chosen = select.value;
        if (
          [...select.options].map((item) => item.value).join("\n") !==
          projects.map((item) => item.name).join("\n")
        ) {
          select.replaceChildren(
            ...projects.map((project) => {
              const option = node("option", "", project.name);
              option.value = project.name;
              return option;
            }),
          );
          if (projects.some((item) => item.name === chosen))
            select.value = chosen;
        }
        select.hidden = !projects.length;
        $(`${provider}-connection`).querySelector(".signal-empty").hidden =
          Boolean(projects.length);
      }
      for (const connection of connections) clearControl(connection);
      setLocked(nextLocked);
    }
    return {
      render,
      setLocked,
      isBusy: () =>
        [...rows.values(), ...clearRows.values()].some((row) => row.busy),
    };
  };
})();
