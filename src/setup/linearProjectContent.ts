import type { AreaConfig, Project } from "../config.ts";
import { LABELS } from "../dispatcher/notes.ts";
import { promotionTicketPolicy } from "../epics.ts";
import {
  baseBranch,
  effectiveVerification,
  effectiveWorkflow,
} from "../projectCapabilities.ts";

/** Linear's icon field uses an icon name or emoji shortcode, not a Unicode glyph. */
export const GREMLIN_PROJECT_ICON = ":space_invader:";
export const GREMLIN_PROJECT_COLOR = "#c3f66b";

const plain = (value: string) =>
  Array.from(value, (character) => {
    const point = character.codePointAt(0)!;
    return (point < 32 && ![9, 10, 13].includes(point)) || point === 127
      ? ""
      : character;
  }).join("");
const markdown = new Set("\\`*_{}[]()#+.!|<>~-");
const text = (value: string) =>
  Array.from(plain(value).replace(/[\r\n\t]+/g, " "), (character) =>
    markdown.has(character) ? "\\" + character : character,
  ).join("");
const code = (value: string) =>
  "`" +
  plain(value)
    .replace(/`/g, "ˋ")
    .replace(/[\r\n]+/g, " ") +
  "`";
const paths = (items: string[], empty: string) =>
  items.length ? items.map((item) => `- ${code(item)}`).join("\n") : empty;

/** Initial project brief only. Never serialize full config, credentials or secret references. */
export function buildLinearProjectContent(
  project: Project,
  area: AreaConfig,
  savedMandate: string,
) {
  const { config } = project;
  const source = new URL(
    config.provider === "gitlab"
      ? (config.serverUrl ?? "https://gitlab.com")
      : "https://github.com",
  );
  if (source.protocol !== "https:" || source.username || source.password)
    throw new Error("The source repository needs a valid HTTPS origin.");
  source.pathname =
    "/" + config.repo.split("/").map(encodeURIComponent).join("/");
  source.search = "";
  source.hash = "";
  const mandate = plain(savedMandate).trim();
  const charter = area.charter ?? {};
  const charterSections = [
    ...(charter.ambition ? ["### Ambition", plain(charter.ambition)] : []),
    ...(charter.goal ? ["### What good looks like", plain(charter.goal)] : []),
    ...(charter.metricDefinition
      ? ["### How success is measured", plain(charter.metricDefinition)]
      : []),
    ...(
      [
        ["Users and situations", charter.users],
        ["Expected to build", charter.expectedToBuild],
        ["Standing priorities", charter.standingPriorities],
        ["Guardrails", charter.guardrails],
        ["Non-goals", charter.nonGoals],
      ] as const
    ).flatMap(([heading, items]) =>
      items?.length
        ? [`### ${heading}`, items.map((item) => `- ${text(item)}`).join("\n")]
        : [],
    ),
  ];
  const verification = effectiveVerification(config);
  const workflow = effectiveWorkflow(config);
  const branch = baseBranch(config);
  const handoff =
    workflow.kind === "promotion"
      ? promotionTicketPolicy(project)
      : `1. **PM Gremlin:** investigate the mandate and propose findings with ${code(LABELS.proposal)} and ${code(area.label)}. Do not self-approve tickets, change app code, or merge PRs.\n2. **Human owner:** review scope and evidence, remove ${code(LABELS.proposal)}, and add ${code(LABELS.approved)} to authorize Coding work. Tickets marked ${code(LABELS.needsHuman)} stay blocked until reviewed.\n3. **Coding Gremlin:** work only on an open approved ticket in this project. Recheck approval, implement the fix on an isolated branch, and pass the configured checks before opening a **draft PR/MR** to ${code(branch)}. Failed checks mean no ready draft.\n4. **Human review and release:** inspect the evidence and merge through the app's release process. A PR into the chosen base branch may still need a separate production release.`;
  const description =
    `PM gremlin for ${plain(area.name)} in ${plain(config.name)}. ${mandate.replace(/[#*_`>[\]]/g, "").replace(/\s+/g, " ")}`.slice(
      0,
      255,
    );
  const content = [
    `# 👾 ${text(area.name)}`,
    `**ShipGremlins · ${text(config.name)} / ${text(area.key)}**  \nA small gremlin with a very particular set of nitpicks.`,
    "## 🎯 The mandate",
    mandate ||
      "No mandate is saved yet. Write and review this PM's mandate in ShipGremlins before running it.",
    ...charterSections,
    "## 🗺️ Patrol map",
    `- **Repository:** [${text(config.repo)}](${source.href})\n- **Issue label:** ${code(area.label)}\n- **Coding PR target:** ${code(branch)}\n- **Verification:** ${verification.mode === "browser" ? `browser review against the selected ${text(verification.environment)} environment; capture actual screenshots` : "repository code, documentation, and configured tests; cite files and test output"}.`,
    "### Owned paths",
    paths(
      area.paths,
      "No ownership paths are configured. Review the mandate and set a clear scope before the first patrol.",
    ),
    "### Shared touchpoints",
    paths(
      area.sharedTouchpoints,
      "None declared. Identify dependencies on another PM's work and stay within the owner mandate.",
    ),
    "## ⏱️ Operating rhythm",
    `- **Patrol schedule:** ${code(area.schedule)} (five-field cron, UTC).\n- **Work in progress limit:** ${area.wipLimit} approved ticket${area.wipLimit === 1 ? "" : "s"} for this PM. ${workflow.kind === "promotion" ? "The controller coordinates coding, verification and bounded repair before work advances." : "Open completed or failed jobs still need review before later tickets advance."}\n- **Metric or route to watch:** ${code(area.metric)}${area.mixpanelReportId ? `\n- **Saved Mixpanel report:** ${code(area.mixpanelReportId)}` : ""}\n- **Automation:** controlled in the ShipGremlins dashboard. Enable automation starts scheduled patrols and approved-ticket pickup; Pause automation stops new automatic work. Run once does not change that switch.`,
    "## 🔎 Findings worth fixing",
    `Search this Linear project for duplicates first. Each finding should include the affected flow, expected and actual behavior, reproducible steps, impact, and evidence. ${verification.mode === "browser" ? "Use real screenshots from the selected environment; a deployed baseline is not proof of an unmerged fix." : "Use repository file references and real test output; do not invent browser evidence."} Keep credentials, session links, and personal data out of tickets.`,
    "## 🤝 PM finds. Coding fixes.",
    `${handoff}\n\n**Done means the fix's PR is merged into production and the required verification has passed.** A draft, successful agent run, or staging merge is not Done. PMs do not change app code, merge PRs or mark tickets Done; the controller handles authorized integration and release verification.`,
    "## 🚦 First patrol checklist",
    `- [ ] Review the mandate, product brief, and ownership paths.\n- [ ] Create or resume a worker and run **Discovery** to build the codebase map and initial queue.\n- [ ] Review its Features, Queue, and Memory in the PM workspace.\n- [ ] Check this PM's Linear mapping and the selected account.\n- [ ] Run **Verify connections** in ShipGremlins, then choose **Run once** for a patrol.\n- [ ] ${workflow.kind === "promotion" ? "Enable patrols and coding pickup for the adopted scope; review the owning PM promotion PR when changes pass QA." : "Review its evidence and proposals before enabling automation."}`,
    "---\nCreated by [ShipGremlins](https://shipgremlins.ai). This is the initial PM brief; the dashboard and local configuration remain the source of truth for execution settings. Your subsequent Linear edits are yours to keep.",
  ].join("\n\n");
  return {
    description,
    content,
    icon: GREMLIN_PROJECT_ICON,
    color: GREMLIN_PROJECT_COLOR,
  };
}
