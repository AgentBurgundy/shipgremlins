import {
  createOAuthConnection,
  type ConnectionOptions,
} from "../oauthConnection/connection.ts";
export { OAuthConnectionError } from "../oauthConnection/types.ts";
export type {
  OAuthConnection as LinearConnection,
  OAuthStatus as LinearStatus,
  OAuthCredential,
} from "../oauthConnection/types.ts";
export function createLinearConnection(options: ConnectionOptions) {
  return createOAuthConnection("linear", options);
}
