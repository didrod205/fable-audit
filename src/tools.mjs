import { defineTool } from "oh-my-fable";
import { readFile, readdir, stat, realpath, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative, sep, extname, dirname } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".turbo", ".cache", "vendor", "target", "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".gradle", ".terraform", ".pytest_cache", ".mypy_cache",
]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip",
  ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".mp3",
  ".wasm", ".node", ".so", ".dylib", ".dll", ".lock",
]);

const MAX_FILE_BYTES = 120_000; // one file must not eat the context window
const MAX_MATCHES = 60;

/**
 * Keep every tool inside the audited repo. Checking the path lexically is not
 * enough: a symlink inside the repo pointing at /etc passes that check and
 * reads the target anyway, so resolve symlinks before deciding.
 */
async function safeJoin(root, p) {
  const target = resolve(root, p ?? ".");
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || lexical.startsWith(sep) || resolve(lexical) === lexical) {
    throw new Error(`path escapes the repo: ${p}`);
  }
  // Only meaningful for paths that exist; a missing path fails later, honestly.
  try {
    const real = await realpath(target);
    const realRoot = await realpath(root);
    const r = relative(realRoot, real);
    if (r.startsWith("..") || resolve(r) === r) throw new Error(`path resolves outside the repo: ${p}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return target;
}

const rel = (root, abs) => relative(root, abs) || ".";

/**
 * Whether two findings are the same issue wearing different words. A replan
 * re-covers ground, and the model files the issue again with fresh phrasing —
 * "uninstallable off the author's machine" and "npx cannot install" are one
 * problem. Comparing sentences fails; comparing the content words does not.
 *
 * Threshold picked from a real run: genuine restatements scored 0.28-0.44,
 * genuinely different findings on the same file scored 0.05-0.13.
 */
const DUPE_THRESHOLD = 0.2;
const STOP = new Set(["the","a","an","is","are","in","on","of","to","and","or","so","that","this","it","its","no","not","with","for","from","as","by","at","any","all","has","have","been","be"]);

function words(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Turn a thrown path or filesystem error into the {ok:false} shape every other
 * tool here returns. The registry catches throws too, but a tool that reports
 * its own failures is usable directly — and the message stays specific.
 */
function guard(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (err) {
      return { ok: false, output: "", error: err?.message ?? String(err) };
    }
  };
}

/**
 * A finding may quote a file that holds a live credential — which is exactly the
 * finding worth making, and exactly the string that must not travel on into a
 * report someone emails to a client. Keep the shape of the evidence, drop the
 * secret: "AWS_SECRET_ACCESS_KEY=<redacted, 40 chars>" says everything the
 * reader needs and nothing an attacker can use.
 */
const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i;

export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    // KEY=value / "key": "value" / key: value
    .replace(/([\w.\-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[\w.\-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi,
      (m, key, sep, q, val) => `${key}${sep}${q}<redacted, ${val.length} chars>${q}`)
    // standalone high-entropy blobs: provider key prefixes and long base64/hex runs
    .replace(/\b(?:AKIA|ASIA|ghp_|gho_|github_pat_|sk-[a-zA-Z]*-?|xox[baprs]-|AIza)[A-Za-z0-9_\-]{10,}/g,
      (m) => `<redacted ${m.slice(0, 4)}… ${m.length} chars>`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "<redacted private key block>");
}

/** The already-recorded finding this one restates, if there is one. */
function duplicateOf(finding, existing) {
  const file = finding.file ?? "";
  return existing.find((e) => (e.file ?? "") === file && similarity(e.title, finding.title) >= DUPE_THRESHOLD);
}

async function* walk(root, dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      // Directories are skipped by name, not by leading dot. Skipping every
      // dotfile hid .env, .npmrc and every CI config from an audit whose whole
      // job is to notice a committed secret.
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(root, join(dir, e.name), depth + 1);
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

/**
 * Read-only tools scoped to one repository, plus the one write the agent is
 * allowed: recording a finding. Everything the agent claims has to arrive
 * through `record_finding`, so the report is structured data rather than prose
 * scraped out of a transcript.
 */
export function repoTools(root, { sink } = {}) {
  const findings = [];
  if (sink && existsSync(sink)) {
    for (const line of readFileSync(sink, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        if (duplicateOf(f, findings)) continue;
        findings.push({ ...f, id: `f${findings.length + 1}` });
      } catch {
        // a half-written line from a hard kill: skip it, keep the rest
      }
    }
  }

  const list_dir = defineTool(
    "list_dir",
    "List files and directories at a path inside the repo. Use this to orient before reading.",
    { type: "object", properties: { path: { type: "string", description: "repo-relative path; omit for the root" } } },
    guard(async ({ path }) => {
      const dir = await safeJoin(root, path);
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return { ok: true, output: lines.join("\n") || "(empty)" };
    }),
    { readOnly: true },
  );

  const read_file = defineTool(
    "read_file",
    "Read one file from the repo. Returns the text with 1-based line numbers so you can cite exact lines.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "repo-relative file path" },
        start: { type: "number", description: "1-based first line (optional)" },
        end: { type: "number", description: "1-based last line (optional)" },
      },
      required: ["path"],
    },
    guard(async ({ path, start, end }) => {
      const file = await safeJoin(root, path);
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) {
        return { ok: false, output: "", error: `file is ${info.size} bytes; read a line range instead (start/end)` };
      }
      if (BINARY_EXT.has(extname(file).toLowerCase())) {
        return { ok: false, output: "", error: "binary or lockfile — not readable as text" };
      }
      const lines = (await readFile(file, "utf8")).split("\n");
      const from = Math.max(1, start ?? 1);
      const to = Math.min(lines.length, end ?? lines.length);
      const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n");
      return { ok: true, output: body || "(empty file)" };
    }),
    { readOnly: true },
  );

  const search = defineTool(
    "search",
    "Search the repo's text files for a regular expression. Returns file:line and the matching line.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        glob: { type: "string", description: "optional substring the file path must contain, e.g. 'src/' or '.ts'" },
      },
      required: ["pattern"],
    },
    guard(async ({ pattern, glob }) => {
      let re;
      try {
        re = new RegExp(pattern, "i");
      } catch (err) {
        return { ok: false, output: "", error: `bad regular expression: ${err.message}` };
      }
      const hits = [];
      for await (const file of walk(root, root)) {
        if (hits.length >= MAX_MATCHES) break;
        const r = rel(root, file);
        if (glob && !r.includes(glob)) continue;
        if (BINARY_EXT.has(extname(file).toLowerCase())) continue;
        let text;
        try {
          const info = await stat(file);
          if (info.size > MAX_FILE_BYTES) continue;
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        text.split("\n").forEach((line, i) => {
          if (hits.length < MAX_MATCHES && re.test(line)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
      const capped = hits.length >= MAX_MATCHES ? `\n(stopped at ${MAX_MATCHES} matches)` : "";
      return { ok: true, output: hits.length ? hits.join("\n") + capped : "no matches" };
    }),
    { readOnly: true },
  );

  const record_finding = defineTool(
    "record_finding",
    "Record ONE audit finding. Call this for every issue worth reporting. A finding you do not record does not exist in the report.",
    {
      type: "object",
      properties: {
        title: { type: "string", description: "one line, specific — name the actual problem, not the category" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        category: { type: "string", description: "e.g. security, correctness, dependencies, testing, docs, ci, licensing, maintainability" },
        file: { type: "string", description: "repo-relative path this is anchored to, if any" },
        line: { type: "number", description: "1-based line number, if any" },
        evidence: { type: "string", description: "what you actually saw in the file — quote it. Not a guess." },
        impact: { type: "string", description: "what goes wrong for the maintainer if this is left alone" },
        fix: { type: "string", description: "the concrete change to make" },
      },
      required: ["title", "severity", "category", "evidence", "impact", "fix"],
    },
    async (f) => {
      // A replan re-covers ground, and the model files the same issue again with
      // fresh wording. Two entries for one problem reads as padding, so collapse
      // them on what the finding is ABOUT rather than on its prose.
      for (const field of ["evidence", "title", "impact", "fix"]) {
        if (typeof f[field] === "string") f[field] = redactSecrets(f[field]);
      }
      const dupe = duplicateOf(f, findings);
      if (dupe) return { ok: true, output: `already recorded as ${dupe.id} ("${dupe.title}") — not filed again` };
      findings.push({ ...f, id: `f${findings.length + 1}` });
      // Write through immediately: findings must outlive the process, and the
      // harness's checkpoint keeps only a prose trace of tool calls, not the
      // structured input. This file is what a resumed audit reads back.
      if (sink) {
        await mkdir(dirname(sink), { recursive: true }).catch(() => {});
        await appendFile(sink, JSON.stringify(f) + "\n", "utf8").catch(() => {});
      }
      return { ok: true, output: `recorded ${findings.length}: [${f.severity}] ${f.title}` };
    },
  );

  return { tools: [list_dir, read_file, search, record_finding], findings };
}

/** A quick factual sketch of the repo, so the planner plans for THIS codebase. */
export async function surveyRepo(root) {
  const byExt = new Map();
  let files = 0;
  const notable = [];
  const WANTED = new Set([
    "package.json", "tsconfig.json", "README.md", "LICENSE", "Dockerfile",
    "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", ".gitignore",
  ]);
  for await (const file of walk(root, root)) {
    files++;
    const ext = extname(file).toLowerCase() || "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    const r = rel(root, file);
    if (WANTED.has(r) || r.startsWith(".github/")) notable.push(r);
  }
  const top = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    files,
    extensions: top.map(([e, n]) => `${e}×${n}`).join(", "),
    notable: notable.sort().slice(0, 15),
  };
}
