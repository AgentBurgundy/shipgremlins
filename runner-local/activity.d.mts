export const ACTIVITY_PREFIX: string;
export function createActivityWriter(options: {
  write: (line: string) => void;
  redact?: (value: string) => string;
  now?: () => Date;
}): {
  emit: (
    type: string,
    title: string,
    detail?: string,
    status?: string,
  ) => unknown;
  modelRecord: (record: unknown) => void;
  summary: () => string | undefined;
};
