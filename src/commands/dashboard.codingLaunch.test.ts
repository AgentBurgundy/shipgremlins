import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  href = "";
  value = "";
  constructor(public tag: string) {}
  get textContent(): string {
    return (
      this.value + this.children.map((child) => child.textContent).join(" ")
    );
  }
  set textContent(value: string) {
    this.value = value;
    this.children = [];
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}
interface Project {
  name: string;
  instanceId?: string;
  readiness?: {
    canRun: boolean;
    blockers: { id: string; action: string; message: string }[];
  };
}
interface Job {
  id: string;
  type: string;
  project: string;
  projectInstanceId?: string;
  ticket: string;
  status: string;
}
interface Operation {
  busy: boolean;
  kind?: string;
  job?: Job;
  message?: string;
}
interface Callbacks {
  api: (...args: unknown[]) => Promise<{ job?: Job }>;
  getProject: (name: string) => Project | undefined;
  isLocked: () => boolean;
  onState: () => void;
  onChanged: () => Promise<void>;
  onJob: (job: Job) => void;
  onFinished: () => void;
}
function fixture() {
  const window = {} as {
    renderCodingLauncher: (
      project: Project,
      options?: {
        locked?: boolean;
        operation?: Operation;
        jobs?: Job[];
        compact?: boolean;
      },
    ) => Element;
    createCodingActions: (callbacks: Callbacks) => {
      run: (name: string) => Promise<void>;
      getState: (name: string) => Operation | undefined;
      isBusy: () => boolean;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/coding-launch.js", import.meta.url),
      "utf8",
    ),
    { window, document: { createElement: (tag: string) => new Element(tag) } },
  );
  const project: Project = {
    name: "my-app",
    instanceId: "project-1",
    readiness: { canRun: true, blockers: [] },
  };
  const job: Job = {
    id: "job-123",
    project: project.name,
    projectInstanceId: project.instanceId,
    type: "developer",
    ticket: "APP-42",
    status: "queued",
  };
  const callbacks = {
    api: vi.fn<Callbacks["api"]>(async () => ({ job })),
    getProject: (name: string) => (name === project.name ? project : undefined),
    isLocked: vi.fn(() => false),
    onState: vi.fn(),
    onChanged: vi.fn(async () => {}),
    onJob: vi.fn(),
    onFinished: vi.fn(),
  };
  return {
    project,
    job,
    callbacks,
    actions: window.createCodingActions(callbacks),
    render: window.renderCodingLauncher,
  };
}

