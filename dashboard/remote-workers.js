"use strict";
(() => {
  const el = (tag, text, className = "") => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  window.createRemoteWorkers = (root, { api, pages, isLocked }) => {
    const heading = el("div", undefined, "project-section-title"),
      copy = el("div");
    copy.append(
      el("h3", "Bring another machine"),
      el(
        "p",
        "Run Docker jobs on your server, homelab, or cloud VM. Choose exactly which projects it can work on.",
        "runner-guidance",
      ),
    );
    heading.append(copy);
    const drawer = el("details", undefined, "remote-enrollment"),
      summary = el("summary", "Connect a remote worker");
    drawer.append(summary);
    const form = el("form"),
      fields = el("div", undefined, "remote-fields"),
      name = el("input"),
      controller = el("input"),
      privateLan = el("input"),
      projectList = el("div", undefined, "remote-project-options"),
      status = el("p", "", "operations-message"),
      result = el("section", undefined, "remote-enrollment-result"),
      list = el("div", undefined, "remote-worker-list");
    status.hidden = true;
    result.hidden = true;
    name.id = "remote-worker-name";
    name.required = true;
    name.maxLength = 80;
    name.pattern = "[A-Za-z0-9 \\-]+";
    name.placeholder = "Homelab worker";
    controller.id = "remote-controller-url";
    controller.type = "url";
    controller.required = true;
    controller.placeholder = "https://gremlins.example.com";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))
      controller.value = window.location.origin;
    for (const [input, label, help] of [
      [name, "Worker name", "A recognizable name for this machine."],
      [
        controller,
        "Controller address",
        "An address reachable from the worker. Use HTTPS, or a trusted private LAN address.",
      ],
    ]) {
      const field = el("div", undefined, "field"),
        title = el("label", label);
      title.htmlFor = input.id;
      field.append(title, input, el("p", help));
      fields.append(field);
    }
    privateLan.type = "checkbox";
    privateLan.id = "remote-private-lan";
    const allow = el("label", undefined, "remote-lan-choice");
    allow.append(
      privateLan,
      document.createTextNode("Allow HTTP over my trusted private LAN"),
    );
    const projectLabel = el("fieldset", undefined, "remote-projects");
    projectLabel.append(
      el("legend", "Allowed projects"),
      el(
        "p",
        "Only selected projects can send jobs to this worker.",
        "runner-guidance",
      ),
      projectList,
    );
    const submit = el(
      "button",
      "Generate connection command",
      "button button-dark",
    );
    submit.type = "submit";
    form.append(
      fields,
      allow,
      projectLabel,
      el(
        "p",
        "Docker runs Linux jobs on Linux, macOS, or Windows with Docker Desktop. Native macOS/iOS builds are not supported. Keep the worker process running; use your OS service manager for automatic startup.",
        "runner-guidance",
      ),
      submit,
      status,
    );
    drawer.append(form, result);
    root.append(heading, drawer, list);
    let projects = [],
      workers = [],
      busy = false,
      fetching = false,
      timer,
      signature = "",
      workerError = "",
      secret = "",
      generation = 0;
    function message(text, error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle("error", error);
    }
    function clearCode() {
      generation += 1;
      secret = "";
      result.replaceChildren();
      result.hidden = true;
      form.hidden = false;
    }
    function selections() {
      return [...projectList.querySelectorAll("input")]
        .filter((input) => input.checked)
        .map((input) => input.value);
    }
    function renderProjects() {
      const chosen = new Set(selections());
      projectList.replaceChildren();
      for (const project of projects) {
        const label = el("label"),
          input = el("input");
        input.type = "checkbox";
        input.value = project.name;
        input.checked = chosen.has(project.name);
        label.append(input, el("span", project.name));
        projectList.append(label);
      }
      if (!projects.length)
        projectList.append(
          el(
            "p",
            "Add a project before enrolling a worker.",
            "runner-guidance",
          ),
        );
      submit.disabled = busy || isLocked() || !projects.length;
    }
    function button(text, fn) {
      const value = el("button", text, "small-button");
      value.type = "button";
      value.addEventListener("click", fn);
      return value;
    }
    async function copyCommand(input, notice) {
      try {
        if (navigator.clipboard?.writeText)
          await navigator.clipboard.writeText(input.value);
        else {
          input.focus();
          input.select();
          if (!document.execCommand("copy")) throw new Error("manual");
        }
        notice.textContent =
          "Command copied. Paste it in a terminal on the worker machine.";
      } catch {
        input.focus();
        input.select();
        notice.textContent =
          "Command selected. Copy it manually, then paste it on the worker machine.";
      }
    }
    function paint() {
      const next = JSON.stringify([workers, busy, isLocked(), workerError]);
      if (next === signature) return;
      signature = next;
      list.replaceChildren();
      if (workerError)
        list.append(el("p", workerError, "operations-message error"));
      if (!workers.length) {
        list.append(
          el(
            "p",
            "No remote machines connected yet. Your local workers keep running independently.",
            "runner-guidance",
          ),
        );
        return;
      }
      for (const worker of workers) {
        const card = el("article", undefined, "remote-worker-card"),
          identity = el("div"),
          state = worker.revoked
            ? "Access revoked"
            : worker.online
              ? "Online"
              : worker.enrolled
                ? "Offline"
                : "Awaiting enrollment";
        identity.append(
          el("strong", worker.name),
          el(
            "span",
            state,
            `runtime-badge ${worker.online && !worker.revoked ? "state-ready" : ""}`,
          ),
          el(
            "p",
            `${worker.projects.join(" · ")}${worker.platform ? ` · ${worker.platform}${worker.architecture ? ` / ${worker.architecture}` : ""}` : ""}`,
            "runner-guidance",
          ),
        );
        card.append(identity);
        if (!worker.revoked) {
          const revoke = button("Revoke access", () => {
            const confirm = el("div", undefined, "approval-confirm");
            confirm.append(
              el(
                "p",
                `Revoke ${worker.name}? Its worker access and active lease will be stopped. Existing run history is preserved.`,
              ),
            );
            const accept = button("Revoke this worker", async () => {
              if (busy || isLocked()) return;
              busy = true;
              workerError = "";
              accept.disabled = true;
              try {
                await api(
                  `/api/remote/${encodeURIComponent(worker.id)}/revoke`,
                  {},
                );
                await refresh();
              } catch (error) {
                workerError = `Worker access was not revoked. ${error.message}`;
              } finally {
                busy = false;
                signature = "";
                paint();
              }
            });
            const cancel = button("Keep connected", () => confirm.remove());
            confirm.append(accept, cancel);
            card.append(confirm);
            accept.focus();
          });
          revoke.disabled = busy || isLocked();
          card.append(revoke);
        }
        list.append(card);
      }
    }
    async function refresh() {
      if (fetching || isLocked()) return;
      fetching = true;
      try {
        const data = await api("/api/remote/status");
        workers = data.workers || [];
        paint();
      } catch (error) {
        if (!workers.length)
          list.replaceChildren(
            el(
              "p",
              `Remote worker status could not load. ${error.message}`,
              "operations-message error",
            ),
          );
      } finally {
        fetching = false;
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || isLocked() || !form.reportValidity()) return;
      const allowed = selections();
      if (!allowed.length) {
        message("Choose at least one allowed project.", true);
        return;
      }
      let origin;
      try {
        const url = new URL(controller.value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error(
            "Use an HTTP(S) origin without a path or credentials.",
          );
        if (url.protocol === "http:" && !privateLan.checked)
          throw new Error("Use HTTPS or explicitly allow your private LAN.");
        if (url.protocol === "http:") {
          const parts = url.hostname.split(".").map(Number);
          const privateAddress =
            parts.length === 4 &&
            parts.every(
              (part) => Number.isInteger(part) && part >= 0 && part <= 255,
            ) &&
            (parts[0] === 10 ||
              parts[0] === 127 ||
              (parts[0] === 192 && parts[1] === 168) ||
              (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
              (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
          if (!privateAddress)
            throw new Error(
              "For HTTP, enter a private LAN or Tailscale IP address. Use HTTPS for a public host.",
            );
        }
        origin = url.origin;
      } catch (error) {
        message(
          error.message || "Enter the reachable controller address.",
          true,
        );
        return;
      }
      busy = true;
      submit.disabled = true;
      const requestGeneration = generation;
      message("Creating a one-time enrollment code…");
      try {
        const enrollment = await api("/api/remote/enrollments", {
          name: name.value.trim(),
          projects: allowed,
        });
        if (requestGeneration !== generation || pages.current !== "runners")
          return;
        secret = enrollment.code;
        result.replaceChildren();
        const command = el("textarea");
        command.readOnly = true;
        command.rows = 4;
        command.setAttribute("aria-label", "Private worker enrollment command");
        command.value = `gremlins worker --controller '${origin}' --enrollment-code ${secret}${origin.startsWith("http:") ? " --allow-insecure-lan" : ""}`;
        const notice = el(
          "p",
          "This code expires in 10 minutes and can be used once. Treat this command as a credential.",
          "runner-guidance",
        );
        notice.setAttribute("role", "status");
        result.append(
          el("h4", "Run this on the worker machine"),
          el(
            "p",
            "Install the gremlins CLI and Docker there first. The command connects back to this dashboard’s controller.",
            "runner-guidance",
          ),
          command,
          button("Copy command", () => copyCommand(command, notice)),
          button("Done — hide command", clearCode),
          notice,
        );
        form.hidden = true;
        result.hidden = false;
        message("");
        await refresh();
      } catch (error) {
        message(error.message, true);
      } finally {
        busy = false;
        submit.disabled = isLocked();
      }
    });
    function schedule() {
      clearTimeout(timer);
      if (pages.current !== "runners" || document.hidden || isLocked()) return;
      refresh();
      timer = setTimeout(schedule, 15000);
    }
    window.addEventListener("dashboard:pagechange", () => {
      if (pages.current !== "runners") clearCode();
      schedule();
    });
    window.addEventListener("pagehide", () => {
      clearCode();
      clearTimeout(timer);
    });
    document.addEventListener("visibilitychange", schedule);
    drawer.addEventListener("toggle", () => {
      if (!drawer.open) clearCode();
    });
    return {
      setProjects(value) {
        const next = value || [];
        if (
          JSON.stringify(next.map((p) => p.name)) !==
          JSON.stringify(projects.map((p) => p.name))
        ) {
          projects = next;
          renderProjects();
        } else submit.disabled = busy || isLocked() || !projects.length;
        schedule();
      },
      isBusy: () => busy,
    };
  };
})();
