export type OAuthProvider = "linear" | "vercel";
export type OAuthAvailabilityReason = "not_configured" | "provider_unavailable";
export interface OAuthStatus {
  provider: OAuthProvider;
  available: boolean;
  /** Browser setup availability is independent of existing saved credentials. */
  availabilityReason?: OAuthAvailabilityReason;
  connected: boolean;
  method: "oauth" | "token" | "none";
  workspace?: { id: string; name: string };
  account?: { id: string; name: string };
  expiresAt?: string;
  needsReconnect?: boolean;
  message?: string;
}
export interface OAuthCredential {
  token: string;
  authorization: string;
  method: "oauth" | "token";
  expiresAt?: string;
  teamId?: string | null;
  /** Vercel integration installation identity; never a credential or public status field. */
  configurationId?: string;
  workspaceId?: string;
}
export interface CredentialRequest {
  minValidityMs?: number;
  projectId?: string;
  teamId?: string | null;
  workspaceId?: string;
}
export interface OAuthConnection {
  status(options?: {
    checkAvailability?: boolean;
    refreshAvailability?: boolean;
  }): Promise<OAuthStatus>;
  connect(returnUrl: string): Promise<{ url: string }>;
  complete(envelope: string): Promise<OAuthStatus>;
  disconnect(): Promise<OAuthStatus>;
  resolveCredential(input?: CredentialRequest): Promise<OAuthCredential>;
  acquireLease(
    input: CredentialRequest & { jobId: string; minutes?: number },
  ): Promise<OAuthCredential>;
  releaseLease(jobId: string): Promise<void>;
}
export class OAuthConnectionError extends Error {
  constructor(
    message: string,
    public readonly code = "connection_error",
    public readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthConnectionError";
  }
}
