export class AccessFailure extends Error {
  readonly code: string;
  constructor(code: string);
}
export function accessFailure(error: unknown): {
  code: string;
  message: string;
};
export function parsePrivateAccess(input: unknown): {
  version: 1;
  origin: string;
  url: string;
  token: string;
  access?: {
    kind: "password";
    accounts: { name: string; username: string; password: string }[];
  };
};
