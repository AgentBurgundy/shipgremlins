import { createPrivateKey } from "node:crypto";

export interface GoogleServiceAccount {
  type: "service_account";
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: "https://oauth2.googleapis.com/token";
}

/** Accept only service-account keys, never externally supplied executable/URL credentials. */
export function parseGoogleServiceAccount(
  source: string,
): GoogleServiceAccount {
  try {
    if (Buffer.byteLength(source) > 24_576) throw new Error();
    const value = JSON.parse(source) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.type !== "service_account" ||
      typeof value.project_id !== "string" ||
      !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.project_id) ||
      typeof value.client_email !== "string" ||
      !/^[a-zA-Z0-9._-]+@(?:[a-zA-Z0-9.-]+\.iam|developer|appspot)\.gserviceaccount\.com$/.test(
        value.client_email,
      ) ||
      typeof value.private_key !== "string" ||
      value.private_key.length > 16_384 ||
      (value.token_uri !== undefined &&
        value.token_uri !== "https://oauth2.googleapis.com/token") ||
      (value.universe_domain !== undefined &&
        value.universe_domain !== "googleapis.com")
    )
      throw new Error();
    const key = createPrivateKey(value.private_key);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
    // Project only the fields the auth library uses. Ignore arbitrary metadata/endpoints.
    return {
      type: "service_account",
      project_id: value.project_id,
      client_email: value.client_email,
      private_key: key.export({ format: "pem", type: "pkcs8" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    };
  } catch {
    throw new Error(
      "Enter a valid Google service-account JSON key with a 2048-bit or stronger RSA key and the official Google token endpoint.",
    );
  }
}
