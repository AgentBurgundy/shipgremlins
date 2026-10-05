"use strict";

(() => {
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  window.createConnectionProfiles = (
    container,
    { provider, api, onChange, onCreated, onRemoved },
  ) => {
    let locked = true;
    let busy = false;
    let selected = "default";
    const root = node("div", "connection-profiles");
    const remove = node(
        "button",
        "small-button danger-button",
        "Remove saved account",
      ),
      prompt = node("div", "approval-confirm"),
      removeStatus = node("p", "form-message");
    remove.type = "button";
    prompt.hidden = true;
    removeStatus.hidden = true;
    removeStatus.setAttribute("role", "status");
    const label = node("label", "", "Saved connection");
    const select = node("select", "");
    select.id = `${provider}-profile`;
    label.htmlFor = select.id;
    const note = node(
      "p",
      "setup-help",
      "Manage an account here. Choose which connection each project uses in its settings.",
    );
    const add = node("details", "profile-add");
    add.append(node("summary", "", "Add another account or workspace"));
    const nameLabel = node("label", "", "Connection name");
    const name = node("input", "");
    name.id = `${provider}-profile-name`;
    nameLabel.htmlFor = name.id;
    name.placeholder = "e.g. Acme workspace";
    name.maxLength = 80;
    name.autocomplete = "off";
    const create = node("button", "small-button", "Create connection");
    create.type = "button";
    const status = node("p", "form-message");
    status.hidden = true;
    status.setAttribute("role", "status");
    add.append(nameLabel, name, create, status);
    root.append(label, select, note, remove, prompt, removeStatus, add);
    container.replaceChildren(root);
    const controls = () => {
      select.disabled = name.disabled = create.disabled = locked || busy;
      remove.disabled = locked || busy;
      remove.hidden = selected === "default";
      for (const button of prompt.querySelectorAll("button"))
        button.disabled = locked || busy;
    };
    select.addEventListener("change", async () => {
      if (locked || busy) return;
      const previous = selected;
      selected = select.value;
      prompt.hidden = true;
      removeStatus.hidden = true;
      busy = true;
      controls();
      try {
        await onChange(selected);
      } catch (error) {
        selected = previous;
        select.value = previous;
        status.hidden = false;
        status.textContent = error.message;
        add.open = true;
      } finally {
        busy = false;
        controls();
      }
    });
    remove.addEventListener("click", () => {
      if (locked || busy || selected === "default") return;
      const id = selected,
        display = select.selectedOptions?.[0]?.textContent || selected;
      prompt.replaceChildren(
        node(
          "p",
          "",
          `Remove ${display} from this instance? Local browser credentials will be removed. Projects that still use this account or active jobs will block removal. This does not uninstall or revoke a shared provider app. Its local ID stays reserved; reconnect with a new saved account.`,
        ),
      );
      const accept = node(
          "button",
          "small-button danger-button",
          "Remove this saved account",
        ),
        keep = node("button", "small-button", "Keep account");
      accept.type = keep.type = "button";
      keep.addEventListener("click", () => {
        prompt.hidden = true;
      });
      accept.addEventListener("click", async () => {
        if (locked || busy || id !== selected) return;
        busy = true;
        controls();
        removeStatus.hidden = true;
        try {
          await api("/api/service-connections", { provider, id }, "DELETE");
          selected = "default";
          prompt.hidden = true;
          await onRemoved?.(id);
          removeStatus.textContent =
            "Saved account removed from this instance. The provider app remains installed.";
          removeStatus.hidden = false;
        } catch (error) {
          removeStatus.textContent = error.message;
          removeStatus.hidden = false;
        } finally {
          busy = false;
          controls();
        }
      });
      prompt.append(accept, keep);
      prompt.hidden = false;
      accept.focus();
    });
    create.addEventListener("click", async () => {
      if (locked || busy) return;
      const label = name.value.trim();
      if (!label) {
        name.focus();
        return;
      }
      // The stable ID is a storage reference. Users work with the friendly label.
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const id = `${/^[a-z]/.test(slug) ? slug : `account-${slug || "new"}`}-${suffix}`;
      busy = true;
      controls();
      status.hidden = true;
      try {
        await api("/api/service-connections", { provider, id, label });
        selected = id;
        name.value = "";
        await onCreated(id);
        add.open = false;
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message;
      } finally {
        busy = false;
        controls();
      }
    });
    return {
      setConnections(connections, value = selected) {
        selected = value;
        const profiles = connections.filter(
          (item) => item.provider === provider,
        );
        if (!profiles.some((item) => item.id === "default"))
          profiles.unshift({ id: "default", label: "Default connection" });
        if (!profiles.some((item) => item.id === value))
          profiles.push({ id: value, label: `${value} · unavailable` });
        select.replaceChildren(
          ...profiles.map(
            (item) =>
              new Option(
                `${item.label || item.id}${item.connected ? " · connected" : ""}`,
                item.id,
              ),
          ),
        );
        select.value = value;
        controls();
      },
      setLocked(value) {
        locked = value;
        controls();
      },
      isDirty: () => Boolean(name.value.trim()),
      isBusy: () => busy,
    };
  };
})();
