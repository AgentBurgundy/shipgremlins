"use strict";

(() => {
  const categoryIds = [
    "crew-connections",
    "source-control",
    "hosting-connections",
    "signals-connections",
    "project-access",
  ];
  const focusSelector =
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  window.createDashboardShell = () => {
    if (window.dashboardShell) return window.dashboardShell;
    const cleanup = [];
    const listen = (target, event, handler) => {
      target.addEventListener(event, handler);
      cleanup.push(() => target.removeEventListener(event, handler));
    };
    const toggle = document.getElementById("nav-toggle");
    const navigation = document.getElementById("workspace-navigation");
    const backdrop = document.getElementById("nav-backdrop");
    const mobile = window.matchMedia("(max-width: 760px)");
    let open = false;

    function visibleFocusable(element) {
      return (
        !element.hidden &&
        !element.disabled &&
        !element.closest("[hidden], [inert]") &&
        element.getClientRects().length > 0
      );
    }
    function navControls() {
      return [toggle, ...navigation.querySelectorAll(focusSelector)].filter(
        visibleFocusable,
      );
    }
    function updateDrawer() {
      if (!toggle || !navigation || !backdrop) return;
      const expanded = mobile.matches && open;
      if (expanded) document.body.dataset.navigationOpen = "true";
      else delete document.body.dataset.navigationOpen;
      toggle.hidden = !mobile.matches;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute(
        "aria-label",
        expanded ? "Close navigation" : "Open navigation",
      );
      toggle.setAttribute("aria-controls", navigation.id);
      backdrop.hidden = !expanded;
      navigation.inert = mobile.matches && !expanded;
      if (mobile.matches && !expanded)
        navigation.setAttribute("aria-hidden", "true");
      else navigation.removeAttribute("aria-hidden");
    }
    function closeNavigation(restoreFocus = false) {
      const wasOpen = open;
      open = false;
      updateDrawer();
      if (restoreFocus && wasOpen && mobile.matches) toggle?.focus();
    }
    if (toggle && navigation && backdrop) {
      backdrop.setAttribute("tabindex", "-1");
      listen(toggle, "click", () => {
        if (!mobile.matches) return;
        open = !open;
        updateDrawer();
        if (open)
          navControls()
            .find((element) => element !== toggle)
            ?.focus();
      });
      listen(backdrop, "click", () => closeNavigation(true));
      listen(document, "click", (event) => {
        if (!open || toggle.contains(event.target)) return;
        if (!navigation.contains(event.target)) closeNavigation();
        else if (event.target.closest?.("a[href]")) closeNavigation();
      });
      listen(document, "keydown", (event) => {
        if (!open || !mobile.matches) return;
        if (event.key === "Escape") {
          event.preventDefault();
          closeNavigation(true);
        } else if (event.key === "Tab") {
          const controls = navControls();
          if (!controls.length) return;
          const at = controls.indexOf(document.activeElement);
          const next =
            at < 0
              ? event.shiftKey
                ? controls.length - 1
                : 0
              : (at + (event.shiftKey ? -1 : 1) + controls.length) %
                controls.length;
          event.preventDefault();
          controls[next].focus();
        }
      });
      listen(mobile, "change", () => {
        const toggleFocused = document.activeElement === toggle;
        closeNavigation();
        if (!mobile.matches && toggleFocused)
          [...navigation.querySelectorAll(focusSelector)]
            .find(visibleFocusable)
            ?.focus();
      });
      updateDrawer();
    }

    const categories = document.querySelector(".connection-categories");
    const connections = document.getElementById("connections");
    const groups = categoryIds.map((id) => document.getElementById(id));
    const tabs = categoryIds.map((id) =>
      categories?.querySelector(`a[href="#${id}"]`),
    );
    let selectedCategory = categoryIds[0];
    const tabsReady = Boolean(
      categories && connections && groups.every(Boolean) && tabs.every(Boolean),
    );

    function selectCategory(id) {
      if (!tabsReady || !categoryIds.includes(id)) return;
      selectedCategory = id;
      groups.forEach((group, index) => {
        const selected = group.id === id;
        group.hidden = !selected;
        tabs[index].setAttribute("aria-selected", String(selected));
        tabs[index].setAttribute("tabindex", selected ? "0" : "-1");
      });
    }
    function categoryForHash() {
      let id;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return null;
      }
      const target = id && document.getElementById(id);
      return target
        ? groups.find(
            (group) => group && (group === target || group.contains(target)),
          )?.id
        : null;
    }
    function revealAnchor() {
      let id;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      let target = id && document.getElementById(id);
      while (target) {
        if (target.tagName === "DETAILS") target.open = true;
        target = target.parentElement;
      }
    }
    function activateTab(index) {
      const group = groups[index];
      if (!group) return;
      selectCategory(group.id);
      window.dashboardPages?.navigate(`/connections#${group.id}`, {
        focus: false,
        scroll: false,
      });
      tabs[index].focus();
    }
    if (tabsReady) {
      categories.setAttribute("role", "tablist");
      categories.setAttribute("aria-orientation", "horizontal");
      groups.forEach((group, index) => {
        const tab = tabs[index];
        tab.id ||= `connection-tab-${group.id}`;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", group.id);
        group.setAttribute("role", "tabpanel");
        group.setAttribute("aria-labelledby", tab.id);
        group.setAttribute("tabindex", "0");
        listen(tab, "click", (event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          activateTab(index);
        });
        listen(tab, "keydown", (event) => {
          let next;
          if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
          else if (event.key === "ArrowLeft")
            next = (index - 1 + tabs.length) % tabs.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = tabs.length - 1;
          else if (event.key === " " || event.key === "Enter") next = index;
          else return;
          event.preventDefault();
          activateTab(next);
        });
      });
      connections.classList.add("connections-tabs-ready");
      selectCategory(categoryForHash() || selectedCategory);
    }
    listen(window, "dashboard:pagechange", (event) => {
      closeNavigation();
      revealAnchor();
      if (tabsReady && event.detail?.page === "connections")
        selectCategory(categoryForHash() || selectedCategory);
    });
    revealAnchor();

    const api = {
      closeNavigation,
      get category() {
        return selectedCategory;
      },
      destroy() {
        closeNavigation();
        for (const dispose of cleanup.splice(0)) dispose();
        if (navigation) {
          navigation.inert = false;
          navigation.removeAttribute("aria-hidden");
        }
        if (window.dashboardShell === api) delete window.dashboardShell;
      },
    };
    window.dashboardShell = api;
    return api;
  };
  if (document.readyState === "loading")
    document.addEventListener(
      "DOMContentLoaded",
      () => window.createDashboardShell(),
      { once: true },
    );
  else window.createDashboardShell();
})();
