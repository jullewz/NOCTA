/**
 * Lexer: source text to tokens.
 *
 * Newlines end statements, so every token records whether a line break
 * came before it. String literals with `{expr}` interpolation are split
 * into string parts and nested token streams.
 */

import type { Diagnostic, SourceFile, Span } from "./source.js";

export type TokenKind = "number" | "string" | "ident" | "keyword" | "op" | "eof";

export const KEYWORDS = new Set([
  "let",
  "var",
  "fn",
  "if",
  "else",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "return",
  "match",
  "record",
  "enum",
  "true",
  "false",
  "nil",
  "and",
  "or",
  "not",
  "try",
  "catch",
  "throw",
  "import",
  "as",
  "test",
]);

// Longest operators first, so `..=` wins over `..` and `.`.
const OPERATORS = [
  "..=",
  "|>",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "**",
  "..",
  "??",
  "+=",
  "-=",
  "*=",
  "/=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ".",
  ":",
  "|",
  ";",
];

/** A piece of an interpolated string: literal text or an embedded expression. */
export type StringPart = { text: string } | { tokens: Token[]; span: Span };

export interface Token {
  kind: TokenKind;
  /** Keyword, operator or identifier text. For strings, the cooked value when there is no interpolation. */
  text: string;
  span: Span;
  /** True when at least one line break separates this token from the previous one. */
  newlineBefore: boolean;
  value?: number;
  parts?: StringPart[];
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "{": "{",
  "}": "}",
};

export class Lexer {
  readonly diagnostics: Diagnostic[] = [];
  private pos: number;
  private readonly end: number;

  constructor(
    private readonly file: SourceFile,
    start = 0,
    end = file.text.length,
  ) {
    this.pos = start;
    this.end = end;
  }

  private error(message: string, span: Span, hint?: string): void {
    this.diagnostics.push({
      severity: "error",
      code: "syntax",
      message,
      span,
      file: this.file,
      ...(hint ? { hint } : {}),
    });
  }

  tokenize(): Token[] {
    const src = this.file.text;
    const tokens: Token[] = [];
    let newline = false;
    while (this.pos < this.end) {
      const c = src[this.pos] as string;
      if (c === "\n") {
        newline = true;
        this.pos++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
        continue;
      }
      if (c === "/" && src[this.pos + 1] === "/") {
        while (this.pos < this.end && src[this.pos] !== "\n") this.pos++;
        continue;
      }
      if (c === "/" && src[this.pos + 1] === "*") {
        const start = this.pos;
        const close = src.indexOf("*/", this.pos + 2);
        if (close < 0 || close >= this.end) {
          this.error("unterminated block comment", { start, end: start + 2 });
          this.pos = this.end;
        } else {
          if (src.slice(start, close).includes("\n")) newline = true;
          this.pos = close + 2;
        }
        continue;
      }
      const start = this.pos;
      let token: Token | null = null;
      if (isDigit(c)) token = this.number(start);
      else if (isIdentStart(c)) {
        while (this.pos < this.end && isIdentPart(src[this.pos] as string)) this.pos++;
        const text = src.slice(start, this.pos);
        token = {
          kind: KEYWORDS.has(text) ? "keyword" : "ident",
          text,
          span: { start, end: this.pos },
          newlineBefore: false,
        };
      } else if (c === '"') token = this.string(start);
      else {
        const op = OPERATORS.find((o) => src.startsWith(o, this.pos));
        if (op) {
          this.pos += op.length;
          token = { kind: "op", text: op, span: { start, end: this.pos }, newlineBefore: false };
        } else {
          this.pos++;
          this.error(`unexpected character ${JSON.stringify(c)}`, { start, end: this.pos });
        }
      }
      if (token) {
        token.newlineBefore = newline;
        newline = false;
        tokens.push(token);
      }
    }
    tokens.push({ kind: "eof", text: "<end of file>", span: { start: this.end, end: this.end }, newlineBefore: true });
    return tokens;
  }

  private number(start: number): Token {
    const src = this.file.text;
    while (this.pos < this.end && (isDigit(src[this.pos] as string) || src[this.pos] === "_")) this.pos++;
    // a fraction needs a digit after the dot, so `1..5` and `xs.len` still work
    if (src[this.pos] === "." && isDigit(src[this.pos + 1] ?? "")) {
      this.pos++;
      while (this.pos < this.end && (isDigit(src[this.pos] as string) || src[this.pos] === "_")) this.pos++;
    }
    if (src[this.pos] === "e" || src[this.pos] === "E") {
      const save = this.pos;
      this.pos++;
      if (src[this.pos] === "+" || src[this.pos] === "-") this.pos++;
      if (isDigit(src[this.pos] ?? "")) while (isDigit(src[this.pos] ?? "")) this.pos++;
      else this.pos = save;
    }
    const text = src.slice(start, this.pos);
    return {
      kind: "number",
      text,
      value: Number(text.replace(/_/g, "")),
      span: { start, end: this.pos },
      newlineBefore: false,
    };
  }

  private string(start: number): Token {
    const src = this.file.text;
    this.pos++; // opening quote
    const parts: StringPart[] = [];
    let text = "";
    let closed = false;
    while (this.pos < this.end) {
      const c = src[this.pos] as string;
      if (c === '"') {
        this.pos++;
        closed = true;
        break;
      }
      if (c === "\n") break;
      if (c === "\\") {
        const next = src[this.pos + 1] ?? "";
        if (next === "u" && src[this.pos + 2] === "{") {
          const close = src.indexOf("}", this.pos + 3);
          const hex = close > 0 ? src.slice(this.pos + 3, close) : "";
          if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
            text += String.fromCodePoint(parseInt(hex, 16));
            this.pos = close + 1;
          } else {
            this.error("invalid unicode escape, expected \\u{1F600}", { start: this.pos, end: this.pos + 3 });
            this.pos += 2;
          }
          continue;
        }
        const cooked = ESCAPES[next];
        if (cooked === undefined) {
          this.error(
            `unknown escape sequence \\${next}`,
            { start: this.pos, end: this.pos + 2 },
            'valid escapes: \\n \\t \\r \\0 \\\\ \\" \\{ \\} \\u{…}',
          );
          text += next;
        } else text += cooked;
        this.pos += 2;
        continue;
      }
      if (c === "{") {
        // find the matching brace, skipping nested braces and strings
        const open = this.pos;
        let depth = 1;
        let i = this.pos + 1;
        while (i < this.end && depth > 0) {
          const ch = src[i] as string;
          if (ch === "\n") break;
          if (ch === '"') {
            i++;
            while (i < this.end && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
          } else if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
        if (depth !== 0) {
          this.error(
            "unterminated `{` in string interpolation",
            { start: open, end: open + 1 },
            "write \\{ for a literal brace",
          );
          this.pos = i;
          break;
        }
        if (text) parts.push({ text });
        text = "";
        const inner = new Lexer(this.file, open + 1, i - 1);
        const tokens = inner.tokenize();
        this.diagnostics.push(...inner.diagnostics);
        if (tokens.length <= 1) this.error("empty interpolation", { start: open, end: i });
        parts.push({ tokens, span: { start: open, end: i } });
        this.pos = i;
        continue;
      }
      text += c;
      this.pos++;
    }
    if (!closed) this.error("unterminated string", { start, end: Math.min(this.pos, start + 1) }, 'add a closing "');
    const span = { start, end: this.pos };
    if (parts.length === 0) return { kind: "string", text, span, newlineBefore: false };
    if (text) parts.push({ text });
    return { kind: "string", text: "", parts, span, newlineBefore: false };
  }
}
