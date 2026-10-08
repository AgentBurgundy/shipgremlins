import type { PasswordRecipe } from "./access-schema.mjs";
export interface LoginControlRepair {
  kind: "login-controls";
  changes: {
    field: "usernameSelector" | "passwordSelector" | "submitSelector";
    from: string;
    to: string;
  }[];
  recipe: PasswordRecipe;
}
export function suggestLoginControlRepair(
  page: { evaluate: (callback: () => unknown) => Promise<unknown> },
  access: PasswordRecipe & { kind: string; accounts: unknown[] },
): Promise<LoginControlRepair | undefined>;
