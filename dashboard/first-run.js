"use strict";

(() => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const projectPath = (project) =>
    `/projects/${encodeURIComponent(project.name)}`;
  const belongs = (job, project) =>
    job.project === project.name &&
    (job.projectInstanceId ?? null) === (project.instanceId ?? null);
  const actualWork = (job) => ["pm", "developer"].includes(job.type);
  const recentFirst = (a, b) =>
    (Number(b.runId) || Date.parse(b.createdAt) || 0) -
    (Number(a.runId) || Date.parse(a.createdAt) || 0);

  // Read actual, identity-scoped work before interpreting saved configuration.
  // Enabled autonomy means permission to work; it is never proof of a live run.
  window.projectWorkState = (project, jobs = [], operations = {}) => {
    const href = projectPath(project);
    const work = list(jobs)
      .filter((job) => belongs(job, project) && actualWork(job))
      .sort(recentFirst);
    const active =
      work.find((job) => job.status === "running") ||
      work.find((job) => job.status === "queued");
    if (active)
      return {
        state: active.status,
        label: active.status === "running" ? "Working" : "Queued",
        detail:
          active.status === "running"
            ? `${active.type === "developer" ? "Coding" : "Investigation"} run ${active.runId || ""} is in progress.`.trim()
            : "Work is waiting for a runner to pick it up.",
        action: "Follow run",
        href: `/activity?run=${encodeURIComponent(active.id)}`,
        job: active,
      };
    const autonomy = operations.autonomy || project.autonomy;
    const latest = work[0];
    if (["running", "queued"].includes(autonomy?.state))
      return {
        state: autonomy.state,
        label: autonomy.state === "running" ? "Working" : "Queued",
        detail: autonomy.message,
        action: "Follow project",
        href,
      };
    const blocked = list(autonomy?.blockers)[0];
    if (autonomy?.state === "blocked")
      return {
        state: "blocked",
        label: "Needs attention",
        detail:
          (typeof blocked === "string" ? blocked : blocked?.message) ||
          autonomy?.message ||
          "Autonomous work is blocked. Review the project setup.",
        action: "Resolve blocker",
        href:
          {
            source: "/connections#source-control",
            ai: "/connections#model-connections",
            worker: "/runners#workers",
            linear: "/connections#linear-connection",
          }[blocked?.action] || `${href}?tab=environment`,
      };
    if (project.foundation?.needed)
      return {
        state: "setup",
        label:
          project.foundation.stage === "review-code"
            ? "Review foundation"
            : "Foundation needed",
        detail:
          "Finish the first working app before recurring product work begins.",
        action: "Open foundation",
        href: `${href}?tab=environment`,
      };
    if (operations.inbox?.length)
      return {
        state: "review",
        label: `${operations.inbox.length} to review`,
        detail: "Your crew has decisions or evidence ready for you.",
        action: "Review decisions",
        href: `${href}?tab=review`,
      };
    if (autonomy?.enabled === true)
      return {
        state: "autonomous",
        label: "Autonomy on",
        detail:
          autonomy.message ||
          "Automatic work is enabled. No run is currently in flight.",
        action: "Open project",
        href,
      };
    if (latest?.status === "failed" && autonomy?.enabled !== true)
      return {
        state: "blocked",
        label: "Run stopped",
        detail:
          "The latest run failed. Open its evidence to see what needs repair.",
        action: "Review last run",
        href: `/activity?run=${encodeURIComponent(latest.id)}`,
      };
    if (!Array.isArray(project.areas) || !project.readiness)
      return {
        state: "unknown",
        label: "Status unavailable",
        detail: "Project configuration or readiness could not be read.",
        action: "Review settings",
        href: "/settings#advanced-settings",
      };
    if (!project.areas.length)
      return {
        state: "setup",
        label: "Crew needed",
        detail:
          "Review the repository setup and give your first gremlin a purpose. Repository discovery needs no ticket tracker.",
        action: "Meet your first gremlin",
        href,
      };
    const blocker = list(project.readiness.blockers)[0];
    if (blocker && project.readiness.canRun === false)
      return {
        state: "setup",
        label: "Setup needed",
        detail: blocker.message || "Finish project setup before starting work.",
        action: "Finish setup",
        href: `${href}?tab=environment`,
      };
    if (project.areas.some((area) => area.enabled === true))
      return {
        state: "scheduled",
        label: "Patrols scheduled",
        detail:
          "Enabled PMs follow their saved schedules. No run is currently in flight.",
        action: "Open project",
        href,
      };
    return {
      state: "paused",
      label: "Automatic work off",
      detail: "Start work manually or enable autonomy in this project.",
      action: "Open project",
      href,
    };
  };

  // Server summaries come from identity-scoped knowledge and mission journals.
  // A generic successful PM run is not evidence that the first Discovery saved.
  window.projectFirstStep = (project, jobs = []) => {
    if (project.foundation?.needed) return "foundation";
    if (
      project.firstReviewableChange?.url ||
      project.onboardingProgress?.hasMissions ||
      project.onboardingProgress?.investigated ||
      list(jobs).some(
        (job) => belongs(job, project) && job.type === "developer",
      )
    )
      return "mission";
    return project.areas?.length ? "discovery" : "welcome";
  };

  // Read-only guidance. Opening Overview never creates a resource or starts work.
  window.firstRunNextStep = (status, runners) => {
    if (!status) return null;
    const projects = list(status.projects),
      jobs = list(runners?.jobs);
    const established = projects.find(
      (project) =>
        !project.foundation?.needed && project.firstReviewableChange?.url,
    );
    const recentWork = jobs
      .filter(
        (job) =>
          actualWork(job) && projects.some((project) => belongs(job, project)),
      )
      .sort(recentFirst);
    const currentWork =
      recentWork.find((job) => job.status === "running") ||
      recentWork.find((job) => job.status === "queued") ||
      recentWork[0];
    const project =
      projects.find(
        (project) => currentWork && belongs(currentWork, project),
      ) ||
      projects.find((project) => project.areas?.length) ||
      projects[0];
    const sourceStep = list(project?.readiness?.steps).find(
      (item) => item.id === "source_connection",
    );
    const sourceConnections = list(status.sourceConnections);
    const sourceReady = sourceStep
      ? sourceStep.ready === true
      : sourceConnections.some(
          (item) => item.connected && !item.needsReconnect,
        ) ||
        list(status.connections).some((item) => {
          const provider =
            item.name === "GITHUB_TOKEN"
              ? "github"
              : item.name === "GITLAB_TOKEN"
                ? "gitlab"
                : null;
          return (
            provider &&
            item.configured &&
            !sourceConnections.some(
              (source) =>
                source.provider === provider &&
                source.method === "oauth" &&
                (!source.connected || source.needsReconnect),
            )
          );
        });
    const aiReady = list(status.connections).some(
      (item) => item.name === "CLAUDE_CODE_OAUTH_TOKEN" && item.configured,
    );
    const base = {
      active: true,
      noProject: !project,
      project: project?.name,
      completed: [
        sourceReady,
        aiReady,
        Boolean(project),
        Boolean(project?.areas?.length),
        false,
      ],
    };
    const step = (index, title, description, label, href, extra = {}) => ({
      ...base,
      index,
      title,
      description,
      label,
      href,
      ...extra,
    });
    const work =
      project &&
      jobs
        .filter((job) => belongs(job, project) && actualWork(job))
        .sort(recentFirst);
    const active =
      work?.find((job) => job.status === "running") ||
      work?.find((job) => job.status === "queued");
    if (active)
      return step(
        4,
        active.status === "queued"
          ? "Your gremlin has a mission."
          : "Your gremlin is on the job.",
        active.status === "queued"
          ? "The mission is queued. Follow its progress as soon as a runner picks it up."
          : "Watch the actions, evidence, and results as your gremlin works. You can safely leave this page.",
        "Follow the mission",
        `/activity?run=${encodeURIComponent(active.id)}`,
        { active: !established },
      );
    if (established)
      return {
        active: false,
        title: "Your crew. Your next move.",
        description:
          "See what is working, what needs attention, and where your projects go next.",
        label: "Open your projects",
        href: "/projects",
      };
    if (!sourceReady)
      return step(
        0,
        "Connect your code.",
        project
          ? `Connect the source account for ${project.name} so your gremlin can explore its code.`
          : "Connect GitHub or GitLab. Your code stays in your account; your gremlins work from your server.",
        "Connect source control",
        "/connections#source-control",
      );
    if (!aiReady)
      return step(
        1,
        "Connect your AI.",
        "Connect Claude Code to plan a crew and run its missions. You can add Linear and hosting when a task needs them.",
        "Connect Claude Code",
        "/connections#model-connections",
      );
    if (!project)
      return step(
        2,
        "What are we working on?",
        "Connect an app you already have. Review what the Setup Gremlin finds, then adopt a PM to learn the app.",
        "Improve my app",
        "/projects#project-form",
      );
    if (!Array.isArray(project.areas) || !project.readiness)
      return step(
        2,
        "Your project needs a quick repair.",
        "Its saved configuration could not be read. Review the reported settings before adopting or starting a gremlin.",
        "Review settings",
        "/settings#advanced-settings",
      );
    if (project.foundation?.needed)
      return step(
        4,
        project.foundation.stage === "review-code"
          ? "Your first build is ready to review."
          : "Give your idea a real foundation.",
        project.foundation.stage === "review-code"
          ? "Review the coding run and its draft, then check the merged app before PMs explore it."
          : "Your crew’s first job is to build a working app. Review the foundation plan, then explicitly start the Coding Gremlin.",
        project.foundation.stage === "review-code"
          ? "Review foundation"
          : "Review foundation plan",
        `${projectPath(project)}?tab=environment`,
      );
    if (project.autonomy?.enabled === true) {
      const automatic = window.projectWorkState(project, jobs);
      return step(
        4,
        automatic.state === "blocked"
          ? "Your crew needs one thing."
          : "Your crew is ready to work.",
        automatic.detail,
        automatic.action,
        automatic.href,
      );
    }
    const firstStep = window.projectFirstStep(project, jobs);
    if (firstStep === "welcome")
      return step(
        3,
        "Let’s get to know your app.",
        "Review the repository analysis and suggested setup. Then meet a gremlin with a job grounded in your code.",
        "Review your app setup",
        projectPath(project),
      );
    if (firstStep === "mission")
      return step(
        4,
        "Choose the next useful improvement.",
        "Your crew has context to work from. Choose a user outcome, review its proposed change, and approve the exact work before coding.",
        "Open your next change",
        projectPath(project),
      );
    const previous = work?.[0];
    if (previous && ["failed", "canceled"].includes(previous.status))
      return step(
        4,
        "Let’s get that first mission moving.",
        "Your gremlin’s last run stopped. Review its evidence and the blocker before choosing what to try next.",
        "Review the last run",
        `/activity?run=${encodeURIComponent(previous.id)}`,
      );
    const area =
      project.areas.find(
        (item) => item.key === project.onboardingProgress?.area,
      ) || project.areas[0];
    const readiness = list(project.readiness.areas).find(
      (item) => item.key === area.key,
    )?.discovery;
    const blocker = list(readiness?.blockers)[0];
    if (blocker) {
      const links = {
        source: ["Connect source control", "/connections#source-control"],
        ai: ["Connect Claude Code", "/connections#model-connections"],
        worker: ["Set up a runner", "/runners#workers"],
        mandate: [
          "Finish its purpose",
          `${projectPath(project)}?pm=${encodeURIComponent(area.key)}`,
        ],
        config: ["Review settings", "/settings#advanced-settings"],
      };
      const [label, href] = links[blocker.action] || [
        "Open the project",
        projectPath(project),
      ];
      return step(
        4,
        blocker.action === "worker"
          ? "Your gremlin needs somewhere to work."
          : "One step before its first mission.",
        blocker.action === "worker"
          ? "Create a local runner or connect one of your machines. Its browser check must pass before your gremlin can start."
          : blocker.message,
        label,
        href,
      );
    }
    return step(
      4,
      "Let your first gremlin learn the app.",
      "Their first Discovery maps the code, the product, and its gaps. Review what they learn before deciding what should improve. It does not create tickets or start coding.",
      readiness?.canRun
        ? "Start the first investigation"
        : "Prepare the first investigation",
      projectPath(project),
    );
  };

  window.renderFirstRunOverview = (
    status,
    runners,
    { locked = false } = {},
  ) => {
    const state = window.firstRunNextStep(status, runners);
    const get = (id) => document.getElementById(id);
    if (!state) return;
    document.body.classList.toggle("is-first-run", state.active);
    document.body.classList.toggle(
      "first-run-no-project",
      Boolean(state.active && state.noProject),
    );
    get("welcome-title").textContent = state.title;
    get("welcome-description").textContent = state.description;
    get("overview-eyebrow").textContent = state.active
      ? "YOUR FIRST USEFUL CHANGE"
      : "YOUR WORKSPACE";
    const link = get("overview-primary-action"),
      adopt = get("overview-adopt-action");
    link.textContent = `${state.label} →`;
    link.href = state.href;
    link.hidden = Boolean(state.adoptProject);
    adopt.hidden = !state.adoptProject;
    adopt.disabled = locked;
    adopt.dataset.createPmProject = state.adoptProject || "";
    get("first-run-note").hidden = !state.active;
    const automatic = list(status.projects).some(
      (project) => project.autonomy?.enabled,
    );
    get("first-run-note").textContent = automatic
      ? "Autonomous work is enabled for your crew. Requirements and run limits still apply; coding uses approved tickets."
      : "Connect your project, then enable autonomous work. Your crew investigates and picks up approved tickets within its run limits.";
    const progress = get("first-run-progress");
    const labels = [
      "Connect source",
      "Connect Claude",
      "Add a project",
      "Meet your gremlin",
      "Review a change",
    ];
    if (state.active)
      progress.replaceChildren(
        ...labels.map((label, index) => {
          const item = document.createElement("li");
          const marker = document.createElement("span");
          marker.className = "first-run-step-marker";
          marker.textContent = state.completed[index] ? "✓" : String(index + 1);
          marker.setAttribute("aria-hidden", "true");
          const text = document.createElement("span");
          text.textContent = label;
          item.append(marker, text);
          if (index === state.index) item.setAttribute("aria-current", "step");
          item.classList.toggle("complete", state.completed[index]);
          return item;
        }),
      );
  };
})();
