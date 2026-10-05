interface Entry {
  value?: unknown;
  available: boolean;
  failed: boolean;
  attemptedAt: number;
  pending?: Promise<void>;
}

/** Bound one-off downloads without retaining their potentially large bytes. */
export async function dashboardOutputDeadline<T>(
  load: () => Promise<T>,
  waitMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(load),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Output read timed out.")),
          waitMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A slow output source gets one pending read, not another task on every poll. */
export function createDashboardOutputReader() {
  const entries = new Map<string, Entry>();
  return async function read<T>(
    key: string,
    load: () => Promise<T>,
    waitMs: number,
  ): Promise<{
    value?: T;
    available: boolean;
    pending: boolean;
    failed: boolean;
  }> {
    let entry = entries.get(key);
    if (!entry) {
      // Output snapshots are disposable. Never evict pending reads and start
      // duplicate work for a dependency that has not yet returned.
      for (const [name, old] of entries) {
        if (entries.size < 64) break;
        if (!old.pending) entries.delete(name);
      }
      if (entries.size >= 128)
        return { available: false, pending: true, failed: false };
      entry = { available: false, failed: false, attemptedAt: 0 };
      entries.set(key, entry);
    }
    const current = entry;
    if (!current.pending && Date.now() - current.attemptedAt >= 750) {
      current.attemptedAt = Date.now();
      current.pending = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            current.value = value;
            current.available = true;
            current.failed = false;
          },
          () => {
            current.failed = true;
          },
        )
        .finally(() => {
          current.pending = undefined;
        });
    }
    if (current.pending && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          current.pending,
          new Promise<void>((done) => {
            timer = setTimeout(
              done,
              current.available ? Math.min(waitMs, 50) : waitMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return {
      ...(current.available ? { value: current.value as T } : {}),
      available: current.available,
      pending: Boolean(current.pending),
      failed: current.failed,
    };
  };
}
