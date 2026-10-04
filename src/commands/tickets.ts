import { readFileSync } from "node:fs";
import type { Ctx } from "../dispatcher/context.ts";
import { parseCompletionManifest } from "../lifecycle/manifest.ts";
import {
  auditProduction,
  reconcileProduction,
} from "../lifecycle/production.ts";
import { parseFlags, type Io } from "./crons.ts";

/** ctx is already bound to --project by the CLI. All writes need --apply. */
export async function runTickets(
  ctx: Ctx,
  args: string[],
  io: Io,
): Promise<number> {
  const { positionals, values } = parseFlags(args);
  const [action] = positionals;
  if (
    !["audit", "reconcile"].includes(action ?? "") ||
    (action === "audit" && values.apply) ||
    (values.apply && values["dry-run"])
  ) {
    io.error(
      "usage: gremlins tickets audit|reconcile --project <name> [--manifest <reviewed.json>] [--json] [--dry-run | --apply]",
    );
    return 1;
  }
  if (values.apply !== undefined && values.apply !== true) {
    io.error("--apply must be a boolean flag");
    return 1;
  }
  const manifest =
    typeof values.manifest === "string"
      ? parseCompletionManifest(
          JSON.parse(readFileSync(values.manifest, "utf8")),
        )
      : undefined;
  if (action === "reconcile" && !manifest) {
    io.error(
      "Reconciliation requires --manifest with the reviewed complete deliverable scope for each ticket",
    );
    return 1;
  }
  const report =
    action === "reconcile" && manifest
      ? await reconcileProduction(ctx, manifest, {
          apply: values.apply === true,
        })
      : await auditProduction(ctx, manifest);
  if (values.json === true) io.log(JSON.stringify(report, null, 2));
  else {
    io.log(
      `${report.repo} → ${report.productionBranch} at ${report.productionHead ?? "missing"} [${report.dryRun ? "read-only" : "apply"}]`,
    );
    for (const row of report.tickets) {
      io.log(
        `${row.identifier}: ${row.classification}${row.applied ? " → Done" : ""} — ${row.reason}`,
      );
      io.log(
        `  scopeHash=${row.scopeHash}; ticketId=${row.ticketId}; projectId=${row.projectId ?? "unknown"}; teamId=${row.teamId ?? "unknown"}`,
      );
      if (row.availableCompletedStates.length)
        io.log(
          `  completed states: ${row.availableCompletedStates.map((s) => `${s.name}=${s.id}`).join(", ")}`,
        );
    }
    if (!report.tickets.length)
      io.log(
        "No tickets carry the configured area labels in their Linear projects.",
      );
  }
  return 0;
}
