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
      el("h3", "Remote runners"),
      el(
        "p",
        "Add capacity from a server, homelab, or cloud machine.",
        "runner-guidance",
      ),
    );
    const connect = el("button", "Connect a runner", "small-button"),
      drawer = el("dialog", undefined, "remote-enrollment-dialog"),
      dialogHeading = el("header", undefined, "remote-enrollment-heading"),
      dialogIdentity = el("div"),
      stepLabel = el("p", "STEP 1 OF 3", "remote-enrollment-step"),
      dialogTitle = el("h2", "Where will your runner live?"),
      close = el("button", "Close ×", "small-button");
    connect.type = close.type = "button";
    dialogTitle.id = "remote-enrollment-title";
    drawer.setAttribute("aria-labelledby", dialogTitle.id);
    dialogIdentity.append(stepLabel, dialogTitle);
    dialogHeading.append(dialogIdentity, close);
    drawer.append(dialogHeading);
    document.body.append(drawer);
    heading.append(copy, connect);
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
    status.setAttribute("role", "status");
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
      "Create connection command",
      "button button-dark",
    );
    submit.type = "submit";
    const machineStep = el("section", undefined, "remote-enrollment-machine"),
      projectsStep = el("section", undefined, "remote-enrollment-projects"),
      footer = el("div", undefined, "remote-enrollment-footer"),
      back = el("button", "Back", "small-button"),
      next = el("button", "Continue", "button button-dark");
    back.type = next.type = "button";
    machineStep.append(
      fields,
      allow,
      el(
        "p",
        "Install Docker and the gremlins CLI on this machine first. Jobs run in isolated Linux containers.",
        "runner-guidance",
      ),
    );
    projectsStep.append(projectLabel);
    footer.append(back, next, submit);
    form.append(machineStep, projectsStep, footer, status);
    drawer.append(form, result);
    root.append(heading, list);
    let projects = [],
      workers = [],
      busy = false,
      fetching = false,
      timer,
      signature = "",
      workerError = "",
      secret = "",
      generation = 0,
      step = 1;
    function setStep(value, focus = false) {
      step = value;
      machineStep.hidden = step !== 1;
      projectsStep.hidden = step !== 2;
      back.hidden = step !== 2;
      next.hidden = step !== 1;
      submit.hidden = step !== 2;
      stepLabel.textContent = `STEP ${step} OF 3`;
      dialogTitle.textContent =
        step === 1
          ? "Where will your runner live?"
          : step === 2
            ? "Which projects can it work on?"
            : "Connect your runner";
      if (focus)
        (step === 1 ? name : projectList.querySelector("input"))?.focus();
    }
    function closeDialog({ restoreFocus = true } = {}) {
      clearCode();
      if (drawer.open) drawer.close();
      if (restoreFocus) connect.focus();
    }
    connect.addEventListener("click", () => {
      if (isLocked() || busy) return;
      setStep(1);
      message("");
      drawer.showModal();
      name.focus();
    });
    close.addEventListener("click", () => closeDialog());
    drawer.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    back.addEventListener("click", () => {
      if (!busy) {
        message("");
        setStep(1, true);
      }
    });
    next.addEventListener("click", () => {
      if (busy || !name.reportValidity() || !controller.reportValidity())
        return;
      try {
        controllerOrigin();
      } catch (error) {
        message(error.message, true);
        return;
      }
      message("");
      setStep(2, true);
    });
    setStep(1);
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
      setStep(1);
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
            "Remote runners will appear here once connected.",
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
    function controllerOrigin() {
      const url = new URL(controller.value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Use an HTTP(S) origin without a path or credentials.");
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
      return url.origin;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (step === 1) {
        next.click();
        return;
      }
      if (busy || isLocked() || !form.reportValidity()) return;
      const allowed = selections();
      if (!allowed.length) {
        message("Choose at least one allowed project.", true);
        return;
      }
      let origin;
      try {
        origin = controllerOrigin();
      } catch (error) {
        message(
          error.message || "Enter the reachable controller address.",
          true,
        );
        return;
      }
      busy = true;
      submit.disabled = true;
      connect.disabled = true;
      back.disabled = true;
      submit.textContent = "Creating command…";
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
          button("Done", () => closeDialog()),
          notice,
        );
        form.hidden = true;
        result.hidden = false;
        setStep(3);
        message("");
        await refresh();
      } catch (error) {
        message(error.message, true);
      } finally {
        busy = false;
        submit.disabled = isLocked() || !projects.length;
        connect.disabled = isLocked();
        back.disabled = false;
        submit.textContent = "Create connection command";
      }
    });
    function schedule() {
      clearTimeout(timer);
      if (pages.current !== "runners" || document.hidden || isLocked()) return;
      refresh();
      timer = setTimeout(schedule, 15000);
    }
    window.addEventListener("dashboard:pagechange", () => {
      if (pages.current !== "runners") closeDialog({ restoreFocus: false });
      schedule();
    });
    window.addEventListener("pagehide", () => {
      clearCode();
      clearTimeout(timer);
    });
    document.addEventListener("visibilitychange", schedule);
    drawer.addEventListener("close", () => {
      clearCode();
    });
    return {
      setProjects(value) {
        connect.disabled = busy || isLocked();
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
