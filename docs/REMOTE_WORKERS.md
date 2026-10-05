# Remote Docker workers

The dashboard controller owns the queue, approved tickets, project connections, and run history. A remote worker polls that controller and runs one isolated Linux Docker job at a time. It needs outbound access to the controller, source provider, model provider, and the app under test. No inbound worker port or Docker socket is exposed to the controller.

Workers run on Linux, or Docker Desktop on Windows and macOS. This release does not run native macOS or iOS jobs. A Google Compute Engine VM with Docker and Node.js 22.12 or newer can run the same worker command; this is a persistent worker process, not a Cloud Run service.

Projects can select a [managed Docker test environment](PROJECT_ONBOARDING.md). The remote worker then creates the app and optional PostgreSQL/Redis beside the gremlin on a private network, renews its controller lease during preparation, and cleans up after evidence upload. Keep the controller and remote CLI on version 0.14.0 or newer for this payload; run `gremlins update` on each machine. A controller-side environment check does not prove a hosted URL is reachable from another worker's network.

## Connect a worker

1. Install ShipGremlins and Docker on the worker machine. Confirm Docker can run Linux containers as the account that will run the worker.
2. In the controller's Workers page, create a remote enrollment, name the worker, and select the projects it may run. The one-time code expires after ten minutes. Enrollment alone does not verify the worker: the controller queues a real Chromium screenshot check before admitting project work.
3. Run the command shown by the dashboard on the worker machine:

   ```sh
   gremlins worker --controller https://gremlins.example.com --enrollment-code ONE_TIME_CODE
   ```

   The first start builds the bundled worker image locally. No source-provider or model token goes in this command. Keep the command running. For a separate worker identity on the same machine, specify a separate `--worker-home /absolute/worker-directory`.

4. Later starts use the saved worker identity without the enrollment code:

   ```sh
   gremlins worker --controller https://gremlins.example.com
   ```

The default worker directory is `~/.shipgremlins/worker`. Its private `remote-worker.json` contains the worker credential and current launch identity. Preserve it across restarts. A process lock prevents two worker processes from sharing that directory. An unknown attempted launch is reported for review rather than executed again.

For unattended startup, run the latter command under your operating system's service manager using the same user, worker directory, and installed `gremlins` executable. For example, a Linux systemd service can use an absolute `ExecStart=/path/to/gremlins worker --controller https://gremlins.example.com --worker-home /home/gremlins/.shipgremlins/worker`, with `User=gremlins`, `Restart=on-failure`, and `RestartSec=15`. Do not include the enrollment code in the service definition. The service account needs permission to use Docker. Stopping the command stops its current owned job; a service restart reconciles the saved job identity.

## Reach the controller

Remote connections require HTTPS by default. Configure your existing TLS reverse proxy to forward to the dashboard and set its exact public origin before starting the dashboard:

```sh
export SHIPGREMLINS_DASHBOARD_URL=https://gremlins.example.com
gremlins dashboard --port 4311
```

PowerShell uses `$env:SHIPGREMLINS_DASHBOARD_URL = 'https://gremlins.example.com'`. The dashboard accepts the configured origin and host; forwarded headers alone cannot change that authority. A reverse proxy on the same host can forward to loopback. If your proxy is on another trusted machine, launch the dashboard with `--lan` and restrict access to its HTTP port appropriately. The environment setting declares the external HTTPS origin; the dashboard itself does not issue certificates or terminate TLS.

For a private homelab or a Tailscale IP, an explicit exception is available:

```sh
gremlins worker --controller http://192.168.1.20:4311 --enrollment-code ONE_TIME_CODE --allow-insecure-lan
```

This permits only literal private IPv4 or Tailscale addresses. Public HTTP and arbitrary HTTP hostnames remain rejected. The flag does not add encryption: use HTTPS or an encrypted trusted network. Loopback HTTP is allowed for a worker on the controller machine. Use the printed dashboard port; do not put a dashboard `#session` link or dashboard capability token into the worker command.

## Scope, cancellation, and recovery

- Enrollment binds a worker to the selected projects, including their internal identities. Deleting a project and creating another with the same name does not transfer worker access: enroll a worker for the replacement project. A different project's queued job cannot send credentials to that worker. Each worker has one execution slot; the workspace currently supports four logical worker slots total.
- Jobs receive the same scoped, short-lived credentials and isolated Docker limits as local jobs. The worker credential stays on the host and is never provided to the job container. Pending payloads are encrypted in the controller's `.run/remote-workers` registry; retained logs and text evidence are sanitized before storage.
- Every assignment has a random job lease. Authenticated polling renews it. A separate watchdog inside the container checks a root-owned lease file, so losing the worker process or controller connection stops execution without relying on the dashboard to remain online. The lease lasts at most two minutes, with a short forced-stop grace period. A late report cannot revive an expired lease.
- Cancel records the request first and stops only that job's owned container. The UI remains pending until the controller has confirmation, or the independent lease has expired. Revoking a worker prevents further polling and new jobs; an already running container is bounded by that lease.
- Losing contact after a launch does not cause automatic agent execution or publication to repeat. Review the failure and any existing draft PR before submitting another job. Completed evidence uploads and job inspection remain available after controller restart.
- Delivery review runs in a separate browser-only container after the model container has stopped. Its recipe and private role sessions are mounted read-only; replay proof and screenshots go to a different protected volume. The worker uploads that independent proof through its authenticated channel. A model-written pass file or digest cannot authorize promotion. Recipes and private sessions are excluded from ordinary artifact downloads.
- Keep the controller's encrypted registry and its key together when backing up `.run/remote-workers`. Keep the worker directory private. Updates preserve these identities; do not delete them to repair a running job.

The remote channel uses its own worker authentication under `/api/remote/worker/*`. Owner enrollment, project selection, status, and revocation remain protected by the dashboard session.
