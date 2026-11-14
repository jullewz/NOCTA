/** Source files, spans and diagnostics. */

export interface Span {
  /** Byte offsets into the source text, end exclusive. */
  start: number;
  end: number;
}

export class SourceFile {
  private readonly lineStarts: number[] = [0];

  constructor(
    readonly name: string,
    readonly text: string,
  ) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
  }

  /** 1-based line and column of an offset. */
  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.lineStarts[lo] ?? 0) + 1 };
  }

  lineText(line: number): string {
    const start = this.lineStarts[line - 1];
    if (start === undefined) return "";
    const end = this.lineStarts[line] ?? this.text.length + 1;
    return this.text.slice(start, end - 1).replace(/\r$/, "");
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  file: SourceFile;
  /** Extra line of advice, e.g. "did you mean `total`?". */
  hint?: string;
  /** Stable identifier, e.g. "unused-variable". */
  code: string;
}

export class NoctaError extends Error {
  override name = "NoctaError";
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join("\n"));
  }
}

export interface RenderOptions {
  color?: boolean;
}

const C = {
  red: "38;2;251;113;133",
  yellow: "38;2;251;191;36",
  violet: "38;2;167;139;250",
  dim: "38;2;113;113;122",
  bold: "1",
};

/** Render one diagnostic as a compiler-style report with a code frame. */
export function renderDiagnostic(d: Diagnostic, options: RenderOptions = {}): string {
  const paint = (text: string, code: string): string => (options.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const { line, column } = d.file.position(d.span.start);
  const endPos = d.file.position(Math.max(d.span.start, d.span.end - 1));
  const tone = d.severity === "error" ? C.red : C.yellow;
  const out: string[] = [];
  out.push(`${paint(`${d.severity}[${d.code}]`, `${C.bold};${tone}`)}${paint(`: ${d.message}`, C.bold)}`);
  const gutter = String(Math.min(endPos.line, line + 3)).length;
  out.push(`${" ".repeat(gutter)}${paint(" --> ", C.violet)}${d.file.name}:${line}:${column}`);
  out.push(`${" ".repeat(gutter)} ${paint("|", C.violet)}`);
  const lastLine = Math.min(endPos.line, line + 3);
  for (let n = line; n <= lastLine; n++) {
    const text = d.file.lineText(n).replace(/\t/g, " ");
    out.push(`${paint(String(n).padStart(gutter), C.violet)} ${paint("|", C.violet)} ${text}`);
    const from = n === line ? column : 1;
    const to = n === endPos.line ? endPos.column : text.length;
    const width = Math.max(1, to - from + 1);
    out.push(`${" ".repeat(gutter)} ${paint("|", C.violet)} ${" ".repeat(from - 1)}${paint("^".repeat(width), tone)}`);
  }
  if (d.hint) out.push(`${" ".repeat(gutter)} ${paint("=", C.violet)} ${paint("hint:", C.bold)} ${d.hint}`);
  return out.join("\n");
}

export function renderDiagnostics(list: Diagnostic[], options: RenderOptions = {}): string {
  return list.map((d) => renderDiagnostic(d, options)).join("\n\n");
}

/** Closest candidate by edit distance, for "did you mean" hints. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = editDistance(name, candidate, bestDistance);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? limit;
}
