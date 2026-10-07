"use strict";
(() => {
  const key = "shipgremlins.project-connection-return";
  const name = /^[a-z][a-z0-9-]{0,62}$/;
  const identity = (project) => ({
    name: project.name,
    instanceId: project.instanceId ?? null,
    provider: project.provider || "github",
    repo: project.repo,
    serverUrl: project.serverUrl ?? null,
  });
  const hostingBinding = (project) => {
    const environment = project.verification?.environment || null;
    const target =
      (environment && project.environments?.[environment]) || project.vercel;
    return JSON.stringify([
      project.verification?.mode || null,
      environment,
      target?.kind || null,
      target?.connectionId || "default",
      target?.projectId || null,
      target?.teamId || null,
      target?.branch || null,
      target?.customEnvironmentId || null,
    ]);
  };
  window.createProjectConnectionReturn = ({
    storage = () => window.sessionStorage,
    now = () => Date.now(),
  } = {}) => {
    const clear = () => {
      try {
        storage().removeItem(key);
      } catch {
        /* A missing return hint must never prevent a connection. */
      }
    };
    function read() {
      try {
        const saved = storage().getItem(key);
        if (!saved) return null;
        if (saved.length > 4096) throw new Error();
        const value = JSON.parse(saved);
        if (
          value?.schema !== 1 ||
          !["vercel", "linear"].includes(value.provider) ||
          typeof value.connectionId !== "string" ||
          !name.test(value.connectionId) ||
          !name.test(value.project?.name || "") ||
          !Number.isFinite(value.createdAt) ||
          value.createdAt > now() ||
          now() - value.createdAt > 60 * 60 * 1000
        )
          throw new Error();
        return value;
      } catch {
        clear();
        return null;
      }
    }
    return {
      clear,
      remember(project, connectionId, provider = "vercel") {
        if (
          !["vercel", "linear"].includes(provider) ||
          !name.test(project?.name || "") ||
          typeof connectionId !== "string" ||
          !name.test(connectionId) ||
          typeof project.repo !== "string" ||
          !project.repo
        )
          throw new Error("Refresh the project before connecting its account.");
        storage().setItem(
          key,
          JSON.stringify({
            schema: 1,
            provider,
            connectionId,
            project: identity(project),
            ...(provider === "vercel"
              ? { hostingBinding: hostingBinding(project) }
              : {}),
            createdAt: now(),
          }),
        );
      },
      confirmed(provider, connectionId) {
        const value = read();
        if (value?.provider === provider && value.connectionId === connectionId)
          storage().setItem(key, JSON.stringify({ ...value, completed: true }));
      },
      pending(provider, connectionId) {
        const value = read();
        return Boolean(
          value?.completed === true &&
          value.provider === provider &&
          value.connectionId === connectionId,
        );
      },
      take(projects, connectionId, provider = "vercel") {
        const value = read();
        if (!value || value.provider !== provider) return null;
        if (value.connectionId !== connectionId) {
          clear();
          return null;
        }
        if (value.completed !== true) return null;
        clear();
        const project = projects.find(
          (item) =>
            item.name === value.project.name &&
            JSON.stringify(identity(item)) === JSON.stringify(value.project),
        );
        if (
          provider === "linear" &&
          (project?.linear?.connectionId || "default") !== connectionId
        )
          return null;
        if (
          project &&
          provider === "vercel" &&
          value.hostingBinding !== hostingBinding(project)
        )
          return null;
        return project
          ? {
              project: project.name,
              provider,
              path: `/projects/${encodeURIComponent(project.name)}${provider === "vercel" ? "?tab=environment" : ""}`,
            }
          : null;
      },
    };
  };
})();
