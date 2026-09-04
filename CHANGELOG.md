# Changelog

All notable changes to fable-audit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-09-04

Three defects, all found by running this auditor against its own repository
through a web service that sold the result.

### Fixed

- **A security audit could not see `.env`.** `walk` skipped every entry whose
  name began with a dot — files included — so `.env`, `.npmrc` and most CI
  config were invisible to `search` and `surveyRepo`. A repository with
  `AWS_SECRET_ACCESS_KEY=AKIA…` committed answered `search("SECRET|AKIA")` with
  "no matches". Directories are now skipped by name, and the noisy dot
  directories are listed explicitly.
- **One findings file served every run.** The sink was
  `.fable-audit/findings.jsonl`, so a second audit in a directory began by
  loading the first one's findings: re-auditing a repository that had since
  been fixed still reported everything that used to be wrong with it. Findings
  are now keyed by run id.
- `read_file`, `list_dir` and `search` threw raw errors instead of returning the
  `{ ok: false, error }` shape the rest of the toolset uses. The registry caught
  the throw, so it was invisible in a run, but a tool that reports its own
  failure is usable directly and keeps its message.

### Added

- **Credentials are redacted from recorded findings.** Opening dotfiles means an
  audit can finally report a committed key — and the key must not ride along
  into a report someone emails to a client. Values assigned to secret-shaped
  keys, bare provider tokens (`ghp_`, `AKIA`, `sk-`, `xox…`), and private key
  blocks are masked when a finding is recorded. The agent still sees the real
  file through `search` and `read_file`; it needs the truth to judge, the report
  does not need it to be useful.
- `--runs-dir` is honoured rather than silently ignored, and an unknown flag is
  now an error instead of a no-op — a misspelled flag used to cost real minutes
  and then not do what was asked.
- A test suite (31 tests) and CI on Node 18, 20 and 22. The package previously
  shipped with `npm test` failing on "missing script".

## [0.1.0] — 2026-09-04

First release. An autonomous codebase audit that survives crashes: it plans the
audit, reads your actual files, records structured findings, and ships a
markdown and a standalone HTML report. Built on
[oh-my-fable](https://www.npmjs.com/package/oh-my-fable).

[0.1.1]: https://github.com/didrod205/fable-audit/releases/tag/v0.1.1
[0.1.0]: https://github.com/didrod205/fable-audit/releases/tag/v0.1.0
