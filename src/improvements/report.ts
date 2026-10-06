export interface Opportunity {
  key: string;
  title: string;
  problem: string;
  evidence: {
    kind: "source" | "browser" | "telemetry" | "hypothesis";
    detail: string;
    artifact?: string;
  }[];
  alternatives: string[];
  hypotheses: string[];
  smallestExperiment: string;
  successMeasure: string;
  ticketIdentifiers: string[];
}
export interface Journey {
  goal: string;
  outcome: "success" | "partial" | "blocked" | "abandoned";
  reportedClicks: number | null;
  steps: { action: string; observation: string }[];
  wins: string[];
  friction: string[];
  screenshots: string[];
  environment: string;
}
export interface ImprovementReport {
  schemaVersion: 1;
  summary: string;
  opportunities: Opportunity[];
  journey?: Journey;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Only public printable text.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error("Invalid improvement report text.");
  return value.trim();
}
function strings(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error("Invalid improvement report list.");
  return [...new Set(value.map((item) => text(item, maxLength)))];
}
function artifact(value: unknown, files: Set<string>): string {
  const path = text(value, 200).replace(/^\/output\//, "");
  if (
    !files.has(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))
  )
    throw new Error("An improvement report cites an unavailable artifact.");
  return path;
}
export function parseImprovementReport(
  value: unknown,
  files: Set<string>,
): ImprovementReport {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.opportunities) ||
    value.opportunities.length > 8
  )
    throw new Error("Invalid improvement report.");
  const opportunities = value.opportunities.map((item): Opportunity => {
    if (
      !object(item) ||
      typeof item.key !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(item.key) ||
      !Array.isArray(item.evidence) ||
      item.evidence.length > 12
    )
      throw new Error("Invalid product opportunity.");
    const evidence = item.evidence.map(
      (entry): Opportunity["evidence"][number] => {
        if (
          !object(entry) ||
          !["source", "browser", "telemetry", "hypothesis"].includes(
            String(entry.kind),
          )
        )
          throw new Error("Invalid opportunity evidence.");
        return {
          kind: entry.kind as Opportunity["evidence"][number]["kind"],
          detail: text(entry.detail, 1800),
          ...(entry.artifact === undefined
            ? {}
            : { artifact: artifact(entry.artifact, files) }),
        };
      },
    );
    const ticketIdentifiers = strings(item.ticketIdentifiers, 5, 40);
    if (
      ticketIdentifiers.some(
        (id) => !/^[A-Z][A-Z0-9]{0,20}-[1-9][0-9]*$/.test(id),
      )
    )
      throw new Error("Invalid reported ticket identifier.");
    return {
      key: item.key,
      title: text(item.title, 160),
      problem: text(item.problem, 1800),
      evidence,
      alternatives: strings(item.alternatives, 6, 1000),
      hypotheses: strings(item.hypotheses, 8, 1000),
      smallestExperiment: text(item.smallestExperiment, 1800),
      successMeasure: text(item.successMeasure, 1000),
      ticketIdentifiers,
    };
  });
  if (
    new Set(opportunities.map((item) => item.key)).size !== opportunities.length
  )
    throw new Error("Repeated opportunity keys.");
  let journey: Journey | undefined;
  if (value.journey !== undefined) {
    const item = value.journey;
    if (
      !object(item) ||
      !["success", "partial", "blocked", "abandoned"].includes(
        String(item.outcome),
      ) ||
      (item.reportedClicks !== null &&
        (!Number.isInteger(item.reportedClicks) ||
          Number(item.reportedClicks) < 0 ||
          Number(item.reportedClicks) > 100)) ||
      !Array.isArray(item.steps) ||
      item.steps.length > 60
    )
      throw new Error("Invalid journey report.");
    journey = {
      goal: text(item.goal, 1000),
      outcome: item.outcome as Journey["outcome"],
      reportedClicks: item.reportedClicks as number | null,
      steps: item.steps.map((step) => {
        if (!object(step)) throw new Error("Invalid journey step.");
        return {
          action: text(step.action, 600),
          observation: text(step.observation, 1000),
        };
      }),
      wins: strings(item.wins, 8, 1000),
      friction: strings(item.friction, 8, 1000),
      screenshots: strings(item.screenshots, 20, 200).map((name) =>
        artifact(name, files),
      ),
      environment: text(item.environment, 1000),
    };
  }
  return {
    schemaVersion: 1,
    summary: text(value.summary, 3000),
    opportunities,
    ...(journey ? { journey } : {}),
  };
}

export const IMPROVEMENT_REPORT_CONTRACT = [
  "RETAINED PRODUCT EVIDENCE",
  "In addition to the four knowledge documents, write /output/improvement-report.json as one JSON object with schemaVersion:1, summary:string, opportunities:[] and optional journey. This stores observations across later PM runs; it does not approve work or prove customer demand. Zero opportunities is valid.",
  'Each opportunity: {key:"stable-short-slug",title,problem,evidence:[{kind:"source"|"browser"|"telemetry"|"hypothesis",detail,artifact?:"existing relative /output filename"}],alternatives:[strings],hypotheses:[strings],smallestExperiment,successMeasure,ticketIdentifiers:["ACTUAL-123"]}. Include only actual tickets created or inspected in the permitted Linear account; unfiled ideas use an empty list. Keep at most eight considered opportunities, twelve evidence entries, six alternatives, eight hypotheses and five ticket identifiers. Text must be concise (under 1000 characters per field, summary under 3000); no private account data or credentials.',
  'A Grumblin also supplies journey:{goal,outcome:"success"|"partial"|"blocked"|"abandoned",reportedClicks:number|null,steps:[{action,observation}],wins:[strings],friction:[strings],screenshots:["screenshots/step-01.png"],environment:"actual target and deployment identity when known"}. Record only actual actions and existing screenshots. These are reported observations, not independently certified measurements; use null for an unknown click count. At most sixty steps and twenty screenshots. Keep the total JSON under 64 KiB. Do not fabricate evidence, a prior baseline, comparisons, or a report about an action that did not occur. A blocked investigation reports its real blocker; it does not invent a product opportunity.',
].join("\n\n");