describe("coding agent launcher", () => {
  it("offers one direct launch and delegates ticket choice and approval checks to the server", async () => {
    const f = fixture();
    const card = f.render(f.project);
    const buttons = card.all().filter((element) => element.tag === "button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Start coding",
    ]);
    expect(buttons[0]!.dataset).toEqual({
      launchProject: "my-app",
      launchCrew: "developer",
    });
    await f.actions.run(f.project.name);
    expect(f.callbacks.api).toHaveBeenCalledExactlyOnceWith(
      "/api/jobs",
      { type: "developer", project: "my-app" },
      "POST",
      90000,
    );
    expect(f.callbacks.onJob).toHaveBeenCalledExactlyOnceWith(f.job);
    expect(f.actions.getState(f.project.name)).toMatchObject({
      busy: false,
      kind: "queued",
      job: f.job,
    });
  });

  it("blocks duplicate clicks while selection is pending and exposes the searching state", async () => {
    const f = fixture();
    let finish!: (value: { job: Job }) => void;
    f.callbacks.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.actions.run(f.project.name);
    await f.actions.run(f.project.name);
    expect(f.callbacks.api).toHaveBeenCalledTimes(1);
    expect(f.actions.isBusy()).toBe(true);
    const card = f.render(f.project, {
      operation: f.actions.getState(f.project.name),
    });
    expect(card.dataset.state).toBe("searching");
    expect(card.attributes.get("aria-busy")).toBe("true");
    expect(
      card.all().find((element) => element.tag === "button")?.disabled,
    ).toBe(true);
    finish({ job: f.job });
    await pending;
    expect(f.actions.isBusy()).toBe(false);
  });

  it("keeps an accepted job when status refresh fails and links to its progress", async () => {
    const f = fixture();
    f.callbacks.onChanged.mockRejectedValue(new Error("status unavailable"));
    await f.actions.run(f.project.name);
    const card = f.render(f.project, {
      operation: f.actions.getState(f.project.name),
    });
    expect(card.dataset.state).toBe("active");
    expect(card.textContent).toContain("APP-42 will start");
    expect(
      card.all().find((element) => element.textContent === "View progress")
        ?.href,
    ).toBe("/activity?run=job-123");
    expect(f.callbacks.onJob).toHaveBeenCalledOnce();
    expect(f.callbacks.api).toHaveBeenCalledOnce();
  });

  it("turns an empty queue into proposal review without creating or approving a ticket", async () => {
    const f = fixture();
    f.callbacks.api.mockRejectedValue(
      new Error("No approved tickets are ready for a new Coding run."),
    );
    await f.actions.run(f.project.name);
    const card = f.render(f.project, {
      operation: f.actions.getState(f.project.name),
    });
    expect(card.dataset.state).toBe("empty");
    expect(
      card.all().find((element) => element.textContent === "Review proposals")
        ?.href,
    ).toBe("/projects/my-app?tab=review");
    expect(f.callbacks.api).toHaveBeenCalledOnce();
    expect(f.callbacks.onJob).not.toHaveBeenCalled();
    expect(f.actions.isBusy()).toBe(false);
  });

  it.each([
    undefined,
    new Error("The server took too long to respond."),
    new Error("Cannot reach the dashboard."),
    new Error("The dashboard received an unexpected response."),
  ])(
    "asks users to inspect Activity when acceptance is uncertain (%s)",
    async (error) => {
      const f = fixture();
      if (error) f.callbacks.api.mockRejectedValue(error);
      else f.callbacks.api.mockResolvedValue({});
      await f.actions.run(f.project.name);
      const card = f.render(f.project, {
        operation: f.actions.getState(f.project.name),
      });
      expect(f.actions.getState(f.project.name)?.kind).toBe("uncertain");
      expect(card.textContent).toContain("Check Activity before trying again");
      expect(
        card
          .all()
          .find(
            (element) =>
              element.tag === "a" && element.textContent === "Open Activity",
          )?.href,
      ).toBe("/activity");
      expect(card.all().some((element) => element.dataset.launchCrew)).toBe(
        false,
      );
    },
  );

  it("shows a rejected launch safely as text with a retry and releases its busy state", async () => {
    const f = fixture();
    f.callbacks.api.mockRejectedValue(
      Object.assign(
        new Error("<script>unsafe</script> Linear access expired."),
        { status: 400 },
      ),
    );
    await f.actions.run(f.project.name);
    const card = f.render(f.project, {
      operation: f.actions.getState(f.project.name),
    });
    expect(card.dataset.state).toBe("error");
    expect(card.textContent).toContain("<script>unsafe</script>");
    expect(card.all().some((element) => element.tag === "script")).toBe(false);
    expect(
      card.all().find((element) => element.attributes.get("role") === "alert")
        ?.textContent,
    ).toContain("Linear access expired");
    expect(f.actions.isBusy()).toBe(false);
  });

  it("shows only the next setup action and never puts controls inside a disclosure", () => {
    const f = fixture();
    f.project.readiness = {
      canRun: false,
      blockers: [
        {
          id: "linear_connection",
          action: "linear",
          message: "Connect Linear first.",
        },
        { id: "worker", action: "worker", message: "Set up a worker." },
      ],
    };
    const card = f.render(f.project);
    expect(card.dataset.state).toBe("setup");
    const controls = card.all().filter((element) => element.tag === "button");
    expect(controls).toHaveLength(1);
    expect(controls[0]!.dataset).toEqual({
      setupProject: "my-app",
      setupAction: "linear",
      setupStep: "linear_connection",
    });
    expect(card.all().some((element) => element.tag === "details")).toBe(false);
  });

  it("does not reuse runs or launch state from a deleted and recreated project", async () => {
    const f = fixture();
    await f.actions.run(f.project.name);
    f.project.instanceId = "project-2";
    expect(f.actions.getState(f.project.name)).toBeUndefined();
    expect(f.render(f.project, { jobs: [f.job] }).dataset.state).toBe("ready");
  });

  it("does not keep reporting queued after the live job finishes", async () => {
    const f = fixture();
    await f.actions.run(f.project.name);
    const card = f.render(f.project, {
      jobs: [{ ...f.job, status: "succeeded" }],
      operation: f.actions.getState(f.project.name),
    });
    expect(card.dataset.state).toBe("ready");
    expect(card.textContent).not.toContain("Your coding run is queued");
  });

  it("shows currently running work before queued work and allows a second deliberate launch", () => {
    const f = fixture();
    const card = f.render(f.project, {
      jobs: [
        f.job,
        { ...f.job, id: "job-2", ticket: "APP-99", status: "running" },
      ],
    });
    expect(card.textContent).toContain("APP-99 is being implemented");
    expect(card.textContent).toContain("2 coding runs in progress");
    expect(
      card.all().find((element) => element.dataset.launchCrew)?.textContent,
    ).toBe("Start another");
  });

  it("keeps active progress visible when there is no additional eligible ticket", () => {
    const f = fixture();
    const card = f.render(f.project, {
      jobs: [f.job],
      operation: { kind: "empty", busy: false },
    });
    expect(card.textContent).toContain("Your ready work is already underway");
    expect(
      card
        .all()
        .find(
          (element) =>
            element.tag === "a" && element.textContent === "View progress",
        )?.href,
    ).toBe("/activity?run=job-123");
  });

  it("prevents launches from a locked dashboard and unknown projects", async () => {
    const f = fixture();
    f.callbacks.isLocked.mockReturnValue(true);
    await f.actions.run(f.project.name);
    f.callbacks.isLocked.mockReturnValue(false);
    await f.actions.run("missing");
    expect(f.callbacks.api).not.toHaveBeenCalled();
    expect(
      f
        .render(f.project, { locked: true })
        .all()
        .find((element) => element.tag === "button")?.disabled,
    ).toBe(true);
    delete f.project.readiness;
    const card = f.render(f.project);
    expect(card.dataset.state).toBe("loading");
    expect(
      card.all().find((element) => element.tag === "button")?.disabled,
    ).toBe(true);
  });
});
