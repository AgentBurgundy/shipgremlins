import { posix } from "node:path";

export const SOURCE_LIMITS = {
  files: 80,
  sourceBytes: 512 * 1024,
  fileBytes: 1024 * 1024,
  fetchedBytes: 8 * 1024 * 1024,
  depth: 7,
};
const code = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|php|html?|vue|svelte)$/i;
const tests = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\./i;
const fixture = /(?:^|\/)(?:examples?|fixtures?|e2e|test-apps?)(?:\/|$)/i;
const manifest =
  /(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/;
const webEntry =
  /(?:^|\/)(?:index\.html?|server\.[cm]?[jt]s|main\.[cm]?[jt]sx?|app\.(?:py|[cm]?[jt]sx?)|manage\.py|(?:page|layout)\.[jt]sx?|Dockerfile|recipe\.json)$/i;

/** Seeds identify executable surfaces, not an alphabetical sample of the tree. */
export function seedPriority(path: string): number | undefined {
  if (
    /(?:^|\/)(?:fonts?|assets|third_party|third-party|vendor|node_modules)(?:\/|$)/i.test(
      path,
    )
  )
    return undefined;
  if (manifest.test(path)) return path.includes("/") ? 8 : 0;
  if (
    fixture.test(path) &&
    /(?:README\.md|Dockerfile|recipe\.json|server\.[cm]?[jt]s|fixture\.[cm]?[jt]s)$/i.test(
      path,
    )
  )
    return 3;
  if (tests.test(path)) return undefined;
  if (webEntry.test(path)) return 6;
  if (/^README\.md$/i.test(path)) return 4;
  if (
    /^(?:README\.md|Procfile|Makefile|compose\.ya?ml|docker-compose\.ya?ml|vercel\.json|railway\.json|next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s)$/i.test(
      path,
    )
  )
    return 18;
  return undefined;
}

export interface SourceReference {
  path: string;
  reason: string;
  priority: number;
}
/** Follow literal paths only. No shell, dynamic evaluation, remote fetch or arbitrary path lookup. */
export function sourceReferences(
  path: string,
  content: string,
  available: ReadonlySet<string>,
): SourceReference[] {
  const directory = posix.dirname(path),
    found = new Map<string, SourceReference>();
  const resolve = (literal: string, reason: string, priority = 10) => {
    if (/\.html?$/i.test(path) && /^\/[^/]/.test(literal))
      literal = literal.slice(1);
    if (
      !literal ||
      literal.length > 300 ||
      /[\s\\?#]|^[a-z]+:|^\//i.test(literal)
    )
      return;
    const base = posix.normalize(posix.join(directory, literal));
    const candidates = [
      base,
      literal,
      ...[
        ".ts",
        ".tsx",
        ".js",
        ".mjs",
        ".jsx",
        ".py",
        ".vue",
        ".svelte",
      ].flatMap((ext) => [base + ext, posix.join(base, "index" + ext)]),
    ];
    // Transpiled JS imports commonly refer to the corresponding source TS file.
    if (/\.js$/.test(base))
      candidates.push(
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
      );
    let matched = candidates.find((candidate) => available.has(candidate));
    if (!matched && code.test(literal) && !literal.includes("/")) {
      const suffix = [...available].filter(
        (candidate) => posix.basename(candidate) === literal,
      );
      if (suffix.length === 1) matched = suffix[0];
    }
    if (matched && matched !== path) {
      const existing = found.get(matched);
      const important =
        /(?:dashboard|server|serve|fixture|mock|main|app|cli)\.[cm]?[jt]sx?$/.test(
          matched,
        )
          ? Math.min(priority, 5)
          : priority;
      if (!existing || important < existing.priority)
        found.set(matched, { path: matched, reason, priority: important });
    }
  };
  if (path.endsWith("package.json")) {
    try {
      const value = JSON.parse(content);
      const strings = (item: unknown): string[] =>
        typeof item === "string"
          ? [item]
          : item && typeof item === "object"
            ? Object.values(item).flatMap(strings)
            : [];
      for (const entry of strings({
        main: value.main,
        module: value.module,
        bin: value.bin,
        exports: value.exports,
      }))
        resolve(entry, `manifest entrypoint in ${path}`, 1);
      for (const [name, script] of Object.entries(value.scripts ?? {})) {
        if (typeof script !== "string") continue;
        const command = script;
        const priority =
          /^(?:start|dev|serve|build|preview|setup|hub)(?::|$)/.test(name)
            ? 2
            : 30;
        for (const part of command.split(/[\s"'`;&|]+/))
          if (code.test(part))
            resolve(part, `script ${name} in ${path}`, priority);
        if (/\b(?:vite|next|astro|webpack)\b/.test(command))
          for (const candidate of [
            "index.html",
            "src/main.tsx",
            "src/main.ts",
            "src/main.jsx",
            "app/page.tsx",
            "src/app/page.tsx",
          ])
            resolve(candidate, `web framework entrypoint from ${path}`, 4);
      }
    } catch {
      /* Unparseable manifests remain evidence; never execute them. */
    }
  }
  for (const match of content.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:_relative)?\s*\(?\s*)["']([^"'\r\n]+)["']/g,
  )) {
    if (match[1]!.startsWith(".") || match[1]!.startsWith("src/"))
      resolve(match[1]!, `import from ${path}`);
  }
  // Runtime path joins and HTML script references reveal UI files that imports miss.
  for (const match of content.matchAll(
    /["']([^"'\r\n]{1,300}\.(?:[cm]?[jt]sx?|html?|py|rb|json|vue|svelte))["']/g,
  ))
    resolve(match[1]!, `literal runtime or asset reference in ${path}`, 11);
  for (const match of content.matchAll(
    /\b(?:from|import)\s+([a-zA-Z_][\w.]*)/g,
  )) {
    if (path.endsWith(".py"))
      resolve(
        match[1]!.replaceAll(".", "/") + ".py",
        `Python module in ${path}`,
        10,
      );
  }
  if (code.test(path) && !tests.test(path)) {
    const base = path.replace(/\.[^.]+$/, "");
    for (const extension of [".test.ts", ".test.js", ".spec.ts"]) {
      const candidate = base + extension;
      if (available.has(candidate))
        found.set(candidate, {
          path: candidate,
          reason: `focused test of ${path}`,
          priority: 35,
        });
    }
  }
  return [...found.values()]
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
    .slice(0, 60);
}

export interface SourceRange {
  start: number;
  end: number;
}
/** Large application entrypoints remain visible as labeled evidence, never silently skipped. */
export function sourceExcerpt(
  content: string,
  maximum = 16 * 1024,
): { content: string; ranges?: SourceRange[] } {
  if (Buffer.byteLength(content) <= maximum) return { content };
  const lines = content.split(/\r?\n/),
    windows: SourceRange[] = [{ start: 1, end: Math.min(lines.length, 45) }];
  const important = lines.flatMap((line, i) =>
    /createServer|createDashboard|\.listen\(|DOMContentLoaded|fixture|synthetic|test.?mode|dependency.?inject|(?:app|router)\.(?:use|get|post)\(/i.test(
      line,
    )
      ? [i]
      : [],
  );
  const count = Math.min(14, important.length);
  for (let i = 0; i < count; i++) {
    const line = important[Math.floor((i * important.length) / count)]!;
    windows.push({
      start: Math.max(1, line - 5),
      end: Math.min(lines.length, line + 10),
    });
  }
  if (!important.length)
    windows.push({ start: Math.max(1, lines.length - 40), end: lines.length });
  windows.sort((a, b) => a.start - b.start);
  const merged: SourceRange[] = [];
  for (const range of windows) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let output = "";
  const ranges: SourceRange[] = [];
  for (const range of merged) {
    const header = `\n[Source excerpt: lines ${range.start}-${range.end}; omitted lines are not reviewed]\n`;
    const chunk = header + lines.slice(range.start - 1, range.end).join("\n");
    if (Buffer.byteLength(output + chunk) <= maximum) {
      output += chunk;
      ranges.push(range);
    }
  }
  // Minified or extremely long lines cannot provide safely bounded, faithful excerpts.
  return { content: output, ranges };
}
