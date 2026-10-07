const DIALOGS = 'dialog, [role="dialog"], [data-motion-reveal]';
const BLOCKED = '[hidden], [inert], [aria-hidden="true"]';
const EDITABLE = 'input, textarea, select, [contenteditable="true"]';
const MAX_KEYS = 500;

/** Motion belongs to deliberate navigation and real state changes, never polling. */
export function createDashboardMotion({ window, document, animate }) {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const active = new Map();
  let seenNodes = new WeakSet();
  let revealed = new WeakSet();
  const seenKeys = new Set();
  const states = new Map();
  const frames = new Set();
  let lastRoute = null;
  let destroyed = false;

  function visible(node) {
    if (!node?.isConnected || node.closest(BLOCKED)) return false;
    if (node.tagName === "DIALOG" && !node.open) return false;
    if (!node.getClientRects().length) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function editing(node) {
    const focus = document.activeElement;
    return Boolean(focus?.matches?.(EDITABLE) && node.contains(focus));
  }

  function stop(node) {
    const entry = active.get(node);
    if (!entry) return;
    active.delete(node);
    entry.control.cancel();
    entry.restore();
  }

  function stopAll() {
    for (const frame of frames) window.cancelAnimationFrame(frame);
    frames.clear();
    for (const node of active.keys()) stop(node);
  }

  function remember(collection, key, value) {
    if (collection.size >= MAX_KEYS && !collection.has(key))
      collection.delete(collection.keys().next().value);
    if (collection instanceof Map) collection.set(key, value);
    else collection.add(key);
  }

  function play(node, kind = "card", delay = 0) {
    if (
      destroyed ||
      preference.matches ||
      document.visibilityState === "hidden" ||
      !visible(node) ||
      (kind !== "dialog" && editing(node)) ||
      typeof node.animate !== "function"
    )
      return false;
    stop(node);
    const style = window.getComputedStyle(node);
    const opacity = Number.parseFloat(style.opacity);
    if (!Number.isFinite(opacity) || opacity <= 0) return false;
    const transform = style.transform || "none";
    // Page containers may own positioned children. Fade them without creating a
    // temporary transform containing block; small cards/dialogs can rise gently.
    const moves = kind === "card" || kind === "dialog";
    const target = { opacity: String(opacity) };
    const keyframes = { opacity: [opacity * 0.65, opacity] };
    if (moves) {
      target.transform = transform;
      keyframes.transform = [
        `${transform === "none" ? "" : `${transform} `}translateY(${kind === "dialog" ? 8 : 5}px)`,
        transform,
      ];
    }
    const original = Object.fromEntries(
      Object.keys(target).map((name) => [
        name,
        [
          node.style.getPropertyValue(name),
          node.style.getPropertyPriority(name),
        ],
      ]),
    );
    const restore = () => {
      for (const [name, [value, priority]] of Object.entries(original)) {
        // A renderer can change inline styles during the animation. Restore only
        // our committed final values; do not overwrite newer application state.
        if (node.style.getPropertyValue(name) !== target[name]) continue;
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
    };
    let control;
    try {
      control = animate(node, keyframes, {
        duration: kind === "state" ? 0.14 : kind === "dialog" ? 0.2 : 0.18,
        delay: Math.max(0, Math.min(Number(delay) || 0, 0.12)),
        ease: [0.2, 0.65, 0.3, 1],
      });
    } catch {
      // Animation is progressive enhancement. Content and controls remain usable.
      restore();
      return false;
    }
    const entry = { control, restore };
    active.set(node, entry);
    Promise.resolve(control.finished).then(
      () => {
        if (active.get(node) !== entry) return;
        active.delete(node);
        restore();
      },
      () => {
        if (active.get(node) !== entry) return;
        active.delete(node);
        restore();
      },
    );
    return true;
  }

  function enter(node, { key, kind = "card", delay = 0 } = {}) {
    if (!visible(node) || seenNodes.has(node) || (key && seenKeys.has(key)))
      return false;
    seenNodes.add(node);
    // A very large list degrades to static content. Evicting entrance keys would
    // make a polling renderer repeatedly animate old cards after reaching the cap.
    if (key && seenKeys.size >= MAX_KEYS) return false;
    if (key) remember(seenKeys, key);
    return play(node, kind, delay);
  }

  function reveal(node, { kind = "dialog" } = {}) {
    if (!visible(node) || revealed.has(node)) return false;
    revealed.add(node);
    return play(node, kind);
  }

  function hide(node) {
    if (!node) return;
    revealed.delete(node);
    stop(node);
  }

  function transition(node, { key, value } = {}) {
    if (!key || destroyed) return false;
    const previous = states.get(key);
    const hadValue = states.has(key);
    remember(states, key, value);
    if (!hadValue || previous === value) return false;
    return play(node, "state");
  }

  function nextFrame(callback) {
    const frame = window.requestAnimationFrame(() => {
      frames.delete(frame);
      if (!destroyed) callback();
    });
    frames.add(frame);
  }

  function routeChanged(event) {
    const detail = event.detail || {};
    // Run dialogs preserve the underlying route. Opening/closing one must not
    // animate the entire page or replay its cards.
    const url = new URL(
      detail.path || window.location.href,
      window.location.href,
    );
    url.searchParams.delete("run");
    const key = url.pathname + url.search + url.hash;
    if (key === lastRoute) return;
    lastRoute = key;
    stopAll();
    seenNodes = new WeakSet();
    seenKeys.clear();
    states.clear();
    nextFrame(() => {
      let index = 0;
      for (const panel of document.querySelectorAll("[data-page]")) {
        if (!visible(panel)) continue;
        enter(panel, { kind: "page", delay: Math.min(index++ * 0.025, 0.1) });
      }
    });
  }

  function reducedMotionChanged() {
    if (preference.matches) stopAll();
  }

  function visibilityChanged() {
    if (document.visibilityState === "hidden") stopAll();
  }

  // Attribute-only observation: input edits, activity logs and polled node
  // replacements never trigger entrance animations. Dialog content is untouched.
  const observer = new window.MutationObserver((records) => {
    const dialogs = new Set();
    for (const { target } of records) {
      if (target.matches?.(DIALOGS)) dialogs.add(target);
      for (const dialog of target.querySelectorAll?.(DIALOGS) || [])
        dialogs.add(dialog);
    }
    for (const dialog of dialogs) {
      if (visible(dialog)) reveal(dialog);
      else hide(dialog);
    }
    for (const node of active.keys()) if (!visible(node)) stop(node);
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "hidden", "aria-hidden", "inert"],
  });
  window.addEventListener("dashboard:pagechange", routeChanged);
  window.addEventListener("pagehide", stopAll);
  document.addEventListener("visibilitychange", visibilityChanged);
  preference.addEventListener("change", reducedMotionChanged);

  const api = {
    enter,
    reveal,
    hide,
    transition,
    get reducedMotion() {
      return preference.matches;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopAll();
      observer.disconnect();
      seenKeys.clear();
      states.clear();
      revealed = new WeakSet();
      window.removeEventListener("dashboard:pagechange", routeChanged);
      window.removeEventListener("pagehide", stopAll);
      document.removeEventListener("visibilitychange", visibilityChanged);
      preference.removeEventListener("change", reducedMotionChanged);
      if (window.dashboardMotion === api) delete window.dashboardMotion;
    },
  };
  return api;
}
