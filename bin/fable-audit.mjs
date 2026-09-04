#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { audit, resumeAudit } from "../src/audit.mjs";
import { toMarkdown, toHtml, counts, sortFindings } from "../src/report.mjs";

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), yellow = c("33"), cyan = c("36");

/** A flag given without a value is `true`, which is not a path or a number. */
const str = (v) => (typeof v === "string" && v.trim() ? v : undefined);
function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number, got "${v}"`);
  return n;
}

function parse(argv) {
  const _ = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else _.push(a);
  }
  return { _, flags };
}

const SEV = { critical: red, high: yellow, medium: cyan, low: dim };

/** Show the audit working. A long run with no output looks like a hang. */
function renderer() {
  return (e) => {
    if (e.type === "plan_created")
      process.stdout.write(`  ${cyan("plan")}  ${e.plan.steps.map((s) => s.intent).join(dim(" → "))}\n`);
    else if (e.type === "step_start") process.stdout.write(`  ${bold("▶")}  ${e.step.intent}\n`);
    else if (e.type === "tool_call" && e.name === "record_finding")
      process.stdout.write(`     ${(SEV[e.input?.severity] ?? dim)("✦ " + (e.input?.title ?? "finding"))}\n`);
    else if (e.type === "reflection" && e.reflection.progress !== "on_track")
      process.stdout.write(`     ${yellow("⟲ " + e.reflection.progress)}\n`);
    else if (e.type === "replan") process.stdout.write(`  ${yellow("🔁 replan")}\n`);
    else if (e.type === "exit_check")
      process.stdout.write(`  ${e.reflection.progress === "goal_met" ? green("✔ verified") : yellow("… not done yet")}\n`);
    else if (e.type === "halted") process.stdout.write(`  ${yellow("⛔ " + e.reason)}\n`);
  };
}

async function emit(out, { repo, findings, survey, runId, status }) {
  const payload = { repo, findings: sortFindings(findings), survey, runId, status };
  const md = `${out}.md`, html = `${out}.html`;
  await writeFile(md, toMarkdown(payload), "utf8");
  await writeFile(html, toHtml(payload), "utf8");
  const n = counts(payload.findings);
  process.stdout.write(
    `\n  ${bold(`${payload.findings.length} findings`)}  ` +
      `${red(`critical ${n.critical}`)} · ${yellow(`high ${n.high}`)} · ${cyan(`medium ${n.medium}`)} · ${dim(`low ${n.low}`)}\n` +
      `  ${dim("report:")} ${md}\n  ${dim("report:")} ${html}\n\n`,
  );
}

function help() {
  process.stdout.write(`
${bold("fable-audit")} — an autonomous codebase audit that survives crashes.

  fable-audit <path>                audit a repository
  fable-audit resume <runId>        continue an interrupted audit

Options
  --focus "<what>"     steer the audit ("security", "is this safe to publish?")
  --out <prefix>       report path prefix (default: ./audit)
  --provider claude    your Claude Code login, no API key (default)
  --provider anthropic ANTHROPIC_API_KEY
  --model <id>         model for the chosen provider
  --max-steps <n>      step budget (default 24)
  --runs-dir <dir>     where checkpoints and findings live (default: .fable-audit)

Runs are checkpointed after every step, so an audit that dies to a laptop
lid, an OOM, or a lost network resumes instead of starting over.
`);
}

const KNOWN = new Set(["focus", "out", "provider", "model", "max-steps", "runs-dir", "help"]);

const { _, flags } = parse(process.argv.slice(2));
const cmd = _[0];
// A misspelled flag that is quietly ignored is worse than one that errors: the
// run costs real minutes and does not do what was asked.
const unknown = Object.keys(flags).filter((f) => !KNOWN.has(f));
if (unknown.length) {
  process.stderr.write(`\nfable-audit: unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => "--" + f).join(", ")}\n\n`);
  process.exit(2);
}

try {
  if (!cmd || flags["help"] || cmd === "help") {
    help();
  } else if (cmd === "resume") {
    const runId = _[1];
    if (!runId) throw new Error("give a run id: fable-audit resume <runId>");
    process.stdout.write(`\n  ${dim("resuming")} ${runId}\n\n`);
    const r = await resumeAudit({
      runId,
      provider: str(flags["provider"]),
      model: str(flags["model"]),
      runsDir: str(flags["runs-dir"]),
      onEvent: renderer(),
    });
    await emit(str(flags["out"]) ?? "audit", { repo: basename(r.ctx?.meta?.repoRoot ?? "repo"), ...r });
    process.exit(r.status === "done" ? 0 : 1);
  } else {
    const root = resolve(cmd);
    process.stdout.write(`\n  ${bold("auditing")} ${root}\n\n`);
    const r = await audit({
      root,
      focus: str(flags["focus"]),
      provider: str(flags["provider"]),
      model: str(flags["model"]),
      maxSteps: num(flags["max-steps"], "max-steps"),
      runsDir: str(flags["runs-dir"]),
      onEvent: renderer(),
    });
    await emit(str(flags["out"]) ?? "audit", { repo: basename(root), ...r });
    process.exit(r.status === "done" ? 0 : 1);
  }
} catch (err) {
  process.stderr.write(`\nfable-audit: ${err.message}\n\n`);
  process.exit(2);
}
