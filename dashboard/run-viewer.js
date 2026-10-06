"use strict";

(() => {
  window.createRunViewer = (dialog, { onClose } = {}) => {
    document.body.append(dialog);
    const tabs = [...dialog.querySelectorAll("[data-run-tab]")];
    const panels = [...dialog.querySelectorAll("[data-run-panel]")];
    const body = dialog.querySelector(".run-viewer-body");
    const scrollPositions = new Map();
    let selected = "summary";
    let previousFocus = null;
    function selectTab(name, { focus = false } = {}) {
      if (!tabs.some((tab) => tab.dataset.runTab === name)) return false;
      const changed = selected !== name;
      if (changed && body) scrollPositions.set(selected, body.scrollTop);
      selected = name;
      for (const tab of tabs) {
        const active = tab.dataset.runTab === selected;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active && focus) tab.focus({ preventScroll: true });
      }
      for (const panel of panels)
        panel.hidden = panel.dataset.runPanel !== selected;
      if (changed && body) body.scrollTop = scrollPositions.get(selected) || 0;
      return true;
    }
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener("click", () => selectTab(tab.dataset.runTab));
      tab.addEventListener("keydown", (event) => {
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % tabs.length
            : event.key === "ArrowLeft"
              ? (index - 1 + tabs.length) % tabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        selectTab(tabs[next].dataset.runTab, { focus: true });
      });
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      onClose?.();
    });
    const outsideDialog = (event) => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      );
    };
    let backdropPressed = false;
    dialog.addEventListener("pointerdown", (event) => {
      backdropPressed = outsideDialog(event);
    });
    dialog.addEventListener("click", (event) => {
      if (backdropPressed && outsideDialog(event)) onClose?.();
      backdropPressed = false;
    });
    selectTab(selected);
    return {
      open({ reset = false } = {}) {
        if (reset) {
          selectTab("summary");
          scrollPositions.clear();
          if (body) body.scrollTop = 0;
          for (const panel of panels) panel.scrollTop = 0;
        }
        if (dialog.open) return;
        previousFocus = document.activeElement;
        dialog.hidden = false;
        dialog.showModal();
        tabs
          .find((tab) => tab.dataset.runTab === selected)
          ?.focus({ preventScroll: true });
      },
      close({ restoreFocus = true } = {}) {
        if (dialog.open) dialog.close();
        dialog.hidden = true;
        if (restoreFocus && previousFocus?.isConnected)
          previousFocus.focus({ preventScroll: true });
        previousFocus = null;
      },
      selectTab,
      get isOpen() {
        return dialog.open;
      },
      get selectedTab() {
        return selected;
      },
    };
  };
})();
