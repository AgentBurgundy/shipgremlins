# When to use ShipGremlins

**AI product managers that actually use your app.**

Start with a product idea or an app you already have. ShipGremlins can turn an
idea into a proposed first milestone and PM crew, then carry work through the
same supervised delivery loop used to improve an existing product. PMs plan and
investigate; Coding Gremlins implement approved tickets and prepare draft PRs
or MRs. You set priorities and review what ships.

## Find your starting point

| Where you are                          | A useful next step                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| An idea or an empty repository         | Describe the users and first useful version. Review the crew and its private-by-default repository, then approve and build the foundation. |
| An early codebase or working prototype | Give one PM a focused goal and run repository discovery. Review its feature map and opportunities before assigning more work.              |
| A product with a growing backlog       | Use a PM patrol to investigate a flow, approve a scoped improvement, and review the Coding Gremlin's draft change.                         |
| An established app with several areas  | Add distinct mandates for areas that need attention. Set schedules and work limits around your ability to review the results.              |

An idea can be enough to plan a crew. A prototype can be enough to start improving
an app. You do not need paying users, a public launch,
a funding milestone, or a large team. The useful signal is development work that
deserves sustained attention: an import flow you keep postponing, onboarding
with too many rough edges, or account permissions that need another careful look.

## What makes a project ready?

- **An idea or existing source.** Describe the new app, or connect its GitHub or
  GitLab repository. Idea planning needs no repository; creating the crew also
  creates a new repository, private by default, in your chosen source account.
  [Follow the idea-to-app guide →](IDEA_TO_APP.md)
- **A clear goal.** Explain who uses the product, what should work better, and
  which area the PM should investigate. Set boundaries for changes it should avoid.
- **A way to judge the result.** Review findings and acceptance criteria. Before
  coding work, configure the app's install and check commands.
- **Time to review.** Start with enough room to read the findings, approve useful
  work, and inspect the resulting code and checks.

Browser patrols also need a runnable app in an isolated test environment with
appropriate test accounts or public test access. Use hosted staging or a
supported disposable Docker app. The [Setup Gremlin](PROJECT_ONBOARDING.md) can
recommend a test strategy and propose setup files for your existing application.

Repository discovery can begin before browser or Linear setup. It needs source
access, Claude Code, and a ready Docker worker. It builds context without filing
tickets or publishing code. [Learn about discovery →](PM_WORKFLOW.md)

## A first assignment that earns its keep

For a new app, use **one milestone and a foundation PM**. The idea planner
proposes one to four PMs with first assignments and dependency order. Creating
the crew saves their briefs together and creates a repository with a README.
Private visibility is the default; choose public explicitly for open-source work.
PMs start paused. Review **Build the foundation** and choose **Approve & build**
to prepare its Linear ticket and queue a Coding Gremlin. Merge the reviewed draft
before routine PM analysis and browser walkthroughs. The initial stack is Node.js with npm.
[Start an app with a PM crew →](IDEA_TO_APP.md)

For a fresh perspective on a working app, try [Grumblins](GRUMBLINS.md).
AI generates customers suited to your product and gives each a goal, personality
and patience budget. Their walkthroughs expose friction and possible unmet needs;
PMs investigate the evidence and propose experiments. These are simulated
perspectives to test with real users, not a substitute for customer research.

For an existing app, start with **one PM, one area, one useful change**. For example, give a PM this
mandate for an existing import feature:

> Help users import a CSV and understand the result. Investigate upload,
> validation, and confirmation using synthetic contacts. Look for lost valid
> rows, unclear errors, and confusing empty states. Propose a bounded improvement
> with reproducible evidence and acceptance criteria. Leave billing and account
> permissions alone.

1. **Connect the app and create one PM.** Follow [setup](SETUP.md). Give the PM
   the goal, boundaries, and expected behavior in its product brief. Keep
   automation paused.
2. **Run Discovery.** Review the feature inventory, opportunities, and source
   evidence. Correct the PM's understanding before asking it to investigate more.
3. **Try one supervised patrol.** Finish the PM's Linear mapping and project
   checks. For browser work, configure and test its environment first. Choose
   **Run now** and inspect the findings and evidence in Activity.
4. **Approve one bounded ticket.** Confirm that the scope and acceptance criteria
   are useful. Run Coding on that approved ticket, then review the draft PR or
   MR and its checks. Discovery alone does not create a ticket for a Coding run.
5. **Decide whether to expand.** If the findings and implementation justify the
   review time, enable a schedule or add another mandate. If they do not, refine
   the brief and try a narrower assignment.

The first win is a concrete improvement you can inspect. A finished process or
an impressive report is not proof that the app improved. See the
[verification model](VERIFICATION.md) and [delivery workflow](DELIVERY_WORKFLOW.md)
for evidence and merge controls.

## Keep your editor. Grow your crew.

Your editor and coding assistant remain useful for hands-on changes.
ShipGremlins supplies persistent PM responsibilities, shared direction, and a
repeatable route from a proposal to reviewed implementation. Idea onboarding
assembles that crew; the Setup Gremlin helps prepare a runnable app for testing.

If you are still exploring the product, keep the first milestone small and
review the planner's assumptions. If you only need one immediate edit, a direct
session with your coding tool may
be simpler. ShipGremlins becomes more useful when you can give an area ongoing
attention through a clear mandate and a repeatable review process.

Add mandates deliberately: imports first, then onboarding, then permissions,
for example. Each should have a useful goal and clear ownership. Add worker
capacity only when there is approved work and room to review it. More simultaneous
work still needs coordination and human judgment.

ShipGremlins is early alpha. Start with a small supervised assignment and consult
the [implementation status](IMPLEMENTATION_STATUS.md) for current boundaries.

[Set up your first crew →](SETUP.md)
