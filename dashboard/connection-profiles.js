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
    { provider, api, onChange, onCreated },
  ) => {
    let locked = true;
    let busy = false;
    let selected = "default";
    const root = node("div", "connection-profiles");
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
    root.append(label, select, note, add);
    container.replaceChildren(root);
    const controls = () => {
      select.disabled = name.disabled = create.disabled = locked || busy;
    };
    select.addEventListener("change", async () => {
      if (locked || busy) return;
      const previous = selected;
      selected = select.value;
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
    };
  };
})();
