"use strict";
(() => {
  const node = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (label, fn, primary = false) => {
    const value = node(
      "button",
      label,
      primary ? "button button-dark" : "small-button",
    );
    value.type = "button";
    value.addEventListener("click", fn);
    return value;
  };
  const list = (values, className = "") => {
    const result = node("ul", undefined, className);
    for (const value of values || []) result.append(node("li", value));
    return result;
  };
  const ongoing = (data) =>
    ["analyzing", "publishing"].includes(data?.status) ||
    data?.environment?.verification?.status === "testing";
  function openDialogAtStart(dialog, heading) {
    heading.setAttribute("tabindex", "-1");
    heading.setAttribute("autofocus", "");
    dialog.showModal();
    heading.focus({ preventScroll: true });
    dialog.scrollTop = 0;
  }
  function dialogHeader(dialog, heading) {
    const header = node("header", undefined, "foundation-dialog-header"),
      close = button("Close", () => dialog.close());
    close.className = "small-button foundation-dialog-close";
    header.append(heading, close);
    return header;
  }
  function settingsSheet(title) {
    const section = node("section", undefined, "onboarding-settings-link"),
      dialog = node("dialog", undefined, "foundation-brief-dialog"),
      content = node("div"),
      heading = node("h2", title);
    dialog.setAttribute("aria-label", title);
    dialog.append(
      dialogHeader(dialog, heading),
      content,
      button("Done", () => dialog.close()),
    );
    section.append(
      button(title, () => openDialogAtStart(dialog, heading)),
      dialog,
    );
    return { section, content, dialog };
  }
  window.onboardingStep = (data) =>
    data?.environment?.verification?.status === "passed"
      ? 3
      : data?.environment
        ? 2
        : data?.report
          ? 1
          : 0;
  function withAccess(target, draft) {
    if (draft.accessKind === "legacy" || draft.accessKind === undefined)
      return target;
    if (draft.accessKind === "public")
      return { ...target, access: { kind: "public" } };
    const secret = /^[A-Z][A-Z0-9_]*$/;
    if (!draft.accounts?.length)
      throw new Error("Add at least one named test account.");
    if (!draft.loginPath?.startsWith("/") || !draft.successSelector?.trim())
      throw new Error(
        "Set a login path and a signed-in success selector to verify test accounts.",
      );
    for (const account of draft.accounts)
      if (
        !account.name.trim() ||
        !secret.test(account.usernameSecret) ||
        !secret.test(account.passwordSecret)
      )
        throw new Error(
          "Each test account needs a name and saved username/password secret references, not their values.",
        );
    return {
      ...target,
      access: {
        kind: "password",
        loginPath: draft.loginPath.trim(),
        usernameSelector: draft.usernameSelector.trim(),
        passwordSelector: draft.passwordSelector.trim(),
        submitSelector: draft.submitSelector.trim(),
        successSelector: draft.successSelector.trim(),
        accounts: structuredClone(draft.accounts),
      },
    };
  }
  function withProtection(target, draft) {
    const result = structuredClone(target);
    if (result.kind !== "vercel" || draft.vercelBypassEnabled === undefined)
      return result;
    if (draft.vercelBypassEnabled) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(draft.vercelBypassSecret || ""))
        throw new Error(
          "Use the saved Vercel bypass secret name, such as VERCEL_BYPASS_MY_APP. Add the token itself in Connections.",
        );
      result.bypassSecret = draft.vercelBypassSecret;
    } else delete result.bypassSecret;
    return result;
  }
  window.readOnboardingTarget = (draft) => {
    if (draft.profile === "hosted") {
      if (draft.providerTarget)
        return {
          profile: "hosted",
          target: withAccess(
            withProtection(draft.providerTarget, draft),
            draft,
          ),
        };
      if (draft.existing)
        return {
          profile: "hosted",
          environment: draft.existing,
          target: withAccess(
            withProtection(draft.existingTarget, draft),
            draft,
          ),
        };
      const url = new URL(draft.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Use an HTTP(S) test URL without credentials, a query, or a fragment.",
        );
      return {
        profile: "hosted",
        target: withAccess(
          { kind: "url", role: "staging", url: url.href },
          draft,
        ),
      };
    }
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        "Enter the port your application listens on, from 1 to 65535.",
      );
    const recipe =
      draft.recipeKind === "image"
        ? { kind: "image", image: draft.image.trim() }
        : {
            kind: "dockerfile",
            dockerfile: draft.dockerfile.trim(),
            context: draft.context.trim(),
          };
    if (Object.values(recipe).some((value) => !value))
      throw new Error("Complete the application image or Dockerfile recipe.");
    let advanced;
    try {
      advanced = JSON.parse(draft.advanced || "{}");
    } catch {
      throw new Error("Advanced runtime settings must be valid JSON.");
    }
    if (
      !advanced ||
      Array.isArray(advanced) ||
      typeof advanced !== "object" ||
      Object.keys(advanced).some(
        (key) => !["start", "env", "services", "migrate", "seed"].includes(key),
      )
    )
      throw new Error(
        "Advanced settings support start, env, services, migrate, and seed only.",
      );
    return {
      profile: "docker",
      target: withAccess(
        {
          kind: "docker",
          role: "staging",
          recipe,
          port,
          healthPath: draft.healthPath.trim() || "/",
          ...advanced,
        },
        draft,
      ),
    };
  };
  window.createProjectOnboarding = ({
    api,
    getStatus = () => null,
    onSaved = async () => {},
    isLocked = () => false,
    onCreatePm,
    loadImage,
  }) => {
    const entries = new Map();
    let active = null,
      destroyed = false;
    const endpoint = (s, action = "") =>
      `/api/projects/${encodeURIComponent(s.project.name)}/onboarding${action ? `/${action}` : ""}`;
    const dirty = (s) =>
      Boolean(s.draft && JSON.stringify(s.draft) !== s.baseline);
    const disabled = (s) => isLocked() || s.busy || ongoing(s.data);
    function paintConnections(s) {
      if (!s.connectionLinks) return;
      const status = getStatus(),
        credentials = status?.connections || [],
        provider = s.project.provider || "github",
        providerName = provider === "gitlab" ? "GitLab" : "GitHub",
        server =
          s.project.serverUrl ||
          (provider === "gitlab" ? "https://gitlab.com" : "https://github.com");
      const origin = (value) => {
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      };
      const source = status?.sourceConnections?.find(
        (connection) =>
          connection.provider === provider &&
          origin(connection.serverUrl) === origin(server),
      );
      const manual = credentials.find(
        (connection) =>
          connection.name ===
          (provider === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN"),
      );
      const claude = credentials.find(
        (connection) => connection.name === "CLAUDE_CODE_OAUTH_TOKEN",
      );
      const sourceReady =
        Boolean(source?.connected && !source.needsReconnect) ||
        (!source?.needsReconnect &&
          source?.method !== "oauth" &&
          Boolean(manual?.configured));
      const rows = [
        {
          ready: sourceReady,
          missing: !sourceReady && Boolean(source),
          label:
            source?.method === "token" ||
            (!source?.connected && manual?.configured)
              ? `${providerName} token saved`
              : `${providerName} connected`,
          action: source?.needsReconnect
            ? `Reconnect ${providerName}`
            : source
              ? `Connect ${providerName}`
              : `Manage ${providerName}`,
          href: "/connections#source-control",
        },
        {
          ready: Boolean(claude?.configured),
          missing: claude?.configured === false,
          label: "Claude configured",
          action:
            claude?.configured === false ? "Connect Claude" : "Manage Claude",
          href: "/connections#model-connections",
        },
      ];
      const signature = JSON.stringify(rows);
      if (s.connectionSignature === signature) return;
      s.connectionSignature = signature;
      s.connectionHelp.textContent = rows.every((row) => row.ready)
        ? "Uses your saved connections and Docker on this server."
        : rows.some((row) => row.missing)
          ? "Connect the missing service below to analyze this repository. Docker is also required on this server."
          : "Analysis uses source access, Claude Code and Docker on this server.";
      s.connectionLinks.replaceChildren();
      for (const row of rows) {
        const item = node(
          row.ready ? "span" : "a",
          row.ready ? `✓ ${row.label}` : row.action,
          row.ready ? "onboarding-connection-ready" : "",
        );
        if (!row.ready) item.href = row.href;
        s.connectionLinks.append(item);
      }
      if (rows.some((row) => row.ready)) {
        const manage = node("a", "Manage connections");
        manage.href = "/connections";
        s.connectionLinks.append(manage);
      }
    }
    function accessDraft(target, legacy = false, project = "APP", instanceId) {
      const prefix = `APP_${project.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}${instanceId ? `_${instanceId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}` : ""}`;
      const access = target?.access;
      return {
        accessKind: access?.kind || (legacy ? "legacy" : "public"),
        loginPath: access?.loginPath || "/login",
        usernameSelector: access?.usernameSelector || 'input[type="email"]',
        passwordSelector: access?.passwordSelector || 'input[type="password"]',
        submitSelector: access?.submitSelector || 'button[type="submit"]',
        successSelector: access?.successSelector || "",
        accounts: structuredClone(
          access?.accounts || [
            {
              name: "Admin",
              usernameSecret: `${prefix}_TEST_ADMIN_USERNAME`,
              passwordSecret: `${prefix}_TEST_ADMIN_PASSWORD`,
            },
          ],
        ),
      };
    }
    function initialDraft(s) {
      const savedVercel = Object.entries(s.project.environments || {}).filter(
        ([, target]) =>
          target.kind === "vercel" && target.role !== "production",
      );
      const suggestedEnvironment =
        !s.data?.environment && savedVercel.length === 1
          ? {
              name: savedVercel[0][0],
              target: savedVercel[0][1],
              profile: "hosted",
            }
          : null;
      const environment = s.data?.environment || suggestedEnvironment;
      const target = environment?.target;
      const vercelIdentity = (value) =>
        value?.kind === "vercel"
          ? JSON.stringify([
              value.projectId,
              value.connectionId || "default",
              value.teamId === undefined ? "saved-team" : value.teamId,
              value.branch || null,
              value.customEnvironmentId || null,
            ])
          : null;
      const observedPreview =
        target?.kind === "vercel" &&
        vercelIdentity(target) === vercelIdentity(s.observedPreview?.target)
          ? s.observedPreview?.url
          : undefined;
      const proposed = s.data?.stale ? null : s.data?.report?.docker;
      const local = target?.kind === "docker" ? target : proposed;
      const profile =
        environment?.profile || s.data?.report?.recommendation || "hosted";
      const advanced = {};
      for (const key of ["start", "env", "services", "migrate", "seed"])
        if (local?.[key] !== undefined) advanced[key] = local[key];
      return {
        ...protectionDraft(target, s.project),
        ...accessDraft(
          target,
          s.data?.environment?.legacySignIn,
          s.project.name,
          s.project.instanceId,
        ),
        existingTarget: target,
        profile,
        existing:
          target && target.kind !== "url" && target.kind !== "docker"
            ? environment.name
            : "",
        suggestedEnvironment: Boolean(suggestedEnvironment),
        url: target?.kind === "url" ? target.url : "",
        ...(observedPreview ? { providerUrl: observedPreview } : {}),
        recipeKind: local?.recipe?.kind || "dockerfile",
        dockerfile: local?.recipe?.dockerfile || "Dockerfile",
        context: local?.recipe?.context || ".",
        image: local?.recipe?.image || "",
        port: String(local?.port || ""),
        healthPath: local?.healthPath || "/",
        advanced: JSON.stringify(advanced, null, 2),
      };
    }
    function protectionDraft(target, project) {
      const name = project.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const instance = project.instanceId
        ? `_${project.instanceId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`
        : "";
      return {
        vercelBypassEnabled: Boolean(
          target?.kind === "vercel" && target.bypassSecret,
        ),
        vercelBypassSecret:
          (target?.kind === "vercel" && target.bypassSecret) ||
          `VERCEL_BYPASS_${name}${instance}`,
      };
    }
    function entry(project) {
      if (!entries.has(project.name)) {
        const s = {
          project,
          data: null,
          busy: false,
          loading: false,
          loaded: false,
          generation: 0,
          timer: null,
          error: "",
          notice: "",
          draft: null,
          baseline: "",
          reviewed: false,
          signature: "",
          formSignature: "",
          node: node("section", undefined, "project-onboarding"),
        };
        s.heading = node("header", undefined, "onboarding-heading");
        s.title = node("h2", "A safe place to test.");
        s.description = node(
          "p",
          "Choose where your crew can explore. Test access before using a browser environment.",
        );
        s.heading.append(
          node("span", "ENVIRONMENT", "eyebrow muted"),
          s.title,
          s.description,
        );
        s.foundation = node("section", undefined, "onboarding-analysis");
        s.steps = node("ol", undefined, "onboarding-steps");
        s.message = node("div", undefined, "onboarding-message");
        s.message.setAttribute("role", "status");
        s.analysis = node("section", undefined, "onboarding-analysis");
        s.form = node("section", undefined, "onboarding-choice");
        s.verification = node("section", undefined, "onboarding-verification");
        s.proposal = node("section", undefined, "onboarding-proposal");
        s.node.append(
          s.heading,
          s.foundation,
          s.steps,
          s.message,
          s.analysis,
          s.form,
          s.verification,
          s.proposal,
        );
        entries.set(project.name, s);
      }
      const result = entries.get(project.name);
      result.project = project;
      return result;
    }
    function schedule(s) {
      clearTimeout(s.timer);
      if (
        destroyed ||
        active !== s ||
        document.hidden ||
        (!ongoing(s.data) &&
          !["queued", "building"].includes(s.data?.foundation?.stage))
      )
        return;
      s.timer = setTimeout(() => load(s, true), 1800);
    }
    async function load(s, force = false) {
      if (s.loading || s.busy || (s.loaded && !force) || isLocked()) return;
      const generation = ++s.generation;
      s.loading = true;
      paint(s);
      try {
        const data = await api(endpoint(s));
        if (
          generation !== s.generation ||
          destroyed ||
          entries.get(s.project.name) !== s
        )
          return;
        const wasDirty = dirty(s);
        if (
          JSON.stringify(s.data?.report?.proposedFiles) !==
          JSON.stringify(data.report?.proposedFiles)
        )
          s.reviewed = false;
        s.data = data;
        s.loaded = true;
        s.error = "";
        if (wasDirty && s.draftRevision !== data.configurationRevision)
          s.notice =
            "Project settings changed elsewhere. Your draft is kept; discard and reload before applying it to the newer configuration.";
        if (!wasDirty && !s.form.contains(document.activeElement)) {
          s.draft = initialDraft(s);
          s.baseline = JSON.stringify(s.draft);
          s.draftRevision = data.configurationRevision;
          s.formSignature = "";
        }
      } catch (error) {
        if (generation === s.generation)
          s.error = error.message || "Environment setup could not be loaded.";
      } finally {
        if (generation === s.generation) {
          s.loading = false;
          paint(s);
          schedule(s);
        }
      }
    }
    async function run(s, action, body) {
      if (isLocked() || s.busy || (ongoing(s.data) && action !== "cancel"))
        return;
      clearTimeout(s.timer);
      s.busy = true;
      s.error = "";
      s.notice = "";
      paint(s);
      try {
        const data = await api(endpoint(s, action), body);
        if (destroyed || entries.get(s.project.name) !== s) return;
        s.data = data;
        s.loaded = true;
        if (action === "configure") {
          s.notice = "Environment saved. Test it before the crew uses it.";
          s.showForm = false;
          s.showAnalysis = false;
          s.draft = initialDraft(s);
          s.baseline = JSON.stringify(s.draft);
          s.draftRevision = data.configurationRevision;
          s.formSignature = "";
          await onSaved(s.project.name);
        }
        if (action === "setup-pr") s.reviewed = false;
      } catch (error) {
        s.error =
          error.message ||
          "This action did not finish. Refresh status before retrying.";
      } finally {
        s.busy = false;
        paint(s);
        schedule(s);
      }
    }
    async function runFoundation(s, action) {
      if (isLocked() || s.busy || s.loading) return;
      s.busy = true;
      s.error = s.notice = "";
      paint(s);
      try {
        const foundation = await api(
          `/api/projects/${encodeURIComponent(s.project.name)}/foundation/${action}`,
          action === "inspect"
            ? {}
            : {
                revision: s.data.foundation.revision,
                ...(s.data.foundation.stage === "failed" &&
                s.data.foundation.job
                  ? { retryJobId: s.data.foundation.job.id }
                  : {}),
              },
          "POST",
          180000,
        );
        s.data.foundation = foundation;
        if (action === "inspect")
          s.notice =
            foundation.stage === "ready"
              ? "Application code and test commands are on the base branch. Now choose where to test the app."
              : "The base branch still needs the app, npm start, and tests. Review and merge the foundation PR, then check again.";
        await onSaved(s.project.name);
      } catch (error) {
        s.error =
          error.message ||
          "Foundation setup paused. Your progress is saved; retry to resume.";
      } finally {
        s.busy = false;
        paint(s);
        schedule(s);
      }
    }
    function showBuildBrief(s) {
      if (s.briefDialog) s.briefDialog.remove();
      const dialog = node("dialog", undefined, "foundation-brief-dialog");
      const title = node("h2", "Your foundation build brief");
      title.id = `foundation-brief-${s.project.name}`;
      dialog.setAttribute("aria-labelledby", title.id);
      const close = button("Back to build review", () => dialog.close());
      const brief = String(s.data.foundation.buildBrief || "").replace(
        /^<!-- ShipGremlins foundation: [a-f0-9-]+ -->\s*$/m,
        "",
      );
      dialog.append(
        dialogHeader(dialog, title),
        node(
          "p",
          "This is the exact scope used for the approved Linear ticket.",
        ),
        typeof window.renderKnowledgeDocument === "function"
          ? window.renderKnowledgeDocument(brief)
          : node("pre", brief),
        close,
      );
      s.node.append(dialog);
      s.briefDialog = dialog;
      openDialogAtStart(dialog, title);
    }
    function paintFoundation(s) {
      const data = s.data?.foundation,
        stage = data?.stage || "review";
      s.foundation.className = "foundation-card";
      s.foundation.replaceChildren();
      const timeline = node("ol", undefined, "foundation-progress");
      for (const [index, label] of [
        "Build foundation",
        "Review code",
        "Test the app",
      ].entries()) {
        const step = node("li", label);
        if (index === (stage === "review-code" ? 1 : 0))
          step.setAttribute("aria-current", "step");
        timeline.append(step);
      }
      s.foundation.append(timeline);
      if (!data) {
        s.foundation.append(node("h3", "Preparing your build review…"));
        return;
      }
      const running = ["queued", "building"].includes(stage);
      s.foundation.append(
        node(
          "span",
          running ? "CODING GREMLIN" : "YOUR FIRST VERSION",
          "eyebrow muted",
        ),
        node(
          "h3",
          running
            ? stage === "queued"
              ? "Your foundation is in the queue."
              : "Your foundation is taking shape."
            : stage === "review-code"
              ? "Your first build is ready to review."
              : stage === "failed"
                ? "Let's get your build moving again."
                : data.title,
        ),
        node(
          "p",
          running
            ? "A Coding Gremlin will implement the reviewed plan on your runner, run its tests, and open a draft pull request."
            : stage === "review-code"
              ? "Open the coding run to review its draft pull request and test evidence. Merge the code when you're happy, then check the repository below."
              : stage === "failed"
                ? data.job?.message ||
                  "Open the run to see what stopped it. Retry resumes the same foundation ticket."
                : data.milestone,
          "foundation-lead",
        ),
      );
      if (!running && stage === "review") {
        s.foundation.append(
          node(
            "p",
            "Automatic foundation: Node.js web app + npm.",
            "onboarding-help",
          ),
          node("p", data.assignment),
        );
        const acceptance = node("section", undefined, "foundation-acceptance");
        acceptance.append(
          node("h4", "The first version will"),
          list(data.acceptanceCriteria),
        );
        s.foundation.append(acceptance);
        const scope = button("Read the full build brief", () =>
          showBuildBrief(s),
        );
        scope.className = "onboarding-text-button";
        s.foundation.append(scope);
      }
      const actions = node("div", undefined, "onboarding-actions");
      if (["review", "failed"].includes(stage)) {
        const build = button(
          s.busy
            ? "Setting up your build…"
            : stage === "failed"
              ? "Retry foundation build"
              : "Approve & build foundation",
          () => runFoundation(s, "build"),
          true,
        );
        build.disabled = isLocked() || s.loading || s.busy;
        actions.append(build);
      }
      if (data.job) {
        const run = node("a", "Open coding run", "button");
        run.href = `/activity?run=${encodeURIComponent(data.job.id)}`;
        actions.append(run);
      }
      if (!running) {
        const check = button(
          s.busy
            ? "Checking…"
            : stage === "review-code"
              ? "I've merged it · check repository"
              : "My app already has code",
          () => runFoundation(s, "inspect"),
        );
        check.disabled = isLocked() || s.loading || s.busy;
        actions.append(check);
      }
      s.foundation.append(actions);
      if (stage === "review")
        s.foundation.append(
          node(
            "p",
            "This approves one foundation ticket in Linear and starts a coding run. We'll set up its team and labels and check your connections. You review the draft pull request before merging. Hosting can wait.",
            "onboarding-help",
          ),
        );
      if (data.ticket) {
        const ticket = node(
          "a",
          `Foundation ticket · ${data.ticket.identifier}`,
        );
        if (
          typeof data.ticket.url === "string" &&
          /^https:\/\/linear\.app\//.test(data.ticket.url)
        ) {
          ticket.href = data.ticket.url;
          ticket.target = "_blank";
          ticket.rel = "noopener noreferrer";
        }
        s.foundation.append(ticket);
      }
      const resources = node("p", undefined, "foundation-resources");
      const connections = node("a", "Connections"),
        runners = node("a", "Runners");
      connections.href = "/connections";
      runners.href = "/runners";
      resources.append(connections, runners);
      s.foundation.append(resources);
    }
    function field(s, key, label, help, type = "text") {
      const wrap = node("div", undefined, "field"),
        caption = node("label", label),
        input = node(type === "textarea" ? "textarea" : "input");
      input.id = `onboarding-${s.project.name}-${key}`;
      caption.htmlFor = input.id;
      if (type !== "textarea") input.type = type;
      input.value = s.draft[key];
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        s.draft[key] = input.value;
        s.notice = "";
        updateFormActions(s);
      });
      wrap.append(caption, input);
      if (help) {
        const hint = node("p", help);
        hint.id = `${input.id}-help`;
        input.setAttribute("aria-describedby", hint.id);
        wrap.append(hint);
      }
      return wrap;
    }
    function updateFormActions(s) {
      const choosingPreview =
        s.draft?.profile === "hosted" &&
        s.showVercel &&
        !s.draft.providerTarget &&
        !s.draft.existing;
      if (s.save)
        s.save.disabled = disabled(s) || !s.data || !s.draft || choosingPreview;
      if (s.test)
        s.test.disabled = disabled(s) || dirty(s) || !s.data?.environment;
      if (s.create) s.create.disabled = isLocked() || s.busy || dirty(s);
      if (s.draftNotice)
        s.draftNotice.textContent = choosingPreview
          ? "Choose a ready Vercel preview before saving, or enter a test URL instead."
          : s.draft?.suggestedEnvironment
            ? "Suggested from your saved Vercel settings · save this choice, then test access. It is not verified yet."
            : dirty(s)
              ? "Unsaved changes · save this choice before testing."
              : "Credentials stay in Connections. Saving does not start a PM or enable automation.";
    }
    function paintForm(s) {
      if (!s.draft) return;
      const shape = JSON.stringify([
        s.draft.profile,
        s.draft.existing,
        s.draft.recipeKind,
        s.draft.accessKind,
        s.draft.vercelBypassEnabled,
        s.draft.accounts.length,
        s.showVercel,
        Object.keys(s.project.environments || {}),
      ]);
      if (shape === s.formSignature) {
        updateFormActions(s);
        return;
      }
      s.formSignature = shape;
      s.form.replaceChildren(node("h3", "Where should your crew test?"));
      const choices = node("div", undefined, "onboarding-strategies");
      for (const [profile, title, detail] of [
        [
          "hosted",
          "Use hosted staging",
          "An existing test URL or a saved deployment.",
        ],
        ["docker", "Run locally", "An isolated app instance for each run."],
      ]) {
        const choice = button("", () => {
          s.draft.profile = profile;
          s.formSignature = "";
          paintForm(s);
        });
        choice.className = `onboarding-strategy${s.draft.profile === profile ? " selected" : ""}`;
        choice.setAttribute(
          "aria-pressed",
          String(s.draft.profile === profile),
        );
        choice.append(node("strong", title), node("span", detail));
        choices.append(choice);
      }
      s.form.append(choices);
      if (s.draft.profile === "hosted") {
        if (!s.showVercel) s.vercelSetup?.setActive(false);
        const hostedTarget =
          s.draft.providerTarget ||
          (s.draft.existing && s.draft.existingTarget);
        const useManualUrl = () => {
          delete s.draft.providerTarget;
          delete s.draft.providerLabel;
          delete s.draft.providerUrl;
          s.draft.existing = "";
          s.draft.existingTarget = undefined;
          s.draft.suggestedEnvironment = false;
          s.showVercel = false;
          s.formSignature = "";
          paintForm(s);
        };
        const chooseVercel = button(
          s.showVercel
            ? "Enter a test URL instead"
            : hostedTarget?.kind === "vercel"
              ? "Change Vercel preview"
              : "Find a preview with Vercel",
          () => {
            if (s.showVercel) return useManualUrl();
            s.showVercel = true;
            s.formSignature = "";
            paintForm(s);
          },
        );
        s.form.append(chooseVercel);
        if (window.createVercelSetup && s.showVercel) {
          if (!s.vercelSetup)
            s.vercelSetup = window.createVercelSetup({
              api,
              project: s.project,
              getStatus,
              isLocked: () => disabled(s),
              onSelect: ({ target, label, url }) => {
                const previous =
                  s.draft.providerTarget || s.draft.existingTarget;
                const sameProject =
                  previous?.kind === "vercel" &&
                  previous.projectId === target.projectId &&
                  (previous.connectionId || "default") ===
                    (target.connectionId || "default") &&
                  (previous.teamId || null) === (target.teamId || null);
                if (!sameProject)
                  Object.assign(s.draft, protectionDraft(target, s.project));
                s.draft.providerTarget = target;
                s.draft.providerLabel = label;
                s.draft.providerUrl = url;
                s.observedPreview = { target: structuredClone(target), url };
                s.draft.existing = "";
                s.draft.existingTarget = undefined;
                s.draft.suggestedEnvironment = false;
                s.showVercel = false;
                s.formSignature = "";
                paintForm(s);
              },
            });
          s.vercelSetup.mount(s.form);
        }
        if (hostedTarget?.kind === "vercel") {
          const selected = node("div", undefined, "vercel-selected-target");
          selected.append(
            node(
              "strong",
              s.draft.providerLabel
                ? `Selected Vercel preview · ${s.draft.providerLabel}`
                : `${s.draft.suggestedEnvironment ? "Suggested Vercel environment" : "Saved Vercel environment"} · ${s.draft.existing}`,
            ),
            node(
              "p",
              "The worker gets the test address from Vercel. You don’t need to enter a separate Test URL.",
              "onboarding-help",
            ),
          );
          let previewUrl = "";
          try {
            const url = new URL(s.draft.providerUrl);
            if (
              ["https:", "http:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            )
              previewUrl = url.href;
          } catch {
            /* Saved provider targets resolve their address during testing. */
          }
          if (previewUrl) {
            const address = node("a", previewUrl, "vercel-environment-url");
            address.href = previewUrl;
            address.target = "_blank";
            address.rel = "noopener noreferrer";
            selected.append(address);
          }
          selected.append(
            node(
              "p",
              `${hostedTarget.branch ? `Branch ${hostedTarget.branch}. ` : ""}${previewUrl ? "This is the preview found during selection. " : ""}Each test resolves the latest matching deployment; save this choice and test access to check it.`,
              "onboarding-help",
            ),
            button("Enter a test URL instead", useManualUrl),
          );
          s.form.append(selected);
        }
        const existing = Object.entries(s.project.environments || {}).filter(
          ([, target]) =>
            target.role !== "production" && target.kind !== "docker",
        );
        if (existing.length && !s.draft.providerTarget) {
          const label = node("label", "Saved environment"),
            select = node("select");
          select.id = `onboarding-${s.project.name}-existing`;
          label.htmlFor = select.id;
          select.append(new Option("Use a new test URL", ""));
          for (const [name, target] of existing)
            select.append(new Option(`${name} · ${target.kind}`, name));
          select.value = s.draft.existing;
          select.addEventListener("change", () => {
            s.draft.existing = select.value;
            s.draft.existingTarget = s.project.environments?.[select.value];
            s.draft.suggestedEnvironment = Boolean(
              select.value && !s.data?.environment,
            );
            delete s.draft.providerUrl;
            Object.assign(
              s.draft,
              protectionDraft(s.draft.existingTarget, s.project),
              accessDraft(
                s.draft.existingTarget,
                Boolean(select.value && s.data?.environment?.legacySignIn),
                s.project.name,
                s.project.instanceId,
              ),
            );
            s.formSignature = "";
            paintForm(s);
          });
          const wrap = node("div", undefined, "field");
          wrap.append(label, select);
          s.form.append(wrap);
        }
        if (!s.draft.existing && !s.draft.providerTarget && !s.showVercel)
          s.form.append(
            field(
              s,
              "url",
              "Test URL",
              "Use a dedicated preview or staging app. It must be reachable from the worker; localhost refers to the worker itself.",
              "url",
            ),
          );
        else if (s.showVercel && !hostedTarget)
          s.form.append(
            node(
              "p",
              "Choose a ready deployment with ‘Use this preview’. Selecting an account or project alone does not attach a test environment.",
              "onboarding-help",
            ),
          );
        const vercelTarget =
          s.draft.providerTarget ||
          (s.draft.existing && s.draft.existingTarget);
        if (vercelTarget?.kind === "vercel") {
          const protection = node(
              "div",
              undefined,
              "onboarding-vercel-protection",
            ),
            label = node("label", undefined, "onboarding-confirm"),
            enabled = node("input");
          enabled.type = "checkbox";
          enabled.checked = s.draft.vercelBypassEnabled;
          enabled.addEventListener("change", () => {
            s.draft.vercelBypassEnabled = enabled.checked;
            s.formSignature = "";
            paintForm(s);
          });
          label.append(
            enabled,
            node("span", "This preview has Vercel deployment protection"),
          );
          protection.append(
            label,
            node(
              "p",
              "Use a Vercel automation bypass when the preview shows a Vercel login wall. Your app’s own sign-in is configured below.",
              "onboarding-help",
            ),
          );
          if (s.draft.vercelBypassEnabled) {
            protection.append(
              node(
                "p",
                "Save this environment, then add its automation bypass token in Connections. Keep the token out of chat.",
                "onboarding-help",
              ),
            );
            const advanced = settingsSheet("Saved bypass secret name");
            advanced.content.append(
              field(
                s,
                "vercelBypassSecret",
                "Secret name",
                "A reference to the token in Connections, not the token itself.",
              ),
            );
            protection.append(advanced.section);
            const credentials = node(
              "a",
              "Open project access in Connections →",
            );
            credentials.href = "/connections#project-access";
            protection.append(credentials);
          }
          s.form.append(protection);
        }
        const advanced = settingsSheet("Hosting provider settings");
        advanced.content.append(
          node(
            "p",
            "Choose a saved provider account and resource in project settings. Hosting access is separate from signing into your app.",
          ),
        );
        const settings = button("Open project settings", () =>
          advanced.dialog.close(),
        );
        settings.dataset.editProject = s.project.name;
        advanced.content.append(settings);
        s.form.append(advanced.section);
        if (s.data?.report?.hosted?.instructions?.length) {
          const tips = settingsSheet("Suggested hosting setup");
          tips.content.append(list(s.data.report.hosted.instructions));
          s.form.append(tips.section);
        }
      } else {
        s.vercelSetup?.setActive(false);
        s.form.append(
          node(
            "p",
            "The app runs separately from the gremlin. Review its startup recipe; test credentials and data must be safe for this disposable instance.",
            "onboarding-help",
          ),
        );
        const grid = node("div", undefined, "onboarding-form-grid"),
          label = node("label", "Application recipe"),
          select = node("select");
        select.id = `onboarding-${s.project.name}-recipe`;
        label.htmlFor = select.id;
        select.append(
          new Option("Build the repository’s Dockerfile", "dockerfile"),
          new Option("Use an existing container image", "image"),
        );
        select.value = s.draft.recipeKind;
        select.addEventListener("change", () => {
          s.draft.recipeKind = select.value;
          s.formSignature = "";
          paintForm(s);
        });
        const wrap = node("div", undefined, "field");
        wrap.append(label, select);
        s.form.append(wrap);
        if (s.draft.recipeKind === "image")
          grid.append(
            field(
              s,
              "image",
              "Container image",
              "Use an image you trust. An image alone is not proof of a repository commit.",
            ),
          );
        else
          grid.append(
            field(
              s,
              "dockerfile",
              "Dockerfile path",
              "Relative to the repository.",
            ),
            field(
              s,
              "context",
              "Build context",
              "Usually the repository root: .",
            ),
          );
        grid.append(
          field(
            s,
            "port",
            "Application port",
            "The internal HTTP port, for example 3000.",
            "number",
          ),
          field(
            s,
            "healthPath",
            "Health path",
            "A route that responds when the app is ready.",
          ),
        );
        s.form.append(grid);
        const advanced = settingsSheet("Startup, data & credential references");
        advanced.content.append(
          node(
            "p",
            "Advanced JSON can set start, migrate, seed (argument arrays), PostgreSQL/Redis services, and env mappings. env values are dedicated secret names from Connections, never token values.",
          ),
          field(
            s,
            "advanced",
            "Runtime settings",
            'Example: {"env":{"APP_TEST_KEY":"MY_APP_TEST_KEY"}}',
            "textarea",
          ),
        );
        s.form.append(advanced.section);
      }
      const access = node(
        "section",
        undefined,
        "onboarding-advanced onboarding-access",
      );
      access.append(
        node(
          "h4",
          s.draft.accessKind === "password"
            ? `Test accounts · ${s.draft.accounts.length}`
            : s.draft.accessKind === "legacy"
              ? "Test access · existing sign-in recipe"
              : "Test access · public app",
        ),
      );
      const accessLabel = node("label", "How should the gremlin sign in?"),
        accessSelect = node("select");
      accessSelect.id = `onboarding-${s.project.name}-access`;
      accessLabel.htmlFor = accessSelect.id;
      accessSelect.append(
        new Option("Public app · no sign-in needed", "public"),
        new Option("Password login · dedicated test accounts", "password"),
      );
      if (s.data?.environment?.legacySignIn)
        accessSelect.append(
          new Option("Keep existing sign-in recipe", "legacy"),
        );
      accessSelect.value = s.draft.accessKind;
      accessSelect.addEventListener("change", () => {
        s.draft.accessKind = accessSelect.value;
        s.accessOpen = true;
        s.formSignature = "";
        paintForm(s);
      });
      const accessWrap = node("div", undefined, "field");
      accessWrap.append(accessLabel, accessSelect);
      access.append(accessWrap);
      if (s.draft.accessKind === "password") {
        access.append(
          node(
            "p",
            "Create a dedicated test user in your app first. This form does not create accounts or assign roles. After saving, add its username and password values in Connections using the secret names below. Email codes, magic links, and SSO are not supported by this password check.",
          ),
        );
        for (const [index, account] of s.draft.accounts.entries()) {
          const row = node("section", undefined, "onboarding-account");
          for (const [key, label] of [
            ["name", "Account name / role"],
            ["usernameSecret", "Username secret reference"],
            ["passwordSecret", "Password secret reference"],
          ]) {
            const wrap = node("div", undefined, "field"),
              caption = node("label", label),
              input = node("input");
            input.id = `onboarding-${s.project.name}-account-${index}-${key}`;
            caption.htmlFor = input.id;
            input.value = account[key];
            input.autocomplete = "off";
            input.spellcheck = false;
            input.addEventListener("input", () => {
              account[key] = input.value;
              updateFormActions(s);
            });
            wrap.append(caption, input);
            row.append(wrap);
          }
          if (s.draft.accounts.length > 1)
            row.append(
              button("Remove account", () => {
                s.draft.accounts.splice(index, 1);
                s.formSignature = "";
                paintForm(s);
              }),
            );
          access.append(row);
        }
        access.append(
          button("Add test account", () => {
            s.draft.accounts.push({
              name: "",
              usernameSecret: "",
              passwordSecret: "",
            });
            s.formSignature = "";
            paintForm(s);
          }),
        );
        access.append(
          field(
            s,
            "loginPath",
            "Login path",
            "A route on this test app, such as /login.",
          ),
          field(
            s,
            "successSelector",
            "Signed-in success selector",
            "A stable element visible only after successful sign-in, such as [data-testid=account-menu].",
          ),
        );
        const selectors = settingsSheet("Advanced login selectors");
        for (const [key, label] of [
          ["usernameSelector", "Username field"],
          ["passwordSelector", "Password field"],
          ["submitSelector", "Submit button"],
        ])
          selectors.content.append(
            field(s, key, label, "CSS selector used by the browser test."),
          );
        access.append(selectors.section);
      } else if (s.draft.accessKind === "legacy")
        access.append(
          node(
            "p",
            s.data?.environment?.legacySignInSummary ||
              "Existing sign-in recipe retained. This environment test does not exercise the legacy login flow.",
          ),
        );
      else
        access.append(
          node(
            "p",
            "This checks only the public app. Password login can check a dedicated test account. Email codes, magic links, and SSO need a login method this verifier does not yet support; a public check does not verify signed-in flows.",
          ),
        );
      s.form.append(access);
      const connections = node("a", "Manage test credentials in Connections →");
      connections.href = "/connections#project-access";
      s.form.append(connections);
      const actions = node("div", undefined, "onboarding-actions");
      s.save = button(
        "Save environment",
        async () => {
          try {
            const input = window.readOnboardingTarget(s.draft);
            await run(s, "configure", {
              configurationRevision: s.draftRevision,
              ...input,
            });
          } catch (error) {
            s.error = error.message;
            paint(s);
          }
        },
        true,
      );
      actions.append(
        s.save,
        button("Discard edits & reload", () => {
          s.draft = initialDraft(s);
          s.baseline = JSON.stringify(s.draft);
          s.draftRevision = s.data.configurationRevision;
          s.formSignature = "";
          s.error = "";
          s.notice = "Saved environment restored in the form.";
          paint(s);
        }),
      );
      s.form.append(actions);
      s.draftNotice = node("p", "", "onboarding-help");
      s.form.append(s.draftNotice);
      updateFormActions(s);
    }
    function paint(s) {
      const buildFirst = Boolean(
        s.project.ideaPlanId && s.data?.foundation?.stage !== "ready",
      );
      s.foundation.hidden = !buildFirst;
      s.steps.hidden = buildFirst;
      s.verification.hidden = buildFirst;
      s.proposal.hidden = buildFirst;
      s.title.textContent = buildFirst
        ? "First, let's build your app."
        : "A safe place to test.";
      s.description.textContent = buildFirst
        ? "Your plan is ready. A Coding Gremlin can turn it into a working first version before you need a test environment."
        : "Choose where your crew can explore. Test access before using a browser environment.";
      if (buildFirst) {
        s.analysis.hidden = s.form.hidden = true;
        s.vercelSetup?.setActive(false);
        s.message.replaceChildren();
        paintFoundation(s);
        if (s.error)
          s.message.append(
            node("p", s.error, "form-message error"),
            button("Refresh status", () => load(s, true)),
          );
        else if (s.notice)
          s.message.append(node("p", s.notice, "form-message"));
        return;
      }
      const step = window.onboardingStep(s.data);
      s.steps.replaceChildren();
      for (const [index, label] of [
        "Detect",
        "Choose",
        "Test",
        "Ready",
      ].entries()) {
        const item = node(
          "li",
          `${index + 1}  ${label}`,
          index < step ? "complete" : index === step ? "current" : "",
        );
        if (index === step) item.setAttribute("aria-current", "step");
        s.steps.append(item);
      }
      s.message.replaceChildren();
      if (s.error) {
        s.message.append(
          node("p", s.error, "form-message error"),
          button("Refresh status", () => load(s, true)),
        );
      } else if (s.notice)
        s.message.append(node("p", s.notice, "form-message"));
      s.analysis.hidden = Boolean(
        (s.data?.environment || s.showForm) &&
        !s.showAnalysis &&
        !["analyzing", "publishing"].includes(s.data?.status),
      );
      s.form.hidden = !s.showForm;
      s.analysis.replaceChildren();
      const intro = node("div", undefined, "onboarding-analysis-heading"),
        image = node("img");
      image.src = "/assets/gremlin-security.webp";
      image.alt = "";
      image.width = image.height = 44;
      const text = node("div");
      text.append(
        node("h3", "Let a Setup Gremlin look first."),
        node(
          "p",
          "It follows application entrypoints, dependencies and test fixtures to suggest a setup. Analysis does not prove the app runs.",
        ),
      );
      intro.append(image, text);
      s.analysis.append(intro);
      const analyze = button(
        s.data?.status === "analyzing"
          ? "Analyzing repository…"
          : s.data?.status === "failed"
            ? "Retry analysis"
            : s.data?.report
              ? "Analyze again"
              : "Analyze repository",
        () => run(s, "discover", { revision: s.data.revision }),
      );
      analyze.disabled = disabled(s) || !s.data;
      s.analysis.append(analyze);
      const manual = button(
        s.data?.report
          ? "Choose a test environment"
          : "I already know where to test",
        () => {
          s.showForm = true;
          s.showAnalysis = false;
          paint(s);
        },
      );
      manual.disabled = disabled(s) || !s.data;
      s.analysis.append(manual);
      if (s.data?.status === "analyzing") {
        const cancel = button("Stop analysis", () =>
          run(s, "cancel", { revision: s.data.revision }),
        );
        cancel.disabled = isLocked() || s.busy;
        s.analysis.append(cancel);
      }
      s.connectionHelp = node("p", undefined, "onboarding-help");
      s.connectionLinks = node("p", undefined, "onboarding-connection-links");
      s.connectionSignature = "";
      s.analysis.append(s.connectionHelp, s.connectionLinks);
      paintConnections(s);
      if (
        s.data?.message &&
        (ongoing(s.data) || ["failed", "interrupted"].includes(s.data.status))
      )
        s.analysis.append(node("p", s.data.message, "onboarding-progress"));
      if (!s.data && s.loading)
        s.analysis.append(
          node("p", "Loading environment setup…", "onboarding-help"),
        );
      const report = s.data?.report;
      if (report) {
        if (s.data.stale)
          s.analysis.append(
            node(
              "p",
              "Repository or project settings changed since this analysis. Analyze again before using its setup files.",
              "onboarding-progress",
            ),
          );
        const recommendation = node(
          "div",
          undefined,
          "onboarding-recommendation",
        );
        recommendation.append(
          node(
            "span",
            s.data.status === "failed"
              ? "PREVIOUS SUGGESTION · LATEST ANALYSIS FAILED"
              : "SUGGESTED · NOT YET VERIFIED",
            "eyebrow muted",
          ),
          node(
            "h4",
            report.recommendation === "docker"
              ? "Try a disposable local app."
              : "Start with hosted staging.",
          ),
          node("p", String(report.summary || "").replace(/\\n\\n/g, "\n\n")),
          node("p", String(report.rationale || "").replace(/\\n\\n/g, "\n\n")),
        );
        if (report.stack?.length)
          recommendation.append(
            node("p", report.stack.join(" · "), "onboarding-help"),
          );
        if (report.missingInputs?.length) {
          recommendation.append(node("h4", "Needs your input"));
          const items = node("ul");
          for (const item of report.missingInputs) {
            const row = node("li");
            row.append(
              node("strong", item.label),
              document.createTextNode(
                ` — ${item.description}${item.required ? "" : " (optional)"}`,
              ),
            );
            items.append(row);
          }
          recommendation.append(items);
        }
        if (report.warnings?.length)
          recommendation.append(list(report.warnings, "onboarding-help"));
        const inspection = report.repository?.inspection;
        const evidence = settingsSheet(
          `Review source evidence · ${report.repository?.filesRead?.length || 0} files`,
        );
        evidence.content.append(
          node(
            "p",
            `${report.repository?.repo || s.project.repo} · ${report.repository?.branch || ""} · ${(report.repository?.sha || "").slice(0, 12)}`,
          ),
        );
        if (inspection) {
          evidence.content.append(
            node(
              "p",
              `${inspection.totalFiles} files listed${inspection.treeTruncated ? " (repository listing incomplete)" : ""} · ${Math.ceil(inspection.sourceBytes / 1024)} KiB of selected source · ${inspection.files.filter((file) => file.excerpt).length} files read in excerpts.`,
              "onboarding-help",
            ),
          );
          const reviewed = node("ul", undefined, "onboarding-source-files");
          for (const file of inspection.files) {
            const item = node("li");
            item.append(
              node("code", file.path),
              node(
                "span",
                ` — ${file.reason}${file.excerpt ? ` · excerpt${file.ranges?.length ? `, lines ${file.ranges.map((range) => `${range.start}–${range.end}`).join(", ")}` : ""}` : ""}`,
              ),
            );
            reviewed.append(item);
          }
          evidence.content.append(reviewed);
          if (inspection.criticalMissing?.length) {
            evidence.content.append(
              node("strong", "Important source is still missing"),
              list(inspection.criticalMissing),
            );
          }
          if (inspection.unresolved?.length) {
            const remaining = node("section", undefined, "onboarding-advanced");
            remaining.append(
              node("h4", "Unread references & limits"),
              list(inspection.unresolved),
            );
            evidence.content.append(remaining);
          }
          evidence.content.append(
            node(
              "p",
              `This analysis follows selected source references; it is not a complete repository audit. Budget: up to ${inspection.limits.files} source reads and ${Math.round(inspection.limits.sourceBytes / 1024)} KiB of source context.`,
              "onboarding-help",
            ),
          );
        } else {
          evidence.content.append(list(report.repository?.filesRead || []));
          evidence.content.append(
            node(
              "p",
              "This report used the earlier file-selection method. Analyze again to follow application entrypoints, imports and test fixtures with the expanded source budget.",
            ),
          );
        }
        recommendation.append(evidence.section);
        s.analysis.append(recommendation);
      }
      paintForm(s);
      s.verification.replaceChildren();
      if (s.data?.environment) {
        const environment = s.data.environment,
          result = environment.verification,
          hasCrew = Boolean(s.project.areas?.length);
        s.verification.append(
          node(
            "h3",
            result?.status === "passed"
              ? hasCrew
                ? "Your crew can explore."
                : "Ready for a PM."
              : "Test the environment.",
          ),
          node(
            "p",
            result?.message ||
              "Run a browser check against the saved environment before using it.",
          ),
        );
        const detail = node(
          "p",
          `${environment.name} · ${environment.target.kind === "url" ? environment.target.url : environment.profile === "docker" ? "Disposable local app" : environment.target.kind}`,
          "onboarding-help",
        );
        s.verification.append(detail);
        if (result?.checks?.length) {
          const checks = node("ul", undefined, "onboarding-checks");
          for (const item of result.checks)
            checks.append(
              node(
                "li",
                `${item.passed === true || item.ok === true || item.status === "passed" ? "✓" : item.passed === false || item.ok === false || item.status === "failed" ? "!" : "·"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`,
              ),
            );
          s.verification.append(checks);
        }
        s.test = button(
          result?.status === "testing"
            ? "Testing environment…"
            : result?.status === "passed"
              ? "Test again"
              : "Test environment",
          () => run(s, "verify", {}),
          result?.status !== "passed",
        );
        const primaryActions = node("div", undefined, "onboarding-actions");
        primaryActions.append(s.test);
        s.verification.append(primaryActions);
        const editActions = node("div", undefined, "onboarding-actions");
        editActions.append(
          button(
            s.showForm ? "Hide environment settings" : "Change environment",
            () => {
              s.showForm = !s.showForm;
              paint(s);
              if (s.showForm) s.form.scrollIntoView?.({ block: "start" });
            },
          ),
          button(
            s.showAnalysis
              ? "Hide repository analysis"
              : "Review repository analysis",
            () => {
              s.showAnalysis = !s.showAnalysis;
              paint(s);
              if (s.showAnalysis)
                s.analysis.scrollIntoView?.({ block: "start" });
            },
          ),
        );
        for (const action of editActions.children)
          action.classList.add("onboarding-text-button");
        s.verification.append(editActions);
        if (result?.status === "passed") {
          s.create = button(
            hasCrew ? "Open project" : "Create a PM",
            () => {
              if (hasCrew) {
                const path = `/projects/${encodeURIComponent(s.project.name)}`;
                if (!window.dashboardPages?.navigate(path))
                  window.location.assign(path);
              } else onCreatePm?.(s.project.name);
            },
            true,
          );
          s.create.disabled = isLocked() || s.busy || dirty(s);
          primaryActions.replaceChildren(s.create, s.test);
          const commands = button("Review install and test commands", () => {});
          commands.classList.add("onboarding-text-button");
          commands.dataset.editProject = s.project.name;
          s.verification.append(
            node(
              "p",
              "This browser check does not certify your coding checks. Review the repository commands before coding runs.",
              "onboarding-help",
            ),
            commands,
          );
        }
        if (result?.screenshotUrl && loadImage) {
          const screenshot = button("View browser screenshot", async () => {
            try {
              const url = new URL(result.screenshotUrl, window.location.origin);
              if (
                url.origin !== window.location.origin ||
                !url.pathname.startsWith("/api/projects/")
              )
                throw new Error(
                  "The browser screenshot address was not recognized.",
                );
              screenshot.disabled = true;
              const blob = await loadImage(url.pathname + url.search);
              if (active !== s || destroyed) return;
              if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
              s.image?.remove();
              s.imageUrl = URL.createObjectURL(blob);
              const image = node("img");
              image.src = s.imageUrl;
              image.alt = "Environment browser verification screenshot";
              image.className = "onboarding-screenshot";
              s.image = image;
              s.verification.append(image);
            } catch (error) {
              s.error = error.message;
              paint(s);
            } finally {
              screenshot.disabled = false;
            }
          });
          s.verification.append(screenshot);
        }
      }
      s.proposal.replaceChildren();
      if (report?.proposedFiles?.length) {
        const details = settingsSheet(
          `Review ${report.proposedFiles.length} proposed setup ${report.proposedFiles.length === 1 ? "file" : "files"}`,
        );
        details.content.append(
          node(
            "p",
            "These files are a proposal. A draft PR gives you a diff to review; nothing is merged automatically. New Dockerfiles must be merged before they can be used to test this repository.",
          ),
        );
        for (const file of report.proposedFiles) {
          const section = node("section");
          section.append(
            node("h4", file.path),
            node("p", file.reason),
            node("pre", file.content),
          );
          details.content.append(section);
        }
        const confirm = node("label", undefined, "onboarding-confirm"),
          checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.checked = s.reviewed;
        confirm.append(
          checkbox,
          document.createTextNode("I reviewed these proposed setup files."),
        );
        details.content.append(confirm);
        const publish = button(
          s.data?.status === "publishing"
            ? "Preparing draft PR…"
            : "Prepare setup PR",
          () => run(s, "setup-pr", { revision: s.data.revision }),
        );
        publish.disabled = disabled(s) || !s.reviewed || s.data.stale;
        checkbox.addEventListener("change", () => {
          s.reviewed = checkbox.checked;
          publish.disabled = disabled(s) || !s.reviewed || s.data.stale;
        });
        details.content.append(publish);
        s.proposal.append(details.section);
      }
      if (s.data?.setupPull?.url) {
        try {
          const url = new URL(s.data.setupPull.url);
          if (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          ) {
            const link = node(
              "a",
              `Review setup PR #${s.data.setupPull.number}`,
            );
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            s.proposal.append(link);
          }
        } catch {
          /* Unknown external URLs remain unavailable. */
        }
      }
      updateFormActions(s);
    }
    function deactivate() {
      for (const s of entries.values()) {
        clearTimeout(s.timer);
        s.vercelSetup?.setActive(false);
      }
    }
    const pagechange = (event) => {
      if (
        event.detail?.page !== "project" ||
        event.detail?.tab !== "environment"
      ) {
        active = null;
        deactivate();
      }
    };
    const visibility = () => {
      if (document.hidden) deactivate();
      else if (active) load(active, true);
    };
    window.addEventListener("dashboard:pagechange", pagechange);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", deactivate);
    return {
      syncConnections() {
        if (active) {
          paintConnections(active);
          active.vercelSetup?.syncConnections();
        }
      },
      mount(container, project) {
        const s = entry(project);
        if (active !== s) deactivate();
        active = s;
        container.append(s.node);
        paint(s);
        if (!s.form.hidden && s.draft?.profile === "hosted" && s.showVercel)
          s.vercelSetup?.setActive(true);
        load(s);
        schedule(s);
      },
      refresh(project) {
        const s = entries.get(
          typeof project === "string" ? project : project.name,
        );
        if (s) return load(s, true);
      },
      isDirty: () => [...entries.values()].some(dirty),
      dirtyProject: () => [...entries.values()].find(dirty)?.project.name,
      focusDraft(project) {
        const s = entries.get(project);
        if (!s) return;
        s.showForm = true;
        paint(s);
        s.form.querySelector?.("input,select,textarea")?.focus();
      },
      isBusy: () =>
        [...entries.values()].some((s) => s.busy || s.vercelSetup?.isBusy()),
      protectFocus: () =>
        Boolean(active?.form.contains(document.activeElement)),
      forget(project) {
        const s = entries.get(project);
        if (s) {
          clearTimeout(s.timer);
          s.vercelSetup?.destroy();
          if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
          s.generation++;
          if (active === s) active = null;
          entries.delete(project);
        }
      },
      destroy() {
        destroyed = true;
        deactivate();
        for (const s of entries.values()) {
          s.vercelSetup?.destroy();
          if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
        }
        window.removeEventListener("dashboard:pagechange", pagechange);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("pagehide", deactivate);
      },
    };
  };
})();
