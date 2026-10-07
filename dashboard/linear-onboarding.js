"use strict";
(() => {
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const el = (tag, className = "", text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const projectIdentity = (p) =>
    JSON.stringify([
      p?.name,
      p?.instanceId ?? null,
      p?.repo,
      p?.provider || "github",
      p?.serverUrl ?? null,
      p?.linear?.connectionId || "default",
    ]);
  const accountIdentity = (profile) =>
    JSON.stringify([
      profile?.id || "default",
      profile?.workspace?.id ?? null,
      profile?.account?.id ?? null,
    ]);
  window.createLinearOnboarding = ({
    api,
    getStatus,
    isLocked = () => false,
    onConnect,
    onSaved = async () => {},
    onReady = () => {},
  }) => {
    const dialog = el("dialog", "linear-onboarding"),
      header = el("header", "linear-onboarding-header"),
      heading = el("div"),
      title = el("h2", "", "A home for your crew’s work."),
      closeButton = el("button", "small-button", "Close ×"),
      body = el("div", "linear-onboarding-body");
    title.id = "linear-onboarding-title";
    dialog.setAttribute("aria-labelledby", title.id);
    heading.append(el("p", "eyebrow", "LINEAR SETUP"), title);
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close Linear setup");
    header.append(heading, closeButton);
    dialog.append(header, body);
    document.body.append(dialog);
    let state = null,
      generation = 0,
      trigger = null,
      loading = false,
      oauthPending = false;
    const writes = new Set();
    const project = (name) =>
      getStatus()?.projects?.find((p) => p.name === name);
    const profileFor = (p) =>
      getStatus()?.serviceConnections?.find(
        (c) =>
          c.provider === "linear" &&
          c.id === (p?.linear?.connectionId || "default"),
      );
    const connected = (p) => {
      const profile = profileFor(p);
      return Boolean(profile?.connected && !profile.needsReconnect);
    };
    const locked = () =>
      isLocked() || loading || oauthPending || writes.size > 0;
    function close() {
      ++generation;
      loading = false;
      oauthPending = false;
      if (dialog.open) dialog.close();
      if (trigger?.isConnected !== false)
        trigger?.focus?.({ preventScroll: true });
    }
    closeButton.addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      }
    });
    function current(s, expectedGeneration = generation) {
      if (state !== s || generation !== expectedGeneration || !dialog.open)
        return false;
      const p = project(s.name);
      if (
        !p ||
        projectIdentity(p) !== s.identity ||
        accountIdentity(profileFor(p)) !== s.account
      ) {
        s.stage = "stale";
        s.error =
          "This project or its Linear account changed. Reload setup before continuing.";
        return false;
      }
      return true;
    }
    function action(label, fn, primary = false, disabled = false) {
      const button = el(
        "button",
        primary ? "button button-dark" : "small-button",
        label,
      );
      button.type = "button";
      button.disabled = locked() || disabled;
      button.addEventListener("click", fn);
      return button;
    }
    function render() {
      if (!state || !dialog.open) return;
      const s = state,
        p = project(s.name),
        profile = profileFor(p);
      body.replaceChildren();
      body.append(
        el("p", "linear-onboarding-project", `${s.name} · ${s.repo}`),
      );
      if (s.error) {
        const error = el("p", "linear-onboarding-error", s.error);
        error.setAttribute("role", "alert");
        body.append(error);
      }
      if (s.stage === "stale") {
        body.append(action("Reload project setup", () => open(s.name)));
        return;
      }
      if (loading) {
        const pending = el(
          "p",
          "linear-onboarding-progress",
          "Finding your Linear team…",
        );
        pending.setAttribute("role", "status");
        body.append(pending);
        return;
      }
      if (s.stage === "ready") {
        body.append(
          el("div", "linear-onboarding-mark", "✓"),
          el("h3", "", "Your crew has a place to work."),
          el(
            "p",
            "",
            "Linear is ready. Your gremlins can create tickets, keep their labels organized and work through approved improvements.",
          ),
        );
        body.append(
          action(
            "Continue to test environment",
            () => {
              if (!current(s)) {
                render();
                return;
              }
              close();
              onReady(s.name);
            },
            true,
          ),
        );
        return;
      }
      if (s.stage === "refresh") {
        body.append(
          el("h3", "", "Setup was saved."),
          el(
            "p",
            "",
            "Refresh the project to confirm its latest Linear mappings.",
          ),
          action(
            "Refresh project",
            async () => {
              if (locked() || !current(s)) {
                render();
                return;
              }
              const stamp = generation;
              loading = true;
              s.error = "";
              render();
              try {
                await onSaved(s.name);
                if (!current(s, stamp)) return;
                s.stage = s.provisioned ? "ready" : "configure";
              } catch (error) {
                if (current(s, stamp))
                  s.error =
                    error.message ||
                    "The project could not refresh. Try again.";
              } finally {
                if (state === s && generation === stamp) {
                  loading = false;
                  render();
                }
              }
            },
            true,
          ),
        );
        return;
      }
      if (!connected(p)) {
        body.append(
          el(
            "h3",
            "",
            profile?.needsReconnect
              ? "Reconnect your Linear workspace."
              : "Where should your gremlins keep their work?",
          ),
          el(
            "p",
            "",
            "Connect Linear once. We’ll give each PM a project for its tickets and create the labels the crew needs.",
          ),
        );
        if (profile?.label)
          body.append(
            el("p", "linear-onboarding-account", `Account · ${profile.label}`),
          );
        body.append(
          action(
            oauthPending
              ? "Opening Linear…"
              : profile?.needsReconnect
                ? "Reconnect Linear"
                : "Connect Linear",
            async () => {
              if (locked() || !current(s)) {
                render();
                return;
              }
              const stamp = generation;
              oauthPending = true;
              s.error = "";
              render();
              try {
                if (!onConnect)
                  throw new Error(
                    "Open Connections to connect Linear, then return here.",
                  );
                await onConnect(project(s.name), s.connectionId);
                if (!current(s, stamp)) return;
              } catch (error) {
                if (current(s, stamp))
                  s.error =
                    error.message ||
                    "Linear authorization could not start. Try again.";
              } finally {
                if (state === s && generation === stamp) {
                  oauthPending = false;
                  render();
                }
              }
            },
            true,
          ),
        );
        return;
      }
      if (s.stage === "error") {
        body.append(action("Try again", () => load(s), true));
        return;
      }
      const team = s.teams.find((t) => t.id === s.teamId),
        creating = s.teams.length === 0 && !s.teamId;
      body.append(
        el(
          "h3",
          "",
          s.teams.length > 1 && !s.configuredTeam
            ? "Which team should your crew join?"
            : creating
              ? "Create a team for this app?"
              : "Give your PMs their own projects.",
        ),
      );
      body.append(
        el(
          "p",
          "",
          creating
            ? `No teams are available in this workspace. We’ll create a team for ${s.name}, then set up the PM projects and labels.`
            : "We’ll keep existing mappings and create only the missing PM projects and labels.",
        ),
      );
      if (s.teams.length > 1 && !s.configuredTeam) {
        const label = el(
            "label",
            "linear-onboarding-team-label",
            "Linear team",
          ),
          select = el("select", "linear-onboarding-team");
        label.htmlFor = "linear-onboarding-team";
        select.id = label.htmlFor;
        const placeholder = el("option", "", "Choose a team");
        placeholder.value = "";
        select.append(placeholder);
        for (const item of s.teams) {
          const option = el(
            "option",
            "",
            item.name + (item.key ? ` · ${item.key}` : ""),
          );
          option.value = item.id;
          select.append(option);
        }
        select.value = s.teamId;
        select.disabled = locked();
        select.addEventListener("change", () => {
          if (!current(s)) {
            render();
            return;
          }
          s.teamId = select.value;
          s.error = "";
          render();
          body.querySelector("select")?.focus();
        });
        body.append(label, select);
      } else if (!creating)
        body.append(
          el(
            "div",
            "linear-onboarding-team-card",
            team?.name || s.teamName || "Your configured Linear team",
          ),
        );
      body.append(
        el(
          "p",
          "linear-onboarding-account",
          `Using ${profile?.workspace?.name || profile?.label || "your saved Linear account"}.`,
        ),
      );
      const actions = el("div", "linear-onboarding-actions");
      actions.append(
        action(
          writes.size
            ? "Setting up Linear…"
            : creating
              ? "Create team & set up Linear"
              : "Set up Linear",
          () => setup(s),
          true,
          !creating && !s.teamId,
        ),
      );
      body.append(actions);
    }
    async function load(s) {
      if (locked() || !current(s)) {
        render();
        return;
      }
      const stamp = generation;
      loading = true;
      s.error = "";
      render();
      try {
        const p = project(s.name);
        if (!connected(p)) {
          s.stage = "connect";
          return;
        }
        if (uuid.test(p.linear?.teamId || "")) {
          s.teamId = p.linear.teamId;
          s.teamName = p.linear.teamName || "Your configured Linear team";
          s.configuredTeam = true;
          s.teams = [{ id: s.teamId, name: s.teamName }];
          s.stage = "configure";
          return;
        }
        const result = await api(
          `/api/linear/resources?connection=${encodeURIComponent(s.connectionId)}`,
        );
        if (!current(s, stamp)) return;
        if (!Array.isArray(result.teams))
          throw new Error(
            "Linear did not return its teams. Try again before creating anything.",
          );
        s.teams = result.teams.filter(
          (t) => uuid.test(t?.id || "") && typeof t.name === "string",
        );
        if (s.teams.length !== result.teams.length)
          throw new Error(
            "Linear returned incomplete team details. Refresh before continuing.",
          );
        if (!s.teams.some((t) => t.id === s.teamId))
          s.teamId = s.teams.length === 1 ? s.teams[0].id : "";
        s.stage = "configure";
      } catch (error) {
        if (current(s, stamp)) {
          s.stage = "error";
          s.error = error.message || "Linear teams could not be loaded.";
        }
      } finally {
        if (state === s && generation === stamp) {
          loading = false;
          render();
        }
      }
    }
    async function setup(s) {
      if (locked() || !current(s) || !connected(project(s.name))) {
        render();
        return;
      }
      if (s.teams.length && !s.teams.some((t) => t.id === s.teamId)) {
        s.error = "Choose a team before setting up Linear.";
        render();
        return;
      }
      const stamp = generation,
        write = Symbol();
      writes.add(write);
      s.error = "";
      render();
      try {
        const result = await api(
          `/api/projects/${encodeURIComponent(s.name)}/linear`,
          {
            projectInstanceId: s.instanceId,
            repository: s.repo,
            ...(s.teamId ? { teamId: s.teamId } : {}),
          },
          "POST",
          90000,
        );
        if (!current(s, stamp)) return;
        s.provisioned = result.linear?.status === "ready";
        s.stage = "refresh";
        try {
          await onSaved(s.name);
        } catch (error) {
          if (current(s, stamp))
            s.error = `Linear responded, but project status could not refresh. ${error.message || "Try again."}`;
          return;
        }
        if (!current(s, stamp)) return;
        if (s.provisioned) {
          s.stage = "ready";
          return;
        }
        s.stage =
          result.linear?.status === "needs-connection"
            ? "connect"
            : "configure";
        s.error =
          result.linear?.message ||
          "Linear setup is incomplete. Retry to finish the missing resources.";
        // Provisioning may have created a team before a later step failed.
        // Adopt that saved mapping instead of offering another new team.
        const saved = project(s.name)?.linear;
        if (uuid.test(saved?.teamId || "")) {
          s.teamId = saved.teamId;
          s.teamName = saved.teamName || "Your configured Linear team";
          s.teams = [{ id: s.teamId, name: s.teamName }];
          s.configuredTeam = true;
        }
      } catch (error) {
        if (current(s, stamp))
          s.error =
            error.message ||
            "Linear setup did not finish. Existing mappings were kept; retry safely.";
      } finally {
        writes.delete(write);
        if (state === s && generation === stamp) render();
        else if (state && dialog.open && !writes.size) await load(state);
      }
    }
    async function open(name, opener) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || "")) return;
      const p = project(name);
      if (!p) return;
      ++generation;
      loading = false;
      oauthPending = false;
      trigger = opener || document.activeElement;
      state = {
        name,
        repo: p.repo,
        instanceId: p.instanceId ?? null,
        identity: projectIdentity(p),
        account: accountIdentity(profileFor(p)),
        connectionId: p.linear?.connectionId || "default",
        teams: [],
        teamId: "",
        teamName: "",
        stage: "configure",
        error: "",
        configuredTeam: false,
      };
      if (!dialog.open) dialog.showModal();
      render();
      closeButton.focus();
      await load(state);
    }
    return {
      open,
      close,
      isBusy: () => loading || writes.size > 0,
      refresh: () => (state && dialog.open ? load(state) : Promise.resolve()),
      resume: (name) => open(name),
    };
  };
})();
