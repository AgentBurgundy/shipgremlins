"use strict";
(() => {
  const names = { claude: "Claude Code", codex: "Codex" };
  window.aiConnectionState = (status) => {
    const provider = status?.ai?.provider === "codex" ? "codex" : "claude";
    return {
      provider,
      label: names[provider],
      configured: status?.ai
        ? status.ai.configured === true
        : Boolean(
            status?.connections?.some(
              (item) =>
                item.name === "CLAUDE_CODE_OAUTH_TOKEN" && item.configured,
            ),
          ),
    };
  };
  window.createAiConnections = ({ root, claudeAccess, api, onSaved }) => {
    if (!root) return null;
    const node = (tag, cls, text) => {
      const item = document.createElement(tag);
      if (cls) item.className = cls;
      if (text !== undefined) item.textContent = text;
      return item;
    };
    let locked = true,
      busy = false,
      loading = false,
      saved = null,
      login = { status: "idle" },
      timer = null,
      modelDirty = false,
      loginGeneration = 0,
      fileGeneration = 0;
    const group = node("div", "ai-provider-choices"),
      choices = new Map();
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "AI provider for new work");
    const summary = node("p", "ai-provider-summary signal-state");
    summary.setAttribute("role", "status");
    const notice = node("p", "form-message");
    notice.hidden = true;
    notice.setAttribute("role", "status");
    const announce = (text, error = false) => {
      notice.textContent = text;
      notice.hidden = !text;
      notice.setAttribute("role", error ? "alert" : "status");
      notice.classList.toggle("error", error);
    };
    for (const provider of ["claude", "codex"]) {
      const button = node("button", "ai-provider-choice"),
        state = node("span", "ai-provider-state");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", names[provider]);
      button.append(node("strong", "", names[provider]), state);
      button.addEventListener("click", () => select(provider));
      choices.set(provider, { button, state });
      group.append(button);
    }
    group.addEventListener("keydown", (event) => {
      if (
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
        busy ||
        locked
      )
        return;
      event.preventDefault();
      const provider =
        event.key === "Home"
          ? "claude"
          : event.key === "End"
            ? "codex"
            : saved?.provider === "codex"
              ? "claude"
              : "codex";
      choices.get(provider).button.focus();
      select(provider);
    });
    const codex = node("section", "codex-connection");
    codex.setAttribute("aria-label", "Codex connection");
    const actions = node("div", "button-row"),
      start = node("button", "button button-dark", "Sign in to Codex"),
      cancel = node("button", "small-button", "Cancel sign-in");
    start.type = cancel.type = "button";
    cancel.hidden = true;
    actions.append(start, cancel);
    const clear = node(
        "button",
        "small-button danger-button",
        "Clear saved Codex",
      ),
      clearPrompt = node("div", "approval-confirm"),
      clearAccept = node(
        "button",
        "small-button danger-button",
        "Clear saved value",
      ),
      clearKeep = node("button", "small-button", "Keep connected");
    clear.type = clearAccept.type = clearKeep.type = "button";
    clearPrompt.hidden = true;
    clearPrompt.setAttribute("role", "group");
    clearPrompt.setAttribute("aria-label", "Clear saved Codex confirmation");
    clearPrompt.append(
      node(
        "p",
        "",
        "Clear the saved Codex sign-in from this server? This cancels any sign-in session. Codex stays selected; current runs keep their existing access. Exported credentials are kept.",
      ),
      clearAccept,
      clearKeep,
    );
    actions.append(clear);
    const device = node("div", "codex-device"),
      deviceHelp = node(
        "p",
        "",
        "Open the sign-in page and enter this one-time code:",
      ),
      code = node("code", "codex-user-code"),
      visit = node("a", "small-button", "Continue with ChatGPT ↗"),
      expiry = node("p", "setup-help");
    device.hidden = true;
    visit.target = "_blank";
    visit.rel = "noreferrer noopener";
    device.append(deviceHelp, code, visit, expiry);
    const importBox = node("details", "codex-import"),
      importForm = node("form"),
      importFields = node("fieldset"),
      fileLabel = node("label", "field", "Choose your Codex auth.json"),
      file = node("input"),
      pasteLabel = node("label", "field", "Or paste the auth.json contents"),
      authInput = node("textarea", "secret-json"),
      reveal = node("button", "small-button", "Show"),
      importSave = node("button", "small-button", "Save private Codex access");
    importBox.append(
      node("summary", "", "Import existing Codex sign-in instead"),
    );
    file.id = "codex-auth-file";
    file.type = "file";
    file.accept = ".json,application/json";
    fileLabel.htmlFor = file.id;
    authInput.id = "codex-auth-json";
    authInput.rows = 4;
    authInput.maxLength = 65536;
    authInput.autocomplete = "off";
    authInput.spellcheck = false;
    authInput.dataset.secretJson = "true";
    pasteLabel.htmlFor = authInput.id;
    reveal.type = "button";
    reveal.setAttribute("aria-pressed", "false");
    reveal.setAttribute("aria-label", "Show Codex sign-in JSON");
    importSave.type = "submit";
    const importHelp = node(
      "p",
      "setup-help",
      "Use auth.json from your existing Codex ChatGPT sign-in (usually ~/.codex/auth.json). It is saved privately on this server and never returned to the browser. API-key auth files are not accepted.",
    );
    importHelp.id = "codex-import-help";
    authInput.setAttribute("aria-describedby", importHelp.id);
    const wrap = node("div", "password-wrap");
    wrap.append(authInput, reveal);
    importFields.append(
      node("legend", "sr-only", "Private Codex sign-in import"),
      importHelp,
      fileLabel,
      file,
      pasteLabel,
      wrap,
      importSave,
    );
    importForm.append(importFields);
    importBox.append(importForm);
    codex.append(
      node("h4", "", "Use your ChatGPT account"),
      node(
        "p",
        "setup-help",
        "Connect your existing Codex access. New work uses only the AI provider you select; ShipGremlins does not switch providers when a usage limit is reached.",
      ),
      actions,
      clearPrompt,
      device,
      importBox,
    );
    const advanced = node("details", "ai-model-settings"),
      modelForm = node("form"),
      modelFields = node("fieldset"),
      modelLabel = node("label", "field", "Model (optional)"),
      model = node("select"),
      modelHint = node("p", "setup-help ai-model-catalog"),
      modelSave = node("button", "small-button", "Save model");
    advanced.append(node("summary", "", "Choose a model"));
    model.id = "ai-model";
    modelHint.id = "ai-model-catalog";
    model.setAttribute("aria-describedby", modelHint.id);
    const modelChoice = window
      .createAiModelChoices({ api })
      .bind(model, modelHint);
    modelLabel.htmlFor = model.id;
    modelSave.type = "submit";
    modelFields.append(
      node("legend", "sr-only", "AI model override"),
      modelLabel,
      model,
      modelHint,
      node(
        "p",
        "setup-help",
        "Provider default uses the selected provider’s model choice. Existing runs keep their original provider and model.",
      ),
      modelSave,
    );
    modelForm.append(modelFields);
    advanced.append(modelForm);
    root.append(group, summary, codex, advanced, notice);
    const inProgress = () => ["starting", "pending"].includes(login.status);
    const stop = () => {
      clearTimeout(timer);
      timer = null;
    };
    function paint() {
      const provider = saved?.provider || "claude";
      for (const [id, choice] of choices) {
        const connected = saved?.providers?.find(
          (entry) => entry.id === id,
        )?.configured;
        choice.button.setAttribute("aria-checked", String(provider === id));
        choice.button.tabIndex = provider === id ? 0 : -1;
        choice.button.disabled =
          locked || busy || loading || !saved || inProgress();
        choice.state.textContent = `${provider === id ? "Selected · " : ""}${connected ? "Connected" : "Not connected"}`;
      }
      summary.textContent = saved
        ? `${saved.configured ? "Connected" : "Not connected"} · ${names[provider]} selected${saved.model ? ` · ${saved.model}` : ""}`
        : "Checking your AI provider…";
      codex.hidden = provider !== "codex";
      if (claudeAccess) claudeAccess.hidden = provider !== "claude";
      start.disabled = locked || busy || loading || inProgress();
      start.textContent = inProgress()
        ? "Waiting for sign-in…"
        : saved?.providers?.find((entry) => entry.id === "codex")?.configured
          ? "Reconnect Codex"
          : "Sign in to Codex";
      cancel.hidden = !inProgress();
      cancel.disabled = locked || busy;
      clear.hidden = !saved?.providers?.find((entry) => entry.id === "codex")
        ?.configured;
      clear.disabled =
        clearAccept.disabled =
        clearKeep.disabled =
          locked || busy || loading || inProgress();
      importFields.disabled = locked || busy || loading || inProgress();
      modelFields.disabled =
        locked || busy || loading || !saved || inProgress();
      root.setAttribute("aria-busy", String(busy || loading));
      let url = null;
      try {
        const candidate = new URL(login.verificationUrl);
        if (
          candidate.protocol === "https:" &&
          candidate.hostname === "auth.openai.com" &&
          !candidate.username &&
          !candidate.password
        )
          url = candidate.href;
      } catch {
        /* Only an official sign-in destination can be opened. */
      }
      device.hidden =
        !inProgress() ||
        !url ||
        typeof login.userCode !== "string" ||
        login.userCode.length > 64;
      code.textContent = device.hidden ? "" : login.userCode;
      visit.href = device.hidden ? "#" : url;
      expiry.textContent =
        !device.hidden && Number.isFinite(Date.parse(login.expiresAt))
          ? `Code expires ${new Date(login.expiresAt).toLocaleTimeString()}. Keep this page open while signing in.`
          : "";
    }
    async function select(provider, override) {
      if (saved?.provider === provider && override === undefined) return;
      if (
        locked ||
        busy ||
        loading ||
        inProgress() ||
        !saved ||
        (modelDirty && override === undefined)
      ) {
        if (modelDirty && override === undefined)
          announce("Save your model edit before changing providers.", true);
        return;
      }
      busy = true;
      clearPrompt.hidden = true;
      paint();
      try {
        saved = await api("/api/ai", {
          provider,
          ...(override ? { model: override } : {}),
        });
        modelChoice.set(saved.provider, saved.model || "");
        modelDirty = false;
        announce(`${names[saved.provider]} selected for new work.`);
        try {
          await onSaved?.();
        } catch {
          announce(
            `${names[saved.provider]} selected. Workspace status could not refresh; your choice was saved.`,
          );
        }
      } catch {
        announce(
          "The AI provider selection could not be confirmed. Refresh connection status before trying again.",
          true,
        );
      } finally {
        busy = false;
        paint();
      }
    }
    async function poll() {
      if (locked || document.hidden || !inProgress()) return;
      const generation = loginGeneration;
      try {
        const response = await api("/api/ai/codex/login");
        if (generation !== loginGeneration) return;
        login = response;
        if (login.status === "complete") {
          modelChoice.refresh();
          announce(
            "Codex connected. Your ChatGPT sign-in is saved privately on this server.",
          );
          try {
            await onSaved?.();
          } catch {
            announce(
              "Codex connected. Workspace status could not refresh; your sign-in was saved.",
            );
          }
          await load();
        } else if (["failed", "expired"].includes(login.status))
          announce(
            login.status === "expired"
              ? "The sign-in code expired. Start again to get a new code."
              : "Codex sign-in did not complete. Try again or import your existing auth.json.",
            true,
          );
      } catch {
        if (generation !== loginGeneration) return;
        announce(
          "Sign-in status could not refresh. Check your connection or cancel and try again.",
          true,
        );
      } finally {
        paint();
        schedule();
      }
    }
    function schedule() {
      stop();
      if (!locked && !document.hidden && inProgress())
        timer = setTimeout(poll, 2500);
    }
    async function load() {
      if (locked || loading) return;
      loading = true;
      try {
        saved = await api("/api/ai");
        if (!modelDirty) modelChoice.set(saved.provider, saved.model || "");
        if (saved.provider === "codex" && !inProgress()) {
          login = await api("/api/ai/codex/login");
          schedule();
        }
        return true;
      } catch {
        announce(
          "AI connection status is unavailable. Refresh before changing providers.",
          true,
        );
        return false;
      } finally {
        loading = false;
        paint();
      }
    }
    start.addEventListener("click", async () => {
      if (locked || busy || loading || inProgress()) return;
      loginGeneration += 1;
      busy = true;
      announce("");
      paint();
      try {
        login = await api("/api/ai/codex/login", {});
      } catch {
        login = { status: "failed" };
        announce(
          "Codex sign-in could not start. Try again or import your existing auth.json.",
          true,
        );
      } finally {
        busy = false;
        paint();
        schedule();
      }
    });
    cancel.addEventListener("click", async () => {
      if (locked || busy) return;
      busy = true;
      loginGeneration += 1;
      stop();
      paint();
      try {
        login = await api("/api/ai/codex/login", undefined, "DELETE");
        announce("Codex sign-in canceled.");
      } catch {
        announce(
          "The sign-in could not be canceled. Refresh and try again.",
          true,
        );
      } finally {
        busy = false;
        paint();
        schedule();
      }
    });
    clear.addEventListener("click", () => {
      if (!clear.disabled) {
        clearPrompt.hidden = false;
        clearAccept.focus();
      }
    });
    clearKeep.addEventListener("click", () => {
      if (!busy) {
        clearPrompt.hidden = true;
        clear.focus();
      }
    });
    clearAccept.addEventListener("click", async () => {
      if (clearPrompt.hidden || locked || busy || loading || inProgress())
        return;
      busy = true;
      paint();
      try {
        await api("/api/connections/clear", { names: ["CODEX_AUTH_JSON"] });
        modelChoice.refresh();
        loginGeneration += 1;
        login = { status: "canceled" };
        stop();
        clearPrompt.hidden = true;
        try {
          await onSaved?.();
        } catch {
          /* Reload safe connection status below. */
        }
        const refreshed = await load();
        announce(
          !refreshed
            ? "Saved Codex sign-in cleared. Connection status could not refresh; reload to check whether exported credentials remain."
            : saved?.providers?.find((entry) => entry.id === "codex")
                  ?.configured
              ? "Saved Codex sign-in cleared. Exported account credentials still configure Codex; remove them from the controller environment to disconnect fully."
              : "Saved Codex sign-in cleared. Codex stays selected; reconnect it before starting new work.",
        );
      } catch (error) {
        announce(
          error?.status === 409 && typeof error.message === "string"
            ? error.message
            : "The saved Codex sign-in could not be cleared. Refresh connection status before trying again.",
          true,
        );
      } finally {
        busy = false;
        paint();
        if (clear.hidden) start.focus();
      }
    });
    const clearPrivate = () => {
      fileGeneration += 1;
      authInput.value = "";
      file.value = "";
      authInput.classList.remove("revealed");
      reveal.textContent = "Show";
      reveal.setAttribute("aria-pressed", "false");
      reveal.setAttribute("aria-label", "Show Codex sign-in JSON");
    };
    const validate = (value) => {
      if (new TextEncoder().encode(value).length > 65536)
        throw new Error("size");
      const data = JSON.parse(value);
      if (
        data?.auth_mode !== "chatgpt" ||
        data.OPENAI_API_KEY != null ||
        !data.tokens ||
        !["access_token", "id_token", "refresh_token", "account_id"].every(
          (key) => typeof data.tokens[key] === "string" && data.tokens[key],
        )
      )
        throw new Error("format");
      return JSON.stringify({
        auth_mode: "chatgpt",
        tokens: Object.fromEntries(
          ["access_token", "id_token", "refresh_token", "account_id"].map(
            (key) => [key, data.tokens[key]],
          ),
        ),
      });
    };
    file.addEventListener("change", async () => {
      if (locked || busy) return;
      const selected = file.files?.[0];
      if (!selected) return;
      const generation = ++fileGeneration;
      try {
        if (selected.size > 65536) throw new Error("size");
        const value = await selected.text();
        if (generation !== fileGeneration) return;
        authInput.value = validate(value);
        announce("Private sign-in file ready. Save it below to connect Codex.");
      } catch {
        clearPrivate();
        announce(
          "Choose a valid Codex ChatGPT auth.json file, up to 64 KiB. Its contents have not been saved.",
          true,
        );
      }
    });
    reveal.addEventListener("click", () => {
      const show = reveal.getAttribute("aria-pressed") !== "true";
      authInput.classList.toggle("revealed", show);
      reveal.textContent = show ? "Hide" : "Show";
      reveal.setAttribute("aria-pressed", String(show));
      reveal.setAttribute(
        "aria-label",
        `${show ? "Hide" : "Show"} Codex sign-in JSON`,
      );
    });
    importForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (locked || busy || loading || inProgress()) return;
      let value;
      try {
        value = validate(authInput.value);
      } catch {
        announce(
          "Paste a valid Codex ChatGPT auth.json file, up to 64 KiB. No API key is required.",
          true,
        );
        return;
      }
      busy = true;
      paint();
      try {
        await api("/api/connections", { values: { CODEX_AUTH_JSON: value } });
        modelChoice.refresh();
        clearPrivate();
        announce("Codex sign-in saved privately on this server.");
        try {
          await onSaved?.();
        } catch {
          announce(
            "Codex sign-in saved. Workspace status could not refresh; reload to check connection status.",
          );
        }
        await load();
      } catch {
        announce(
          "Codex access could not be saved. Check the sign-in file and try again.",
          true,
        );
      } finally {
        value = "";
        busy = false;
        paint();
      }
    });
    model.addEventListener("change", () => {
      modelDirty = model.value !== (saved?.model || "");
    });
    modelForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!modelChoice.allowed(model.value)) {
        announce("Choose an available model or Provider default.", true);
        return;
      }
      return select(saved?.provider, model.value.trim());
    });
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => {
      stop();
      clearPrivate();
    });
    paint();
    return {
      render(status) {
        if (status?.ai) saved = status.ai;
        if (!modelDirty && saved && !locked)
          modelChoice.set(saved.provider, saved.model || "");
        paint();
      },
      setLocked(value) {
        const unlocked = locked && !value;
        locked = value;
        paint();
        if (unlocked) load();
        schedule();
      },
      refresh() {
        if (!locked) modelChoice.refresh();
        return load();
      },
      isBusy: () => busy,
      isDirty: () => Boolean(authInput.value || modelDirty),
    };
  };
})();
