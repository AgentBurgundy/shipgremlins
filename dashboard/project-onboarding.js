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
  window.readOnboardingTarget = (draft) => {
    if (draft.profile === "hosted") {
      if (draft.existing)
        return {
          profile: "hosted",
          environment: draft.existing,
          target: withAccess(structuredClone(draft.existingTarget), draft),
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
        ? "Uses your saved connections and Docker on this server. Already have a test URL? Choose hosted staging below."
        : rows.some((row) => row.missing)
          ? "Connect the missing service below to analyze this repository. Docker is also required on this server."
          : "Analysis uses source access, Claude Code and Docker on this server. Already have a test URL? Choose hosted staging below.";
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
      const target = s.data?.environment?.target;
      const proposed = s.data?.stale ? null : s.data?.report?.docker;
      const local = target?.kind === "docker" ? target : proposed;
      const profile =
        s.data?.environment?.profile ||
        s.data?.report?.recommendation ||
        "hosted";
      const advanced = {};
      for (const key of ["start", "env", "services", "migrate", "seed"])
        if (local?.[key] !== undefined) advanced[key] = local[key];
      return {
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
            ? s.data.environment.name
            : "",
        url: target?.kind === "url" ? target.url : "",
        recipeKind: local?.recipe?.kind || "dockerfile",
        dockerfile: local?.recipe?.dockerfile || "Dockerfile",
        context: local?.recipe?.context || ".",
        image: local?.recipe?.image || "",
        port: String(local?.port || ""),
        healthPath: local?.healthPath || "/",
        advanced: JSON.stringify(advanced, null, 2),
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
        s.heading.append(
          node("span", "ENVIRONMENT", "eyebrow muted"),
          node("h2", "A safe place to test."),
          node(
            "p",
            "Choose where your crew can explore. Test access before creating your first PM.",
          ),
        );
        s.steps = node("ol", undefined, "onboarding-steps");
        s.message = node("div", undefined, "onboarding-message");
        s.message.setAttribute("role", "status");
        s.analysis = node("section", undefined, "onboarding-analysis");
        s.form = node("section", undefined, "onboarding-choice");
        s.verification = node("section", undefined, "onboarding-verification");
        s.proposal = node("section", undefined, "onboarding-proposal");
        s.node.append(
          s.heading,
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
      if (destroyed || active !== s || document.hidden || !ongoing(s.data))
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
      if (s.save) s.save.disabled = disabled(s) || !s.data || !s.draft;
      if (s.test)
        s.test.disabled = disabled(s) || dirty(s) || !s.data?.environment;
      if (s.create) s.create.disabled = isLocked() || s.busy || dirty(s);
      if (s.draftNotice)
        s.draftNotice.textContent = dirty(s)
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
        s.draft.accounts.length,
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
        const existing = Object.entries(s.project.environments || {}).filter(
          ([, target]) =>
            target.role !== "production" && target.kind !== "docker",
        );
        if (existing.length) {
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
            Object.assign(
              s.draft,
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
        if (!s.draft.existing)
          s.form.append(
            field(
              s,
              "url",
              "Test URL",
              "Use a dedicated preview or staging app. It must be reachable from the worker; localhost refers to the worker itself.",
              "url",
            ),
          );
        const advanced = node("details", undefined, "onboarding-advanced");
        advanced.append(
          node("summary", "Hosting provider settings"),
          node(
            "p",
            "Choose a saved provider account and resource in project settings. Hosting access is separate from signing into your app.",
          ),
        );
        const settings = button("Open project settings", () => {});
        settings.dataset.editProject = s.project.name;
        advanced.append(settings);
        s.form.append(advanced);
        if (s.data?.report?.hosted?.instructions?.length) {
          const tips = node("details", undefined, "onboarding-advanced");
          tips.append(
            node("summary", "Suggested hosting setup"),
            list(s.data.report.hosted.instructions),
          );
          s.form.append(tips);
        }
      } else {
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
        const advanced = node("details", undefined, "onboarding-advanced");
        advanced.append(
          node("summary", "Startup, data & credential references"),
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
        s.form.append(advanced);
      }
      const access = node(
        "details",
        undefined,
        "onboarding-advanced onboarding-access",
      );
      access.open = s.accessOpen === true;
      access.addEventListener("toggle", () => {
        s.accessOpen = access.open;
      });
      access.append(
        node(
          "summary",
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
            "Use isolated test identities with known roles. Add their username and password values in Connections after saving; only secret references belong here.",
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
        const selectors = node("details", undefined, "onboarding-advanced");
        selectors.append(node("summary", "Advanced login selectors"));
        for (const [key, label] of [
          ["usernameSelector", "Username field"],
          ["passwordSelector", "Password field"],
          ["submitSelector", "Submit button"],
        ])
          selectors.append(
            field(s, key, label, "CSS selector used by the browser test."),
          );
        access.append(selectors);
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
            "Browser verification checks the public app. If important flows require a login, configure test accounts first. SSO-only flows need a supported test login method.",
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
        s.data?.environment &&
        !s.showAnalysis &&
        !["analyzing", "publishing"].includes(s.data?.status),
      );
      s.form.hidden = Boolean(s.data?.environment && !s.showForm);
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
        const evidence = node("details", undefined, "onboarding-advanced");
        const inspection = report.repository?.inspection;
        evidence.append(
          node(
            "summary",
            `Reviewed ${report.repository?.filesRead?.length || 0} files${inspection ? " · Entrypoints & dependencies" : " · Earlier source scan"}`,
          ),
          node(
            "p",
            `${report.repository?.repo || s.project.repo} · ${report.repository?.branch || ""} · ${(report.repository?.sha || "").slice(0, 12)}`,
          ),
        );
        if (inspection) {
          evidence.append(
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
          evidence.append(reviewed);
          if (inspection.criticalMissing?.length) {
            evidence.append(
              node("strong", "Important source is still missing"),
              list(inspection.criticalMissing),
            );
          }
          if (inspection.unresolved?.length) {
            const remaining = node("details", undefined, "onboarding-advanced");
            remaining.append(
              node("summary", "Unread references & limits"),
              list(inspection.unresolved),
            );
            evidence.append(remaining);
          }
          evidence.append(
            node(
              "p",
              `This analysis follows selected source references; it is not a complete repository audit. Budget: up to ${inspection.limits.files} source reads and ${Math.round(inspection.limits.sourceBytes / 1024)} KiB of source context.`,
              "onboarding-help",
            ),
          );
        } else {
          evidence.append(list(report.repository?.filesRead || []));
          evidence.append(
            node(
              "p",
              "This report used the earlier file-selection method. Analyze again to follow application entrypoints, imports and test fixtures with the expanded source budget.",
            ),
          );
        }
        recommendation.append(evidence);
        s.analysis.append(recommendation);
      }
      paintForm(s);
      s.verification.replaceChildren();
      if (s.data?.environment) {
        const environment = s.data.environment,
          result = environment.verification;
        s.verification.append(
          node(
            "h3",
            result?.status === "passed"
              ? "Ready for a PM."
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
            "Create a PM",
            () => onCreatePm?.(s.project.name),
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
        const details = node("details", undefined, "onboarding-advanced");
        details.append(
          node(
            "summary",
            `Review ${report.proposedFiles.length} proposed setup ${report.proposedFiles.length === 1 ? "file" : "files"}`,
          ),
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
          details.append(section);
        }
        const confirm = node("label", undefined, "onboarding-confirm"),
          checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.checked = s.reviewed;
        confirm.append(
          checkbox,
          document.createTextNode("I reviewed these proposed setup files."),
        );
        details.append(confirm);
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
        details.append(publish);
        s.proposal.append(details);
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
      for (const s of entries.values()) clearTimeout(s.timer);
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
        if (active) paintConnections(active);
      },
      mount(container, project) {
        const s = entry(project);
        if (active !== s) deactivate();
        active = s;
        container.append(s.node);
        paint(s);
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
      isBusy: () => [...entries.values()].some((s) => s.busy),
      protectFocus: () =>
        Boolean(active?.form.contains(document.activeElement)),
      forget(project) {
        const s = entries.get(project);
        if (s) {
          clearTimeout(s.timer);
          if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
          s.generation++;
          if (active === s) active = null;
          entries.delete(project);
        }
      },
      destroy() {
        destroyed = true;
        deactivate();
        for (const s of entries.values())
          if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
        window.removeEventListener("dashboard:pagechange", pagechange);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("pagehide", deactivate);
      },
    };
  };
})();
