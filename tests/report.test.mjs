import { describe, it, expect } from "vitest";
import { sortFindings, counts, toMarkdown, toHtml } from "../src/report.mjs";

const finding = (over = {}) => ({
  id: "f1",
  title: "a finding",
  severity: "medium",
  category: "correctness",
  evidence: "what was seen",
  impact: "what breaks",
  fix: "what to change",
  ...over,
});

const payload = (findings) => ({
  repo: "demo",
  findings,
  survey: { files: 12 },
  runId: "run_x",
  status: "done",
});

describe("the report is the deliverable", () => {
  it("puts the worst first, whatever order they were recorded in", () => {
    const order = sortFindings([
      finding({ severity: "low" }),
      finding({ severity: "critical" }),
      finding({ severity: "medium" }),
      finding({ severity: "high" }),
    ]).map((f) => f.severity);
    expect(order).toEqual(["critical", "high", "medium", "low"]);
  });

  it("counts each severity, and ignores one it does not recognise", () => {
    // Severity comes from the model. A value outside the enum must not be
    // counted as something else, or the summary line lies about the run.
    const c = counts([
      finding({ severity: "critical" }),
      finding({ severity: "low" }),
      finding({ severity: "low" }),
      finding({ severity: "catastrophic" }),
    ]);
    expect(c).toEqual({ critical: 1, high: 0, medium: 0, low: 2 });
  });

  it("renders an empty audit without pretending it found something", () => {
    const md = toMarkdown(payload([]));
    expect(md).toMatch(/No findings recorded/);
    expect(toHtml(payload([]))).toMatch(/No findings were recorded/);
  });
});

describe("model output cannot break out of the HTML report", () => {
  // Every field in a finding is written by the model against someone's
  // repository. A report that executes what it quotes is a vulnerability, not
  // a formatting bug — the file gets sent to clients.
  const hostile = finding({
    title: '</h2><script>alert(1)</script>',
    evidence: '<img src=x onerror="alert(2)">',
    impact: 'closing "quote and <b>bold</b>',
    fix: "a & b < c",
    file: '"><script>alert(3)</script>',
    category: "<em>security</em>",
  });

  it("escapes every field it interpolates", () => {
    // What matters is that nothing the model wrote survives as markup. An
    // attribute name like `onerror=` sitting in a text node is inert once its
    // `<` is escaped, so the check is for tags, not for scary substrings.
    const html = toHtml(payload([hostile]));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<em>security</em>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("still shows the text, escaped rather than dropped", () => {
    const html = toHtml(payload([hostile]));
    expect(html).toContain("alert(1)");
    expect(html).toContain("a &amp; b &lt; c");
  });

  it("escapes the repo name and run id too", () => {
    const html = toHtml({ ...payload([]), repo: "<script>x</script>", runId: "<b>id</b>" });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>id</b>");
  });
});

describe("the html report stands alone", () => {
  const html = toHtml(payload([finding({ file: "src/a.ts", line: 12 })]));

  it("fetches nothing at render time", () => {
    // It is opened from disk and emailed around; a report that needs the
    // network renders differently for whoever opens it.
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/src="https?:/i);
  });

  it("carries a title and readable colours in both themes", () => {
    expect(html).toMatch(/<title>Audit — demo<\/title>/);
    expect(html).toMatch(/prefers-color-scheme: dark/);
    expect(html).toMatch(/\[data-theme="dark"\]/);
  });
});

describe("the markdown report", () => {
  it("anchors a finding to the file and line it came from", () => {
    const md = toMarkdown(payload([finding({ file: "src/a.ts", line: 12, severity: "high" })]));
    expect(md).toContain("## [high] a finding");
    expect(md).toContain("`src/a.ts:12`");
  });

  it("says the run halted, rather than implying a complete audit", () => {
    const md = toMarkdown({ ...payload([finding()]), status: "halted" });
    expect(md).toContain("halted");
  });
});
