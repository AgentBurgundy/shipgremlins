export function startLeaseWatchdog(options: {
  stop: () => void;
  exit?: (code: number) => void;
  read?: () => { expiresAt: number };
  now?: () => number;
  intervalMs?: number;
}): () => void;
