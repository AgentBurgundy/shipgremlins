// Interfaces for the non-forge services. Real clients live next to this file
// (linear.ts, vercel.ts, slack.ts); fakes for tests live in fakes.ts.

// ── Linear ───────────────────────────────────────────────────────────────────

export interface LinearTicket {
  id: string; // uuid
  identifier: string; // e.g. "GAME-12"
  title: string;
  description: string;
  labels: string[];
  /** Linear state type: backlog | unstarted | started | completed | canceled */
  stateType: string;
  /** Authoritative IDs used by the production reconciler; older clients may omit them. */
  stateId?: string;
  teamId?: string;
  projectId?: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  teamId: string;
}

export interface LinearStateGuard {
  projectId: string;
  teamId: string;
  stateId: string;
  updatedAt: string;
}

export interface LinearClient {
  listWorkflowStates?(teamId: string): Promise<LinearWorkflowState[]>;
  /** Rereads the ticket before writing. Linear does not offer an atomic compare-and-set. */
  updateWorkflowState?(
    ticketId: string,
    stateId: string,
    expected: LinearStateGuard,
  ): Promise<void>;
  /** open+closed tickets in the project carrying ALL of `labels` */
  listTickets(projectId: string, labels: string[]): Promise<LinearTicket[]>;
  getTicket(idOrIdentifier: string): Promise<LinearTicket | null>;
  addLabel(ticketId: string, label: string): Promise<void>;
  removeLabel(ticketId: string, label: string): Promise<void>;
  addComment(ticketId: string, body: string): Promise<LinearComment>;
  listComments(ticketId: string): Promise<LinearComment[]>;
  createTicket(input: {
    projectId: string;
    title: string;
    description: string;
    labels: string[];
    priority?: number;
  }): Promise<LinearTicket>;
}

// ── Vercel ───────────────────────────────────────────────────────────────────

export interface Deployment {
  id: string;
  /** READY | ERROR | BUILDING | QUEUED | CANCELED */
  state: string;
  url: string; // host without scheme
  sha: string;
  branch: string;
  createdAt: string;
}

export interface VercelClient {
  /** the newest deployment for the branch, or null */
  latestDeployment(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<Deployment | null>;
  /** a stable https URL for the branch's preview (branch alias when it exists) */
  branchUrl(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<string | null>;
}

// ── Slack ────────────────────────────────────────────────────────────────────

export interface SlackClient {
  /** post one message to an incoming webhook */
  post(webhookUrl: string, blocks: unknown[], text: string): Promise<void>;
}
