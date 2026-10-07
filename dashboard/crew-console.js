"use strict";
(() => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const active = (job) => ["running", "queued"].includes(job.status);
  const stamp = (job) =>
    Date.parse(
      job.updatedAt || job.finishedAt || job.startedAt || job.createdAt,
    ) || 0;
  const recent = (jobs) =>
    [...jobs].sort(
      (a, b) => stamp(b) - stamp(a) || (b.runId || 0) - (a.runId || 0),
    );
  const scoped = (project, jobs) =>
    list(jobs).filter(
      (job) =>
        job.project === project.name &&
        (job.projectInstanceId ?? null) === (project.instanceId ?? null),
    );
  const projectPath = (project, area) =>
    `/projects/${encodeURIComponent(project.name)}${area ? `?pm=${encodeURIComponent(area.key)}` : ""}`;
  const statusLabel = (job) =>
    job.status === "queued" && job.failure?.category === "environment-wait"
      ? "Waiting for environment"
      : {
          running: "Working",
          queued: "Queued",
          succeeded: "Run finished",
          failed: "Stopped",
          canceled: "Canceled",
        }[job.status] || job.status;
  const jobName = (job, projects) => {
    const project = projects.find(
      (item) =>
        item.name === job.project &&
        (item.instanceId ?? null) === (job.projectInstanceId ?? null),
    );
    const area = list(project?.areas).find((item) => item.key === job.area);
    return job.grumblin
      ? job.grumblin.name
      : job.type === "pm"
        ? area?.name || job.area || "PM Gremlin"
        : job.type === "developer"
          ? "Coding Gremlin"
          : "Browser verification";
  };
  const crew = (projects, jobs) =>
    projects.flatMap((project) =>
      list(project.areas).map((area) => {
        const work = recent(
          scoped(project, jobs).filter(
            (job) => job.type === "pm" && job.area === area.key,
          ),
        );
        const job =
          work.find((item) => item.status === "running") ||
          work.find(active) ||
          work[0];
        const readiness = list(project.readiness?.areas).find(
          (item) => item.key === area.key,
        );
        return {
          project,
          area,
          job,
          href: projectPath(project, area),
          state:
            job && active(job)
              ? statusLabel(job)
              : readiness?.canRun === false
                ? "Needs setup"
                : area.enabled && area.schedule
                  ? "Scheduled"
                  : "On demand",
        };
      }),
    );
  const routes = [
    ["Overview", "/overview", "Workspace"],
    ["Projects", "/projects", "Workspace"],
    ["Your gremlins", "/runners", "Crew"],
    ["Activity", "/activity", "Runs & evidence"],
    ["Review inbox", "/inbox", "Decisions"],
    ["Connections", "/connections", "Tools & accounts"],
    ["Usage", "/usage", "Tokens & costs"],
    ["Settings", "/settings", "Workspace"],
  ];
  function destinations(projects, jobs) {
    return [
      ...routes.map(([name, href, context]) => ({ name, href, context })),
      ...projects.map((project) => ({
        name: project.name,
        href: projectPath(project),
        context: "Project",
      })),
      ...crew(projects, jobs).map((item) => ({
        name: item.area.name || item.area.key,
        href: item.href,
        context: item.project.name,
      })),
    ];
  }
  window.dashboardCrewModel = {
    recent,
    scoped,
    crew,
    statusLabel,
    jobName,
    destinations,
  };
  window.createCrewConsole = ({ pages }) => {
    const $ = (id) => document.getElementById(id);
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const link = (text, href, className = "") => {
      const node = Object.assign(el("a", className, text), { href });
      node.dataset.crewFocus = href;
      return node;
    };
    const focusedLink = (root) =>
      root?.contains(document.activeElement)
        ? document.activeElement?.dataset.crewFocus
        : null;
    const restoreLink = (root, key) => {
      if (key)
        [...root.querySelectorAll("[data-crew-focus]")]
          .find((node) => node.dataset.crewFocus === key)
          ?.focus({ preventScroll: true });
    };
    const chip = (text, state) => el("span", `crew-state ${state || ""}`, text);
    const avatar = (type, area) =>
      Object.assign(el("img", "crew-avatar"), {
        src:
          type === "developer"
            ? "/assets/gremlin-coding.webp"
            : window.gremlinIdentity?.(area)?.image ||
              "/assets/gremlin-investigating.webp",
        alt: "",
        width: 40,
        height: 44,
        loading: "lazy",
      });
    const date = (value) =>
      value && Number.isFinite(Date.parse(value))
        ? new Date(value).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "Time unavailable";
    let projects = [],
      jobs = [],
      runners = null,
      loaded = false,
      error = false;
    let rosterQuery = "",
      rosterProject = "",
      lastSignature = "",
      searchTrigger = null;
    const roster = el("section", "crew-roster");
    roster.id = "crew-roster";
    roster.setAttribute("aria-label", "Your product managers");
    $("runners")?.append(roster);
    const toolbar = el("div", "crew-toolbar");
    const filterLabel = el("label", "crew-filter", "Find a gremlin");
    const filter = Object.assign(el("input"), {
      type: "search",
      placeholder: "Search names or areas…",
    });
    filterLabel.append(filter);
    const projectLabel = el("label", "crew-filter", "Project");
    const projectFilter = el("select");
    projectLabel.append(projectFilter);
    toolbar.append(
      filterLabel,
      projectLabel,
      link(
        "Adopt a gremlin",
        "/projects#pm-create-drawer",
        "button button-dark",
      ),
    );
    const rosterList = el("div", "crew-directory");
    roster.append(toolbar, rosterList);
    filter.addEventListener("input", () => {
      rosterQuery = filter.value;
      paintRoster();
    });
    projectFilter.addEventListener("change", () => {
      rosterProject = projectFilter.value;
      paintRoster();
    });

    function breadcrumbs() {
      const nav = $("workspace-breadcrumbs");
      if (!nav) return;
      const parts = [];
      if (pages.current === "project") {
        parts.push(["Projects", "/projects"]);
        const project = projects.find((item) => item.name === pages.project);
        const area = list(project?.areas).find((item) => item.key === pages.pm);
        parts.push([pages.project, projectPath({ name: pages.project })]);
        if (pages.pm) parts.push([area?.name || pages.pm, ""]);
      } else
        parts.push([
          routes.find((entry) => entry[1] === `/${pages.current}`)?.[0] ||
            "Overview",
          "",
        ]);
      const signature = JSON.stringify(parts);
      if (nav.dataset.signature === signature) return;
      nav.dataset.signature = signature;
      nav.replaceChildren(
        ...parts.flatMap(([text, href], index) => {
          const current = index === parts.length - 1;
          const node = current
            ? el("span", "breadcrumb-current", text)
            : link(text, href);
          node.title = text;
          if (current) node.setAttribute("aria-current", "page");
          if (!index) return [node];
          const separator = el("span", "breadcrumb-separator", "/");
          separator.setAttribute("aria-hidden", "true");
          return [separator, node];
        }),
      );
    }
    function empty(root, title, description, action) {
      const box = el("div", "crew-empty");
      box.append(el("strong", "", title), el("p", "", description));
      if (action) box.append(action);
      root.append(box);
    }
    function runRow(job, compact = false) {
      const row = el("article", `crew-run${compact ? " is-compact" : ""}`);
      const copy = el("div", "crew-run-copy");
      copy.append(
        link(
          jobName(job, projects),
          `/activity?run=${encodeURIComponent(job.id)}`,
          "crew-run-name",
        ),
      );
      copy.append(
        el(
          "p",
          "crew-run-context",
          [
            job.project,
            job.ticket ||
              (job.pmMode === "discovery"
                ? "Discovery"
                : job.type === "pm"
                  ? "Patrol"
                  : "Implementation"),
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      if (!compact)
        copy.append(
          el(
            "p",
            "crew-run-message",
            job.message || "Waiting for the next recorded update.",
          ),
        );
      const status = el("div", "crew-run-status");
      status.append(
        chip(statusLabel(job), `state-${job.status}`),
        el("time", "", date(job.startedAt || job.createdAt)),
      );
      const project = projects.find((item) => scoped(item, [job]).length);
      const area = project?.areas?.find((item) => item.key === job.area);
      row.append(avatar(job.type, area), copy, status);
      return row;
    }
    function paintRoster() {
      const focused = focusedLink(rosterList);
      rosterList.replaceChildren();
      const entries = crew(projects, jobs).filter(
        (item) =>
          (!rosterProject || item.project.name === rosterProject) &&
          `${item.area.name} ${item.area.key} ${item.project.name}`
            .toLowerCase()
            .includes(rosterQuery.trim().toLowerCase()),
      );
      for (const item of entries) {
        const card = el("article", "crew-person");
        const heading = el("div", "crew-person-heading");
        const identity = el("div", "crew-person-identity");
        const name = link(
          item.area.name || item.area.key,
          item.href,
          "crew-person-name",
        );
        name.dataset.crewKey = `${item.project.name}:${item.area.key}`;
        identity.append(
          name,
          link(
            item.project.name,
            projectPath(item.project),
            "crew-person-project",
          ),
        );
        heading.append(
          avatar("pm", item.area),
          identity,
          chip(
            item.state,
            item.job && active(item.job) ? `state-${item.job.status}` : "",
          ),
        );
        card.append(
          heading,
          el(
            "p",
            "crew-person-purpose",
            item.area.mandate ||
              item.area.charter?.goal ||
              `Looks after ${item.area.key}.`,
          ),
        );
        const latest = el("div", "crew-person-latest");
        if (item.job) {
          latest.append(
            el("span", "", active(item.job) ? "Current run" : "Last run"),
            link(
              `${statusLabel(item.job)} · ${date(item.job.startedAt || item.job.createdAt)}`,
              `/activity?run=${encodeURIComponent(item.job.id)}`,
            ),
          );
          latest.append(
            el(
              "p",
              "",
              item.job.message || "Open the run for its evidence and output.",
            ),
          );
        } else
          latest.append(
            el("span", "", "No runs yet"),
            el("p", "", "Open this gremlin to start its first investigation."),
          );
        card.append(latest);
        rosterList.append(card);
        const motionKey = `crew:${item.project.name}:${item.project.instanceId || "legacy"}:${item.area.key}`;
        for (const anchor of card.querySelectorAll("a"))
          anchor.dataset.crewFocus = `${motionKey}:${anchor.getAttribute("href")}`;
        window.dashboardMotion?.enter(card, { key: motionKey, kind: "card" });
        window.dashboardMotion?.transition(
          heading.querySelector(".crew-state"),
          { key: `${motionKey}:state`, value: item.state },
        );
      }
      if (!entries.length)
        empty(
          rosterList,
          projects.length ? "No matching gremlins" : "Your crew starts here",
          projects.length
            ? "Try another name or project, or adopt a gremlin with a new area to look after."
            : "Connect a project, then adopt a PM to investigate and improve it.",
          link("Open projects", "/projects", "small-button"),
        );
      restoreLink(rosterList, focused);
    }
    function enhanceProjects() {
      for (const card of document.querySelectorAll(
        "#project-list [data-project-name]",
      )) {
        const project = projects.find(
          (item) => item.name === card.dataset.projectName,
        );
        if (!project) continue;
        let strip = card.querySelector(".project-crew-strip");
        if (!strip) {
          strip = el("div", "project-crew-strip");
          card.append(strip);
        }
        const entries = crew([project], jobs);
        const signature = JSON.stringify(
          entries.map((item) => [item.area.key, item.area.name, item.state]),
        );
        if (strip.dataset.signature === signature) continue;
        const focused = focusedLink(strip);
        strip.dataset.signature = signature;
        strip.replaceChildren(
          ...entries.map((item) => {
            const a = link(
              item.area.name || item.area.key,
              item.href,
              "project-crew-link",
            );
            a.dataset.projectControl = `pm:${item.area.key}`;
            a.append(
              chip(
                item.state,
                item.job && active(item.job) ? `state-${item.job.status}` : "",
              ),
            );
            return a;
          }),
        );
        restoreLink(strip, focused);
      }
    }
    function paint() {
      if (
        rosterProject &&
        !projects.some((project) => project.name === rosterProject)
      )
        rosterProject = "";
      document.body.classList.toggle("has-projects", projects.length > 0);
      breadcrumbs();
      enhanceProjects();
      const fresh = $("crew-freshness");
      if (fresh) {
        fresh.textContent = error
          ? "Updates paused · refresh to reconnect"
          : runners
            ? "Auto-updating"
            : "Loading activity…";
        fresh.classList.toggle("is-stale", error);
      }
      const signature = JSON.stringify([
        projects,
        jobs,
        Boolean(runners),
        loaded,
      ]);
      if (lastSignature === signature) return;
      lastSignature = signature;
      const live = $("crew-working-list"),
        past = $("crew-recent-list");
      if (live && past) {
        const focused = focusedLink(live.parentElement.parentElement);
        live.replaceChildren();
        past.replaceChildren();
        const currentJobs = jobs.filter((job) =>
          projects.some((project) => scoped(project, [job]).length),
        );
        const working = recent(currentJobs.filter(active)).sort(
          (a, b) =>
            Number(b.status === "running") - Number(a.status === "running"),
        );
        const completed = recent(
          currentJobs.filter((job) => !active(job)),
        ).slice(0, 4);
        $("crew-working-count").textContent = String(working.length);
        for (const job of working.slice(0, 6)) live.append(runRow(job));
        for (const job of completed) past.append(runRow(job, true));
        if (!working.length)
          empty(
            live,
            runners ? "The crew is between runs" : "Loading current work",
            runners
              ? "Start an investigation or let your next scheduled patrol pick things up."
              : "Checking runner status and the job queue.",
            link("Open your crew", "/runners", "small-button"),
          );
        if (working.length > 6)
          live.append(
            link(
              `See all ${working.length} active runs →`,
              "/activity",
              "crew-more",
            ),
          );
        if (!completed.length)
          empty(
            past,
            "A home for every outcome",
            "Completed runs, blockers, and evidence will appear here.",
          );
        restoreLink(live.parentElement.parentElement, focused);
      }
      const options = [
        Object.assign(el("option", "", "All projects"), { value: "" }),
        ...projects.map((project) =>
          Object.assign(el("option", "", project.name), {
            value: project.name,
          }),
        ),
      ];
      projectFilter.replaceChildren(...options);
      projectFilter.value = rosterProject;
      paintRoster();
    }

    const search = el("dialog", "quick-jump");
    search.id = "quick-jump";
    search.setAttribute("aria-labelledby", "quick-jump-title");
    const header = el("div", "quick-jump-header");
    const title = el("h2", "", "Jump to…");
    title.id = "quick-jump-title";
    const close = Object.assign(el("button", "small-button", "Close"), {
      type: "button",
    });
    header.append(title, close);
    const input = Object.assign(el("input", "quick-jump-input"), {
      type: "search",
      placeholder: "Find projects, gremlins, or pages…",
    });
    input.setAttribute("aria-label", "Search projects, gremlins, and pages");
    const results = el("div", "quick-jump-results");
    results.setAttribute("aria-live", "polite");
    search.append(
      header,
      input,
      results,
      el("p", "quick-jump-hint", "↑ ↓ to move · Enter to open · Esc to close"),
    );
    document.body.append(search);
    function searchResults() {
      const query = input.value.trim().toLowerCase();
      const matches = destinations(projects, jobs)
        .filter((item) =>
          `${item.name} ${item.context}`.toLowerCase().includes(query),
        )
        .slice(0, 18);
      results.replaceChildren(
        ...matches.map((item) => {
          const a = link("", item.href, "quick-jump-result");
          a.append(el("strong", "", item.name), el("span", "", item.context));
          a.addEventListener("click", () => search.close("navigate"));
          return a;
        }),
      );
      if (!matches.length)
        results.append(
          el("p", "crew-empty", "No matches. Try a project or gremlin name."),
        );
    }
    function openSearch() {
      if (
        document.querySelector("dialog[open]") ||
        document.body.classList.contains("auth-pending") ||
        document.body.classList.contains("auth-locked")
      )
        return;
      searchTrigger = document.activeElement;
      input.value = "";
      searchResults();
      search.showModal();
      input.focus();
    }
    close.addEventListener("click", () => search.close());
    search.addEventListener("click", (event) => {
      if (event.target === search) {
        const rect = search.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          search.close();
      }
    });
    search.addEventListener("close", () => {
      if (search.returnValue !== "navigate" && searchTrigger?.isConnected)
        searchTrigger.focus({ preventScroll: true });
      search.returnValue = "";
    });
    search.addEventListener("keydown", (event) => {
      const links = [...results.querySelectorAll("a")];
      const index = links.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp"].includes(event.key) && links.length) {
        event.preventDefault();
        const next =
          event.key === "ArrowDown"
            ? Math.min(index + 1, links.length - 1)
            : Math.max(index - 1, 0);
        links[next].focus();
      } else if (
        event.key === "Enter" &&
        event.target === input &&
        links.length
      ) {
        event.preventDefault();
        links[0].click();
      }
    });
    input.addEventListener("input", searchResults);
    $("quick-jump-trigger")?.addEventListener("click", openSearch);
    document.addEventListener("keydown", (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !event.altKey
      ) {
        event.preventDefault();
        openSearch();
      }
    });
    window.addEventListener("dashboard:pagechange", breadcrumbs);
    breadcrumbs();
    return {
      update(data) {
        projects = list(data.status?.projects);
        jobs = list(data.jobs);
        runners = data.runners;
        loaded = Boolean(data.status);
        paint();
      },
      connectionFailed() {
        error = true;
        paint();
      },
      connectionRestored() {
        error = false;
        paint();
      },
      enhanceProjects,
    };
  };
})();
