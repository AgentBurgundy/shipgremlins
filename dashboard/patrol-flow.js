"use strict";
(() => {
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const link = (text, href, className = "small-button") => {
    const result = node("a", className, text);
    result.href = href;
    return result;
  };
  // Display only an origin. Preview query strings and credentials never become links.
  function publicOrigin(value) {
    try {
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null;
      return url.origin;
    } catch {
      return null;
    }
  }
  window.renderPatrolPlan = (project, { compact = false } = {}) => {
    const root = node("section", "patrol-plan"),
      header = node("div", "patrol-plan-heading"),
      copy = node("div", "patrol-plan-copy"),
      actions = node("div", "patrol-plan-actions"),
      mode = project.verification?.mode,
      browser = mode === "browser",
      environment = project.verification?.environment,
      target =
        browser && Object.hasOwn(project.environments || {}, environment)
          ? project.environments[environment]
          : null,
      valid =
        target &&
        ["docker", "vercel", "railway", "url", "cloud-run"].includes(
          target.kind,
        ) &&
        target.role !== "production",
      docker = valid && target.kind === "docker",
      repository = mode === "repository",
      href = `/projects/${encodeURIComponent(project.name)}?tab=environment`,
      origin = valid && target.kind === "url" ? publicOrigin(target.url) : null;
    root.setAttribute("aria-label", "Patrol plan");
    copy.append(
      node("span", "patrol-plan-kicker", "PATROL PLAN"),
      node(
        "h3",
        "",
        valid
          ? docker
            ? "Run a fresh app. Test it in the browser."
            : "Visit your staging app. Test real workflows."
          : repository
            ? "Inspect the code. Run repository checks."
            : "Choose where this crew will test.",
      ),
    );
    const providers = {
      docker: "Disposable Docker",
      vercel: "Vercel",
      railway: "Railway",
      "cloud-run": "Cloud Run",
      url: "Hosted URL",
    };
    copy.append(
      node(
        "p",
        "patrol-plan-target",
        valid
          ? `${environment} · ${providers[target.kind]}${origin ? ` · ${origin}` : ""}`
          : repository
            ? "Repository-only · Opening an application is not required."
            : "The testing mode or environment needs configuration.",
      ),
    );
    if (valid) {
      const accounts =
        target.access?.kind === "password"
          ? (target.access.accounts || []).map((item) => item.name)
          : [];
      copy.append(
        node(
          "p",
          "patrol-plan-access",
          accounts.length
            ? `Test accounts: ${accounts.join(" · ")}`
            : target.access?.kind === "public"
              ? "Public access · No sign-in configured."
              : "Test accounts: no environment login recipe configured.",
        ),
      );
    }
    actions.append(
      link(
        valid
          ? "Environment & accounts"
          : repository
            ? "Add browser testing"
            : "Set up environment",
        href,
      ),
    );
    if (origin) {
      const url = new URL(target.url);
      url.search = "";
      url.hash = "";
      const open = link("Open app ↗", url.href, "patrol-plan-open");
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      actions.append(open);
    }
    header.append(copy, actions);
    root.append(header);
    if (!compact && (valid || repository)) {
      const steps = node("ol", "patrol-plan-steps");
      steps.setAttribute(
        "aria-label",
        "Planned patrol steps, not live progress",
      );
      const labels = repository
        ? [
            "Read mandate & memory",
            "Trace code paths",
            "Run focused checks",
            "Propose & remember",
          ]
        : [
            "Read mandate & memory",
            docker ? "Start app & open browser" : "Open app & sign in",
            "Exercise flows & capture evidence",
            "Propose & remember",
          ];
      for (const [index, label] of labels.entries()) {
        const step = node("li", "");
        step.append(
          node("span", "patrol-step-number", String(index + 1)),
          node("span", "", label),
        );
        steps.append(step);
      }
      root.append(steps);
      root.append(
        node(
          "p",
          "patrol-plan-note",
          valid
            ? docker
              ? "Each run gets a private app environment. Review its actual browser activity and evidence after the patrol."
              : "The URL is resolved at run time. Review the patrol’s actual browser activity and evidence, not just its finished status."
            : "Want this PM to click through your web app? Add a staging URL or a disposable Docker environment.",
        ),
      );
    }
    return root;
  };

  // Tool calls show attempts, not successful navigation, login, or acceptance.
  // Model summaries and arbitrary artifact names are never treated as verification.
  window.patrolEvidence = ({ events = [], files = [], checks = [] } = {}) => {
    const unique = new Map(
      events
        .filter(
          (event) => event.type === "tool" && typeof event.id === "string",
        )
        .map((event) => [event.id, event]),
    );
    const browser = [...unique.values()].filter((event) =>
      /^(?:mcp__playwright__)?browser_[a-z_]+$/.test(event.title),
    );
    return {
      calls: browser.length,
      navigations: browser.filter((event) =>
        /browser_navigate(?:_back)?$/.test(event.title),
      ).length,
      interactions: browser.filter((event) =>
        /browser_(?:click|fill_form|type|press_key|select_option|file_upload|drag)$/.test(
          event.title,
        ),
      ).length,
      images: new Set(
        files
          .filter((file) => /\.(?:png|jpe?g|webp)$/i.test(file.name))
          .map((file) => file.name),
      ).size,
      passed: checks.filter((check) => check.status === "succeeded").length,
      failed: checks.filter((check) => check.status === "failed").length,
      running: checks.filter((check) => check.status === "running").length,
    };
  };
  window.renderPatrolEvidence = ({
    job,
    activity,
    artifacts,
    activityState,
    artifactState,
    onTab,
  }) => {
    const root = node("section", "patrol-evidence"),
      discovery = job?.pmMode === "discovery",
      counts = window.patrolEvidence({ ...activity, files: artifacts }),
      active = ["queued", "running"].includes(job?.status),
      readable = ["ready", "partial"].includes(activityState),
      title = discovery
        ? "Discovery reads code, not the running app"
        : counts.calls
          ? "Browser activity recorded"
          : activityState === "error"
            ? "Browser activity unavailable"
            : !readable
              ? "Loading browser activity…"
              : activityState === "partial"
                ? "Browser activity is incomplete"
                : active
                  ? "Waiting for browser activity"
                  : "No browser calls recorded",
      header = node("div", "patrol-evidence-heading");
    root.setAttribute("aria-label", "Run evidence");
    root.dataset.tone =
      !discovery && !counts.calls && !active && activityState === "ready"
        ? "attention"
        : "neutral";
    header.append(node("h3", "", title));
    root.append(header);
    if (discovery) {
      root.append(
        node(
          "p",
          "patrol-evidence-note",
          "This run maps the codebase and saves knowledge. Start a PM patrol to investigate the configured test environment.",
        ),
      );
      return root;
    }
    const metrics = node("div", "patrol-evidence-metrics");
    function metric(label, value, detail, tab) {
      const button = node("button", "patrol-evidence-metric");
      button.type = "button";
      button.append(
        node("span", "patrol-evidence-label", label),
        node("strong", "", value),
        node("span", "patrol-evidence-detail", detail),
      );
      button.addEventListener("click", () => onTab(tab));
      metrics.append(button);
    }
    metric(
      "Browser calls",
      readable || counts.calls ? String(counts.calls) : "—",
      counts.calls
        ? `${counts.navigations} navigation · ${counts.interactions} ${counts.interactions === 1 ? "interaction" : "interactions"}`
        : "View recorded actions →",
      "activity",
    );
    metric(
      "Images saved",
      artifactState === "ready" || artifacts?.length
        ? String(counts.images)
        : "—",
      artifactState === "error"
        ? "Files could not refresh"
        : artifactState === "loading" || artifactState === "partial"
          ? "Files may arrive after completion"
          : "Inspect screenshots & files →",
      "artifacts",
    );
    metric(
      "Reported checks",
      readable || activity?.checks?.length ? `${counts.passed} passed` : "—",
      counts.failed
        ? `${counts.failed} failed${counts.running ? ` · ${counts.running} running` : ""}`
        : counts.running
          ? `${counts.running} running`
          : "View checks in Activity →",
      "activity",
    );
    root.append(metrics);
    root.append(
      node(
        "p",
        "patrol-evidence-note",
        counts.calls
          ? "Calls show attempts; images may also be test fixtures. Inspect the results before treating the app, sign-in or permissions as verified."
          : "A finished run does not prove the app was tested. Repository-only patrols can finish without browser use.",
      ),
    );
    if (
      [activityState, artifactState].some(
        (state) => state === "error" || state === "partial",
      )
    )
      root.append(
        node(
          "p",
          "patrol-evidence-note patrol-evidence-warning",
          "Some evidence is unavailable or still arriving. Showing what has loaded; missing records are not a test result.",
        ),
      );
    return root;
  };
})();
