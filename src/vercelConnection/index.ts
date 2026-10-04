import {
  createOAuthConnection,
  type ConnectionOptions,
} from "../oauthConnection/connection.ts";
export { OAuthConnectionError } from "../oauthConnection/types.ts";
export type {
  OAuthConnection as VercelConnection,
  OAuthStatus as VercelStatus,
  OAuthCredential,
} from "../oauthConnection/types.ts";
export function createVercelConnection(options: ConnectionOptions) {
  return createOAuthConnection("vercel", options);
}
