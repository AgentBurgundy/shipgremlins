"use strict";
(() => {
  window.normalizedRunFailure = (job) => {
    if (
      !job ||
      !["failed", "queued"].includes(job.status) ||
      (job.status !== "failed" && !job.failure)
    )
      return null;
    const project = `/projects/${encodeURIComponent(job.project || "")}`;
    const reasons = {
      infrastructure: [
        "Runner infrastructure is unavailable",
        "The runner could not start the work. Check its health before another attempt.",
        "Check runners",
        "/runners#workers",
      ],
      configuration: [
        "Project setup needs attention",
        "A saved setting prevented this run from starting correctly.",
        "Review environment",
        `${project}?tab=environment`,
      ],
      "credential-wait": [
        "A connection is required",
        "The runner is waiting for a valid saved connection. Update it before resuming work.",
        "Review connections",
        "/connections",
      ],
      "worker-exit": [
        "The worker stopped unexpectedly",
        "Execution began but did not complete. Review the recorded actions before deciding what to retry.",
        "Inspect activity",
        "activity",
      ],
      completion: [
        "Completion could not be verified",
        "The controller could not confirm the expected result. Inspect the original evidence before taking another action.",
        "Inspect evidence",
        "artifacts",
      ],
      "ambiguous-launch": [
        "The dispatch outcome is unconfirmed",
        "A provider run may already exist. Link the existing run in project recovery instead of launching duplicate work.",
        "Open project recovery",
        project,
      ],
      "runtime-limit": [
        "The run reached its time limit",
        "The configured runtime ceiling stopped this run. Review the evidence and project limits before trying again.",
        "Review run limits",
        `${project}?tab=limits`,
      ],
    };
    const reason = reasons[job.failure?.category];
    if (!reason)
      return {
        title: "This run needs review",
        detail:
          "No recognized failure reason was recorded. The original activity, output, and evidence remain available.",
        label: "Inspect activity",
        href: "activity",
      };
    return {
      title: reason[0],
      detail: reason[1],
      label: reason[2],
      href: reason[3],
      nextAttemptAt:
        job.failure.retryable && Number.isFinite(Date.parse(job.nextAttemptAt))
          ? job.nextAttemptAt
          : null,
    };
  };
  window.renderRunFailure = (host, job, onTab) => {
    if (!host) return;
    const reason = window.normalizedRunFailure(job);
    host.hidden = !reason;
    host.replaceChildren();
    if (!reason) return;
    const title = document.createElement("h3"),
      detail = document.createElement("p"),
      action = document.createElement(
        ["activity", "artifacts"].includes(reason.href) ? "button" : "a",
      );
    title.textContent = reason.title;
    detail.textContent = reason.detail;
    action.textContent = reason.label;
    action.className = "small-button";
    if (action.tagName === "BUTTON") {
      action.type = "button";
      action.addEventListener("click", () => onTab(reason.href));
    } else
      action.href =
        job.project ||
        (reason.href.startsWith("/") && !reason.href.startsWith("/projects/"))
          ? reason.href
          : "/activity";
    host.append(title, detail);
    if (reason.nextAttemptAt) {
      const next = document.createElement("p");
      next.textContent = `Bounded recovery is scheduled for ${new Date(reason.nextAttemptAt).toLocaleString()}.`;
      host.append(next);
    }
    host.append(action);
  };
  window.createOperatorRecovery = ({ api, project, onChanged, isLocked }) => {
    const root = document.createElement("section");
    root.className = "operator-recovery";
    root.setAttribute("aria-label", "Unconfirmed dispatch recovery");
    let loaded = false,
      loadedAt = 0,
      busy = false,
      data = [],
      error = "",
      notice = "";
    const drafts = new Map();
    let lastLocked = isLocked();
    const paint = () => {
      lastLocked = isLocked();
      root.hidden = loaded && !data.length && !error && !notice;
      root.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "Recover an unconfirmed dispatch";
      root.append(title);
      if (error || notice) {
        const message = document.createElement("p");
        message.setAttribute("role", error ? "alert" : "status");
        message.textContent = error || notice;
        root.append(message);
      }
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "small-button";
      refresh.textContent = busy ? "Checking…" : "Refresh recovery";
      refresh.disabled = busy || isLocked();
      refresh.addEventListener("click", load);
      root.append(refresh);
      for (const reservation of data) {
        const form = document.createElement("form"),
          label = document.createElement("label"),
          input = document.createElement("input"),
          scope = document.createElement("p"),
          save = document.createElement("button");
        scope.textContent = `${reservation.ticket || "Dispatch"}${reservation.pr ? ` · PR ${reservation.pr}` : ""} · ${reservation.repository || project} · Attempt ${reservation.attempt || 1}`;
        const remedy = document.createElement("p");
        remedy.textContent =
          reservation.remedy ||
          "Link the provider run that was already started. This does not retry or publish work.";
        label.textContent = "Existing provider run ID";
        input.type = "text";
        input.inputMode = "numeric";
        input.pattern = "[1-9][0-9]{0,15}";
        input.required = true;
        input.disabled = busy || !reservation.supported;
        input.id = `recovery-run-${reservation.id}`;
        label.htmlFor = input.id;
        input.value = drafts.get(reservation.id) || "";
        input.addEventListener("input", () =>
          drafts.set(reservation.id, input.value),
        );
        save.type = "submit";
        save.className = "small-button";
        save.textContent = "Link existing provider run";
        save.disabled = busy || isLocked() || !reservation.supported;
        form.append(scope, remedy, label, input, save);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (
            busy ||
            isLocked() ||
            !reservation.supported ||
            !/^[1-9][0-9]{0,15}$/.test(input.value) ||
            !Number.isSafeInteger(Number(input.value))
          )
            return;
          busy = true;
          error = "";
          paint();
          try {
            const result = await api("/api/recovery/bind", {
              reservationId: reservation.id,
              runId: Number(input.value),
            });
            notice = `Existing run ${result.runId} linked. No new run was launched.`;
            drafts.delete(reservation.id);
            data = data.filter((item) => item.id !== reservation.id);
            try {
              await onChanged?.();
            } catch {
              notice += " Project data could not refresh; the run was linked.";
            }
            await load(true);
          } catch (failure) {
            error = failure.message;
          } finally {
            busy = false;
            paint();
          }
        });
        root.append(form);
      }
    };
    async function load(force = false) {
      if ((busy && force !== true) || isLocked()) return;
      busy = true;
      paint();
      try {
        const result = await api("/api/recovery/reservations");
        const incoming = Array.isArray(result.reservations)
          ? result.reservations.filter(
              (reservation) => reservation.project === project,
            )
          : [];
        const unavailable =
          Array.isArray(result.unavailableProjects) &&
          result.unavailableProjects.includes(project);
        if (!unavailable || incoming.length) data = incoming;
        error = unavailable
          ? "Recovery status could not be checked for this project. Existing reservations are still shown; refresh to try again."
          : "";
        loaded = true;
      } catch (failure) {
        error = failure.message;
      } finally {
        busy = false;
        loadedAt = Date.now();
        paint();
      }
    }
    paint();
    load();
    return {
      node: root,
      refresh: load,
      isDirty: () => [...drafts.values()].some(Boolean),
      resume() {
        if (lastLocked !== isLocked()) paint();
        if (
          (!loaded ||
            (root.isConnected &&
              Date.now() - loadedAt > 15000 &&
              ![...drafts.values()].some(Boolean) &&
              !root.contains?.(document.activeElement))) &&
          !busy &&
          !isLocked()
        )
          load();
      },
    };
  };
})();
