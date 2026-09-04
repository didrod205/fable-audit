import { runWith, resume, createContext, resolveSerializable, claudeCode, AnthropicProvider, FileStore } from "oh-my-fable";
import { repoTools, surveyRepo } from "./tools.mjs";
import { basename, resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";

/**
 * Pick how we talk to a model. `claude` rides the user's Claude Code login —
 * no API key, nothing billed per token — which is what makes a long audit
 * affordable to run in the first place.
 */
export function makeProvider({ provider = "claude", model } = {}) {
  // No timeout override: oh-my-fable >= 0.4.3 defaults to 10 minutes for an
  // agentic CLI step, which is longer than the 5 minutes set here — and 5 was
  // already short enough to kill an audit mid-file-read.
  if (provider === "claude") return claudeCode({ model });
  if (provider === "anthropic") return new AnthropicProvider(model ? { model } : {});
  throw new Error(`unknown provider: ${provider}`);
}

const CATEGORIES = [
  "security (hardcoded secrets, injection, unsafe file/network handling)",
  "correctness (logic that is wrong, not merely ugly)",
  "dependencies (unpinned, abandoned, or risky)",
  "testing (what is untested that would hurt most if it broke)",
  "documentation (claims that do not match the code)",
  "ci / release (what can ship broken)",
  "licensing",
];

export function auditGoal(root, survey, focus) {
  const name = basename(root);
  return {
    description:
      `Audit the codebase at "${name}" and record every finding worth a maintainer's time.\n\n` +
      `Repo sketch: ${survey.files} files (${survey.extensions}).\n` +
      `Notable files: ${survey.notable.join(", ") || "(none detected)"}.\n\n` +
      (focus ? `The maintainer specifically wants: ${focus}\n\n` : "") +
      `Cover, as the code warrants: ${CATEGORIES.join("; ")}.\n\n` +
      `Work from the actual files. Open them with read_file and search; never guess at ` +
      `contents. Every finding must be recorded with record_finding — anything you only ` +
      `mention in prose is lost.\n\n` +
      `Each step is read-then-record: open the files for that step's area, then call ` +
      `record_finding once per issue you found there, before the step ends. The audit ` +
      `must be useful even if it is interrupted halfway.`,
    successCriteria: [
      "every source area of the repo has been read, and each one's findings were recorded before moving on",
      "every recorded finding cites evidence actually read from a file, not a guess",
    ],
    constraints: [
      // Learned the hard way: a plan that reads everything first and records at
      // the end produces an empty report the moment the budget runs out. Make
      // read-and-record the unit of work so partial runs still deliver.
      "EVERY step must end by calling record_finding for what that step found. Never defer recording to a later step — a step that reads without recording is a wasted step.",
      "If a step's area turns up nothing worth reporting, say so and move on. Do not invent findings to fill quota.",
      "Plan 4-6 steps, each covering one area of the repo (a directory, or one concern across the repo). Never one step per file.",
      "Keep each step's intent under 15 words.",
      "Report only what the code shows. No speculation, no generic best-practice advice that is not anchored to a file you read.",
      "Do not modify anything. This is read-only.",
    ],
  };
}

/**
 * One findings file per run. A single shared `findings.jsonl` meant the second
 * audit in a directory started by loading the first one's findings — so a
 * re-audit of a fixed repository still reported everything that used to be
 * wrong with it, and a report sold on that basis was wrong.
 */
const sinkFor = (dir, runId) => join(dir, `findings_${runId}.jsonl`);

/** Run a fresh audit. Returns { status, findings, runId, ctx }. */
export async function audit({ root, focus, provider, model, maxSteps = 24, runsDir, onEvent }) {
  const abs = resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    // Otherwise the agent audits an empty tree and reports, confidently, nothing.
    throw new Error(`not a directory: ${abs}`);
  }
  const dir = runsDir ?? ".fable-audit";
  const survey = await surveyRepo(abs);
  const budgets = { maxSteps, maxStepTokens: 8192 };
  // The context is created first so the run has an id, and the id names the
  // findings file. Tools are attached after, for the run only.
  const ctx = createContext(auditGoal(abs, survey, focus), resolveSerializable(budgets));
  ctx.meta["repoRoot"] = abs;
  ctx.meta["survey"] = survey;
  const { tools, findings } = repoTools(abs, { sink: sinkFor(dir, ctx.runId) });
  const result = await runWith(ctx, {
    provider: makeProvider({ provider, model }),
    store: new FileStore(dir),
    tools,
    onEvent,
    ...budgets,
  });
  return { status: result.status, reason: result.reason, findings, runId: ctx.runId, ctx, survey };
}

/**
 * Continue an audit that was interrupted, reporting the whole run — the
 * findings from before the crash included.
 */
export async function resumeAudit({ runId, provider, model, runsDir, onEvent }) {
  const dir = runsDir ?? ".fable-audit";
  const store = new FileStore(dir);
  const saved = await store.load(runId);
  if (!saved) throw new Error(`no saved audit run "${runId}"`);
  const abs = saved.meta?.["repoRoot"];
  if (!abs) throw new Error(`run "${runId}" has no recorded repo root`);
  // Findings come back from our own sidecar, not from the checkpoint: the
  // harness records tool calls as prose in the step result, not as structured
  // input, so there is nothing there to reconstruct a finding from.
  const { tools, findings } = repoTools(abs, { sink: sinkFor(dir, runId) });
  const result = await resume(runId, {
    provider: makeProvider({ provider, model }),
    store,
    tools,
    onEvent,
  });
  return {
    status: result.status,
    reason: result.reason,
    findings,
    runId,
    ctx: result.ctx,
    survey: saved.meta?.["survey"] ?? { files: "?" },
  };
}
