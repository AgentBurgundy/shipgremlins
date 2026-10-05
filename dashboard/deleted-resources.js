"use strict";
(() => {
  window.createDeletedResources = (
    root,
    { api, pages, isLocked, onRestore },
  ) => {
    const node = (tag, text, cls = "") => {
      const el = document.createElement(tag);
      el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const heading = node("div", undefined, "updates-heading"),
      title = node("div"),
      refresh = node("button", "Refresh list", "small-button"),
      list = node("div", undefined, "deleted-resource-list"),
      message = node("p", "", "form-message");
    refresh.type = "button";
    message.setAttribute("role", "status");
    message.hidden = true;
    title.append(
      node("span", "PRIVATE RECOVERY", "eyebrow muted"),
      node("h3", "Recently deleted"),
    );
    heading.append(title, refresh);
    root.append(
      heading,
      node(
        "p",
        "Restore local projects or PMs from their private backups. Automation stays paused after restore; existing history and external resources are kept.",
        "runner-guidance",
      ),
      message,
      list,
    );
    let busy = false,
      entries = [],
      loaded = false;
    async function load() {
      if (busy || isLocked()) return;
      busy = true;
      refresh.disabled = true;
      try {
        entries = (await api("/api/deleted")).recoveries || [];
        loaded = true;
        message.hidden = true;
        paint();
      } catch (error) {
        message.textContent = error.message;
        message.hidden = false;
      } finally {
        busy = false;
        refresh.disabled = isLocked();
      }
    }
    function paint() {
      list.replaceChildren();
      if (!entries.length)
        list.append(
          node("p", "No deleted projects or PMs yet.", "runner-guidance"),
        );
      for (const entry of entries) {
        const row = node("article", undefined, "deleted-resource-row"),
          copy = node("div");
        copy.append(
          node("strong", entry.name),
          node(
            "p",
            `${entry.project}${entry.area ? ` / ${entry.area}` : ""} · ${entry.kind === "pm" ? "PM" : "Project"}`,
            "runner-guidance",
          ),
          node(
            "small",
            `${new Date(entry.deletedAt).toLocaleString()} · ${entry.status}`,
          ),
        );
        row.append(copy);
        if (entry.status !== "restored") {
          const restore = node("button", "Review restore", "small-button");
          restore.type = "button";
          restore.disabled = isLocked();
          restore.addEventListener("click", () => {
            if (!isLocked())
              onRestore({
                project: entry.project,
                area: entry.area,
                recoveryId: entry.id,
                trigger: restore,
              });
          });
          row.append(restore);
        }
        list.append(row);
      }
    }
    refresh.addEventListener("click", load);
    window.addEventListener("dashboard:pagechange", () => {
      if (pages.current === "settings") load();
    });
    return {
      refresh: load,
      sync() {
        refresh.disabled = busy || isLocked();
        if (pages.current === "settings" && !loaded) load();
      },
      isBusy: () => busy,
    };
  };
})();
