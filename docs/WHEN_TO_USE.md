# When to use ShipGremlins

**When you have an app worth improving and more work than you can keep up with.**
ShipGremlins gives a product area sustained attention: a PM learns the code and
product, investigates opportunities, and proposes scoped changes. Coding Gremlins
implement work you approve on your own runners. You review the result and decide
what ships.

| Your situation                           | A useful starting point                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Working prototype                        | Connect the repository, adopt one PM, and let it learn the existing app. A public launch is not required.                         |
| A neglected user journey                 | Set an outcome such as “Help new users finish their first import.” Investigate the current journey before deciding on a solution. |
| Approved work waiting for implementation | Start Coding to select a ready ticket, or enable automatic coding pickup separately from PM patrols.                              |
| Several areas need ongoing attention     | Add distinct mandates and schedules as the first one proves useful. Keep concurrency within your ability to review.               |

An editor assistant is still useful for a direct change you already understand.
ShipGremlins is useful when the work includes deciding what deserves attention,
carrying context across runs, coordinating approved implementation, and checking
the result.

## Bring one outcome

For an existing import feature:

> Help users import a CSV and understand which rows were accepted. Investigate
> upload, validation, and confirmation using synthetic contacts. Propose a bounded
> improvement with observable acceptance criteria. Leave billing and account
> permissions alone.

1. **Connect the app.** Choose **Improve my app** in project setup and select its
   GitHub or GitLab repository. Connect Claude Code and a ready Docker worker.
2. **Adopt a focused PM.** Give it the goal, ownership boundaries, and expected
   behavior. Repository discovery can begin without Linear or hosting.
3. **Start an improvement mission.** Use **What should get better?** on the project
   home. The mission retains the outcome and links the investigation, proposed
   tickets, and implementation runs. Connect Linear for ticketed work; configure
   isolated staging for browser investigation.
4. **Approve an epic.** Read its evidence, outcome, finite acceptance criteria and
   exclusions. Approval binds the exact scope. Its PM creates the child tickets;
   expanding the epic needs new approval.
5. **Review a tested batch.** Coders implement and the owning PM tests the deployed
   changes. The controller manages internal PRs and returns genuine QA failures
   to coding. You review that PM's promotion into staging, normally at 10 tickets.
6. **Expand when useful.** Activate the ready crew or manage PM and coding schedules
   independently. Dependencies, WIP limits and project budgets govern admission.

This is the default managed flow. Existing direct-PR and ticket-policy projects
retain their saved behavior until migrated. [All workflow situations →](AUTONOMOUS_WORKFLOW.md)

[The mission workflow →](IMPROVEMENT_MISSIONS.md)

## What makes a project ready?

- **Real source and a clear goal.** Explain the users, the task, and what should
  remain outside the PM's scope.
- **A way to assess changes.** Configure actual install/check commands and review
  acceptance criteria. A successful process does not prove a useful product.
- **An isolated environment for browser work.** Use staging or a supported
  disposable Docker app with dedicated test data and accounts. Repository-only
  tools can stay in repository verification mode.
- **Time to review.** Read proposals, inspect changes, and make merge decisions.

Grumblins add an opinionated simulated perspective on a real journey. Compare
one profile before and after a change. Observed friction, simulated preferences,
and actual customer demand must remain distinct. [Grumblins →](GRUMBLINS.md)

## What about a new idea?

The idea-to-app path remains **experimental**. It proposes a small crew, creates
a private-by-default repository, and prepares a reviewed foundation build. A
foundation can establish code, tests, and a first journey; it can still need
substantial design and integration work. Missing integrations must be reported
as missing, rather than presented as working through a mock.

Improving an existing app is the primary workflow. If you use idea builds, keep
the first milestone small and review the implementation before asking PMs to
investigate it. [Experimental idea builds →](IDEA_TO_APP.md)

[Set up your crew →](SETUP.md) · [Current boundaries →](IMPLEMENTATION_STATUS.md)
