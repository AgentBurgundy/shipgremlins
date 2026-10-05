"use strict";
(() => {
  const node = (tag, text, className = "") => {
    const value = document.createElement(tag);
    value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  window.createWorkspaceDeletion = ({
    api,
    isLocked,
    onDeleted,
    onRestored,
  }) => {
    const dialog = node("dialog", undefined, "deletion-dialog");
    dialog.setAttribute("aria-labelledby", "deletion-title");
    const header = node("header", undefined, "deletion-heading"),
      identity = node("div");
    const title = node("h2", "Review deletion"),
      scope = node("p");
    title.id = "deletion-title";
    identity.append(
      node("span", "LOCAL CONFIGURATION", "eyebrow muted"),
      title,
      scope,
    );
    const close = node("button", "Close ×", "small-button");
    close.type = "button";
    header.append(identity, close);
    const content = node("div", undefined, "deletion-content"),
      status = node("p", "", "form-message");
    status.setAttribute("role", "status");
    status.hidden = true;
    const confirm = node("input"),
      label = node("label"),
      explanation = node(
        "p",
        "Type the local ID exactly. This removes saved configuration, not your source repository or provider resources.",
        "setup-help",
      );
    confirm.id = "deletion-confirmation";
    confirm.autocomplete = "off";
    confirm.spellcheck = false;
    label.htmlFor = confirm.id;
    const confirmation = node("div", undefined, "deletion-confirmation");
    confirmation.append(label, confirm, explanation);
    const controls = node("footer", undefined, "deletion-controls"),
      refresh = node("button", "Refresh impact", "small-button"),
      remove = node("button", "Delete", "button button-danger"),
      keep = node("button", "Keep it", "small-button");
    for (const button of [refresh, remove, keep]) button.type = "button";
    controls.append(refresh, keep, remove);
    dialog.append(header, content, status, confirmation, controls);
    document.body.append(dialog);
    let target = null,
      preview = null,
      generation = 0,
      busy = false,
      loading = false,
      completed = false,
      request = null;
    const base = (value) =>
      value.recoveryId
        ? `/api/deleted/${encodeURIComponent(value.recoveryId)}`
        : `/api/projects/${encodeURIComponent(value.project)}${value.area ? `/pms/${encodeURIComponent(value.area)}` : ""}`;
    function notice(text, error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle("error", error);
    }
    function lock() {
      const unavailable = busy || loading || isLocked();
      close.disabled = keep.disabled = busy;
      refresh.disabled = unavailable;
      refresh.hidden = completed;
      confirm.disabled =
        unavailable || completed || Boolean(preview?.blockers?.length);
      confirmation.hidden = completed || !preview;
      remove.hidden = completed;
      remove.disabled =
        unavailable ||
        !preview ||
        Boolean(preview.blockers.length) ||
        confirm.value !== preview.confirmation;
      keep.textContent = completed
        ? "Done"
        : target?.recoveryId
          ? "Cancel restore"
          : "Keep it";
      dialog.setAttribute("aria-busy", String(busy || loading));
    }
    function finish() {
      if (busy) return;
      generation++;
      request?.abort();
      request = null;
      dialog.close();
      if (target?.trigger?.isConnected) target.trigger.focus();
      target = null;
      preview = null;
      confirm.value = "";
    }
    function list(titleText, values, className) {
      if (!values?.length) return;
      const section = node("section", undefined, className),
        list = node("ul");
      section.append(node("h3", titleText));
      for (const text of values) list.append(node("li", text));
      section.append(list);
      content.append(section);
    }
    async function load() {
      if (!target || busy || isLocked()) return;
      const selected = target,
        version = ++generation;
      request?.abort();
      request = new AbortController();
      preview = null;
      loading = true;
      completed = false;
      confirm.value = "";
      content.replaceChildren();
      notice("Checking saved configuration and active work…");
      lock();
      try {
        const result = await api(
          `${base(selected)}${selected.recoveryId ? "" : "/deletion"}`,
          undefined,
          "GET",
          20000,
          request.signal,
        );
        if (version !== generation || target !== selected) return;
        if (
          !result.revision ||
          !result.confirmation ||
          result.project !== selected.project ||
          (result.area || "") !== (selected.area || "")
        )
          throw new Error(
            "The deletion preview did not match this selection. Refresh impact and try again.",
          );
        preview = { ...result, blockers: result.blockers || [] };
        title.textContent = `${selected.recoveryId ? "Restore" : "Delete"} ${selected.area ? "PM" : "project"} ${result.name}?`;
        scope.textContent = selected.area
          ? `${selected.project} / ${selected.area}`
          : selected.project;
        list(
          selected.recoveryId
            ? "Resolve before restoring"
            : "Resolve before deleting",
          result.blockers,
          "deletion-blockers",
        );
        if (result.blockers?.length) {
          const links = node("div", undefined, "button-row");
          for (const [text, href] of [
            ["Review active runs", "/activity"],
            [
              "Review project",
              `/projects/${encodeURIComponent(selected.project)}`,
            ],
          ]) {
            const link = node("a", text, "small-button");
            link.href = href;
            link.addEventListener("click", finish);
            links.append(link);
          }
          content.append(links);
        }
        list(
          selected.recoveryId
            ? "Will be restored"
            : "Will be removed from this workspace",
          result.effects,
          "deletion-effects",
        );
        list("Will be kept", result.retained, "deletion-retained");
        content.append(
          node(
            "p",
            selected.recoveryId
              ? "Restoring keeps the original backup. PMs stay paused; review settings and verify the project before enabling automation."
              : "A private recovery backup is created before removal. Unsaved editor drafts for this local item are not included in that backup.",
            "deletion-recovery-note",
          ),
        );
        label.textContent = `Type ${result.confirmation} to confirm`;
        remove.textContent = `${selected.recoveryId ? "Restore" : "Delete"} ${selected.area ? "PM" : "project"}`;
        remove.className = selected.recoveryId
          ? "button button-dark"
          : "button button-danger";
        explanation.textContent = selected.recoveryId
          ? "Type the local ID exactly. Restore does not overwrite another item or enable automation."
          : "Type the local ID exactly. This removes saved configuration, not your source repository or provider resources.";
        notice(
          result.blockers?.length
            ? `Nothing has been ${selected.recoveryId ? "restored" : "deleted"}. Resolve these blockers, then refresh impact.`
            : "",
        );
      } catch (error) {
        if (version === generation) notice(error.message, true);
      } finally {
        if (version === generation) {
          loading = false;
          lock();
        }
      }
    }
    remove.addEventListener("click", async () => {
      if (
        !target ||
        !preview ||
        busy ||
        loading ||
        isLocked() ||
        preview.blockers.length ||
        confirm.value !== preview.confirmation
      )
        return;
      const selected = target,
        reviewed = preview;
      busy = true;
      notice(
        selected.recoveryId
          ? "Restoring local configuration with automation paused…"
          : "Creating the recovery backup and removing local configuration…",
      );
      lock();
      try {
        const result = await api(
          `${base(selected)}${selected.recoveryId ? "/restore" : ""}`,
          { revision: reviewed.revision, confirm: reviewed.confirmation },
          selected.recoveryId ? "POST" : "DELETE",
        );
        if (
          selected.recoveryId
            ? result.restored !== true
            : result.deleted !== true
        )
          throw new Error(
            "The action was not confirmed. Refresh impact to check its current state.",
          );
        completed = true;
        confirmation.hidden = true;
        content.replaceChildren(
          node(
            "p",
            selected.recoveryId
              ? "Local configuration restored. PMs are paused and the project needs verification before automation. The original backup and run history are kept."
              : "Local configuration deleted. Your source repository, external resources, and run history have not been deleted.",
            "deletion-recovery-note",
          ),
        );
        title.textContent = `${selected.area ? "PM" : "Project"} ${selected.recoveryId ? "restored" : "deleted"}`;
        if (!selected.recoveryId) {
          const recover = node("a", "View recently deleted →", "small-button");
          recover.href = "/settings#deleted-resources";
          recover.addEventListener("click", finish);
          content.append(recover);
        }
        notice(`Recovery backup: ${result.recoveryId}`);
        try {
          await (selected.recoveryId ? onRestored : onDeleted)?.({
            ...selected,
            ...result,
          });
        } catch {
          notice(
            `${selected.recoveryId ? "Restored" : "Deleted"} successfully. Recovery backup: ${result.recoveryId}. Refresh the dashboard to update its lists.`,
          );
        }
      } catch (error) {
        notice(
          `${error.message} This view changes only after the server confirms the action. Refresh impact before retrying.`,
          true,
        );
        preview = null;
        confirm.value = "";
      } finally {
        busy = false;
        lock();
        if (completed) keep.focus();
      }
    });
    close.addEventListener("click", finish);
    keep.addEventListener("click", finish);
    refresh.addEventListener("click", load);
    confirm.addEventListener("input", lock);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    return {
      open(value) {
        if (busy || isLocked()) return;
        target = value;
        completed = false;
        preview = null;
        title.textContent = `Review ${value.area ? "PM" : "project"} ${value.recoveryId ? "restoration" : "deletion"}`;
        scope.textContent = value.area
          ? `${value.project} / ${value.area}`
          : value.project;
        if (!dialog.open) dialog.showModal();
        load();
      },
      isBusy: () => busy,
      sync: lock,
    };
  };
})();
