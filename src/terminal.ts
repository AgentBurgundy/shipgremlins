import type { SetupReport } from "./setup/preflight.ts";

const GREMLIN = String.raw`   ,_       _,
   |\\.-=-.//|
   \ / o o \ /
    (  .^.  )
     \ \_/ /
      '---'`;

function paint(text: string, code: number, color: boolean): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function welcome(color = false, width = 80): string {
  const title = paint("SHIPGREMLINS", 1, color);
  const subtitle = paint("Your app. Our tiny obsession.", 2, color);
  if (width < 60) return `\n${paint(GREMLIN, 92, color)}\n\n  ${title}\n`;
  return (
    "\n" +
    GREMLIN.split("\n")
      .map(
        (line, index) =>
          paint(line.padEnd(22), 92, color) +
          (index === 1 ? title : index === 3 ? subtitle : ""),
      )
      .join("\n") +
    "\n"
  );
}

function wrap(text: string, width: number, indent = "  "): string {
  const result: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width - indent.length) {
      result.push(indent + line);
      line = "";
    }
    let remainder = word;
    while (remainder.length > width - indent.length) {
      if (line) {
        result.push(indent + line);
        line = "";
      }
      result.push(indent + remainder.slice(0, width - indent.length));
      remainder = remainder.slice(width - indent.length);
    }
    line += (line ? " " : "") + remainder;
  }
  if (line) result.push(indent + line);
  return result.join("\n");
}

export function preflightSummary(
  report: SetupReport,
  verbose = false,
  color = false,
  columns = 80,
): string {
  const width = Math.max(36, Math.min(88, columns));
  const failed = report.checks.filter((check) => check.status === "fail");
  const warnings = report.checks.filter(
    (check) => check.status === "warn",
  ).length;
  const passed = report.checks.filter(
    (check) => check.status === "pass",
  ).length;
  const lines = [
    paint(
      `  ${failed.length ? "LET'S GET YOU SET UP" : "READY FOR LIVE CHECKS"}`,
      1,
      color,
    ),
    paint(
      `  ${passed} checks ready  /  ${failed.length} to do  /  ${warnings} notes`,
      2,
      color,
    ),
    "",
  ];
  if (verbose) {
    for (const check of report.checks) {
      lines.push(
        paint(
          `  ${check.status.toUpperCase().padEnd(4)}  ${check.id}`,
          check.status === "pass" ? 92 : check.status === "warn" ? 93 : 91,
          color,
        ),
      );
      lines.push(wrap(check.detail, width, "        "), "");
    }
  } else {
    for (const [index, check] of failed.entries()) {
      const action =
        check.id === "projects"
          ? "Add your first app."
          : check.id === "connections"
            ? "Connect your accounts in the dashboard."
            : check.id === "hub"
              ? "Choose your automation repository."
              : check.id.startsWith("connections:")
                ? `Finish provider settings for ${check.id.slice(12)}.`
                : check.detail;
      lines.push(wrap(`${index + 1}. ${action}`, width));
    }
    if (failed.length)
      lines.push("", paint("  Open setup  >  shipgremlins setup", 92, color));
    else
      lines.push(
        wrap(
          "Run shipgremlins doctor PROJECT to verify provider connections.",
          width,
        ),
      );
    lines.push(
      "",
      paint("  Details     >  shipgremlins setup status --verbose", 2, color),
    );
  }
  lines.push("", paint(wrap(`Config: ${report.directory}`, width), 2, color));
  return lines.join("\n") + "\n";
}
