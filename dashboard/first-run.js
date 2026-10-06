"use strict";

(() => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const projectPath = (project) =>
    `/projects/${encodeURIComponent(project.name)}`;
  const belongs = (job, project) =>
    job.project === project.name &&
    job.projectInstanceId === project.instanceId;
  const actualWork = (job) => ["pm", "developer"].includes(job.type);

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
      .sort((a, b) => b.runId - a.runId);
    const currentWork =
      recentWork.find((job) => ["queued", "running"].includes(job.status)) ||
      recentWork[0];
    const project =
      projects.find(
        (project) => currentWork && belongs(currentWork, project),
      ) ||
      projects.find((project) => project.areas?.length) ||
      projects[0];
    if (established)
      return {
        active: false,
        title: "Your first change is ready to review.",
        description:
          "Inspect the draft and its evidence. A finished coding run is a change to review, not a claim that the product is finished.",
        label: "Review your change",
        href: projectPath(established),
      };
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
        .sort((a, b) => b.runId - a.runId);
    const active = work?.find((job) =>
      ["queued", "running"].includes(job.status),
    );
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
      );
    if (!sourceReady)
      return step(
        0,
        "Give your gremlin a way in.",
        project
          ? `Connect the source account for ${project.name} so your gremlin can explore its code.`
          : "Connect GitHub or GitLab. Your code stays in your account; your gremlins work from your server.",
        "Connect source control",
        "/connections#source-control",
      );
    if (!aiReady)
      return step(
        1,
        "A little brainpower next.",
        "Connect Claude Code to plan a crew and run its missions. You can add Linear and hosting when a task needs them.",
        "Connect Claude Code",
        "/connections#model-connections",
      );
    if (!project)
      return step(
        2,
        "What are we working on?",
        "Connect an app you already have. Choose one user outcome and let your crew work toward a useful, reviewable change.",
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
    if (!project.areas.length)
      return step(
        3,
        "Choose the first useful improvement.",
        "Describe what should get better for your users. We’ll prepare a focused gremlin to investigate and propose a change for your review.",
        "Choose a user outcome",
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
    const area = project.areas[0];
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
      readiness?.canRun
        ? "Turn your direction into a useful change."
        : "Choose the next useful improvement.",
      readiness?.canRun
        ? "Choose a user outcome. Your crew investigates, proposes a bounded improvement, and waits for approval before coding. Automatic work stays off."
        : "Choose a user outcome on the project page. Saved discovery informs the investigation; a report alone is not the first win.",
      "Choose a user outcome",
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
    const progress = get("first-run-progress");
    const labels = [
      "Connect source",
      "Connect Claude",
      "Add a project",
      "Choose an outcome",
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
