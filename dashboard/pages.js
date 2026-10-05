"use strict";

(() => {
  const labels = Object.freeze({
    overview: "Overview",
    connections: "Connections",
    projects: "Projects",
    runners: "Your gremlins",
    activity: "Activity",
    settings: "Settings",
  });
  const routes = new Set(Object.keys(labels));
  const protectedFragments = ["session", "slack", "linear", "vercel"];

  /** Initialize after app.js has captured its session and OAuth return fragments. */
  window.createDashboardPages = ({ initialPage } = {}) => {
    if (window.dashboardPages) return window.dashboardPages;
    const panels = [...document.querySelectorAll("[data-page]")];
    let current = "overview";

    function pageFromPath(path) {
      const name = path.replace(/^\//, "").replace(/\/$/, "");
      return routes.has(name) ? name : path === "/" ? "overview" : null;
    }

    function resolve(destination) {
      let url;
      try {
        url = new URL(destination, window.location.href);
      } catch {
        return null;
      }
      if (url.origin !== window.location.origin || url.username || url.password)
        return null;
      let page = pageFromPath(url.pathname);
      if (!page) return null;
      let target = null;
      if (url.hash) {
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (protectedFragments.some((name) => fragment.has(name))) return null;
        let id;
        try {
          id = decodeURIComponent(url.hash.slice(1));
        } catch {
          return null;
        }
        target = document.getElementById(id);
        const owner = target?.closest("[data-page]")?.dataset.page;
        if (routes.has(owner)) page = owner;
        else if (routes.has(id)) page = id;
        else if (id !== "main") return null;
      }
      const anchor =
        target && target.id !== page && target.id !== "main"
          ? `#${encodeURIComponent(target.id)}`
          : "";
      return { page, target, path: `/${page}${anchor}` };
    }

    function show(route, { focus = false, scroll = false } = {}) {
      current = route.page;
      for (const panel of panels) panel.hidden = panel.dataset.page !== current;
      document.body.dataset.page = current;
      document.title = `${labels[current]} · ShipGremlins`;
      for (const label of document.querySelectorAll("[data-page-title]"))
        label.textContent = labels[current];
      for (const link of document.querySelectorAll(".navigation a")) {
        const destination = resolve(link.href);
        if (destination?.page === current)
          link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      window.dispatchEvent(
        new CustomEvent("dashboard:pagechange", {
          detail: { page: current, path: route.path },
        }),
      );
      if (focus || scroll)
        window.requestAnimationFrame(() => {
          // A later navigation may have won before this frame runs.
          if (current !== route.page) return;
          const active = panels.find((panel) => panel.dataset.page === current);
          const target =
            route.target ||
            active?.querySelector("h1, h2") ||
            active ||
            document.getElementById("main");
          if (focus && target) {
            if (!target.hasAttribute("tabindex"))
              target.setAttribute("tabindex", "-1");
            target.focus({ preventScroll: true });
          }
          if (scroll) {
            if (route.target) route.target.scrollIntoView({ block: "start" });
            else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
          }
        });
    }

    function navigate(
      destination,
      { replace = false, focus = true, scroll = true } = {},
    ) {
      const route = resolve(destination);
      if (!route) return false;
      const next = route.path;
      const existing =
        window.location.pathname +
        window.location.search +
        window.location.hash;
      if (next !== existing)
        history[replace ? "replaceState" : "pushState"](
          { page: route.page },
          "",
          next,
        );
      show(route, { focus, scroll });
      return true;
    }

    function onClick(event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target.closest?.("a[href]");
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const route = resolve(link.href);
      if (!route) return;
      event.preventDefault();
      navigate(link.href);
    }
    function onPopState() {
      const route = resolve(window.location.href);
      if (route) show(route, { focus: true, scroll: true });
    }
    function onHashChange() {
      const route = resolve(window.location.href);
      if (route) navigate(window.location.href, { replace: true });
    }
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);

    const api = {
      navigate,
      get current() {
        return current;
      },
      destroy() {
        document.removeEventListener("click", onClick);
        window.removeEventListener("popstate", onPopState);
        window.removeEventListener("hashchange", onHashChange);
        if (window.dashboardPages === api) delete window.dashboardPages;
      },
    };
    window.dashboardPages = api;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (protectedFragments.some((name) => fragment.has(name))) {
      // Never consume an authentication fragment before its owner has handled it.
      show({
        page: pageFromPath(window.location.pathname) || "overview",
        path: window.location.pathname,
        target: null,
      });
    } else {
      const initial = routes.has(initialPage)
        ? `/${initialPage}`
        : window.location.href;
      if (
        !navigate(initial, {
          replace: true,
          focus: false,
          scroll: Boolean(window.location.hash),
        })
      )
        navigate("/overview", { replace: true, focus: false, scroll: false });
    }
    return api;
  };
})();
