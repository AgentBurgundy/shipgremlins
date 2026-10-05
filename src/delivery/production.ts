import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project } from "../config.ts";
import type { Ctx } from "../dispatcher/context.ts";
import type { CompletionManifest } from "../lifecycle/manifest.ts";
import { reconcileProduction } from "../lifecycle/production.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import type { createDeliveryService } from "./index.ts";

export interface ProductionDeclaration {
  id: string;
  createdAt: string;
  deliveryIds: string[];
  manifest: CompletionManifest;
}
export interface ProductionDeclarationInput {
  revision: string;
  deliveryIds: string[];
  productionPr: number;
  completedStateId: string;
  scopeComplete: true;
}
export function createProductionDeclarations(options: {
  root: string;
  project: Project;
  ledger: Pick<
    ReturnType<typeof createDeliveryService>,
    "list" | "completionManifest"
  >;
  context?: () => Promise<Ctx>;
  now?: () => Date;
}) {
  const directory = join(
      options.root,
      ".run",
      "delivery",
      options.project.config.name,
    ),
    file = join(directory, "production.json"),
    lock = join(directory, "production.lock");
  const read = (): ProductionDeclaration[] => {
    assertNoSymlinks(file);
    if (!existsSync(file)) return [];
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new Error(
        "Production declarations require repair; existing records were preserved.",
      );
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (
      state?.schema !== 1 ||
      !Array.isArray(state.declarations) ||
      state.declarations.length > 100 ||
      state.declarations.some(
        (d: ProductionDeclaration) =>
          !d?.id ||
          !Array.isArray(d.deliveryIds) ||
          d.manifest?.repo !== options.project.config.repo,
      )
    )
      throw new Error(
        "Production declarations belong to invalid or changed configuration.",
      );
    return state.declarations;
  };
  const status = () => {
    const declarations = read();
    return {
      declarations,
      revision: createHash("sha256")
        .update(
          JSON.stringify({ records: options.ledger.list(), declarations }),
        )
        .digest("hex"),
    };
  };
  async function declare(input: ProductionDeclarationInput) {
    if (
      input.scopeComplete !== true ||
      !Array.isArray(input.deliveryIds) ||
      !input.deliveryIds.length ||
      input.deliveryIds.length > 100 ||
      new Set(input.deliveryIds).size !== input.deliveryIds.length ||
      !Number.isSafeInteger(input.productionPr) ||
      input.productionPr <= 0 ||
      !input.completedStateId ||
      !/^[a-f0-9]{64}$/.test(input.revision)
    )
      throw new Error(
        "Confirm the complete finite delivery scope, production PR, completed state and current revision.",
      );
    assertNoSymlinks(lock);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100)
        throw new Error(
          "Production declaration lock is unsafe; inspect it without deleting existing state.",
        );
      const pid = Number(readFileSync(lock, "utf8"));
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0)
        try {
          process.kill(pid, 0);
        } catch (cause) {
          dead = (cause as NodeJS.ErrnoException).code === "ESRCH";
        }
      if (!dead)
        throw new Error(
          "Another controller may be reviewing production scope. Retry, or inspect the owner PID in production.lock after stopping other controllers.",
        );
      unlinkSync(lock);
      fd = openSync(lock, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
    let temporary: string | undefined;
    try {
      const current = status();
      if (current.revision !== input.revision)
        throw new Error(
          "Delivery state changed. Reload before confirming production scope.",
        );
      const manifest = options.ledger.completionManifest(input);
      if (!options.context)
        throw new Error("Production connection is unavailable.");
      const ctx = await options.context();
      if (!ctx.linear.listWorkflowStates)
        throw new Error("Linear workflow states cannot be verified.");
      for (const ticket of manifest.tickets) {
        const states = await ctx.linear.listWorkflowStates(ticket.teamId);
        if (
          !states.some(
            (s) =>
              s.id === input.completedStateId &&
              s.type === "completed" &&
              s.teamId === ticket.teamId,
          )
        )
          throw new Error(
            "Choose an existing completed state in this ticket's Linear team.",
          );
        ticket.approvedBy =
          "dashboard owner — complete delivery scope confirmed";
        ticket.approvedAt = (options.now?.() ?? new Date()).toISOString();
      }
      const pull = await ctx.forge.getPull(
        options.project.config.repo,
        input.productionPr,
      );
      if (
        !pull ||
        pull.baseRef !== options.project.config.branches.production ||
        pull.headRef !== options.project.config.branches.staging
      )
        throw new Error(
          "Choose the staging-to-production PR for this repository.",
        );
      if (status().revision !== input.revision)
        throw new Error(
          "Delivery state changed while checking production scope. Reload and review again.",
        );
      const existing = current.declarations.find(
        (d) =>
          JSON.stringify(d.deliveryIds.slice().sort()) ===
            JSON.stringify(input.deliveryIds.slice().sort()) &&
          d.manifest.tickets.every((t) =>
            t.deliverables.every((a) => a.productionPr === input.productionPr),
          ),
      );
      if (existing) return existing;
      if (current.declarations.length >= 100)
        throw new Error(
          "Production declaration history is full. Archive it deliberately before adding another scope.",
        );
      const value: ProductionDeclaration = {
        id: randomBytes(20).toString("hex"),
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        deliveryIds: [...input.deliveryIds],
        manifest,
      };
      temporary = join(
        directory,
        `.production-${randomBytes(12).toString("hex")}.tmp`,
      );
      writeFileSync(
        temporary,
        JSON.stringify({
          schema: 1,
          declarations: [...current.declarations, value],
        }),
        { flag: "wx", mode: 0o600 },
      );
      assertNoSymlinks(file);
      renameSync(temporary, file);
      temporary = undefined;
      return value;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
      if (temporary) unlinkSync(temporary);
    }
  }
  async function reconcile() {
    if (!options.context)
      throw new Error("Production connection is unavailable.");
    const declarations = read();
    if (!declarations.length) return [];
    const ctx = await options.context();
    const reports = [];
    for (const declaration of declarations) {
      // New work under the same ticket invalidates an earlier completeness declaration.
      options.ledger.completionManifest({
        deliveryIds: declaration.deliveryIds,
        productionPr:
          declaration.manifest.tickets[0]!.deliverables[0]!.productionPr,
        completedStateId: declaration.manifest.tickets[0]!.completedStateId,
      });
      reports.push({
        id: declaration.id,
        report: await reconcileProduction(ctx, declaration.manifest, {
          apply: true,
        }),
      });
    }
    return reports;
  }
  return { status, declare, reconcile };
}
