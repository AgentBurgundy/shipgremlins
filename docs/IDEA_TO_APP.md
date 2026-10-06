# Experimental: start an app with a PM crew

Improving an existing application is ShipGremlins' primary workflow. This path
is an experiment for establishing a foundation, not a promise of a polished
application from one prompt. Inspect the design, actual integrations, and complete
journey before treating the first draft as a usable product. A mock adapter must
be identified as a limitation; passing tests against it do not verify the real
service. [Improve an existing app →](WHEN_TO_USE.md)

Describe the app you want to build. ShipGremlins proposes a first milestone and
one to four PMs with distinct responsibilities, first assignments, acceptance
criteria, and a build order. Review the plan and ShipGremlins creates a new
repository and the crew together. Repositories are **private by default**.
An existing app uses the primary **Improve my app** path.

## Describe the first useful version

1. Open **Projects → Add project** and choose **I have an idea**. Setup asks one
   question at a time. Back preserves your answers.
2. Describe the users, their main task, and what to leave out. For example:

   > A booking app for a small pottery studio. Students browse classes and
   > reserve a seat. The owner manages sessions and capacity. The first version
   > needs bookings, but no online payments.

3. Choose **Plan my crew**. Planning needs Claude Code connected in **Connections**
   and Docker available on the controller. It does not need repository access
   and does not create a project or change source code.
4. Review the first milestone, PM responsibilities, assumptions, and exclusions.
   Edit the idea and plan again if the scope is wrong. Small ideas may need only
   one PM. The **foundation** PM owns the initial app and first complete user journey;
   later PMs extend that same application.

## Create the crew

Name the project, choose GitHub or GitLab, and select its owner. The project name
also names the new repository. GitHub supports your personal account and listed
organizations; GitLab supports owned namespaces, including groups. The provider
enforces your permission to create there. For self-hosted GitLab, enter its HTTPS
origin and use a token issued by that server.

Choose visibility next. **Private** is selected by default. Select **Public · for
open source** only when everyone should be able to read the code and product
brief. Public visibility does not add an open-source license; choose a license
before inviting contributions. Visibility is never inferred from AI output.

The final review shows the destination, visibility, PMs, and milestone. The next
step is the foundation build. Linear setup happens as part of that reviewed
action; you do not need a running app or a test URL.

Choose **Create private repository & crew** (or the explicit public option). ShipGremlins:

- Creates the provider repository and adds a README containing the reviewed brief.
  A name collision never adopts or changes an unrelated repository.
- Creates the local project and all proposed PMs, with individual briefs and
  one shared product decision recording the milestone and build order.
- Starts with repository verification, a pull-request workflow, and one active
  work item per PM. Schedules remain paused.

Creation is resumable. If it stops halfway, retry the same plan and destination.
The dashboard retains the draft in the current browser session; reloading can
recover the saved plan from the controller. Completed steps are reused. If you
edit a partially created PM or its repository README, resolve the reported
conflict before continuing. A repository created before an interruption is retained;
starting a different setup does not delete it. The destination and visibility are
fixed after creation begins. Older saved plans targeting existing repositories
can still resume.

GitHub creation needs **Repository creation (write)** or **Administration (write)**
on the app/token. A classic token needs `repo` for private repositories. The app
also needs access to the new repository with Contents and Pull requests write
permissions. If creation or installation access is denied, update access at GitHub,
accept any changed app permissions, then choose **Resume setup**. GitLab needs
`api` access and permission to create in the selected namespace. Setup never
expands permissions or substitutes a different account automatically.

## Build the first slice

The current starting stack is a **Node.js web app with npm**. The foundation brief
requires a runnable app, `package.json`, `npm start`, and meaningful `npm test`
checks. Proposed ownership paths are suggestions until code exists.

For an explicit request for a different stack, the planner must explain its
proposed Node.js alternative and the unmet requirement in the summary and first
milestone before you approve it. Review those assumptions in the build brief.
Automatic foundation building does not scaffold Python-only, native mobile, or
native engine applications. To work on an existing app using another stack,
choose **Improve my app** and configure its own install and test commands.

1. Open the project's **Environment** page. A new idea shows **First, let's
   build your app** with the first milestone and acceptance criteria. **Read the
   full build brief** shows the exact ticket scope.
2. Choose **Approve & build foundation**. This approves one foundation ticket,
   prepares the selected Linear team, PM projects and required labels, verifies
   connections, and queues a Coding Gremlin on your runners. Connect source
   control, Claude Code and Linear, and verify a runner if prompted. Existing
   mappings are preserved. A test URL, hosting account and PM analysis are not
   prerequisites for this build.
3. The coding run implements the first journey, startup command, meaningful
   tests and a Dockerfile for later testing. Open the run to review its draft
   PR or MR and check evidence. Merge when ready; this button never merges or
   deploys the app.
4. Choose **I've merged it · check repository**. ShipGremlins checks the base
   branch for application source, `npm start`, `npm test` and test files before
   showing environment setup. This is a source check, not a claim that the app
   runs. **My app already has code** supports work built outside the dashboard.
5. Configure and test a browser environment with the
   [Setup Gremlin](PROJECT_ONBOARDING.md), then run PM discovery or a patrol.
   Empty idea repositories are held at the foundation step rather than spending
   a PM run looking for features that do not exist.
6. Run the remaining PMs as their prerequisites become available. Dependency
   order is saved in their briefs; it is not an automatic execution scheduler.

The build is resumable. A dropped response or a second click reuses the saved
Linear issue and coding run. A failed or canceled run needs **Retry foundation
build**; that starts a new attempt on the same ticket. Removed ticket approval,
changed scope, or changed account mappings require review, rather than being
silently overwritten. PM schedules remain paused throughout.

Creating the crew alone does not start jobs or approve tickets. The separate
**Approve & build foundation** action approves only the displayed first build.

[Setup](SETUP.md) · [When to use ShipGremlins](WHEN_TO_USE.md) ·
[Delivery workflow](DELIVERY_WORKFLOW.md)
