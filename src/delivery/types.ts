import type { LinearTicket } from "../services/types.ts";

export interface QaFailureFinding {
  criterion: string;
  receiptId: string;
  expected: string;
  url: string;
  screenshot: { name: string; sha256: string };
}
export interface QaReworkIntent {
  key: string;
  rootDeliveryId: string;
  attempt: number;
  reviewHash: string;
  findings: QaFailureFinding[];
  jobId?: string;
  phase: "queued" | "running" | "awaiting-review" | "stopped";
  message: string;
}
export interface IntegrationRepairIntent {
  key: string;
  kind: "conflict" | "checks";
  headSha: string;
  integrationSha: string;
  jobId?: string;
  phase: "queued" | "running" | "stopped" | "replaced";
  message: string;
}

export interface ReviewDeployment {
  id: string;
  url: string;
  sha: string;
  branch: string;
  provider: string;
  state: "READY";
}
export interface DeliveryRecord {
  id: string;
  jobId: string;
  project: string;
  area: string;
  /** Distinguishes a recreated PM from earlier crews with the same visible ID. */
  areaInstanceId?: string;
  repository: string;
  configuration: string;
  ticket: Pick<
    LinearTicket,
    "id" | "identifier" | "title" | "description" | "projectId" | "teamId"
  >;
  scopeHash: string;
  approvedBy: string;
  approvedAt: string;
  implementation: {
    number: number;
    url: string;
    branch: string;
    headSha: string;
    author: string;
    mergeSha?: string;
  };
  checks?: { headSha: string; commands: string[]; completedAt: string };
  status:
    | "awaiting-merge"
    | "awaiting-deployment"
    | "awaiting-review"
    | "verified"
    | "failed"
    | "blocked"
    | "promoted";
  message: string;
  createdAt: string;
  updatedAt: string;
  review?: {
    planId: string;
    jobId: string;
    testedSha: string;
    deployment: ReviewDeployment;
    at: string;
    manifestHash: string;
    artifacts: { name: string; sha256: string }[];
    failures?: QaFailureFinding[];
  };
  rework?: QaReworkIntent;
  /** One bounded repair before this implementation has ever entered integration. */
  integrationRepair?: IntegrationRepairIntent;
  integrationRepairOf?: string;
  supersededBy?: string;
  reworkOf?: {
    deliveryId: string;
    rootDeliveryId: string;
    attempt: number;
    key: string;
  };
  promotion?: { number: number; url: string; headSha: string; branch: string };
}
export interface PmReviewPlan {
  schema: 1;
  id: string;
  jobId: string;
  project: string;
  area: string;
  configuration: string;
  createdAt: string;
  deployment: ReviewDeployment;
  deliveries: Array<{
    id: string;
    ticket: DeliveryRecord["ticket"];
    implementationPr: number;
    mergeSha: string;
    scopeHash: string;
    criteria: string[];
  }>;
}
export interface PmReviewManifest {
  schema: 1;
  planId: string;
  jobId: string;
  project: string;
  area: string;
  testedSha: string;
  deploymentId: string;
  deliveries: Array<{
    id: string;
    status: "passed" | "failed" | "blocked";
    assertions: Array<{
      criterion: string;
      status: "passed" | "failed" | "blocked";
      receiptId: string;
    }>;
    screenshots: Array<{ name: string; sha256: string }>;
  }>;
}
export interface ReviewIngestion {
  planId: string;
  manifest: unknown;
  /** Result read from the trusted, completed worker container, never request JSON. */
  trustedResult: {
    ok: boolean;
    kind: string;
    nonce?: string;
    commitSha?: string;
  };
  /** Fresh provider read after the PM run; mutable branch aliases must still identify this exact deployment. */
  deployment: ReviewDeployment;
  verifyArtifact: (input: {
    jobId: string;
    name: string;
    sha256: string;
  }) => Promise<boolean>;
  /** Must validate controller-captured browser/test receipts, not the model's claim of success. */
  verifyAssertion: (input: {
    jobId: string;
    deliveryId: string;
    criterion: string;
    receiptId: string;
    deployment: ReviewDeployment;
  }) => Promise<boolean>;
  /** Independently replayed failed predicate + verified screenshot, never PM prose. */
  failureEvidence?: (input: {
    jobId: string;
    deliveryId: string;
    criterion: string;
    receiptId: string;
    deployment: ReviewDeployment;
  }) => Promise<QaFailureFinding | null>;
}
