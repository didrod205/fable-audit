# fable-audit

**An autonomous codebase audit that survives crashes.** Point it at a repository;
it plans the audit, opens your actual files, and ships a prioritized report.

```bash
npx fable-audit ./my-repo
```

No API key needed — it rides your existing Claude Code login, so a full audit
costs you nothing per token.

```
  auditing /Users/you/my-repo

  plan  manifests & dependencies → source security pass → error handling → tests & CI → docs vs code
  ▶  manifests & dependencies
     ✦ Unpinned dependency range on a package that ships binaries
     ✦ No `engines` field, yet the code uses Node 20 syntax
  ▶  source security pass
     ✦ User-supplied path joined without a traversal guard
  ...
  ✔ verified

  7 findings  critical 1 · high 2 · medium 3 · low 1
  report: audit.md
  report: audit.html
```

## Why "survives crashes" is the feature

A real audit of a real repository is a long job: dozens of files, several
passes, many minutes of model time. Long jobs get interrupted — a closed laptop,
an OOM, a dropped network, a rate limit.

Every other tool starts over. This one doesn't:

```bash
fable-audit ./my-repo        # dies 12 minutes in
fable-audit resume run_abc   # picks up at the step it died on
```

That comes from [oh-my-fable](https://www.npmjs.com/package/oh-my-fable), the
durable agent harness underneath: the whole run lives in one serializable
context, checkpointed after every step.

Findings recorded before the crash are replayed out of the checkpoint, so a
resumed audit reports the whole run — not just the part after the crash.

## What you get

Two files, both generated from the same structured findings:

- **`audit.md`** — for your issue tracker, PR description, or CLAUDE.md
- **`audit.html`** — a standalone, self-contained report you can send to a
  client or a board. Dark mode included, no external assets.

Every finding carries four things, because a finding without them is noise:

| | |
| --- | --- |
| **What's there** | quoted from the file it was read from — not a guess |
| **Why it matters** | what breaks for the maintainer if it's left alone |
| **Fix** | the concrete change |
| **Where** | `file:line` |

## Usage

```bash
fable-audit <path>                    # audit a repository
fable-audit resume <runId>            # continue an interrupted audit

  --focus "<what>"     steer it: "security", "is this safe to open-source?"
  --out <prefix>       report path prefix (default: ./audit)
  --provider claude    your Claude Code login, no API key (default)
  --provider anthropic use ANTHROPIC_API_KEY instead
  --max-steps <n>      step budget (default 24)
```

The audit is strictly read-only. It is given `list_dir`, `read_file`, `search`,
and one recording tool — there is no tool that can write to your repository.

## Honest limits

- Quality tracks the model. It reads what it reads; it is not a formal verifier
  and will not find every bug.
- It reports what the code shows. A finding it cannot anchor to a file it opened
  is a finding it is told not to make — but "told not to" is not a guarantee.
- A large monorepo needs a bigger `--max-steps` than the default 24.
- Each step is one model call, and a call through the Claude CLI is not fast.
  Budget minutes, not seconds.

## Pricing

Free and MIT for local use — bring your own Claude Code login.

The paid tier is the part that is annoying to self-host: scheduled audits on
every push, trend lines across runs, and a shareable hosted report per commit.
That isn't built yet. If you want it,
[open an issue](https://github.com/didrod205/fable-audit/issues) and say what
you'd actually pay for.

## License

MIT
