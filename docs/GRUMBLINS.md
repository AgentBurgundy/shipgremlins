# Grumblins: let simulated customers try your app

Open a project's **Your crew** page and choose **Grumblins**.
Choose **Find my Grumblins** to generate three opinionated customers
for this product. You can optionally focus them on a journey or question, such
as “Would a first-time customer finish booking on a phone?”

The AI uses the project's PM briefs, owner decisions and retained observations.
It creates profiles for the project rather than choosing from a fixed list of
personality templates. Each has a specific role, goal, situation, personality,
device, familiarity, patience budget and success criteria. The profile explains
why it fits the product and lists assumptions that still need checking. These
are **simulated customers, not real customer research**.

If the project has no useful brief or retained context yet, describe what the app
does and who it helps in the focus field first. Generation asks for that context
instead of producing generic customers from an empty project.

You can prepare profiles while an idea's foundation is being built. Running a
walkthrough requires application code, a preview or staging environment, a PM
with a reviewed mandate, source and Claude connections, and an eligible Docker
worker. Linear setup is not required for the simulation itself. Hosted staging
and isolated local app environments use the project's existing environment
configuration and dedicated test accounts.

## Try a goal, then read the evidence

Choose **Simulate** on a profile. The job runs through the existing runner queue,
including eligible remote runners. Repeated clicks reuse an active run for that
profile. You can follow progress and open its report through Activity; the
responsible PM retains the resulting observations in Learning.

The Grumblin attempts its goal as a customer, working from the visible interface.
It records the actual journey, interaction counts, wrong turns, screenshots when
available, and whether it succeeded, gave up or was blocked. A useful report also
acknowledges what worked. A click budget is a scenario constraint, not a measured
human tolerance or a reason to invent a complaint.

The PM then investigates the strongest observations and possible unmet needs.
It distinguishes reproduced friction from assumptions about demand, considers
competing customer priorities, and proposes a small experiment with a clear
success measure. Missing access or features are reported honestly; they do not
become imaginary interactions or proof of market demand.

The simulation saves evidence and candidate ideas. It does not create or approve
Linear tickets, change app code, promote releases or enable a recurring schedule.
A later PM patrol can use the retained evidence to investigate and propose work
through the normal owner review process. After a change is available in the test
environment, run the same profile again to compare the experience.

[Improvement missions](IMPROVEMENT_MISSIONS.md) can attach that followup to a
specific outcome. Structured journey reports are retained per run with the
profile, job, and revision context, rather than relying only on the latest PM
Markdown. Compare the same scenario and inspect environmental differences.
Reported click counts and preferences remain model observations; they do not
establish measured customer conversion or independently verified acceptance.

## Keep customer context current

Profiles survive reloads. Changes to owner direction or project identity require
a fresh roster before a new run. New learned observations alone do not invalidate
the other profiles after the first simulation. Each queued run keeps the exact
profile it was started with, so regeneration cannot silently change its goal.

Profile generation uses the saved Claude Code connection in a bounded Docker
planning process. It reads supplied project context and returns structured
profiles; it does not independently browse the app or claim to have interviewed
customers. The subsequent simulation is the step that actually attempts the
journey in the configured environment.
