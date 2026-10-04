// `gremlins ticket <identifier>` — prints one Linear ticket as markdown. developer.yml
// redirects this into ticket.md, which is the developer prompt's whole input.

import type {
  LinearClient,
  LinearComment,
  LinearTicket,
} from "../services/types.ts";
import type { Io } from "./crons.ts";

export function ticketMarkdown(
  ticket: LinearTicket,
  comments: LinearComment[],
): string {
  const lines = [
    `# ${ticket.identifier} — ${ticket.title}`,
    "",
    `- Identifier: ${ticket.identifier}`,
    `- URL: ${ticket.url}`,
    `- State: ${ticket.stateType}`,
    `- Priority: ${ticket.priority}`,
    `- Labels: ${ticket.labels.length ? ticket.labels.join(", ") : "(none)"}`,
    `- Created: ${ticket.createdAt}`,
    "",
    "## Description",
    "",
    ticket.description.trim() || "_(empty)_",
    "",
    "## Comments",
    "",
  ];
  if (comments.length === 0) lines.push("_(none)_");
  for (const c of comments) {
    lines.push(`### ${c.createdAt}`, "", c.body.trim(), "");
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export async function runTicket(
  linear: LinearClient,
  args: string[],
  io: Io,
): Promise<number> {
  const identifier = args[0];
  if (!identifier || identifier.startsWith("-")) {
    io.error("usage: gremlins ticket <identifier>");
    return 1;
  }
  const ticket = await linear.getTicket(identifier);
  if (!ticket) {
    io.error(`no Linear ticket ${identifier}`);
    return 1;
  }
  const comments = await linear.listComments(ticket.id);
  io.log(ticketMarkdown(ticket, comments));
  return 0;
}
