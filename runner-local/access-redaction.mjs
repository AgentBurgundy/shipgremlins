const DEFAULT_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxValues: 8192,
  maxNodes: 65536,
  maxDepth: 128,
};
export class RedactionBudgetError extends Error {
  constructor() {
    super("Private browser storage exceeds the bounded redaction budget.");
  }
}
function variants(value) {
  let encoded;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    // Web storage permits lone UTF-16 surrogates. Raw/JSON forms still apply.
  }
  return new Set(
    [value, encoded, JSON.stringify(value).slice(1, -1)].filter(Boolean),
  );
}

/** Private, session-scoped redaction state. Nothing is silently dropped at a cap. */
export function createAccessRedaction(initial = [], overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const values = new Set();
  let bytes = 0,
    failed = false;
  const exceeded = () => {
    failed = true;
    return new RedactionBudgetError();
  };
  const assertUsable = () => {
    if (failed) throw new RedactionBudgetError();
  };
  const collect = (value) => {
    assertUsable();
    const stack = [{ item: value, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
      const { item, depth } = stack.pop();
      if (++nodes > limits.maxNodes || depth > limits.maxDepth)
        throw exceeded();
      if (typeof item === "string") {
        // Check duplicates before capacity; refreshing an unchanged context must
        // not consume a new budget or repeatedly parse a large application cache.
        if (!item || values.has(item)) continue;
        const size = item.length * 2;
        if (values.size >= limits.maxValues || bytes + size > limits.maxBytes)
          throw exceeded();
        values.add(item);
        bytes += size;
        if (!/^[\s]*[\[{"]/.test(item)) continue;
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch {
          continue;
        }
        if (parsed !== item) stack.push({ item: parsed, depth: depth + 1 });
      } else if (item && typeof item === "object") {
        for (const nested of Object.values(item)) {
          if (stack.length + nodes >= limits.maxNodes) throw exceeded();
          stack.push({ item: nested, depth: depth + 1 });
        }
      }
    }
  };
  for (const value of initial) collect(value);
  const redact = (input) => {
    assertUsable();
    let text = String(input);
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      // Encoded and JSON-escaped strings cannot be shorter than their raw form.
      // Keep large values protected without allocating multi-MiB variants for
      // ordinary, small browser snapshots.
      if (value.length > text.length) continue;
      for (const variant of variants(value)) {
        if (variant.length < 8) {
          const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          text = text.replace(
            new RegExp(
              `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
              "gu",
            ),
            "[private]",
          );
        } else text = text.split(variant).join("[private]");
      }
    }
    return text;
  };
  const screenshotPlan = () => {
    assertUsable();
    const matches = new Set();
    for (const value of values) {
      // Keep locators live until the screenshot is captured (including shadow
      // roots). A prior DOM scan races hydration and can miss newly shown values.
      // Prefixes mask the containing element without giant selector payloads.
      let prefix = value.length > 2048 ? value.slice(0, 128) : value;
      if (value.length > 2048 && /[\uD800-\uDBFF]$/.test(prefix))
        prefix = prefix.slice(0, -1);
      for (const variant of variants(prefix)) {
        if (matches.has(variant)) continue;
        if (matches.size >= 256) return { maskAll: true, values: [] };
        matches.add(variant);
      }
    }
    return { maskAll: false, values: [...matches] };
  };
  return { collect, redact, screenshotPlan };
}
