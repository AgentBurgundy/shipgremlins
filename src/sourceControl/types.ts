export type SourceProvider = "github" | "gitlab";
export interface SourceTarget {
  provider: SourceProvider;
  serverUrl?: string;
}
export interface SourceStatus {
  provider: SourceProvider;
  serverUrl: string;
  available: boolean;
  connected: boolean;
  method: "oauth" | "token" | "none";
  account?: { id: string; login: string; name?: string };
  expiresAt?: string;
  needsReconnect?: boolean;
  installationUrl?: string;
  message?: string;
}
export interface DeviceFlow {
  id: string;
  provider: SourceProvider;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  intervalSeconds: number;
  installationUrl?: string;
}
export interface DevicePoll {
  status: "pending" | "connected" | "expired" | "denied";
  retryAfterSeconds?: number;
  connection?: SourceStatus;
}
export interface SourceRepository {
  id: string;
  provider: SourceProvider;
  serverUrl: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
  canPush: boolean;
  installationId?: string;
}
export interface SourceCredential {
  token: string;
  method: "oauth" | "token";
  expiresAt?: string;
}
export interface SourceControl {
  status(): Promise<SourceStatus[]>;
  connect(
    input: SourceTarget & { clientId?: string; repositoryId?: string },
  ): Promise<DeviceFlow>;
  poll(id: string): Promise<DevicePoll>;
  disconnect(input: SourceTarget): Promise<SourceStatus>;
  repositories(
    input: SourceTarget & { search?: string },
  ): Promise<{ repositories: SourceRepository[]; truncated: boolean }>;
  acquireLease(
    input: SourceTarget & {
      jobId: string;
      repository: string;
      minutes?: number;
      write?: boolean;
    },
  ): Promise<SourceCredential>;
  resolveCredential(
    input: SourceTarget & {
      repository: string;
      minValidityMs?: number;
      write?: boolean;
    },
  ): Promise<SourceCredential>;
  releaseLease(jobId: string): Promise<void>;
}
export class SourceControlError extends Error {
  constructor(
    message: string,
    public readonly code = "source_error",
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SourceControlError";
  }
}
