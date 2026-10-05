(() => {
  "use strict";
  const REFRESH_MS = 15 * 60 * 1000;
  const version = (value) =>
    typeof value === "string" && value
      ? value.slice(0, 64)
      : "the latest version";

  function bannerView(
    status,
    { busy = false, authenticated = false, restarting = false } = {},
  ) {
    if (!status || !authenticated) return null;
    const disabled = busy || restarting;
    if (restarting)
      return {
        tone: "progress",
        title: "Your dashboard is restarting",
        text: "This tab will reconnect. Running gremlins keep working.",
        action: null,
        disabled: true,
      };
    if (status.phase === "installing")
      return {
        tone: "progress",
        title: "Getting your update ready",
        text: "You can keep using the dashboard. Your projects and running jobs stay in place.",
        action: null,
        disabled: true,
      };
    if (status.restartRequired)
      return {
        tone: "ready",
        title: `ShipGremlins ${version(status.installedVersion || status.latestVersion)} is ready`,
        text: status.canRestart
          ? "Restart the dashboard to use it. Your projects and running jobs are preserved."
          : "Restart ShipGremlins on your server to load the update. See Settings for instructions.",
        action: status.canRestart ? "restart" : null,
        label: "Restart dashboard",
        disabled,
      };
    if (status.phase === "available")
      return {
        tone: "available",
        title: `ShipGremlins ${version(status.latestVersion)} is available`,
        text: "A fresh update for your crew. Install it here whenever you’re ready.",
        action: "apply",
        label: "Update now",
        disabled,
      };
    if (status.phase === "error")
      return {
        tone: "attention",
        title: "Updates need attention",
        text: "Open update details to see what happened. Your workspace is still available.",
        action: "check",
        label: "Check again",
        disabled,
      };
    // A routine background check should not interrupt an up-to-date workspace.
    return null;
  }

  function createRefresh({ check, getStatus, canCheck }, environment = window) {
    let timer = null;
    let stopped = true;
    let pending = false;
    let lastAttempt = 0;
    const now = () => Date.now();
    const schedule = () => {
      environment.clearTimeout(timer);
      if (!stopped) timer = environment.setTimeout(tick, REFRESH_MS);
    };
    async function tick() {
      if (stopped) return;
      const status = getStatus();
      const checked = Date.parse(status?.checkedAt || "");
      const last = Math.max(
        lastAttempt,
        Number.isFinite(checked) ? checked : 0,
      );
      if (
        pending ||
        environment.document.visibilityState === "hidden" ||
        !canCheck() ||
        status?.restartRequired ||
        ["checking", "installing"].includes(status?.phase) ||
        now() - last < REFRESH_MS
      ) {
        schedule();
        return;
      }
      pending = true;
      lastAttempt = now();
      try {
        await check();
      } catch {
        /* The caller owns error presentation; avoid unhandled timer rejections. */
      } finally {
        pending = false;
        schedule();
      }
    }
    return {
      start() {
        if (!stopped) return;
        stopped = false;
        // Initial loading already checks. This timer only discovers later releases.
        lastAttempt = now();
        environment.document.addEventListener("visibilitychange", tick);
        environment.addEventListener("focus", tick);
        environment.addEventListener("online", tick);
        schedule();
      },
      stop() {
        stopped = true;
        environment.clearTimeout(timer);
        environment.document.removeEventListener("visibilitychange", tick);
        environment.removeEventListener("focus", tick);
        environment.removeEventListener("online", tick);
      },
    };
  }

  function createUpdateBanner(container, actions) {
    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    container.hidden = true;
    container.classList.add("global-update-banner");
    const icon = make("span", "update-banner-icon", "↥");
    icon.setAttribute("aria-hidden", "true");
    const copy = make("div", "update-banner-copy");
    copy.setAttribute("role", "status");
    copy.setAttribute("aria-live", "polite");
    const title = make("strong", "");
    const text = make("p", "");
    copy.append(title, text);
    const buttons = make("div", "update-banner-actions");
    const action = make("button", "button button-dark primary-button");
    action.type = "button";
    const details = make("a", "small-button", "Update details");
    details.href = "/settings#updates";
    let currentAction;
    action.addEventListener("click", () => {
      if (action.disabled || action.hidden) return;
      const callback = {
        apply: actions.onApply,
        restart: actions.onRestart,
        check: actions.onCheck,
      }[currentAction];
      callback?.();
    });
    details.addEventListener("click", (event) => {
      if (
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !actions.onDetails
      )
        return;
      event.preventDefault();
      actions.onDetails();
    });
    buttons.append(action, details);
    container.replaceChildren(icon, copy, buttons);
    let refresh;
    return {
      render(status, options) {
        const view = bannerView(status, options);
        container.hidden = !view;
        if (!view) return;
        container.dataset.tone = view.tone;
        // Keep the same controls mounted so polling never steals keyboard focus.
        if (title.textContent !== view.title) title.textContent = view.title;
        if (text.textContent !== view.text) text.textContent = view.text;
        currentAction = view.action;
        action.hidden = !view.action;
        action.disabled = view.disabled;
        action.textContent = view.label || "";
      },
      startRefresh(options) {
        refresh?.stop();
        refresh = createRefresh(options);
        refresh.start();
      },
      stopRefresh() {
        refresh?.stop();
      },
    };
  }
  createUpdateBanner.view = bannerView;
  createUpdateBanner.createRefresh = createRefresh;
  window.createUpdateBanner = createUpdateBanner;
})();
