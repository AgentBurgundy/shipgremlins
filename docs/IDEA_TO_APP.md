# Start an app with a PM crew

Describe the app you want to build. ShipGremlins proposes a first milestone and
one to four PMs with distinct responsibilities, first assignments, acceptance
criteria, and a build order. Review the plan and ShipGremlins creates a new
repository and the crew together. Repositories are **private by default**.
An existing app uses the separate **I have an app** path.

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

The final review shows the destination, visibility, PMs, and milestone. Linear,
workflow commands, and worker settings can be configured in the project afterward.

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

1. Complete source, Claude Code, Linear, and worker setup. Review the foundation
   PM's brief, run discovery, and verify connections.
2. Use **Run now** on the foundation PM to propose the first implementation
   ticket. Check its scope and acceptance criteria in the review inbox.
3. Approve the ticket and run Coding. Review the resulting draft PR or MR,
   its code and checks, then merge when ready.
4. Configure and test a browser environment once the app runs. The
   [Setup Gremlin](PROJECT_ONBOARDING.md) can help with that step.
5. Run the remaining PMs as their prerequisites become available. Dependency
   order is saved in their briefs; it is not an automatic execution scheduler.

Creating the crew does not run PM jobs, approve tickets, generate application
code, provision hosting, or deploy the app. It creates the team and shared plan
that feed the existing supervised delivery workflow. You decide when to run the
first investigation and what gets implemented.

[Setup](SETUP.md) · [When to use ShipGremlins](WHEN_TO_USE.md) ·
[Delivery workflow](DELIVERY_WORKFLOW.md)
