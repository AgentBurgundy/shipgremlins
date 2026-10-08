export type LoginStep =
  | { kind: "navigate"; path: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; credential: "username" | "password" }
  | { kind: "select"; selector: string; value: string }
  | { kind: "wait"; selector: string; state: "visible" | "hidden" };
export type IdentityAssertion =
  | { kind: "principal"; selector: string }
  | { kind: "tenant"; selector: string; equals: string };
export interface PasswordRecipe {
  loginPath: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successSelector: string;
  authenticatedPath?: string;
  steps?: LoginStep[];
}
export function validLoginPath(value: unknown): value is string;
export function parsePasswordRecipe(value: unknown): PasswordRecipe;
export function parseIdentityAssertions(
  value: unknown,
): IdentityAssertion[] | undefined;
