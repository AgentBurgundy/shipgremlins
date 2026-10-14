"use strict";
(() => {
  const identity = (project) =>
    project?.name && (project.preferenceId || project.instanceId)
      ? `${project.name}:${project.preferenceId || project.instanceId}`
      : null;
  window.compareWorkspaceProjects = (preferences, a, b) => {
    const priority = (entry) =>
      entry.work?.state === "blocked"
        ? 0
        : entry.work?.state === "review"
          ? 1
          : 2;
    return (
      priority(a) - priority(b) ||
      preferences.compare(
        a.status || { name: a.project.project },
        b.status || { name: b.project.project },
      )
    );
  };
  window.createProjectPreferences = (storage) => {
    let key = "",
      current = [],
      favorites = [],
      order = [];
    const save = () => {
      try {
        storage?.setItem(key, JSON.stringify({ version: 1, favorites, order }));
      } catch {
        /* Memory-only preferences remain usable. */
      }
    };
    const valid = (values) =>
      Array.isArray(values)
        ? [
            ...new Set(
              values.filter(
                (value) => typeof value === "string" && value.length < 300,
              ),
            ),
          ].slice(0, 2000)
        : [];
    return {
      sync(status) {
        const scope = `${location.origin}|${status.controllerId || status.configDirectory || "default"}`;
        const next = `shipgremlins.projects.v1.${encodeURIComponent(scope)}`;
        if (key !== next) {
          key = next;
          favorites = [];
          order = [];
          try {
            const saved = JSON.parse(storage?.getItem(key) || "null");
            if (saved?.version === 1) {
              favorites = valid(saved.favorites);
              order = valid(saved.order);
            }
          } catch {
            /* Corrupt preferences do not block work. */
          }
        }
        current = (status.projects || []).map(identity).filter(Boolean);
        favorites = favorites.filter((id) => current.includes(id));
        order = [
          ...order.filter((id) => current.includes(id)),
          ...current.filter((id) => !order.includes(id)),
        ];
        save();
      },
      isFavorite: (project) => favorites.includes(identity(project)),
      canPersist: (project) => Boolean(identity(project)),
      toggle(project) {
        const id = identity(project);
        if (!id || !current.includes(id)) return false;
        favorites = favorites.includes(id)
          ? favorites.filter((value) => value !== id)
          : [...favorites, id];
        save();
        return true;
      },
      move(project, direction) {
        const peers = order.filter(
          (id) =>
            favorites.includes(id) === favorites.includes(identity(project)),
        );
        const at = peers.indexOf(identity(project)),
          next = at + direction;
        if (
          at < 0 ||
          next < 0 ||
          next >= peers.length ||
          ![-1, 1].includes(direction)
        )
          return false;
        const first = order.indexOf(peers[at]),
          second = order.indexOf(peers[next]);
        [order[first], order[second]] = [order[second], order[first]];
        save();
        return true;
      },
      compare(a, b) {
        const favorite =
          Number(favorites.includes(identity(b))) -
          Number(favorites.includes(identity(a)));
        return (
          favorite ||
          (order.indexOf(identity(a)) < 0 ? 2000 : order.indexOf(identity(a))) -
            (order.indexOf(identity(b)) < 0
              ? 2000
              : order.indexOf(identity(b))) ||
          a.name.localeCompare(b.name)
        );
      },
      position: (project) =>
        order
          .filter(
            (id) =>
              favorites.includes(id) === favorites.includes(identity(project)),
          )
          .indexOf(identity(project)),
      sizeFor: (project) =>
        order.filter(
          (id) =>
            favorites.includes(id) === favorites.includes(identity(project)),
        ).length,
      get size() {
        return order.length;
      },
    };
  };
  const source = (path) => {
    const clean = path.split("?")[0];
    if (clean === "/api/status") return ["workspace", "Workspace"];
    if (clean === "/api/runners") return ["runners", "Runners"];
    if (clean === "/api/jobs") return ["history", "Run history"];
    if (clean === "/api/operations") return ["reviews", "Review queue"];
    const project = /^\/api\/projects\/([^/]+)\/operations$/.exec(clean);
    if (project)
      return [
        `project:${project[1]}`,
        `Project · ${decodeURIComponent(project[1])}`,
      ];
    const run = /^\/api\/jobs\/([^/]+)\/(activity|logs|artifacts)$/.exec(clean);
    if (run)
      return [`run:${run[2]}`, `Run ${run[2] === "logs" ? "output" : run[2]}`];
    return null;
  };
  window.createDashboardFreshness = ({
    changed = () => {},
    now = () => Date.now(),
  } = {}) => {
    const entries = new Map();
    return {
      start(path) {
        const found = source(path);
        if (!found) return;
        const [key, label] = found;
        entries.set(key, { ...entries.get(key), key, label, pending: true });
        changed();
      },
      success(path, value) {
        const found = source(path);
        if (!found) return;
        const [key, label] = found;
        entries.set(key, {
          key,
          label,
          lastSuccess: now(),
          value,
          pending: false,
          degraded: false,
        });
        changed();
      },
      fail(path) {
        const found = source(path);
        if (!found) return;
        const [key, label] = found;
        entries.set(key, {
          ...entries.get(key),
          key,
          label,
          pending: false,
          degraded: true,
        });
        changed();
      },
      cancel(path) {
        const found = source(path);
        if (found && entries.has(found[0]))
          entries.get(found[0]).pending = false;
        changed();
      },
      resetRun() {
        for (const key of entries.keys())
          if (key.startsWith("run:")) entries.delete(key);
        changed();
      },
      snapshot: () =>
        [...entries.values()].map(({ value: _value, ...entry }) => ({
          ...entry,
          stale: Boolean(
            entry.lastSuccess && now() - entry.lastSuccess > 90000,
          ),
        })),
      lastGood: (path) => {
        const found = source(path);
        return found && entries.get(found[0])?.value;
      },
    };
  };
  let storage;
  try {
    storage = window.localStorage;
  } catch {
    /* Optional storage. */
  }
  window.dashboardProjectPreferences = window.createProjectPreferences(storage);
  const host = document.getElementById("main");
  if (!host) return;
  const panel = document.createElement("details");
  panel.className = "dashboard-freshness";
  const summary = document.createElement("summary"),
    list = document.createElement("ul"),
    refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "small-button";
  refresh.textContent = "Refresh data";
  refresh.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("dashboard:refresh")),
  );
  summary.setAttribute("aria-label", "Data freshness details");
  panel.append(summary, list, refresh);
  host.prepend(panel);
  const paint = () => {
    const entries = window.dashboardFreshness.snapshot();
    panel.hidden = !entries.length;
    const failed = entries.filter(
      (entry) => entry.degraded || entry.stale,
    ).length;
    const pending = entries.filter((entry) => entry.pending).length;
    summary.textContent = failed
      ? `${failed} data ${failed === 1 ? "source needs" : "sources need"} attention · showing last available data`
      : pending
        ? `Data status · refreshing ${pending} ${pending === 1 ? "source" : "sources"}`
        : "Data status · all sources current";
    panel.classList.toggle("degraded", failed > 0);
    list.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement("li"),
          label = document.createElement("strong"),
          detail = document.createElement("span");
        label.textContent = entry.label;
        detail.textContent = `${entry.degraded ? "Refresh failed" : entry.pending ? "Refreshing" : entry.stale ? "Refresh due" : "Current"} · ${entry.lastSuccess ? `Last success ${new Date(entry.lastSuccess).toLocaleString()}` : "No successful refresh yet"}`;
        item.append(label, detail);
        return item;
      }),
    );
  };
  window.dashboardFreshness = window.createDashboardFreshness({
    changed: paint,
  });
  paint();
  const timer = setInterval(paint, 30000);
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
})();
