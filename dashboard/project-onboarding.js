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
    data?.environmentSetup?.status === "preparing" ||
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
  const hasAppAccess = (environment) =>
    Boolean(environment?.target?.access || environment?.legacySignIn);
  const appAccessDraftKeys = [
    "accessKind",
    "accounts",
    "loginPath",
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successSelector",
    "steps",
    "authenticatedPath",
  ];
  const loginRecipeKeys = [
    "loginPath",
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successSelector",
    "steps",
    "authenticatedPath",
  ];
  function loginFailureContext(diagnosis, target) {
    const access = target?.access;
    if (diagnosis?.action !== "edit_login" || access?.kind !== "password")
      return null;
    const labels = {
      usernameSelector: "Username field",
      passwordSelector: "Password field",
      submitSelector: "Submit button",
      successSelector: "Signed-in confirmation",
    };
    const label = labels[diagnosis.field];
    return [
      diagnosis.code === "login_origin_rejected" && diagnosis.origin
        ? `Preview origin: ${diagnosis.origin}.`
        : "",
      `Tested login path: ${access.loginPath}.`,
      label && access[diagnosis.field]
        ? `${label}: ${access[diagnosis.field]}.${Number.isSafeInteger(diagnosis.matchCount) ? ` Matched ${diagnosis.matchCount} element${diagnosis.matchCount === 1 ? "" : "s"}; exactly one is required.` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  window.onboardingStep = (data) =>
    data?.environment?.verification?.status === "passed" &&
    hasAppAccess(data.environment)
      ? 3
      : data?.environment
        ? 2
        : data?.report
          ? 1
          : 0;
  function withAccess(target, draft) {
    if (draft.accessKind === "legacy") {
      const result = structuredClone(target);
      delete result.access;
      return result;
    }
    if (draft.accessKind === "public")
      return { ...target, access: { kind: "public" } };
    if (draft.accessKind !== "password")
      throw new Error(
        "Choose how your gremlins should access the app: a dedicated test account or public pages only.",
      );
    const secret = /^[A-Z][A-Z0-9_]*$/;
    if (!draft.accounts?.length)
      throw new Error("Add at least one named test account.");
    if (!draft.loginPath?.startsWith("/") || !draft.successSelector?.trim())
      throw new Error(
        "Set a login path and a signed-in success selector to verify test accounts.",
      );
    if (
      ["usernameSelector", "passwordSelector", "submitSelector"].some(
        (key) => !draft[key]?.trim(),
      )
    )
      throw new Error(
        "Detect sign-in from code, or set the username, password and submit controls in Advanced login selectors. We do not guess your app’s login form.",
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
        ...(draft.steps ? { steps: structuredClone(draft.steps) } : {}),
        ...(draft.authenticatedPath
          ? { authenticatedPath: draft.authenticatedPath }
          : {}),
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
    onConnectHosting,
    loadImage,
  }) => {
    const entries = new Map();
    let active = null,
      destroyed = false;
    const endpoint = (s, action = "") =>
      `/api/projects/${encodeURIComponent(s.project.name)}/onboarding${action ? `/${action}` : ""}`;
    const accountDirty = (s) =>
      Boolean(
        s.accountEntry?.username ||
        s.accountEntry?.password ||
        s.accountLabel?.trim(),
      );
    const dirty = (s) =>
      accountDirty(s) ||
      Boolean(s.draft && JSON.stringify(s.draft) !== s.baseline);
    const disabled = (s) =>
      isLocked() || s.busy || s.hostingConnecting || ongoing(s.data);
    const vercelTargetIdentity = (target) =>
      target?.kind === "vercel"
        ? JSON.stringify([
            target.projectId,
            target.connectionId || "default",
            target.teamId ?? null,
            target.branch ?? null,
            target.customEnvironmentId ?? null,
            target.role,
          ])
        : null;
    const projectIdentity = (project) =>
      JSON.stringify([
        project.name,
        project.instanceId ?? null,
        project.provider || "github",
        project.serverUrl ?? null,
        project.repo,
      ]);
    const hostingBinding = (s) =>
      JSON.stringify([
        vercelTargetIdentity(
          s.data?.environment?.target || s.draft?.existingTarget,
        ),
        s.project.vercel?.connectionId || "default",
        s.project.vercel?.projectId ?? null,
        s.project.vercel?.teamId ?? null,
        s.data?.environmentSetup?.action === "connect_vercel"
          ? (s.data.environmentSetup.connectionId ?? null)
          : null,
      ]);
    const manualPreviewAccessRequired = (s) =>
      s.data?.environment?.target.kind === "vercel" &&
      s.data?.environmentSetup?.action === "manage_credentials" &&
      s.data.environmentSetup.step === "connect_access";
    const previewNeedsSave = (s) =>
      dirty(s) || s.draft?.suggestedEnvironment || !s.data?.environment;
    const preparedTargetKey = (target) => {
      const sorted = (value) =>
        Array.isArray(value)
          ? value.map(sorted)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, sorted(value[key])]),
              )
            : value;
      return JSON.stringify(sorted({ ...target, bypassSecret: undefined }));
    };
    function acceptPreparedDraft(s, data) {
      if (
        !s.prepareDraft ||
        s.prepareDraft.revision === data.configurationRevision ||
        s.prepareDraft.snapshot !== JSON.stringify(s.draft) ||
        preparedTargetKey(data.environment?.target) !== s.prepareDraft.target
      )
        return false;
      s.draft = initialDraft(s);
      s.baseline = JSON.stringify(s.draft);
      s.draftRevision = data.configurationRevision;
      s.formSignature = "";
      s.prepareDraft = null;
      s.showForm = false;
      return true;
    }
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
        accessKind: access?.kind || (legacy ? "legacy" : ""),
        loginPath: access?.loginPath || "",
        usernameSelector: access?.usernameSelector || "",
        passwordSelector: access?.passwordSelector || "",
        submitSelector: access?.submitSelector || "",
        successSelector: access?.successSelector || "",
        ...(access?.steps ? { steps: structuredClone(access.steps) } : {}),
        ...(access?.authenticatedPath
          ? { authenticatedPath: access.authenticatedPath }
          : {}),
        accounts: structuredClone(
          access?.accounts || [
            {
              name: "Test user",
              usernameSecret: `${prefix}_TEST_USER_USERNAME`,
              passwordSecret: `${prefix}_TEST_USER_PASSWORD`,
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
      const recommended =
        s.data?.recommendedDocker?.status === "ready"
          ? s.data.recommendedDocker.target
          : null;
      const proposed =
        recommended || (s.data?.stale ? null : s.data?.report?.docker);
      const local = target?.kind === "docker" ? target : proposed;
      const profile =
        environment?.profile ||
        (recommended && "docker") ||
        s.data?.report?.recommendation ||
        "hosted";
      const advanced = {};
      for (const key of ["start", "env", "services", "migrate", "seed"])
        if (local?.[key] !== undefined) advanced[key] = local[key];
      return {
        ...protectionDraft(target, s.project),
        ...accessDraft(
          s.data?.testAccountSetupSupported &&
            !target?.access &&
            !s.data?.environment?.legacySignIn &&
            s.data.testAccountSuggestion?.kind === "password" &&
            s.data.testAccountSuggestion.recipe
            ? {
                ...(target || recommended),
                access: {
                  kind: "password",
                  ...s.data.testAccountSuggestion.recipe,
                },
              }
            : target || recommended,
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
    function readAppAccessTarget(s) {
      const saved = s.data?.environment;
      if (!saved) return window.readOnboardingTarget(s.draft);
      const hostingFields = (draft) =>
        Object.fromEntries(
          Object.entries(draft).filter(
            ([key]) => !appAccessDraftKeys.includes(key),
          ),
        );
      if (
        JSON.stringify(hostingFields(s.draft)) ===
        JSON.stringify(hostingFields(JSON.parse(s.baseline)))
      )
        return {
          profile: saved.profile,
          environment: saved.name,
          target: withAccess(structuredClone(saved.target), s.draft),
        };
      const input = window.readOnboardingTarget(s.draft);
      if (
        !input.environment &&
        input.target.kind === saved.target.kind &&
        ["url", "docker"].includes(input.target.kind)
      ) {
        // These controls edit the selected environment. Keep its identity and
        // non-editable options while applying every edited field, including
        // removal of optional runtime settings from the advanced draft.
        const target = structuredClone(saved.target);
        for (const key of input.target.kind === "url"
          ? ["url"]
          : [
              "recipe",
              "port",
              "healthPath",
              "start",
              "env",
              "services",
              "migrate",
              "seed",
            ])
          delete target[key];
        return {
          ...input,
          environment: saved.name,
          target: { ...target, ...input.target, role: saved.target.role },
        };
      }
      return input;
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
      const previous = entries.get(project.name);
      if (
        previous &&
        projectIdentity(previous.project) !== projectIdentity(project)
      ) {
        clearTimeout(previous.timer);
        previous.accountEntry = {};
        previous.vercelSetup?.destroy();
        if (previous.imageUrl) URL.revokeObjectURL(previous.imageUrl);
        previous.generation++;
        entries.delete(project.name);
      }
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
        s.title = node("h2", "Your test environment.");
        s.description = node(
          "p",
          "Connect a preview, add any test account, then verify browser access.",
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
        s.automatic = node("section", undefined, "onboarding-automatic");
        s.localSetup = node(
          "section",
          undefined,
          "onboarding-docker-recommendation",
        );
        s.appAccess = node("section", undefined, "onboarding-app-access");
        s.appAccess.id = "project-app-access";
        s.form = node("section", undefined, "onboarding-choice");
        s.verification = node("section", undefined, "onboarding-verification");
        s.proposal = node("section", undefined, "onboarding-proposal");
        s.node.append(
          s.heading,
          s.foundation,
          s.steps,
          s.message,
          s.localSetup,
          s.appAccess,
          s.automatic,
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
        const previousRevision = s.data?.configurationRevision;
        if (
          JSON.stringify(s.data?.report?.proposedFiles) !==
          JSON.stringify(data.report?.proposedFiles)
        )
          s.reviewed = false;
        s.data = data;
        if (s.hostingResume?.identity === projectIdentity(s.project))
          s.hostingResume.loaded = true;
        s.loaded = true;
        s.error = "";
        if (
          s.notice ===
            "Test account saved. We’re checking whether the crew can sign in." &&
          data.environment?.verification?.status !== "testing"
        )
          s.notice =
            "Test account saved. Review its latest browser check below.";
        const savedPreparation = acceptPreparedDraft(s, data);
        if (
          wasDirty &&
          !savedPreparation &&
          s.draftRevision !== data.configurationRevision
        )
          s.notice =
            "Project settings changed elsewhere. Your draft is kept; discard and reload before applying it to the newer configuration.";
        if (
          !wasDirty &&
          !s.form.contains(document.activeElement) &&
          !s.appAccess.contains(document.activeElement)
        ) {
          s.draft = initialDraft(s);
          s.baseline = JSON.stringify(s.draft);
          s.draftRevision = data.configurationRevision;
          s.formSignature = "";
        }
        if (
          s.preparingSaved &&
          previousRevision !== data.configurationRevision
        ) {
          s.preparingSaved = false;
          await onSaved(s.project.name);
        }
        if (
          data.environmentSetup?.status &&
          data.environmentSetup.status !== "preparing"
        )
          s.preparingSaved = false;
      } catch (error) {
        if (s.hostingResume) s.environmentActivated = false;
        s.hostingResume = null;
        if (generation === s.generation)
          s.error = error.message || "Environment setup could not be loaded.";
      } finally {
        if (generation === s.generation) {
          s.loading = false;
          paint(s);
          schedule(s);
          maybePrepareEnvironment(s);
        }
      }
    }
    function hostingConnection(s) {
      const status = getStatus(),
        connections = (status?.serviceConnections || []).filter(
          (connection) => connection.provider === "vercel",
        ),
        target = s.data?.environment?.target || s.draft?.existingTarget,
        reconnectId =
          s.data?.environmentSetup?.action === "connect_vercel"
            ? s.data.environmentSetup.connectionId
            : undefined,
        id =
          reconnectId ||
          (target?.kind === "vercel" && (target.connectionId || "default")) ||
          (s.project.vercel && (s.project.vercel.connectionId || "default")) ||
          connections.find(
            (connection) =>
              connection.id === "default" &&
              connection.connected &&
              !connection.needsReconnect,
          )?.id ||
          connections.find(
            (connection) => connection.connected && !connection.needsReconnect,
          )?.id ||
          connections.find((connection) => connection.id === "default")?.id ||
          connections[0]?.id ||
          "default",
        connection = connections.find((item) => item.id === id);
      if (
        s.hostingFailure &&
        (s.hostingFailure.connectionId !== id ||
          s.hostingFailure.binding !== hostingBinding(s))
      )
        s.hostingFailure = null;
      const unavailable =
        connection?.available === false &&
        (!connection.connected || connection.needsReconnect) &&
        ["not_configured", "provider_unavailable"].includes(
          connection.availabilityReason,
        );
      return {
        id,
        label: connection?.name || id,
        known: Array.isArray(status?.serviceConnections),
        ready: Boolean(connection?.connected && !connection.needsReconnect),
        reconnect: Boolean(connection?.needsReconnect || reconnectId),
        failure: unavailable
          ? {
              connectionId: id,
              needsOperator: connection.availabilityReason === "not_configured",
              message:
                connection.message ||
                "Vercel sign-in is unavailable. Check again to continue.",
            }
          : null,
      };
    }
    async function connectHosting(
      s,
      connectionId = hostingConnection(s).id,
      delegated = false,
    ) {
      if (
        active !== s ||
        destroyed ||
        disabled(s) ||
        entries.get(s.project.name) !== s
      )
        return;
      const identity = projectIdentity(s.project),
        binding = hostingBinding(s),
        current = () =>
          !destroyed &&
          entries.get(s.project.name) === s &&
          projectIdentity(s.project) === identity;
      s.hostingConnecting = true;
      s.error = "";
      paint(s);
      try {
        if (onConnectHosting) await onConnectHosting(s.project, connectionId);
        else if (
          !window.dashboardPages?.navigate("/connections#vercel-connection")
        )
          window.location.assign("/connections#vercel-connection");
        if (current()) s.hostingFailure = null;
      } catch (error) {
        if (delegated) throw error;
        if (current() && hostingBinding(s) === binding)
          s.hostingFailure = {
            connectionId,
            binding,
            needsOperator:
              error.code === "oauth_unavailable" &&
              error.availabilityReason === "not_configured",
            message:
              error.message ||
              "Vercel sign-in could not start. Retry to check the connection and open Vercel.",
          };
      } finally {
        if (current()) {
          s.hostingConnecting = false;
          paint(s);
        }
      }
    }
    function hasDockerRecommendation(s) {
      return Boolean(
        s.data?.recommendedDocker &&
        (s.data.report?.recommendation === "docker" ||
          s.data.recommendedDocker.target?.kind === "docker"),
      );
    }
    function canPrepareEnvironment(s) {
      if (!s.data?.environmentSetupSupported) return false;
      if (s.project.ideaPlanId && s.data.foundation?.stage !== "ready")
        return false;
      if (!s.data.environment && hasDockerRecommendation(s)) return false;
      if (s.data.environment) {
        const connection = hostingConnection(s);
        return (
          s.data.environment.target.kind === "vercel" &&
          (!connection.known || connection.ready)
        );
      }
      return (getStatus()?.serviceConnections || []).some(
        (connection) =>
          connection.provider === "vercel" &&
          connection.connected &&
          !connection.needsReconnect,
      );
    }
    function maybePrepareEnvironment(s) {
      if (s.hostingResume?.loaded && !s.loading) {
        const resume = s.hostingResume;
        s.hostingResume = null;
        if (
          active !== s ||
          destroyed ||
          entries.get(s.project.name) !== s ||
          resume.identity !== projectIdentity(s.project) ||
          dirty(s) ||
          disabled(s) ||
          !canPrepareEnvironment(s) ||
          !hostingConnection(s).ready ||
          s.data.environment?.verification?.status === "passed" ||
          (s.data.environmentSetup &&
            s.data.environmentSetup.action !== "connect_vercel") ||
          s.hostingResumedRevision === s.data.configurationRevision
        )
          return;
        s.environmentActivated = false;
        s.autoPreparedRevision = s.hostingResumedRevision =
          s.data.configurationRevision;
        void prepareEnvironment(
          s,
          undefined,
          s.data.environmentSetup?.action === "connect_vercel",
        );
        return;
      }
      if (!s.environmentActivated || !s.loaded || s.loading || disabled(s))
        return;
      s.environmentActivated = false;
      if (
        active !== s ||
        destroyed ||
        dirty(s) ||
        !canPrepareEnvironment(s) ||
        s.data.environmentSetup ||
        s.data.environment?.verification?.status === "passed" ||
        s.autoPreparedRevision === s.data.configurationRevision
      )
        return;
      s.autoPreparedRevision = s.data.configurationRevision;
      void prepareEnvironment(s);
    }
    async function prepareEnvironment(s, target, force = false) {
      if (disabled(s) || s.loading || !s.data || (dirty(s) && !target)) return;
      const identity = projectIdentity(s.project),
        current = () =>
          !destroyed &&
          entries.get(s.project.name) === s &&
          projectIdentity(s.project) === identity;
      clearTimeout(s.timer);
      s.busy = s.preparePending = true;
      s.preparingSaved = true;
      s.error = s.notice = "";
      if (target && dirty(s))
        s.prepareDraft = {
          revision: s.draftRevision,
          snapshot: JSON.stringify(s.draft),
          target: preparedTargetKey(target),
        };
      paint(s);
      try {
        const data = await api(endpoint(s, "prepare-environment"), {
          configurationRevision: target
            ? s.draftRevision
            : s.data.configurationRevision,
          ...(target ? { target } : {}),
          ...(force ? { force: true } : {}),
        });
        if (!current()) return;
        const previousRevision = s.data.configurationRevision;
        s.data = data;
        s.loaded = true;
        s.showAnalysis = false;
        acceptPreparedDraft(s, data);
        if (!dirty(s)) {
          s.draft = initialDraft(s);
          s.baseline = JSON.stringify(s.draft);
          s.draftRevision = data.configurationRevision;
          s.formSignature = "";
        }
        if (!dirty(s)) s.showForm = false;
        if (previousRevision !== data.configurationRevision) {
          s.preparingSaved = false;
          await onSaved(s.project.name);
        }
        if (
          data.environmentSetup?.status &&
          data.environmentSetup.status !== "preparing"
        )
          s.preparingSaved = false;
      } catch (error) {
        if (current())
          s.error =
            error.message ||
            "Environment setup could not start. Your settings are kept.";
      } finally {
        if (current()) {
          s.busy = s.preparePending = false;
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
        if (action === "configure" || action === "prepare-docker") {
          s.notice =
            action === "prepare-docker"
              ? "Local Docker setup saved. Follow the browser test below; a saved recipe is not a passing test."
              : "Environment saved. Test it before the crew uses it.";
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
    async function connectPreviewAccess(s) {
      if (disabled(s) || s.loading || !s.data || !s.draft) return;
      const identity = projectIdentity(s.project),
        current = () =>
          !destroyed &&
          entries.get(s.project.name) === s &&
          projectIdentity(s.project) === identity;
      let changed = false;
      try {
        const input = window.readOnboardingTarget(s.draft),
          targetIdentity = vercelTargetIdentity(input.target);
        if (!targetIdentity || input.target.role === "production")
          throw new Error("Choose a Vercel preview before connecting access.");
        const acceptState = (data) => {
          if (
            !data ||
            data.project !== s.project.name ||
            typeof data.configurationRevision !== "string" ||
            !data.configurationRevision ||
            data.environment?.profile !== "hosted" ||
            vercelTargetIdentity(data.environment?.target) !== targetIdentity
          )
            throw new Error(
              "Preview access returned an unexpected environment. Refresh status before retrying; your draft is kept.",
            );
        };
        clearTimeout(s.timer);
        s.busy = s.accessPending = true;
        s.error = s.notice = "";
        paint(s);
        let revision = s.draftRevision;
        if (previewNeedsSave(s)) {
          const draftBeforeSave = JSON.stringify(s.draft),
            data = await api(endpoint(s, "configure"), {
              configurationRevision: revision,
              ...input,
            });
          if (!current()) return;
          acceptState(data);
          changed = true;
          s.data = data;
          s.loaded = true;
          s.draftRevision = revision = data.configurationRevision;
          const savedDraft = initialDraft(s);
          s.baseline = JSON.stringify(savedDraft);
          if (JSON.stringify(s.draft) !== draftBeforeSave)
            throw new Error(
              "Environment saved. Your newer edits are kept; save them before connecting preview access.",
            );
          s.draft = savedDraft;
          s.formSignature = "";
          paint(s);
        }
        const draftBeforeAccess = JSON.stringify(s.draft),
          data = await api(endpoint(s, "vercel/access"), {
            configurationRevision: revision,
          });
        if (!current()) return;
        acceptState(data);
        if (
          !["connected", "not_required"].includes(data.previewAccess?.status) ||
          typeof data.previewAccess?.message !== "string" ||
          !data.previewAccess.message.trim()
        )
          throw new Error(
            "Preview access did not return a connection result. Refresh status before retrying; your draft is kept.",
          );
        changed = true;
        s.data = data;
        s.loaded = true;
        s.draftRevision = data.configurationRevision;
        const savedDraft = initialDraft(s);
        s.baseline = JSON.stringify(savedDraft);
        if (JSON.stringify(s.draft) === draftBeforeAccess) {
          s.draft = savedDraft;
          s.showForm = false;
        }
        s.formSignature = "";
        s.notice =
          "Preview access updated. Test the environment to verify browser access.";
      } catch (error) {
        if (current())
          s.error =
            error.message ||
            "Preview access could not be connected. Your environment settings are kept.";
      } finally {
        if (current()) {
          s.busy = s.accessPending = false;
          paint(s);
          schedule(s);
          if (changed) {
            try {
              await onSaved(s.project.name);
            } catch {
              if (current()) {
                s.notice =
                  "Environment settings were saved. Refresh project status to reload the latest details, then test access.";
                paint(s);
              }
            }
          }
        }
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
      (s.inputs ||= {})[key] = input;
      caption.htmlFor = input.id;
      if (type !== "textarea") input.type = type;
      input.value = s.draft[key] ?? "";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        s.draft[key] = input.value;
        if (s.recoveryField === key) {
          s.recoveryField = null;
          input.setAttribute("aria-invalid", "false");
        }
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
      if (s.localPrepare)
        s.localPrepare.disabled = disabled(s) || s.loading || dirty(s);
      const preparing =
        s.preparePending || s.data?.environmentSetup?.status === "preparing";
      if (!s.accessPending && !preparing && s.accessLockedControls) {
        for (const [control, wasDisabled] of s.accessLockedControls)
          control.disabled = wasDisabled;
        s.accessLockedControls.clear();
      }
      const choosingPreview =
        s.draft?.profile === "hosted" &&
        s.showVercel &&
        !s.draft.providerTarget &&
        !s.draft.existing;
      if (s.save)
        s.save.disabled =
          disabled(s) || !s.data || !s.draft?.accessKind || choosingPreview;
      if (s.accessSave) {
        s.accessSave.disabled = disabled(s) || s.loading;
        if (s.data?.testAccountSetupSupported)
          s.accessSave.textContent = s.busy
            ? "Connecting & testing…"
            : "Connect & test";
      }
      for (const choice of s.appAccess?.querySelectorAll(
        "button,input,select,textarea",
      ) || [])
        choice.disabled = disabled(s) || s.loading;
      if (s.test)
        s.test.disabled =
          disabled(s) || dirty(s) || !hasAppAccess(s.data?.environment);
      if (s.create) s.create.disabled = isLocked() || s.busy || dirty(s);
      const accessConnected =
        !previewNeedsSave(s) &&
        s.draft?.profile === "hosted" &&
        ["saved", "verified", "connected", "not_required"].includes(
          s.data?.previewAccess?.status,
        ) &&
        vercelTargetIdentity(
          s.draft.providerTarget || s.draft.existingTarget,
        ) === vercelTargetIdentity(s.data?.environment?.target);
      for (const action of [s.formPreviewAccess, s.savedPreviewAccess]) {
        if (!action) continue;
        action.textContent = s.accessPending
          ? accessConnected
            ? "Checking preview access…"
            : "Connecting preview access…"
          : previewNeedsSave(s)
            ? "Save & connect preview access"
            : accessConnected
              ? "Check preview access"
              : "Connect preview access";
        action.className = accessConnected
          ? "small-button"
          : "button button-dark";
        action.disabled = Boolean(
          disabled(s) || s.loading || !s.data || choosingPreview,
        );
      }
      if (s.draftNotice)
        s.draftNotice.textContent = choosingPreview
          ? "Choose a ready Vercel preview before saving, or enter a test URL instead."
          : s.draft?.suggestedEnvironment
            ? "Suggested from your saved Vercel settings · save this choice, then test access. It is not verified yet."
            : dirty(s)
              ? "Unsaved changes · save this choice before testing."
              : !s.draft?.accessKind
                ? "Choose app sign-in access above before saving."
                : s.data?.testAccountSetupSupported
                  ? "Test accounts stay with this project. Saving does not start a PM or enable automation."
                  : "Credentials stay in Connections. Saving does not start a PM or enable automation.";
      if (s.verificationDraftNotice) {
        s.verificationDraftNotice.hidden = !dirty(s);
        s.verificationDraftNotice.textContent =
          "You have unsaved changes. These results describe the saved environment; save your changes before testing again.";
      }
      if (s.recoveryAction)
        s.recoveryAction.disabled = disabled(s) || s.loading;
      for (const control of s.prepareControls || [])
        control.disabled =
          disabled(s) || s.loading || (control.needsCleanDraft && dirty(s));
      s.form.inert = Boolean(s.accessPending || preparing);
      if (s.accessPending || preparing) {
        s.accessLockedControls ||= new Map();
        for (const control of s.form.querySelectorAll?.(
          "button,input,select,textarea",
        ) || []) {
          if (!s.accessLockedControls.has(control))
            s.accessLockedControls.set(control, control.disabled);
          control.disabled = true;
        }
      }
    }
    function previewAccessCard(s, target, manual = false) {
      const card = node("section", undefined, "onboarding-vercel-protection"),
        result =
          vercelTargetIdentity(target) ===
          vercelTargetIdentity(s.data?.environment?.target)
            ? s.data?.previewAccess
            : null,
        action = button(
          "Connect preview access",
          () => connectPreviewAccess(s),
          true,
        );
      if (manual) s.formPreviewAccess = action;
      else s.savedPreviewAccess = action;
      if (manual && s.data?.environmentSetupSupported) {
        s.formPreviewAccess = null;
        card.append(
          node(
            "h4",
            manualPreviewAccessRequired(s)
              ? "One-time preview access"
              : "Preview access",
          ),
          node(
            "p",
            manualPreviewAccessRequired(s)
              ? "Add a dedicated bypass secret under Vercel preview access in Connections, then verify preview access above. Your Vercel connection stays connected."
              : "Saving checks Vercel protection and tests access from your runner. We’ll ask for a one-time access secret only if Vercel requires it.",
            "onboarding-help",
          ),
        );
        return card;
      }
      card.append(
        node("h4", "Vercel preview access"),
        node(
          "p",
          result?.status === "verified"
            ? "Preview access verified by the browser check."
            : result?.status === "saved"
              ? "Bypass credential saved. Test the environment to verify that it works."
              : result?.status === "missing"
                ? "The bypass credential is missing. A reference name is saved, but its value is not in Connections. Connect preview access to repair it."
                : result?.status === "connected"
                  ? "Access connected. Test the environment next."
                  : result?.status === "not_required"
                    ? "No deployment protection detected. Test the environment next."
                    : target.bypassSecret
                      ? "A bypass reference is saved. Connect to check the setup, then test browser access."
                      : "Let ShipGremlins check preview protection and connect automation access when needed.",
          "onboarding-help",
        ),
        action,
        node(
          "p",
          "The automation credential works across this Vercel project’s deployments. Protection stays on. Your app’s own sign-in is separate.",
          "onboarding-help",
        ),
      );
      if (manual) {
        const advanced = settingsSheet("Advanced preview access"),
          label = node("label", undefined, "onboarding-confirm"),
          enabled = node("input");
        enabled.type = "checkbox";
        enabled.checked = s.draft.vercelBypassEnabled;
        enabled.addEventListener("change", () => {
          s.draft.vercelBypassEnabled = enabled.checked;
          s.notice = "";
          updateFormActions(s);
        });
        label.append(enabled, node("span", "Use a saved bypass credential"));
        const credentials = node("a", "Open project access in Connections →");
        credentials.href = "/connections#project-access";
        advanced.content.append(
          node(
            "p",
            "Use this option to manage your own Vercel automation credential. Enter only its reference name here; save the token privately in Connections. Save environment to apply manual changes.",
          ),
          label,
          field(
            s,
            "vercelBypassSecret",
            "Secret name",
            "A saved reference, never the token itself.",
          ),
          credentials,
        );
        card.append(advanced.section);
      } else {
        card.append(
          button("Manage preview access settings", () => {
            if (disabled(s)) return;
            s.showForm = true;
            paint(s);
            s.formPreviewAccess?.focus({ preventScroll: true });
            s.form.scrollIntoView?.({ block: "start" });
          }),
        );
      }
      return card;
    }
    function managedRecipe(s) {
      return Object.fromEntries(
        loginRecipeKeys
          .filter((key) => s.draft[key] !== undefined && s.draft[key] !== "")
          .map((key) => [key, structuredClone(s.draft[key])]),
      );
    }
    function managedAccount(s) {
      const accounts = s.data?.testAccounts || [];
      return accounts.find(
        (account) => account.index === (s.accountIndex ?? 0),
      );
    }
    function openManagedAccess(s) {
      if (disabled(s) || s.loading) return;
      s.editAppAccess = true;
      s.accessMethodChoice = false;
      s.formSignature = "";
      paint(s);
      s.appAccess.hidden = false;
      s.appAccess.scrollIntoView?.({ block: "start", behavior: "smooth" });
      s.appAccess.querySelectorAll("input")[0]?.focus({ preventScroll: true });
    }
    async function connectTestAccount(s) {
      if (disabled(s) || s.loading || !s.data?.environment) return;
      const identity = projectIdentity(s.project),
        current = () =>
          !destroyed &&
          entries.get(s.project.name) === s &&
          projectIdentity(s.project) === identity,
        saved = managedAccount(s),
        values = s.accountEntry || {},
        recipe = managedRecipe(s),
        original = s.data.environment.target.access,
        hint = s.data.testAccountSuggestion,
        sourceRecipe = original?.kind === "password" ? original : hint?.recipe;
      const missing = [
        "loginPath",
        "usernameSelector",
        "passwordSelector",
        "submitSelector",
        "successSelector",
      ].some((key) => !recipe[key]);
      if (missing) {
        s.error =
          "We still need to discover this app’s sign-in flow. Find sign-in below, or review the advanced recipe.";
        paint(s);
        return;
      }
      if (
        (!saved?.usernameSaved && !values.username?.trim()) ||
        (!saved?.passwordSaved && !values.password)
      ) {
        s.error =
          "Enter the test account’s email and password, then connect it.";
        paint(s);
        return;
      }
      const baseline = s.baseline ? JSON.parse(s.baseline) : {},
        environmentChanged = Object.keys(s.draft).some(
          (key) =>
            !appAccessDraftKeys.includes(key) &&
            JSON.stringify(s.draft[key]) !== JSON.stringify(baseline[key]),
        );
      if (environmentChanged) {
        s.error =
          "Save your environment changes before connecting this account. Your account entries are kept.";
        paint(s);
        return;
      }
      const unchangedRecipe =
        sourceRecipe &&
        loginRecipeKeys.every(
          (key) =>
            JSON.stringify(recipe[key]) === JSON.stringify(sourceRecipe[key]),
        );
      const account = {
        name: s.accountLabel?.trim() || saved?.name || "Test user",
        ...(saved?.id ? { id: saved.id } : saved ? { index: saved.index } : {}),
        ...(values.username?.trim()
          ? { username: values.username.trim() }
          : {}),
        ...(values.password ? { password: values.password } : {}),
      };
      const input = {
        configurationRevision: s.draftRevision,
        ...(original?.kind !== "password" && hint?.sourceRevision
          ? { sourceRevision: hint.sourceRevision }
          : {}),
        ...(!unchangedRecipe ? { recipe } : {}),
        account,
      };
      clearTimeout(s.timer);
      s.busy = true;
      s.error = s.notice = "";
      paint(s);
      try {
        const data = await api(endpoint(s, "connect-test-account"), input);
        if (!current()) return;
        for (const field of s.appAccess.querySelectorAll("input"))
          if (/test-(username|password)$/.test(field.id)) field.value = "";
        s.accountEntry = {};
        s.accountLabel = "";
        s.data = data;
        s.loaded = true;
        s.draft = initialDraft(s);
        s.baseline = JSON.stringify(s.draft);
        s.draftRevision = data.configurationRevision;
        s.editAppAccess = false;
        s.formSignature = "";
        s.notice =
          "Test account saved. We’re checking whether the crew can sign in.";
        try {
          await onSaved(s.project.name);
        } catch {
          if (current())
            s.notice +=
              " The dashboard could not refresh; your account is saved.";
        }
      } catch (error) {
        if (current())
          s.error =
            error.message ||
            "The account could not be connected. Your entries are kept here; retry when ready.";
      } finally {
        if (current()) {
          s.busy = false;
          paint(s);
          schedule(s);
        }
      }
    }
    function paintManagedAccess(s) {
      const access = s.appAccess,
        savedAccess = s.data.environment?.target.access,
        hint = s.data.testAccountSuggestion,
        account = managedAccount(s),
        verification = s.data.environment?.verification,
        recipe = managedRecipe(s),
        complete = [
          "loginPath",
          "usernameSelector",
          "passwordSelector",
          "submitSelector",
          "successSelector",
        ].every((key) => recipe[key]),
        password = s.draft.accessKind === "password";
      s.accessSave = null;
      access.replaceChildren(node("span", "TEST ACCESS", "eyebrow muted"));
      const choosePassword = () => {
        if (disabled(s)) return;
        s.draft.accessKind = "password";
        if (hint?.recipe)
          for (const key of loginRecipeKeys) {
            if (hint.recipe[key] !== undefined)
              s.draft[key] = structuredClone(hint.recipe[key]);
          }
        s.accessMethodChoice = false;
        s.editAppAccess = true;
        s.formSignature = "";
        paint(s);
      };
      const choosePublic = async () => {
        if (disabled(s) || s.loading) return;
        s.draft.accessKind = "public";
        s.accessMethodChoice = false;
        s.formSignature = "";
        if (!s.data.environment) {
          s.showForm = true;
          paint(s);
          return;
        }
        try {
          await run(s, "configure", {
            configurationRevision: s.draftRevision,
            ...readAppAccessTarget(s),
          });
          if (!s.error && !destroyed && entries.get(s.project.name) === s) {
            s.accountEntry = {};
            s.accountLabel = "";
            s.editAppAccess = false;
            await run(s, "verify", {});
          }
        } catch (error) {
          s.error = error.message;
          paint(s);
        }
      };
      const showMethods = () => {
        if (disabled(s)) return;
        s.accessMethodChoice = true;
        s.formSignature = "";
        paint(s);
      };
      if (s.accessMethodChoice || !s.draft.accessKind) {
        const unsupported = ["email-code", "sso"].includes(hint?.kind);
        access.append(
          node(
            "h3",
            unsupported
              ? "This app uses a different sign-in method."
              : "What should your crew be able to test?",
          ),
          node(
            "p",
            unsupported
              ? `We found ${hint.kind === "sso" ? "SSO" : "email-code or magic-link"} sign-in. Automated access for this method is not supported yet. Your app’s authentication stays unchanged.`
              : hint?.summary ||
                  "Connect a dedicated account for signed-in journeys, or explicitly limit testing to public pages.",
            "onboarding-access-intro",
          ),
        );
        const actions = node("div", undefined, "onboarding-actions");
        if (!unsupported || savedAccess?.kind === "password")
          actions.append(
            button("Connect a test account", choosePassword, !unsupported),
          );
        actions.append(button("Explore public pages for now", choosePublic));
        if (unsupported)
          actions.append(
            button("My test app also has password sign-in", choosePassword),
          );
        access.append(
          actions,
          node(
            "p",
            "Public-only testing leaves account, billing and other signed-in journeys unverified.",
            "onboarding-help",
          ),
        );
        return;
      }
      if (!password) {
        access.append(
          node(
            "h3",
            s.draft.accessKind === "public"
              ? "Public pages only."
              : "Your existing sign-in recipe is kept.",
          ),
          node(
            "p",
            s.draft.accessKind === "public"
              ? "Your crew can explore pages that don’t require an account. Signed-in journeys are outside this coverage."
              : "This legacy sign-in method is preserved. The browser access check does not verify its login flow.",
            "onboarding-access-intro",
          ),
          button("Add sign-in", choosePassword),
          button("Use another sign-in method", showMethods),
        );
        return;
      }
      if (
        savedAccess?.kind === "password" &&
        !s.editAppAccess &&
        account?.usernameSaved &&
        account?.passwordSaved
      ) {
        access.append(
          node(
            "h3",
            verification?.status === "passed"
              ? "Your crew can test while signed in."
              : verification?.status === "testing"
                ? "Checking your test account…"
                : "Your test account is saved.",
          ),
          node(
            "p",
            `${account.name} · ${s.data.environment.name}. ${verification?.status === "passed" ? "Sign-in was verified. Individual journeys and permissions still need their own evidence." : "Credentials are saved. The browser test below checks whether sign-in works."}`,
            "onboarding-access-intro",
          ),
          button("Manage test account", () => openManagedAccess(s)),
        );
        return;
      }
      access.append(
        node(
          "h3",
          account
            ? "Reconnect your test account."
            : "Give your crew a test account.",
        ),
      );
      if (complete)
        access.append(
          node(
            "p",
            account
              ? "Saved details stay private. Leave a field blank to keep its saved value."
              : "We found password sign-in. Use an account in your test environment; your gremlins may create test data while working.",
            "onboarding-access-intro",
          ),
        );
      else
        access.append(
          node(
            "p",
            "We need to identify the login flow before using your account. Your account and app settings stay unchanged during discovery.",
            "onboarding-access-intro",
          ),
          button(
            disabled(s) ? "Finding sign-in…" : "Find sign-in",
            () => run(s, "discover", {}),
            true,
          ),
        );
      if ((s.data.testAccounts || []).length > 1) {
        const label = node("label", "Test account"),
          select = node("select");
        select.id = `onboarding-${s.project.name}-test-account`;
        label.htmlFor = select.id;
        for (const item of s.data.testAccounts)
          select.append(new Option(item.name, String(item.index)));
        select.value = String(s.accountIndex ?? 0);
        select.addEventListener("change", () => {
          s.accountIndex = Number(select.value);
          s.accountEntry = {};
          s.accountLabel = "";
          s.formSignature = "";
          paint(s);
        });
        access.append(label, select);
      }
      if (complete && s.data.environment) {
        const form = node("div", undefined, "test-account-fields");
        for (const [key, label, saved] of [
          ["username", "Email or username", account?.usernameSaved],
          ["password", "Password", account?.passwordSaved],
        ]) {
          const wrap = node("div", undefined, "field"),
            caption = node("label", label),
            input = node("input");
          input.id = `onboarding-${s.project.name}-test-${key}`;
          caption.htmlFor = input.id;
          input.type = key === "password" ? "password" : "text";
          input.autocomplete = key === "password" ? "new-password" : "off";
          input.spellcheck = false;
          input.value = s.accountEntry?.[key] || "";
          input.placeholder = saved
            ? "Saved — leave blank to keep"
            : key === "username"
              ? "test-user@example.com"
              : "Test account password";
          input.addEventListener("input", () => {
            const wasDirty = dirty(s);
            (s.accountEntry ||= {})[key] = input.value;
            if (wasDirty !== dirty(s)) paint(s);
            else updateFormActions(s);
          });
          wrap.append(caption, input);
          form.append(wrap);
        }
        access.append(form);
        const actions = node("div", undefined, "onboarding-actions");
        s.accessSave = button(
          s.busy ? "Connecting & testing…" : "Connect & test",
          () => connectTestAccount(s),
          true,
        );
        actions.append(
          s.accessSave,
          button("Use another sign-in method", showMethods),
        );
        access.append(actions);
      } else if (complete)
        access.append(
          node(
            "p",
            "Save your test environment below, then connect the account here.",
            "onboarding-help",
          ),
        );
      const inspector = settingsSheet("Advanced sign-in recipe");
      s.loginSelectors = inspector;
      inspector.dialog.addEventListener("close", () => {
        s.formSignature = "";
        paint(s);
      });
      inspector.content.append(
        node(
          "p",
          "These details are normally discovered for you. Changes are applied with Connect & test; they are not proof that sign-in works.",
        ),
      );
      for (const [key, label] of [
        ["loginPath", "Login path"],
        ["usernameSelector", "Username field"],
        ["passwordSelector", "Password field"],
        ["submitSelector", "Submit button"],
        ["successSelector", "Signed-in confirmation"],
        ["authenticatedPath", "Protected page to verify (optional)"],
      ])
        inspector.content.append(field(s, key, label, undefined));
      if (recipe.steps?.length)
        inspector.content.append(
          node("h3", "Discovered sign-in steps"),
          list(
            recipe.steps.map((step) =>
              step.kind === "fill"
                ? `Enter the private ${step.credential} in ${step.selector}`
                : step.kind === "navigate"
                  ? `Open ${step.path}`
                  : step.kind === "wait"
                    ? `Wait for ${step.selector} to be ${step.state}`
                    : step.kind === "select"
                      ? `Select ${step.value} in ${step.selector}`
                      : `Click ${step.selector}`,
            ),
            "onboarding-login-steps",
          ),
          node(
            "p",
            "These discovered steps are preserved when you update the account. Find sign-in again if the flow has changed.",
            "onboarding-help",
          ),
        );
      const accountName = node("input"),
        nameLabel = node("label", "Account label");
      accountName.id = `onboarding-${s.project.name}-test-label`;
      nameLabel.htmlFor = accountName.id;
      accountName.value = s.accountLabel || account?.name || "Test user";
      accountName.addEventListener("input", () => {
        s.accountLabel = accountName.value;
      });
      inspector.content.append(nameLabel, accountName);
      access.append(inspector.section);
      const url = s.data.environment?.target.url;
      if (url) {
        const open = node("a", "Open test app to create an account ↗");
        open.href = url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        access.append(open);
      }
    }
    function paintLegacyAccess(s) {
      const access = s.appAccess;
      access.replaceChildren();
      access.append(
        node("span", "APP SIGN-IN", "eyebrow muted"),
        node("h3", "Does your app have a sign-in?"),
        node(
          "p",
          "Use a dedicated account for signed-in testing. Vercel access opens the preview; it does not sign into your app.",
          "onboarding-access-intro",
        ),
      );
      const loginHint =
          (!s.data?.stale || s.data?.setupConfirmation?.confirmedAt) &&
          s.data?.report?.projectSetup?.appAccess,
        detectedRecipe = loginHint?.kind === "password" && loginHint.password,
        detectedMatches =
          detectedRecipe &&
          [
            "loginPath",
            "usernameSelector",
            "passwordSelector",
            "submitSelector",
            "successSelector",
          ].every((key) => s.draft[key] === detectedRecipe[key]);
      if (loginHint) {
        const detection = node(
          "section",
          undefined,
          "onboarding-login-detection",
        );
        detection.append(
          node("h4", "What the code tells us"),
          node("p", loginHint.summary),
        );
        if (s.data.stale)
          detection.append(
            node(
              "p",
              "This suggestion comes from your previously reviewed source inspection. Check it against the current app; a live sign-in test is still required.",
              "onboarding-help",
            ),
          );
        if (detectedRecipe) {
          detection.append(
            node(
              "p",
              "We found a password login route and its browser controls. Use this suggestion, then test with your dedicated account; source inspection alone does not verify sign-in.",
            ),
          );
          const use = button(
            detectedMatches && s.draft.accessKind === "password"
              ? "Detected login selected"
              : "Use detected password login",
            () => {
              if (disabled(s)) return;
              for (const key of [
                "loginPath",
                "usernameSelector",
                "passwordSelector",
                "submitSelector",
                "successSelector",
              ])
                s.draft[key] = detectedRecipe[key];
              s.draft.accessKind = "password";
              s.editAppAccess = true;
              s.formSignature = "";
              paint(s);
            },
            true,
          );
          detection.append(use);
        } else if (["email-code", "sso"].includes(loginHint.kind))
          detection.append(
            node(
              "p",
              "This login cannot be checked by the password verifier. Use an existing supported login recipe, enable a dedicated password test login in your app, or explicitly select public pages only.",
            ),
          );
        else if (loginHint.kind === "unknown" || loginHint.kind === "password")
          detection.append(
            node(
              "p",
              "The inspected source did not establish a complete password login recipe. Review the login route and controls below; no sign-in was tested.",
            ),
          );
        else
          detection.append(
            node(
              "p",
              "The source suggests public flows. Confirm public-only coverage below; this is not a verified browser result.",
            ),
          );
        access.append(detection);
      } else {
        const inspect = button("Detect sign-in from code", () =>
          run(s, "discover", {}),
        );
        access.append(
          node(
            "p",
            "Detect login controls from code, then verify with your test account.",
            "onboarding-help",
          ),
          inspect,
        );
      }
      const accessChoices = node("div", undefined, "onboarding-access-choices");
      accessChoices.setAttribute("role", "group");
      accessChoices.setAttribute("aria-label", "App sign-in access");
      for (const [kind, title, description] of [
        [
          "password",
          "Yes, test signed-in flows",
          "Connect a dedicated account for the parts behind sign-in.",
        ],
        [
          "public",
          "Public pages only",
          "Skip sign-in. Account, billing and other private flows stay untested.",
        ],
        ...(s.data?.environment?.legacySignIn
          ? [
              [
                "legacy",
                "Keep existing sign-in recipe",
                "Keep the project's current login instructions.",
              ],
            ]
          : []),
      ]) {
        const choice = button("", () => {
          if (disabled(s)) return;
          s.draft.accessKind = kind;
          s.editAppAccess = true;
          s.formSignature = "";
          paint(s);
        });
        choice.id = `onboarding-${s.project.name}-access-${kind}`;
        choice.className = `onboarding-access-choice${s.draft.accessKind === kind ? " selected" : ""}`;
        choice.setAttribute(
          "aria-pressed",
          String(s.draft.accessKind === kind),
        );
        choice.append(node("strong", title), node("span", description));
        accessChoices.append(choice);
      }
      access.append(accessChoices);
      const editingAccess =
          s.editAppAccess || !hasAppAccess(s.data?.environment),
        needsTestCredentials = s.project.readiness?.steps?.some(
          (step) => step.id === "test_access" && step.ready === false,
        );
      if (s.draft.accessKind === "password" && editingAccess) {
        access.append(
          node("h4", "Connect a test account"),
          node(
            "p",
            "Create a dedicated user in your test app with the role you want checked. Save these settings, then enter its email and password securely in Connections. Your personal account is not needed.",
          ),
        );
        for (const [index, account] of s.draft.accounts.entries()) {
          const row = node("section", undefined, "onboarding-account"),
            references = settingsSheet("Credential reference names");
          references.content.append(
            node(
              "p",
              "These names are generated for your project. Keep them unless you already saved credentials under different names. Enter the actual username and password only in Connections.",
            ),
          );
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
            if (key === "name") row.append(wrap);
            else references.content.append(wrap);
          }
          row.append(references.section);
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
            const accountNumber = s.draft.accounts.length + 1,
              prefix = `APP_${s.project.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}${s.project.instanceId ? `_${s.project.instanceId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}` : ""}_TEST_${accountNumber}`;
            s.draft.accounts.push({
              name: `Test account ${accountNumber}`,
              usernameSecret: `${prefix}_USERNAME`,
              passwordSecret: `${prefix}_PASSWORD`,
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
            "The actual password sign-in route on this test app. Detect it from code above, or enter the route your app uses.",
          ),
        );
        if (!detectedMatches)
          access.append(
            field(
              s,
              "successSelector",
              "Signed-in success selector",
              "A stable element visible only after successful sign-in, such as [data-testid=account-menu].",
            ),
          );
        const selectors = settingsSheet("Advanced login selectors");
        s.loginSelectors = selectors;
        for (const [key, label] of [
          ["usernameSelector", "Username field"],
          ["passwordSelector", "Password field"],
          ["submitSelector", "Submit button"],
          ...(detectedMatches
            ? [["successSelector", "Signed-in success selector"]]
            : []),
        ])
          selectors.content.append(
            field(s, key, label, "CSS selector used by the browser test."),
          );
        access.append(selectors.section);
        if (detectedMatches)
          access.append(
            node(
              "p",
              "Login controls are filled from the source inspection. Test access checks the real sign-in result; use Advanced login selectors to review them.",
              "onboarding-help",
            ),
          );
        access.append(
          node(
            "p",
            "Uses email and password login. For apps using only email codes, magic links or SSO, first enable a password login for a dedicated test user, or explicitly choose public pages only.",
            "onboarding-help",
          ),
        );
      } else if (s.draft.accessKind === "password") {
        access.append(
          node(
            "p",
            needsTestCredentials
              ? "Test account details saved. Add its email and password in Connections before browser patrols."
              : `${s.draft.accounts.length} test account${s.draft.accounts.length === 1 ? "" : "s"} saved. The environment check below shows whether sign-in is verified.`,
            "onboarding-access-status",
          ),
          button("Edit test account setup", () => {
            s.editAppAccess = true;
            s.formSignature = "";
            paint(s);
          }),
        );
      } else if (s.draft.accessKind === "legacy")
        access.append(
          node(
            "p",
            s.data?.environment?.legacySignInSummary ||
              "Existing sign-in recipe retained. This environment test does not exercise the legacy login flow.",
          ),
        );
      else if (s.draft.accessKind === "public")
        access.append(
          node(
            "p",
            "Public pages only. Your gremlins can investigate pages that do not require an account. Signed-in journeys will not be verified.",
            "onboarding-access-status",
          ),
        );
      else
        access.append(
          node(
            "p",
            "Choose an option before your gremlins start browser testing.",
            "onboarding-help",
          ),
        );
      s.accessSave = null;
      if (s.draft.accessKind && editingAccess) {
        const actions = node("div", undefined, "onboarding-actions"),
          canSave = Boolean(
            s.data?.environment ||
            s.draft.existingTarget ||
            s.draft.providerTarget,
          );
        s.accessSave = button(
          canSave
            ? s.draft.accessKind === "password"
              ? "Save & add test credentials"
              : s.draft.accessKind === "legacy"
                ? "Save sign-in recipe"
                : "Save public-pages access"
            : "Choose a test environment",
          async () => {
            if (disabled(s)) return;
            if (!canSave) {
              s.showForm = true;
              paint(s);
              s.form.scrollIntoView?.({ block: "start", behavior: "smooth" });
              return;
            }
            try {
              const password = s.draft.accessKind === "password",
                input = readAppAccessTarget(s);
              // Save the account references before opening Connections so its
              // secure credential form can offer this project's test identity.
              await run(s, "configure", {
                configurationRevision: s.draftRevision,
                ...input,
              });
              if (s.error || destroyed || entries.get(s.project.name) !== s)
                return;
              s.editAppAccess = false;
              s.formSignature = "";
              paint(s);
              if (password) {
                const path = "/connections#project-access";
                if (!window.dashboardPages?.navigate(path))
                  window.location.assign(path);
              }
            } catch (error) {
              s.error = error.message;
              paint(s);
            }
          },
          true,
        );
        actions.append(s.accessSave);
        access.append(actions);
      }
      if (s.draft.accessKind === "password" && !editingAccess) {
        const connections = node(
          "a",
          needsTestCredentials
            ? "Add test credentials"
            : "Manage test credentials in Connections →",
          needsTestCredentials ? "button button-dark" : "",
        );
        connections.href = "/connections#project-access";
        access.append(connections);
      }
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
        s.editAppAccess,
        s.data?.configurationRevision,
        s.data?.revision,
        s.data?.stale,
        s.data?.testAccountSetupSupported,
        s.data?.testAccountSuggestion,
        s.data?.testAccounts,
        s.data?.environment?.verification?.status,
        s.accountIndex,
        s.accessMethodChoice,
        s.project.readiness?.steps?.find((step) => step.id === "test_access")
          ?.ready,
        s.showVercel,
        Object.keys(s.project.environments || {}),
      ]);
      if (shape === s.formSignature) {
        updateFormActions(s);
        return;
      }
      s.formSignature = shape;
      s.inputs = {};
      s.loginSelectors = null;
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
              onConnectHosting: (_project, connectionId) =>
                connectHosting(s, connectionId, true),
              onConfigured: async () => {
                const pendingAccess = s.draft;
                s.data = await api(endpoint(s));
                s.draft = initialDraft(s);
                s.baseline = JSON.stringify(s.draft);
                if (
                  !hasAppAccess(s.data.environment) &&
                  pendingAccess.accessKind
                ) {
                  for (const key of appAccessDraftKeys)
                    s.draft[key] = structuredClone(pendingAccess[key]);
                }
                s.draftRevision = s.data.configurationRevision;
                s.showVercel = s.showForm = false;
                s.formSignature = "";
                await onSaved(s.project.name);
                await prepareEnvironment(s, undefined, true);
              },
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
        if (vercelTarget?.kind === "vercel")
          s.form.append(previewAccessCard(s, vercelTarget, true));
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
      if (s.data?.testAccountSetupSupported) paintManagedAccess(s);
      else paintLegacyAccess(s);
      const actions = node("div", undefined, "onboarding-actions");
      s.save = button(
        s.data?.environmentSetupSupported &&
          (s.draft.providerTarget || s.draft.existingTarget)?.kind === "vercel"
          ? "Save & set up environment"
          : "Save environment",
        async () => {
          try {
            const input = window.readOnboardingTarget(s.draft);
            if (
              s.data?.environmentSetupSupported &&
              input.target?.kind === "vercel"
            ) {
              await prepareEnvironment(s, input.target);
              return;
            }
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
    function editEnvironment(s, diagnosis) {
      if (disabled(s) || s.loading) return;
      if (
        s.data?.testAccountSetupSupported &&
        ["choose_access", "edit_login", "manage_credentials"].includes(
          diagnosis?.action,
        )
      ) {
        openManagedAccess(s);
        return;
      }
      if (diagnosis?.action === "choose_access") {
        s.appAccess.scrollIntoView?.({ block: "start", behavior: "smooth" });
        s.appAccess
          .querySelectorAll("button")[0]
          ?.focus({ preventScroll: true });
        return;
      }
      if (diagnosis?.action === "edit_login" && !s.editAppAccess) {
        s.editAppAccess = true;
        s.formSignature = "";
      }
      s.showForm = true;
      s.showAnalysis = false;
      paint(s);
      const key =
          diagnosis?.field ||
          (diagnosis?.action === "edit_login" ? "loginPath" : "url"),
        input = s.inputs?.[key];
      if (
        ["usernameSelector", "passwordSelector", "submitSelector"].includes(
          key,
        ) &&
        s.loginSelectors
      ) {
        const { dialog } = s.loginSelectors;
        if (!dialog.open) dialog.showModal();
        dialog.scrollTop = 0;
      }
      if (input) {
        s.recoveryField = key;
        input.setAttribute("aria-invalid", "true");
        input.focus({ preventScroll: true });
        input.scrollIntoView?.({ block: "center", behavior: "smooth" });
      } else s.form.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
    function verificationSteps(s, result, target, container = s.verification) {
      const checks = result?.status === "untested" ? [] : result?.checks || [],
        passed = (check) =>
          check.passed === true ||
          check.ok === true ||
          check.status === "passed",
        failed = (check) =>
          check.passed === false ||
          check.ok === false ||
          check.status === "failed",
        opening = checks.filter(
          (check) => check.name === "Browser opens application",
        ),
        login = checks.filter((check) => /^Test account \d+/.test(check.name)),
        status = result?.status,
        groups = [];
      if (target.kind === "vercel") {
        const access = s.data.previewAccess?.status;
        groups.push({
          name: "Vercel preview access",
          state:
            status === "passed" || opening.some(passed) || access === "verified"
              ? "passed"
              : access === "missing" ||
                  (status === "failed" &&
                    result.diagnosis?.action === "connect_preview")
                ? "failed"
                : "pending",
          detail:
            status === "passed" || opening.some(passed) || access === "verified"
              ? "Runner can pass deployment protection"
              : access === "missing"
                ? "Bypass credential missing"
                : ["saved", "connected"].includes(access)
                  ? "Credential saved · browser check pending"
                  : access === "not_required"
                    ? "No protection detected · browser check pending"
                    : "Not yet checked",
        });
      }
      groups.push({
        name: "Browser opens application",
        state: opening.some(failed)
          ? "failed"
          : opening.some(passed) || status === "passed"
            ? "passed"
            : "pending",
        detail: opening.some(failed)
          ? "The runner could not open the app"
          : opening.some(passed) || status === "passed"
            ? "Reached the app from the Docker runner"
            : "Not yet tested",
      });
      if (target.access?.kind === "password") {
        const accountCount = target.access.accounts?.length || 1,
          signedIn = login.filter(
            (check) =>
              /^Test account \d+ signs in$/.test(check.name) && passed(check),
          ).length,
          failedCheck = login.find(failed);
        groups.push({
          name: "Test account sign-in",
          state: failedCheck
            ? "failed"
            : status === "passed" || signedIn === accountCount
              ? "passed"
              : "pending",
          detail: failedCheck
            ? failedCheck.name
            : signedIn || status === "passed"
              ? `${signedIn || accountCount} of ${accountCount} accounts signed in`
              : "Not yet tested",
        });
      }
      const rows = node("ol", undefined, "environment-checklist");
      let checking = false;
      for (const group of groups) {
        const isChecking =
          status === "testing" && group.state === "pending" && !checking;
        if (isChecking) checking = true;
        const row = node(
            "li",
            undefined,
            `environment-check ${group.state}${isChecking ? " checking" : ""}`,
          ),
          icon = node(
            "span",
            group.state === "passed"
              ? "✓"
              : group.state === "failed"
                ? "!"
                : isChecking
                  ? "…"
                  : "·",
            "environment-check-icon",
          ),
          copy = node("div"),
          stateLabel = node(
            "span",
            group.state === "passed"
              ? "Passed"
              : group.state === "failed"
                ? "Needs attention"
                : isChecking
                  ? "Checking…"
                  : "Not yet tested",
            "environment-check-status",
          );
        icon.setAttribute("aria-hidden", "true");
        copy.append(node("strong", group.name), node("span", group.detail));
        row.append(icon, copy, stateLabel);
        rows.append(row);
      }
      container.append(rows);
      if (checks.length) {
        const details = settingsSheet("View test details");
        details.section.classList.add("environment-test-details");
        const items = node("ul", undefined, "onboarding-checks");
        for (const check of checks)
          items.append(
            node(
              "li",
              `${passed(check) ? "✓ Passed" : failed(check) ? "! Failed" : "Not yet tested"} · ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
            ),
          );
        details.content.append(items);
        container.append(details.section);
      }
    }
    async function choosePreview(s, choice, repair = false) {
      if (disabled(s) || (dirty(s) && (!choice?.target || s.data?.environment)))
        return;
      if (choice?.target && !repair) {
        try {
          await prepareEnvironment(s, withAccess(choice.target, s.draft));
        } catch (error) {
          s.error = error.message;
          paint(s);
        }
        return;
      }
      const identity = projectIdentity(s.project);
      s.busy = true;
      s.error = "";
      paint(s);
      try {
        if (choice?.projectId) {
          const discovered = await api(endpoint(s, "vercel/discover"), {
            connectionId: choice.connectionId,
            projectId: choice.projectId,
            ...(choice.teamId !== undefined ? { teamId: choice.teamId } : {}),
          });
          // Repository, branch bases and missing branches are resolved by the
          // controller; present one concrete plan instead of manual ID forms.
          await api(endpoint(s, "vercel/prepare"), {
            revision: discovered.revision,
            ...(repair ? { repairWorkflow: true } : {}),
          });
        }
        if (
          destroyed ||
          entries.get(s.project.name) !== s ||
          projectIdentity(s.project) !== identity
        )
          return;
        s.showForm = s.showVercel = true;
        s.showAnalysis = false;
        s.formSignature = "";
      } catch (error) {
        s.error =
          error.message || "Vercel previews could not be loaded. Try again.";
      } finally {
        s.busy = false;
        if (!destroyed && entries.get(s.project.name) === s) {
          paint(s);
          if (s.showForm)
            s.form.scrollIntoView?.({ block: "start", behavior: "smooth" });
        }
      }
    }
    function paintAutomatic(s) {
      const connection = hostingConnection(s);
      if (connection.ready) s.hostingFailure = null;
      const setup = s.data?.environmentSetup,
        available = s.data?.environmentSetupSupported,
        manualPreviewAccess = manualPreviewAccessRequired(s),
        showConnection =
          !s.showForm || s.data?.environment?.target.kind === "vercel",
        connectionFailure = showConnection
          ? s.hostingFailure || connection.failure
          : null,
        needsConnection =
          connection.known &&
          !connection.ready &&
          (!s.data?.environment ||
            s.data.environment.target.kind === "vercel") &&
          showConnection,
        preparing = s.preparePending || setup?.status === "preparing",
        blocked = ["needs_input", "failed"].includes(setup?.status),
        suggested = !setup && !s.data?.environment && canPrepareEnvironment(s),
        managedLoginBlocker =
          s.data?.testAccountSetupSupported &&
          (setup?.action === "edit_login" ||
            (setup?.action === "manage_credentials" && !manualPreviewAccess)),
        visible =
          available &&
          !managedLoginBlocker &&
          (s.data?.environment || !hasDockerRecommendation(s)) &&
          (!s.data?.environment ||
            s.data.environment.target.kind === "vercel") &&
          (preparing ||
            blocked ||
            suggested ||
            needsConnection ||
            connectionFailure);
      s.automatic.hidden = !visible;
      s.prepareControls = [];
      if (!visible) return;
      s.steps.hidden = true;
      s.analysis.hidden = true;
      s.verification.hidden = true;
      s.proposal.hidden = true;
      if (preparing) s.form.hidden = true;
      s.automatic.replaceChildren();
      s.automatic.setAttribute("aria-busy", String(Boolean(preparing)));
      const heading = node("div", undefined, "environment-result-heading"),
        copy = node("div"),
        diagnosis =
          setup?.step === "test_access"
            ? s.data.environment?.verification?.diagnosis
            : undefined,
        title = preparing
          ? "Getting your crew connected."
          : needsConnection
            ? "Let your gremlins see the app."
            : manualPreviewAccess
              ? "One-time access for your protected preview."
              : suggested
                ? "We’ll find your test environment."
                : setup?.action === "choose_preview"
                  ? "Choose the app your crew should test."
                  : diagnosis?.title || "One thing needs your help.";
      copy.append(
        node("h3", title),
        node(
          "p",
          preparing
            ? (setup?.status === "preparing" && setup.message) ||
                "Finding the right preview, connecting access and checking it from the runner."
            : needsConnection
              ? setup?.action === "connect_vercel"
                ? setup.message
                : "Connect Vercel. We’ll find the preview, prepare private access and verify it from your runner."
              : suggested
                ? "Your Vercel account is connected. We’ll match this repository to a preview and check that your gremlins can use it."
                : diagnosis?.detail ||
                  setup?.message ||
                  "Review the connection status before continuing.",
        ),
      );
      heading.append(
        copy,
        node(
          "span",
          preparing
            ? "Preparing"
            : needsConnection
              ? "Connect hosting"
              : blocked
                ? "Your turn"
                : "Automatic setup",
          `environment-result-badge ${blocked && !preparing ? "attention" : "testing"}`,
        ),
      );
      s.automatic.append(heading);
      const loginFailure = loginFailureContext(
        diagnosis,
        s.data?.environment?.target,
      );
      if (loginFailure)
        s.automatic.append(node("p", loginFailure, "onboarding-help"));
      if (manualPreviewAccess)
        s.automatic.append(
          node(
            "p",
            `In Connections, open “Vercel preview access” for ${s.project.name}. This lets your gremlins test protected previews while protection stays enabled.`,
            "onboarding-help",
          ),
        );
      if (
        !preparing &&
        setup?.action === "connect_vercel" &&
        setup.connectionId
      )
        s.automatic.append(
          node("p", `Vercel account: ${connection.label}`, "onboarding-help"),
        );
      if (preparing) {
        const steps = [
            ["find_preview", "Find the right preview"],
            ["save_environment", "Prepare the environment"],
            ["connect_access", "Connect private preview access"],
            ["test_access", "Check access from the runner"],
          ],
          current = Math.max(
            0,
            steps.findIndex(
              ([key]) => setup?.status === "preparing" && key === setup.step,
            ),
          ),
          progress = node("ol", undefined, "environment-setup-progress");
        progress.setAttribute("aria-label", "Automatic environment setup");
        for (const [index, [, label]] of steps.entries()) {
          const item = node(
            "li",
            undefined,
            index < current
              ? "complete"
              : index === current
                ? "current"
                : "pending",
          );
          if (index === current) item.setAttribute("aria-current", "step");
          item.append(
            node("span", index < current ? "✓" : String(index + 1)),
            node("strong", label),
          );
          progress.append(item);
        }
        s.automatic.append(
          progress,
          node(
            "p",
            "You can leave this page. Setup continues in the background.",
            "onboarding-help",
          ),
        );
        return;
      }
      const actions = node("div", undefined, "onboarding-actions"),
        action = (label, handler, needsCleanDraft = true, primary = true) => {
          const control = button(label, handler, primary);
          control.needsCleanDraft = needsCleanDraft;
          s.prepareControls.push(control);
          return control;
        },
        navigate = (path) => {
          if (!window.dashboardPages?.navigate(path))
            window.location.assign(path);
        };
      if (
        blocked &&
        setup.step === "test_access" &&
        s.data.environment?.verification?.checks?.length
      )
        verificationSteps(
          s,
          s.data.environment.verification,
          s.data.environment.target,
          s.automatic,
        );
      if (connectionFailure) {
        const problem = node("div", undefined, "environment-diagnosis");
        problem.setAttribute("role", "alert");
        problem.append(
          node(
            "h4",
            connectionFailure.needsOperator
              ? "Vercel sign-in needs setup."
              : "Vercel sign-in couldn’t start.",
          ),
          node("p", connectionFailure.message),
        );
        s.automatic.append(problem);
      }
      if (
        needsConnection ||
        setup?.action === "connect_vercel" ||
        connectionFailure
      )
        actions.append(
          action(
            s.hostingConnecting
              ? "Checking Vercel sign-in…"
              : connectionFailure
                ? connectionFailure.needsOperator
                  ? "Check Vercel sign-in again"
                  : "Retry Vercel sign-in"
                : connection.reconnect
                  ? "Reconnect Vercel"
                  : "Connect Vercel",
            () => connectHosting(s, connection.id),
            false,
          ),
        );
      else if (setup?.action === "choose_preview" && setup.choices?.length) {
        const choices = node("div", undefined, "environment-preview-choices");
        for (const choice of setup.choices) {
          const select = action(
            "",
            () => choosePreview(s, choice),
            Boolean(s.data?.environment),
          );
          select.className = "environment-preview-choice";
          select.append(
            node("strong", choice.name || "Vercel app"),
            node(
              "span",
              [
                choice.rootDirectory
                  ? `Directory ${choice.rootDirectory}`
                  : "Repository root",
                choice.branch ? `Branch ${choice.branch}` : "",
                choice.target ? "Ready preview" : "Set up a preview",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          );
          choices.append(select);
        }
        s.automatic.append(choices);
      } else if (setup?.action === "manage_credentials")
        actions.append(
          action(
            manualPreviewAccess
              ? "Add preview access secret"
              : "Add test credentials",
            () =>
              s.data?.testAccountSetupSupported && !manualPreviewAccess
                ? openManagedAccess(s)
                : navigate("/connections#project-access"),
            false,
          ),
        );
      else if (setup?.action === "edit_login")
        actions.append(
          action(
            "Fix sign-in settings",
            () => editEnvironment(s, diagnosis || { action: "edit_login" }),
            false,
          ),
        );
      else if (setup?.action === "choose_preview")
        actions.append(
          action("Set up a Vercel preview", () => choosePreview(s)),
        );
      else
        actions.append(
          action(
            suggested ? "Set up my test environment" : "Try setup again",
            () => prepareEnvironment(s, undefined, true),
          ),
        );
      if (
        blocked &&
        !needsConnection &&
        !connectionFailure &&
        ["connect_vercel", "manage_credentials", "edit_login"].includes(
          setup.action,
        )
      )
        actions.append(
          action(
            manualPreviewAccess ? "Verify preview access" : "Check again",
            () => prepareEnvironment(s, undefined, true),
            true,
            false,
          ),
        );
      s.automatic.append(actions);
      const manual = action(
        s.showForm
          ? "Hide environment settings"
          : needsConnection
            ? "Use another host or local environment"
            : "Review environment settings",
        () => {
          s.hostingFailure = null;
          s.showForm = !s.showForm;
          paint(s);
          if (s.showForm)
            s.form.scrollIntoView?.({ block: "start", behavior: "smooth" });
        },
        false,
        false,
      );
      manual.classList.add("onboarding-text-button");
      s.automatic.append(manual);
      if (dirty(s))
        s.automatic.append(
          node(
            "p",
            "Your edits are kept. Save or discard them before setting up another preview.",
            "environment-draft-notice",
          ),
        );
    }
    function paint(s) {
      const buildFirst = Boolean(
        s.project.ideaPlanId && s.data?.foundation?.stage !== "ready",
      );
      s.foundation.hidden = !buildFirst;
      s.localSetup.hidden = true;
      s.appAccess.hidden = buildFirst || !s.draft;
      s.automatic.hidden = true;
      s.steps.hidden = buildFirst;
      s.verification.hidden = buildFirst;
      s.proposal.hidden = buildFirst;
      s.title.textContent = buildFirst
        ? "First, let's build your app."
        : canPrepareEnvironment(s)
          ? "Your crew’s test environment."
          : "Your test environment.";
      s.description.textContent = buildFirst
        ? "Your plan is ready. A Coding Gremlin can turn it into a working first version before you need a test environment."
        : canPrepareEnvironment(s)
          ? "We handle preview access and check it from the runner. We’ll ask only when a choice or test account is needed."
          : "Connect a preview, add any test account, then verify browser access.";
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
      if (
        s.data?.testAccountSetupSupported &&
        dirty(s) &&
        s.draftRevision !== s.data.configurationRevision
      ) {
        s.message.append(
          button("Discard setting edits & reload", () => {
            if (disabled(s) || s.loading) return;
            s.draft = initialDraft(s);
            s.baseline = JSON.stringify(s.draft);
            s.draftRevision = s.data.configurationRevision;
            s.error = "";
            s.notice =
              "Latest project settings loaded. Your account entries are kept. Review the environment, then connect & test.";
            s.editAppAccess = true;
            s.formSignature = "";
            paint(s);
          }),
        );
      }
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
          hasCrew = Boolean(s.project.areas?.length),
          target = environment.target,
          accessKnown = hasAppAccess(environment),
          savedResult = Boolean(
            s.data?.testAccountSetupSupported &&
            dirty(s) &&
            result?.status === "passed",
          ),
          ready = result?.status === "passed" && accessKnown && !savedResult,
          testing = result?.status === "testing",
          awaitingAccount =
            s.data?.testAccountSetupSupported &&
            !accessKnown &&
            !testing &&
            !result?.diagnosis &&
            [undefined, "untested"].includes(result?.status) &&
            s.draft.accessKind === "password" &&
            [
              "loginPath",
              "usernameSelector",
              "passwordSelector",
              "submitSelector",
              "successSelector",
            ].every((key) => s.draft[key]),
          preview = s.data.previewAccess,
          diagnosis =
            !ready &&
            !testing &&
            (!accessKnown
              ? {
                  title: "Your app sign-in is not set up yet.",
                  detail:
                    "Opening a preview only checks public pages. Add a test account to explore signed-in flows, or explicitly choose public pages only.",
                  action: "choose_access",
                }
              : result?.diagnosis ||
                (preview?.status === "missing"
                  ? {
                      title: "The preview bypass credential is missing.",
                      detail:
                        "A credential name is saved, but the credential itself is not in Connections. Connect preview access to repair this without turning off protection.",
                      action: "connect_preview",
                    }
                  : result?.status === "failed"
                    ? {
                        title: "Browser access could not be verified.",
                        detail:
                          result.message ||
                          "The last test did not complete. Run it again for a current diagnosis, then review the saved environment if it still fails.",
                        action: "retry",
                      }
                    : null)),
          header = node("div", undefined, "environment-result-heading"),
          heading = node("div"),
          badge = node(
            "span",
            savedResult
              ? "Previous check"
              : ready
                ? target.access?.kind === "public"
                  ? "Public pages only"
                  : "Ready"
                : testing
                  ? "Testing"
                  : diagnosis
                    ? "Needs attention"
                    : "Not tested",
            `environment-result-badge ${ready ? "ready" : testing ? "testing" : diagnosis ? "attention" : "pending"}`,
          );
        s.verification.setAttribute("aria-busy", String(testing));
        header.setAttribute("aria-live", "polite");
        heading.append(
          node(
            "h3",
            savedResult
              ? "Your saved access was verified."
              : ready
                ? target.access?.kind === "public"
                  ? "Public pages are ready to explore."
                  : hasCrew
                    ? "Your crew can explore."
                    : "Ready for a PM."
                : testing
                  ? "Checking the runner’s access…"
                  : diagnosis
                    ? "Let’s get your crew connected."
                    : "Test the environment.",
          ),
        );
        heading.append(
          node(
            "p",
            savedResult
              ? "These results describe the saved account and environment. Connect & test to verify your changes."
              : ready
                ? target.access?.kind === "password"
                  ? "The app opened and your test accounts signed in successfully."
                  : "The runner reached the public app. Signed-in flows are not included in this check."
                : testing
                  ? "Opening the app from Docker, then checking the configured sign-in."
                  : "We check the same access your gremlins will use.",
          ),
        );
        header.append(heading, badge);
        s.verification.append(header);
        const summary = node("dl", undefined, "environment-target-summary");
        for (const [label, value] of [
          [
            "Environment",
            `${environment.name} · ${target.kind === "vercel" ? "Vercel preview" : environment.profile === "docker" ? "Disposable local app" : target.kind === "url" ? "Hosted app" : target.kind}`,
          ],
          target.kind === "url"
            ? ["Test URL", target.url]
            : target.branch
              ? ["Branch", target.branch]
              : null,
          result?.runnerName && ["passed", "failed"].includes(result.status)
            ? ["Checked on", result.runnerName]
            : null,
          target.access?.kind === "password"
            ? [
                "Sign-in",
                `${target.access.accounts?.length || 1} test account${target.access.accounts?.length === 1 ? "" : "s"} · ${target.access.loginPath}`,
              ]
            : awaitingAccount
              ? null
              : [
                  "Access",
                  target.access?.kind === "public"
                    ? "Public pages only"
                    : environment.legacySignIn
                      ? "Existing sign-in recipe"
                      : "Not chosen",
                ],
        ].filter(Boolean)) {
          const row = node("div");
          row.append(node("dt", label), node("dd", value));
          summary.append(row);
        }
        s.verification.append(summary);
        if (diagnosis) {
          const issue = node("div", undefined, "environment-diagnosis");
          issue.setAttribute("role", "status");
          issue.append(
            node("h4", diagnosis.title),
            node("p", diagnosis.detail),
          );
          const loginFailure = loginFailureContext(diagnosis, target);
          if (loginFailure) issue.append(node("p", loginFailure));
          s.verification.append(issue);
        } else if (!ready && !testing && target.kind === "vercel") {
          const previewMessage = ["saved", "connected"].includes(
            preview?.status,
          )
            ? preview.status === "saved"
              ? "Bypass credential saved. Test the environment to verify that it works."
              : "Access connected. Test the environment next."
            : preview?.status === "not_required"
              ? "No deployment protection detected. Test the environment next."
              : target.bypassSecret
                ? "A bypass reference is saved. Connect preview access to check that its credential is available."
                : "Connect preview access to check Vercel protection and save automation access when needed.";
          s.verification.append(
            node(
              "p",
              `${previewMessage} Protection stays on.`,
              "environment-preview-note",
            ),
          );
        }
        s.savedPreviewAccess = null;
        s.recoveryAction = null;
        verificationSteps(s, result, target);
        s.verificationDraftNotice = node(
          "p",
          undefined,
          "environment-draft-notice",
        );
        s.verification.append(s.verificationDraftNotice);
        const needsPreview =
            !ready &&
            !testing &&
            target.kind === "vercel" &&
            (diagnosis?.action === "connect_preview" ||
              (!diagnosis &&
                !["saved", "connected", "not_required", "verified"].includes(
                  preview?.status,
                ))),
          recovery =
            diagnosis &&
            !["connect_preview", "retry"].includes(diagnosis.action);
        s.test = button(
          testing
            ? "Testing environment…"
            : ready
              ? "Test again"
              : result?.status === "failed"
                ? "Retry test"
                : "Test environment",
          () =>
            canPrepareEnvironment(s)
              ? prepareEnvironment(s, undefined, true)
              : run(s, "verify", {}),
          !ready && !needsPreview && !recovery,
        );
        const primaryActions = node("div", undefined, "onboarding-actions");
        if (needsPreview) {
          if (canPrepareEnvironment(s)) {
            s.recoveryAction = button(
              "Set up & test environment",
              () => prepareEnvironment(s, undefined, true),
              true,
            );
            primaryActions.append(s.recoveryAction);
          } else {
            s.savedPreviewAccess = button(
              "Connect preview access",
              () => connectPreviewAccess(s),
              true,
            );
            primaryActions.append(s.savedPreviewAccess);
          }
        } else if (recovery) {
          const credentials = diagnosis.action === "manage_credentials";
          s.recoveryAction = button(
            credentials
              ? "Add test credentials"
              : diagnosis.action === "choose_access"
                ? "Set up app sign-in"
                : diagnosis.action === "edit_login"
                  ? "Fix sign-in settings"
                  : "Review environment settings",
            () => {
              if (credentials && s.data?.testAccountSetupSupported) {
                openManagedAccess(s);
              } else if (credentials) {
                const path = "/connections#project-access";
                if (!window.dashboardPages?.navigate(path))
                  window.location.assign(path);
              } else editEnvironment(s, diagnosis);
            },
            true,
          );
          primaryActions.append(s.recoveryAction);
        }
        primaryActions.append(s.test);
        if (target.kind === "vercel")
          primaryActions.append(
            button("Repair PM staging setup", () =>
              choosePreview(s, target, true),
            ),
          );
        if (
          !ready &&
          !diagnosis &&
          !s.data.environmentSetupSupported &&
          target.kind === "vercel" &&
          ["saved", "connected", "not_required"].includes(preview?.status)
        ) {
          s.savedPreviewAccess = button("Check preview access", () =>
            connectPreviewAccess(s),
          );
          primaryActions.append(s.savedPreviewAccess);
        }
        s.verification.append(primaryActions);
        if (
          result?.checkedAt &&
          Number.isFinite(new Date(result.checkedAt).getTime())
        ) {
          const checked = node(
            "time",
            `Last checked ${new Date(result.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
            "environment-checked-at",
          );
          checked.dateTime = result.checkedAt;
          s.verification.append(checked);
        }
        const editActions = node("div", undefined, "onboarding-actions");
        editActions.append(
          button(
            s.showForm ? "Hide environment settings" : "Change environment",
            () => {
              s.showForm = !s.showForm;
              if (s.showForm) {
                s.editAppAccess = true;
                s.formSignature = "";
              }
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
        if (ready) {
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
        if (awaitingAccount) {
          // The account form above is the next action. Do not repeat it as an
          // error or offer a second setup button before the first check runs.
          s.verification.replaceChildren(
            node("h3", "Where your crew will test"),
            summary,
            editActions,
          );
          s.recoveryAction = null;
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
      paintAutomatic(s);
      paintDockerRecommendation(s);
      if (s.data?.testAccountSetupSupported) {
        s.steps.hidden = true;
        if (!s.data.environment && !s.showForm) s.appAccess.hidden = true;
        if (s.data.environment && !s.showAnalysis) s.analysis.hidden = true;
      }
      updateFormActions(s);
    }
    function paintDockerRecommendation(s) {
      const recommendation = s.data?.recommendedDocker;
      if (!hasDockerRecommendation(s) || s.data.environment || !s.draft) return;
      const ready = recommendation.status === "ready";
      s.localSetup.hidden = false;
      s.localSetup.replaceChildren();
      s.localSetup.append(
        node("span", "RECOMMENDED TEST ENVIRONMENT", "eyebrow muted"),
        node(
          "h3",
          ready
            ? "Run this app in Docker. Test it in the browser."
            : "Finish the local test setup.",
        ),
        node("p", recommendation.message),
      );
      if (s.project.verification?.mode === "repository")
        s.localSetup.append(
          node(
            "p",
            "Currently checking code only. No browser walkthrough is included until a browser environment is configured and verified.",
            "onboarding-help",
          ),
        );
      const target = recommendation.target;
      if (target) {
        const summary = node("dl", undefined, "environment-target-summary");
        for (const [label, value] of [
          ["Recipe", target.recipe?.dockerfile || target.recipe?.image],
          ["App port", target.port],
          ["Ready check", target.healthPath || "/"],
          [
            "Access",
            target.access?.kind === "public"
              ? "Public pages"
              : "Review app sign-in",
          ],
        ]) {
          if (value === undefined) continue;
          const row = node("div");
          row.append(node("dt", label), node("dd", String(value)));
          summary.append(row);
        }
        s.localSetup.append(summary);
      }
      const blockers = recommendation.blockers?.filter(
        (item) => item !== recommendation.message,
      );
      if (blockers?.length)
        s.localSetup.append(list(blockers, "onboarding-help"));
      const actions = node("div", undefined, "onboarding-actions");
      const openSettings = () => {
        if (disabled(s)) return;
        s.showForm = true;
        s.showAnalysis = false;
        paint(s);
        s.form.scrollIntoView?.({ block: "start", behavior: "smooth" });
      };
      const prepare = button(
        ready
          ? s.busy
            ? "Preparing local app…"
            : "Set up Docker & test"
          : "Review local setup",
        async () => {
          if (
            disabled(s) ||
            s.loading ||
            dirty(s) ||
            destroyed ||
            entries.get(s.project.name) !== s
          )
            return;
          if (!ready) return openSettings();
          await run(s, "prepare-docker", {
            revision: s.data.revision,
            configurationRevision: s.data.configurationRevision,
          });
        },
        true,
      );
      prepare.disabled = disabled(s) || s.loading || dirty(s);
      s.localPrepare = prepare;
      const review = button(
        ready ? "Review environment settings" : "Analyze again",
        () => {
          if (disabled(s) || dirty(s)) return;
          if (ready) return openSettings();
          return run(s, "discover", { revision: s.data.revision });
        },
      );
      review.disabled = disabled(s);
      actions.append(prepare, review);
      s.localSetup.append(
        actions,
        node(
          "p",
          dirty(s)
            ? "Your environment edits are kept. Save or discard them before applying this suggestion."
            : ready
              ? "This saves the reviewed local recipe and starts a real browser access test. It does not start a PM or enable automation."
              : "Review the blocker or analyze the current source again. Your environment stays unchanged until you save.",
          "onboarding-help",
        ),
      );
      if (!s.showAnalysis) s.analysis.hidden = true;
      if (!s.showForm) s.appAccess.hidden = true;
    }
    function deactivate() {
      for (const s of entries.values()) {
        s.hostingResume = null;
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
          paint(active);
          active.vercelSetup?.syncConnections();
        }
      },
      async resumeHosting(projectName) {
        const s = entries.get(projectName);
        if (
          !s ||
          active !== s ||
          destroyed ||
          dirty(s) ||
          disabled(s) ||
          s.data?.environment?.verification?.status === "passed" ||
          (s.data?.environment && s.data.environment.target.kind !== "vercel")
        )
          return;
        s.hostingResume = {
          identity: projectIdentity(s.project),
          loaded: false,
        };
        if (!s.loading) await load(s, true);
      },
      mount(container, project) {
        const s = entry(project),
          returning = active !== s;
        if (returning) deactivate();
        if (returning) s.environmentActivated = true;
        active = s;
        container.append(s.node);
        paint(s);
        if (!s.form.hidden && s.draft?.profile === "hosted" && s.showVercel)
          s.vercelSetup?.setActive(true);
        load(s, returning);
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
        if (s.data?.testAccountSetupSupported && accountDirty(s)) {
          openManagedAccess(s);
          return;
        }
        s.showForm = true;
        paint(s);
        s.form.querySelector?.("input,select,textarea")?.focus();
      },
      isBusy: () =>
        [...entries.values()].some((s) => s.busy || s.vercelSetup?.isBusy()),
      protectFocus: () =>
        Boolean(
          active?.form.contains(document.activeElement) ||
          active?.appAccess.contains(document.activeElement),
        ),
      forget(project) {
        const s = entries.get(project);
        if (s) {
          clearTimeout(s.timer);
          s.accountEntry = {};
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
          s.accountEntry = {};
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
