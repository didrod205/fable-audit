import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoTools, surveyRepo } from "../src/tools.mjs";
import { auditGoal } from "../src/audit.mjs";

const tool = (tools, name) => tools.find((t) => t.name === name);
const record = (over = {}) => ({
  title: "a finding",
  severity: "medium",
  category: "correctness",
  evidence: "e",
  impact: "i",
  fix: "f",
  ...over,
});

function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "fa-"));
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

describe("a finding filed twice is one finding", () => {
  // A replan re-covers ground and the model files the same issue again in
  // different words. Two entries for one problem reads as padding, and the
  // report is the thing being sold.
  it("collapses a restatement of the same issue on the same file", async () => {
    const { tools, findings } = repoTools(process.cwd());
    const rec = tool(tools, "record_finding");
    await rec.handler(record({ file: "package.json", category: "dependencies", title: "Published package depends on a local filesystem path so npx cannot install" }));
    const second = await rec.handler(record({ file: "package.json", category: "dependencies", title: "Sole runtime dependency is a local filesystem path so the package is uninstallable off the author machine" }));
    expect(second.output).toMatch(/already recorded/);
    expect(findings).toHaveLength(1);
  });

  it("keeps two genuinely different issues in the same file apart", async () => {
    const { tools, findings } = repoTools(process.cwd());
    const rec = tool(tools, "record_finding");
    await rec.handler(record({ file: "src/tools.mjs", title: "search compiles a caller-supplied regex with no timeout" }));
    await rec.handler(record({ file: "src/tools.mjs", title: "read_file rejects any file over 120KB and suggests something unsupported" }));
    expect(findings).toHaveLength(2);
  });

  it("does not merge the same words about different files", async () => {
    const { tools, findings } = repoTools(process.cwd());
    const rec = tool(tools, "record_finding");
    await rec.handler(record({ file: "a.ts", title: "no timeout on the network call" }));
    await rec.handler(record({ file: "b.ts", title: "no timeout on the network call" }));
    expect(findings).toHaveLength(2);
  });
});

describe("findings outlive the process", () => {
  // The harness records tool calls as prose in the step result, not as
  // structured input, so a resumed audit cannot reconstruct them. Losing them
  // silently is how an interrupted audit used to report nothing.
  it("writes each finding through to the sink as it is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-sink-"));
    try {
      const sink = join(dir, "findings.jsonl");
      const { tools } = repoTools(process.cwd(), { sink });
      await tool(tools, "record_finding").handler(record({ title: "first thing" }));
      await tool(tools, "record_finding").handler(record({ title: "a completely separate second matter" }));
      expect(readFileSync(sink, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads them back in a fresh process, still deduplicating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-sink-"));
    try {
      const sink = join(dir, "findings.jsonl");
      const first = repoTools(process.cwd(), { sink });
      await tool(first.tools, "record_finding").handler(record({ file: "a.ts", title: "the network call has no timeout at all" }));

      const afterCrash = repoTools(process.cwd(), { sink });
      expect(afterCrash.findings).toHaveLength(1);
      const again = await tool(afterCrash.tools, "record_finding").handler(
        record({ file: "a.ts", title: "the network call has no timeout at all" }),
      );
      expect(again.output).toMatch(/already recorded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a half-written line from a hard kill", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-sink-"));
    try {
      const sink = join(dir, "findings.jsonl");
      writeFileSync(sink, `${JSON.stringify(record({ title: "intact" }))}\n{"title":"cut off mid-`, "utf8");
      expect(repoTools(process.cwd(), { sink }).findings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the audit cannot read outside the repository", () => {
  it("refuses a path that climbs out", async () => {
    const root = repo({ "a.txt": "inside\n" });
    try {
      const out = await tool(repoTools(root).tools, "read_file").handler({ path: "../../etc/hosts" });
      expect(out.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink pointing out of the repo", async () => {
    // The lexical check passes for a link that lives inside the root; without
    // resolving it, the read follows the link straight out.
    const root = repo({ "a.txt": "inside\n" });
    const outside = repo({ "secret.txt": "TOP SECRET\n" });
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
      const out = await tool(repoTools(root).tools, "read_file").handler({ path: "leak.txt" });
      expect(`${out.output ?? ""}${out.error ?? ""}`).not.toContain("TOP SECRET");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a file inside the repo with line numbers, so findings can cite them", async () => {
    const root = repo({ "a.txt": "one\ntwo\nthree\n" });
    try {
      const out = await tool(repoTools(root).tools, "read_file").handler({ path: "a.txt", start: 2, end: 3 });
      expect(out.ok).toBe(true);
      expect(out.output).toContain("2\ttwo");
      expect(out.output).toContain("3\tthree");
      expect(out.output).not.toContain("one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("search", () => {
  it("reports file and line for each match", async () => {
    const root = repo({ "src/a.mjs": "const x = 1;\nconst apiKey = 'nope';\n" });
    try {
      const out = await tool(repoTools(root).tools, "search").handler({ pattern: "apikey" });
      expect(out.ok).toBe(true);
      expect(out.output).toMatch(/src\/a\.mjs:2:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the bad pattern as a tool error rather than throwing", async () => {
    const root = repo({ "a.txt": "x" });
    try {
      const out = await tool(repoTools(root).tools, "search").handler({ pattern: "([unclosed" });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/regular expression/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("surveying a repo", () => {
  it("skips dependency and build directories", async () => {
    const root = repo({
      "index.mjs": "x",
      "node_modules/dep/index.js": "x",
      "dist/bundle.js": "x",
      "package.json": "{}",
    });
    try {
      const s = await surveyRepo(root);
      expect(s.files).toBe(2);
      expect(s.notable).toContain("package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the goal handed to the agent", () => {
  it("demands recording inside each step, so an interrupted audit still delivers", () => {
    // Learned the hard way: a plan that reads everything first and records at
    // the end produces an empty report the moment the budget runs out.
    const g = auditGoal("/tmp/demo", { files: 3, extensions: ".ts×3", notable: [] });
    const constraints = g.constraints.join(" ");
    expect(constraints).toMatch(/EVERY step must end by calling record_finding/);
    expect(constraints).toMatch(/Never defer recording/);
    expect(g.description).toMatch(/read-then-record/);
  });

  it("forbids inventing findings to fill a quota", () => {
    const g = auditGoal("/tmp/demo", { files: 3, extensions: "", notable: [] });
    expect(g.constraints.join(" ")).toMatch(/Do not invent findings/);
  });

  it("carries the operator's focus through to the agent", () => {
    const g = auditGoal("/tmp/demo", { files: 1, extensions: "", notable: [] }, "only the auth code");
    expect(g.description).toContain("only the auth code");
  });
});
