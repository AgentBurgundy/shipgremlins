"use strict";

(() => {
  window.createDashboardAuth = ({
    bootstrapToken = "",
    sessionKey = "shipgremlins.dashboard.session",
    onAuthenticated = () => {},
    onLocked = () => {},
    hasUnsavedInputs = () => false,
    onSignedOut = () => window.location.reload(),
  } = {}) => {
    const screen = document.getElementById("dashboard-sign-in");
    const account = document.getElementById("account-access");
    const workspace = document.querySelector(".workspace");
    let session = null;
    let unlocked = false;
    let busy = false;
    let checking = null;
    let generation = 0;
    let formNotice = "";
    let suspendedDialogs = [];
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    };
    function clearBootstrap() {
      bootstrapToken = "";
      try {
        sessionStorage.removeItem(sessionKey);
      } catch {
        // A memory-only bootstrap is also removed.
      }
    }
    function clearPasswords() {
      for (const input of document.querySelectorAll(".auth-password")) {
        input.value = "";
        input.type = "password";
      }
    }
    function visibility(visible) {
      document.body.classList.toggle("auth-pending", !visible);
      if (workspace) workspace.inert = !visible;
      if (screen) screen.hidden = visible;
      if (!visible)
        for (const dialog of document.querySelectorAll("dialog[open]")) {
          if (!suspendedDialogs.includes(dialog)) suspendedDialogs.push(dialog);
          dialog.close();
        }
    }
    function expire() {
      if (!unlocked && !session?.authenticated) return;
      generation += 1;
      clearBootstrap();
      unlocked = false;
      session = {
        ...session,
        authenticated: false,
        mode: null,
        csrfToken: undefined,
      };
      formNotice =
        "Your session ended. Sign in to continue. Your unsaved work is still here.";
      clearPasswords();
      visibility(false);
      render();
      onLocked();
    }
    async function request(path, options = {}) {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password)
        throw new Error("Dashboard requests must stay on this server.");
      const headers = new Headers(options.headers);
      headers.delete("Authorization");
      headers.delete("X-CSRF-Token");
      if (session?.mode === "bootstrap" && bootstrapToken)
        headers.set("Authorization", `Bearer ${bootstrapToken}`);
      if (
        session?.mode === "cookie" &&
        !["GET", "HEAD"].includes((options.method || "GET").toUpperCase())
      )
        headers.set("X-CSRF-Token", session.csrfToken || "");
      const started = generation;
      const response = await fetch(path, {
        ...options,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401 && started === generation) {
        const error = await response
          .clone()
          .json()
          .catch(() => ({}));
        if (error.code === "auth_required") expire();
      }
      return response;
    }
    async function authJson(action, body) {
      const response = await request(`/api/auth/${action}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(
          typeof data.error === "string"
            ? data.error
            : "Sign-in could not be completed. Please try again.",
        );
        error.code = data.code;
        throw error;
      }
      return data;
    }
    async function accept(data) {
      generation += 1;
      busy = false;
      session = data;
      if (data.mode === "cookie") clearBootstrap();
      clearPasswords();
      unlocked = Boolean(data.authenticated);
      visibility(unlocked);
      formNotice = "";
      render();
      if (unlocked) {
        await onAuthenticated();
        if (unlocked) {
          const dialogs = suspendedDialogs;
          suspendedDialogs = [];
          for (const dialog of dialogs)
            if (dialog.isConnected !== false && !dialog.open)
              dialog.showModal();
        }
      }
    }
    function button(text, action, className = "") {
      const result = node("button", className, text);
      result.type = "button";
      result.addEventListener("click", action);
      return result;
    }
    function checkbox(text, id) {
      const label = node("label", "auth-check");
      const input = node("input");
      input.type = "checkbox";
      input.id = id;
      label.append(input, node("span", "", text));
      return { label, input };
    }
    function password(labelText, id, autocomplete) {
      const label = node("label", "auth-field");
      const input = node("input", "auth-password");
      input.id = id;
      input.name = id;
      input.type = "password";
      input.required = true;
      input.autocomplete = autocomplete;
      input.maxLength = 256;
      input.spellcheck = false;
      if (autocomplete === "new-password") input.minLength = 8;
      label.append(node("span", "", labelText), input);
      return { label, input };
    }
    function notice(host, text, error = false) {
      host.textContent = text;
      host.hidden = !text;
      host.className = `auth-notice${error ? " is-error" : ""}`;
    }
    function transport(host, setup) {
      if (session?.secureTransport) return null;
      const warning = node("div", "auth-transport");
      warning.append(node("strong", "", "This connection is not encrypted."));
      warning.append(
        node(
          "p",
          "",
          session?.transportMessage ||
            "Use HTTPS for encrypted access. Only use HTTP on a local network you trust.",
        ),
      );
      let permission = null;
      if (setup && session?.canAllowInsecureLan) {
        permission = checkbox(
          "Allow password sign-in on this trusted local network",
          "auth-allow-lan",
        );
        warning.append(permission.label);
      }
      host.append(warning);
      return permission;
    }
    function passwordForm(host, kind) {
      const setup = kind === "setup";
      const change = kind === "password";
      const form = node("form", "auth-form");
      const fields = node("fieldset", "auth-fields");
      const current = change
        ? password(
            "Current password",
            "auth-current-password",
            "current-password",
          )
        : null;
      const next = password(
        setup ? "Create a password" : change ? "New password" : "Password",
        "auth-password",
        setup || change ? "new-password" : "current-password",
      );
      const confirmation =
        setup || change
          ? password(
              "Confirm password",
              "auth-confirm-password",
              "new-password",
            )
          : null;
      if (current) fields.append(current.label);
      fields.append(next.label);
      if (setup || change)
        fields.append(
          node(
            "p",
            "auth-hint",
            "Use at least 8 characters. A few memorable words work well.",
          ),
        );
      if (confirmation) fields.append(confirmation.label);
      const remember = checkbox("Remember this device", "auth-remember");
      fields.append(remember.label);
      fields.append(
        node("p", "auth-hint", "Leave unchecked on a shared computer."),
      );
      const permission = transport(fields, setup);
      const allowed =
        session?.secureTransport ||
        session?.allowInsecureLan ||
        (setup && session?.canAllowInsecureLan);
      const submit = node(
        "button",
        "primary auth-submit",
        setup
          ? "Set password & open dashboard"
          : change
            ? "Update password"
            : "Sign in",
      );
      submit.type = "submit";
      const updateSubmit = () => {
        submit.disabled =
          busy || !allowed || Boolean(permission && !permission.input.checked);
      };
      permission?.input.addEventListener("change", updateSubmit);
      fields.append(submit);
      const feedback = node("p", "auth-notice");
      feedback.setAttribute("role", "status");
      notice(feedback, formNotice);
      form.append(fields, feedback);
      updateSubmit();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || submit.disabled) return;
        if (confirmation && next.input.value !== confirmation.input.value) {
          notice(
            feedback,
            "The passwords do not match. Please check them.",
            true,
          );
          confirmation.input.focus();
          return;
        }
        busy = true;
        fields.disabled = true;
        submit.textContent = change
          ? "Updating…"
          : setup
            ? "Setting up…"
            : "Signing in…";
        notice(feedback, "");
        try {
          const result = await authJson(kind, {
            password: next.input.value,
            remember: remember.input.checked,
            ...(change ? { currentPassword: current.input.value } : {}),
            ...(permission?.input.checked ? { allowInsecureLan: true } : {}),
          });
          await accept(result);
          if (change) {
            const message = account?.querySelector(
              "[data-auth-account-message]",
            );
            if (message)
              notice(
                message,
                "Password updated. Other browser sessions have been signed out.",
              );
          }
        } catch (error) {
          clearPasswords();
          notice(
            feedback,
            error instanceof TypeError
              ? "Cannot reach ShipGremlins. Check the connection and try again."
              : error.message,
            true,
          );
        } finally {
          busy = false;
          fields.disabled = false;
          submit.textContent = setup
            ? "Set password & open dashboard"
            : change
              ? "Update password"
              : "Sign in";
          updateSubmit();
        }
      });
      host.append(form);
    }
    function renderAccount() {
      if (!account) return;
      account.replaceChildren();
      account.append(
        node("span", "eyebrow muted", "YOUR DASHBOARD"),
        node("h3", "", "Account access"),
      );
      if (!session?.authenticated) return;
      if (session.mode === "bootstrap") {
        account.append(
          node(
            "p",
            "auth-description",
            "You’re using an owner launch link. Set up or sign in with a password to remember this device.",
          ),
        );
        account.append(
          button(
            session.configured
              ? "Sign in with password"
              : "Set a dashboard password",
            () => {
              unlocked = false;
              visibility(false);
              render();
              onLocked();
            },
            "primary",
          ),
        );
      } else {
        account.append(
          node(
            "p",
            "auth-description",
            session.remembered
              ? "This device is remembered. You can return to this dashboard without a launch link."
              : "You’re signed in for this browser session.",
          ),
        );
        const summary = node("div", "auth-account-summary");
        summary.append(
          node(
            "strong",
            "",
            session.remembered ? "Remembered device" : "Current session",
          ),
        );
        if (session.expiresAt) {
          const expiry = new Date(session.expiresAt);
          if (!Number.isNaN(expiry.getTime()))
            summary.append(
              node("span", "", `Expires ${expiry.toLocaleString()}`),
            );
        }
        account.append(summary);
        const formHost = node("div", "auth-password-change");
        formHost.hidden = true;
        const change = button("Change password", () => {
          formHost.hidden = !formHost.hidden;
          change.setAttribute("aria-expanded", String(!formHost.hidden));
          if (formHost.hidden) clearPasswords();
          else formHost.querySelector("input")?.focus();
        });
        change.setAttribute("aria-expanded", "false");
        passwordForm(formHost, "password");
        account.append(change, formHost);
      }
      const feedback = node("p", "auth-notice");
      feedback.dataset.authAccountMessage = "";
      feedback.setAttribute("role", "status");
      feedback.hidden = true;
      const actions = node("div", "auth-account-actions");
      const confirmation = node("div", "auth-signout-confirm");
      confirmation.hidden = true;
      const finishSignOut = async (all) => {
        if (busy) return;
        busy = true;
        for (const control of actions.querySelectorAll("button"))
          control.disabled = true;
        try {
          if (session.mode === "cookie")
            await authJson(all ? "logout-all" : "logout", {});
          clearBootstrap();
          clearPasswords();
          unlocked = false;
          session = {
            ...session,
            authenticated: false,
            mode: null,
            csrfToken: undefined,
          };
          visibility(false);
          suspendedDialogs = [];
          render();
          onLocked();
          onSignedOut();
        } catch (error) {
          notice(feedback, error.message, true);
        } finally {
          busy = false;
          for (const control of actions.querySelectorAll("button"))
            control.disabled = false;
        }
      };
      const signOut = (all) => {
        if (busy) return;
        const drafts = hasUnsavedInputs();
        if (!all && !drafts) return finishSignOut(false);
        confirmation.replaceChildren(
          node(
            "p",
            "",
            all
              ? `Sign out all browser devices, including this one?${drafts ? " Unsaved drafts on this page will be discarded." : ""} Owner launch links remain available for recovery.`
              : "Your unsaved drafts will be discarded when you sign out.",
          ),
        );
        confirmation.append(
          button(
            all ? "Sign out all devices" : "Sign out & discard drafts",
            () => finishSignOut(all),
            "danger",
          ),
          button("Keep working", () => {
            confirmation.hidden = true;
          }),
        );
        confirmation.hidden = false;
      };
      actions.append(button("Sign out", () => signOut(false)));
      if (session.mode === "cookie")
        actions.append(button("Sign out all devices", () => signOut(true)));
      account.append(actions, confirmation, feedback);
    }
    function render() {
      renderAccount();
      if (!screen) return;
      if (unlocked) {
        screen.replaceChildren();
        return;
      }
      const card = node("section", "auth-card");
      card.setAttribute("aria-labelledby", "auth-title");
      const brand = node("div", "auth-brand");
      const mark = node("img");
      mark.src = "/assets/mark.svg";
      mark.width = 34;
      mark.height = 34;
      mark.alt = "";
      brand.append(mark, node("span", "", "ShipGremlins"));
      card.append(brand);
      const setup = session?.canSetup && !session.configured;
      const title = node(
        "h1",
        "",
        setup ? "Make yourself at home." : "Your crew is waiting.",
      );
      title.id = "auth-title";
      card.append(title);
      if (!session) {
        card.append(
          node("p", "auth-description", formNotice || "Checking your session…"),
        );
        if (formNotice)
          card.append(button("Try again", () => start(), "primary"));
      } else if (setup || session.configured) {
        card.append(
          node(
            "p",
            "auth-description",
            setup
              ? "Set a password for this dashboard. Next time, just open its address and sign in."
              : "Sign in to your ShipGremlins dashboard.",
          ),
        );
        passwordForm(card, setup ? "setup" : "login");
        if (session.mode === "bootstrap")
          card.append(
            button(
              "Continue with this launch session",
              async () => {
                if (busy) return;
                await accept(session);
              },
              "auth-secondary",
            ),
          );
      } else {
        card.append(
          node(
            "p",
            "auth-description",
            "This dashboard needs its owner to set a password once. On the server, run the command below and open the dashboard link it prints.",
          ),
        );
        card.append(node("code", "auth-command", "gremlins status"));
        card.append(
          node(
            "p",
            "auth-hint",
            "Already set it up in another tab? Check again to sign in.",
          ),
        );
        card.append(button("Check again", () => start(), "primary"));
        if (session.mode === "bootstrap") {
          card.append(node("p", "auth-hint", session.transportMessage));
          card.append(
            button(
              "Continue with this launch session",
              () => accept(session),
              "auth-secondary",
            ),
          );
        }
      }
      screen.replaceChildren(
        card,
        node("p", "auth-footer", "Small gremlins. High standards."),
      );
    }
    async function start() {
      if (checking) return checking;
      checking = (async () => {
        const wasUnlocked = unlocked;
        unlocked = false;
        visibility(false);
        onLocked();
        try {
          // Prefer a valid cookie over an old tab-scoped bootstrap credential.
          session = null;
          const response = await fetch("/api/auth/session", {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok)
            throw new Error("Could not check your session. Please try again.");
          let data = await response.json();
          if (!data.authenticated && bootstrapToken) {
            session = { mode: "bootstrap" };
            try {
              data = await authJson("session");
            } catch (error) {
              if (error.code !== "auth_required") throw error;
              clearBootstrap();
            }
          }
          session = data;
          if (data.mode === "cookie") clearBootstrap();
          if (data.authenticated && (data.configured || wasUnlocked))
            await accept(data);
          else {
            unlocked = false;
            visibility(false);
            render();
            onLocked();
          }
        } catch (error) {
          unlocked = false;
          session = null;
          formNotice =
            error instanceof TypeError
              ? "Cannot reach ShipGremlins. Check the connection and try again."
              : error.message;
          visibility(false);
          render();
          onLocked();
        } finally {
          checking = null;
        }
        return unlocked;
      })();
      return checking;
    }
    window.addEventListener("pagehide", clearPasswords);
    window.addEventListener("hashchange", async () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const token = fragment.get("session");
      // Owner links can open in the same tab without a document navigation.
      // Other fragments belong to routing and provider authorization.
      if (fragment.size !== 1 || !/^[a-f0-9]{64}$/.test(token || "")) return;
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      bootstrapToken = token;
      try {
        sessionStorage.setItem(sessionKey, token);
      } catch {
        /* Memory-only owner link. */
      }
      if (checking) await checking;
      await start();
    });
    return {
      start,
      request,
      isAuthenticated: () => unlocked && Boolean(session?.authenticated),
      prepareRedirect() {
        if (session?.mode !== "bootstrap") return;
        try {
          sessionStorage.setItem(sessionKey, bootstrapToken);
        } catch {
          throw new Error(
            "Allow session storage to keep this owner launch session during authorization, or sign in with a password first.",
          );
        }
      },
    };
  };
})();
