// The dispatcher: one project, one pass, every rule in order. A rule that
// throws becomes a "needs you" row and the rules after it still run — a
// Linear outage must not stop merges, and a merge bug must not stop the
// report.

import type { Ctx, DigestRow } from "./context.ts";
import { runSync } from "./sync.ts";
import { checkLine, type RecoveryLane } from "./stopTheLine.ts";
import { runHeal } from "./heal.ts";
import { runRepair } from "./repair.ts";
import { runMerge } from "./merge.ts";
import { runDispatch } from "./dispatch.ts";
import { runPromote, type PromoteOpts } from "./promote.ts";

export async function runDispatcher(
  ctx: Ctx,
  promote?: PromoteOpts,
): Promise<DigestRow[]> {
  const rows: DigestRow[] = [];
  const guarded = async (
    rule: DigestRow["rule"],
    fn: () => Promise<DigestRow[]>,
  ): Promise<void> => {
    try {
      rows.push(...(await fn()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`${rule}: crashed — ${message}`);
      rows.push({ rule, text: `${rule} crashed: ${message}`, needsYou: true });
    }
  };

  await guarded("sync", () => runSync(ctx));

  // Fail closed: if we cannot tell whether the line is green, treat it as red.
  let lineStopped = true;
  let recovery: RecoveryLane | undefined;
  await guarded("line", async () => {
    const line = await checkLine(ctx);
    lineStopped = line.stopped;
    recovery = line.recovery;
    return line.rows;
  });

  await guarded("heal", () => runHeal(ctx));
  await guarded("repair", () => runRepair(ctx));
  await guarded("merge", async () => {
    const merged = await runMerge(ctx, {
      lineStopped,
      ...(recovery ? { recovery } : {}),
    });
    if (merged.some((row) => row.text.startsWith("🚢"))) {
      lineStopped = true;
      recovery = undefined;
    }
    return merged;
  });
  // Again, after merging: a merge in THIS pass can put the next PR in
  // conflict. Handing it to a developer now, instead of on the next pass,
  // is one whole cycle saved — and cycles are hours when the cron is slow.
  await guarded("repair", () => runRepair(ctx));

  if (lineStopped && !recovery) {
    ctx.log("dispatch: skipped — the line is stopped");
  } else {
    await guarded("dispatch", () =>
      recovery ? runDispatch(ctx, { recovery }) : runDispatch(ctx),
    );
  }

  if (promote && !lineStopped) {
    await guarded("promote", () => runPromote(ctx, promote));
  } else {
    ctx.log(
      `promote: skipped — ${lineStopped ? "the line is stopped" : "no checkout supplied"}`,
    );
  }

  // the two repair passes may report the same standing condition
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.rule}|${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
