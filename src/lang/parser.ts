/**
 * Recursive-descent parser with Pratt-style operator precedence.
 *
 * Statements end at a line break or `;`. An expression continues onto the
 * next line when a line ends with a binary operator, or when the next line
 * starts with `.` or `|>` (method chains and pipelines).
 *
 * The parser recovers from errors by skipping to the next statement, so one
 * typo produces one diagnostic instead of a cascade.
 */

import type { AssignTarget, Block, Expr, FnNode, MatchArm, Param, Pattern, Program, Stmt } from "./ast.js";
import { Lexer, type Token } from "./lexer.js";
import type { Diagnostic, SourceFile, Span } from "./source.js";

class ParseError extends Error {}

/** Binding power of infix operators (higher binds tighter). */
const INFIX: Record<string, number> = {
  "|>": 2,
  "??": 3,
  or: 4,
  and: 5,
  "==": 7,
  "!=": 7,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  "..": 8,
  "..=": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 12,
};

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);
const COMPARISON = new Set(["==", "!=", "<", "<=", ">", ">="]);

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

export function parse(file: SourceFile): ParseResult {
  const lexer = new Lexer(file);
  const tokens = lexer.tokenize();
  const parser = new Parser(file, tokens);
  const program = parser.program();
  return { program, diagnostics: [...lexer.diagnostics, ...parser.diagnostics] };
}

export class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private i = 0;
  /** Depth of loops being parsed, to reject `break` outside a loop early. */
  private loopDepth = 0;
  private fnDepth = 0;

  constructor(
    private readonly file: SourceFile,
    private readonly tokens: Token[],
  ) {}

  // ------------------------------------------------------------- helpers
  private get tok(): Token {
    return this.tokens[this.i] as Token;
  }

  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)] as Token;
  }

  private advance(): Token {
    const t = this.tok;
    if (t.kind !== "eof") this.i++;
    return t;
  }

  private is(text: string): boolean {
    const t = this.tok;
    return (t.kind === "op" || t.kind === "keyword") && t.text === text;
  }

  private eat(text: string): boolean {
    if (this.is(text)) {
      this.advance();
      return true;
    }
    return false;
  }

  private fail(message: string, span: Span = this.tok.span, hint?: string): never {
    this.diagnostics.push({
      severity: "error",
      code: "syntax",
      message,
      span,
      file: this.file,
      ...(hint ? { hint } : {}),
    });
    throw new ParseError(message);
  }

  private describe(t: Token): string {
    if (t.kind === "eof") return "the end of the file";
    if (t.kind === "string") return "a string";
    if (t.kind === "number") return `the number ${t.text}`;
    if (t.kind === "ident") return `\`${t.text}\``;
    return `\`${t.text}\``;
  }

  /**
   * At a `{`: does it open a map literal rather than a block? A map starts with `}` (empty, only
   * in expression position), or with a key followed by `:`, `,` or `}` (`{name}` is shorthand).
   */
  private looksLikeMap(allowEmpty: boolean): boolean {
    const a = this.tokens[this.i + 1];
    const b = this.tokens[this.i + 2];
    if (!a) return false;
    if (a.kind === "op" && a.text === "}") return allowEmpty;
    if (!b || b.kind !== "op") return false;
    if (a.kind === "string") return b.text === ":";
    if (a.kind === "ident" || a.kind === "keyword") return b.text === ":" || b.text === "," || b.text === "}";
    return false;
  }

  private expect(text: string, context: string): Token {
    if (this.is(text)) return this.advance();
    const hint = text === ")" || text === "]" || text === "}" ? `add a closing \`${text}\`` : undefined;
    return this.fail(`expected \`${text}\` ${context}, found ${this.describe(this.tok)}`, this.tok.span, hint);
  }

  private ident(context: string): Token {
    if (this.tok.kind === "ident") return this.advance();
    if (this.tok.kind === "keyword") {
      return this.fail(
        `\`${this.tok.text}\` is a reserved word and cannot be used as ${context}`,
        this.tok.span,
        `try \`${this.tok.text}_\` instead`,
      );
    }
    return this.fail(`expected ${context}, found ${this.describe(this.tok)}`);
  }

  private span(start: Span, end: Span = this.tokens[Math.max(0, this.i - 1)]?.span ?? start): Span {
    return { start: start.start, end: Math.max(start.end, end.end) };
  }

  private endStatement(): void {
    if (this.eat(";")) return;
    if (this.tok.newlineBefore || this.is("}") || this.tok.kind === "eof") return;
    this.fail(`expected a new line or \`;\` after the statement, found ${this.describe(this.tok)}`);
  }

  /** Skip tokens until something that plausibly starts a new statement. */
  private synchronize(): void {
    let depth = 0;
    while (this.tok.kind !== "eof") {
      if (this.is("{")) depth++;
      if (this.is("}")) {
        if (depth === 0) return;
        depth--;
      }
      this.advance();
      if (depth === 0 && (this.tok.newlineBefore || this.is(";"))) {
        this.eat(";");
        return;
      }
    }
  }

  // --------------------------------------------------------- statements
  program(): Program {
    const stmts: Stmt[] = [];
    const start = this.tok.span;
    while (this.tok.kind !== "eof") {
      if (this.eat(";")) continue;
      if (this.is("}")) {
        this.diagnostics.push({
          severity: "error",
          code: "syntax",
          message: "unexpected `}` without a matching `{`",
          span: this.tok.span,
          file: this.file,
        });
        this.advance();
        continue;
      }
      try {
        stmts.push(this.statement(true));
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        this.synchronize();
      }
    }
    return { stmts, span: this.span(start, this.tok.span) };
  }

  private block(context: string): Block {
    const open = this.expect("{", context);
    const stmts: Stmt[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      if (this.eat(";")) continue;
      try {
        stmts.push(this.statement(false));
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        this.synchronize();
      }
    }
    if (!this.is("}")) this.fail("this block is never closed", open.span, "add a closing `}`");
    this.advance();
    return { stmts, span: this.span(open.span) };
  }

  private statement(topLevel: boolean): Stmt {
    const t = this.tok;
    if (t.kind === "keyword") {
      switch (t.text) {
        case "let":
        case "var": {
          this.advance();
          const pattern = this.pattern();
          this.expect("=", `after the name in \`${t.text}\``);
          const value = this.expression();
          this.endStatement();
          return { kind: "Let", pattern, mutable: t.text === "var", value, span: this.span(t.span) };
        }
        case "fn":
          if (this.peek().kind === "ident") {
            const fn = this.fnNode(true);
            return { kind: "FnDecl", fn, span: fn.span };
          }
          break;
        case "enum":
          return this.enumDecl();
        case "while": {
          this.advance();
          const cond = this.expression();
          const body = this.loopBody("for the `while` body");
          return { kind: "While", cond, body, span: this.span(t.span) };
        }
        case "for": {
          this.advance();
          const pattern = this.pattern();
          this.expect("in", "after the loop variable");
          const iterable = this.expression();
          const body = this.loopBody("for the `for` body");
          return { kind: "For", pattern, iterable, body, span: this.span(t.span) };
        }
        case "break":
        case "continue": {
          this.advance();
          if (this.loopDepth === 0) this.fail(`\`${t.text}\` can only be used inside a loop`, t.span);
          this.endStatement();
          return { kind: t.text === "break" ? "Break" : "Continue", span: t.span };
        }
        case "return": {
          this.advance();
          if (this.fnDepth === 0) this.fail("`return` can only be used inside a function", t.span);
          const value =
            this.tok.newlineBefore || this.is("}") || this.is(";") || this.tok.kind === "eof"
              ? null
              : this.expression();
          this.endStatement();
          return { kind: "Return", value, span: this.span(t.span) };
        }
        case "throw": {
          this.advance();
          const value = this.expression();
          this.endStatement();
          return { kind: "Throw", value, span: this.span(t.span) };
        }
        case "test": {
          this.advance();
          if (!topLevel) this.fail("`test` blocks must be at the top level of a file", t.span);
          if (this.tok.kind !== "string" || this.tok.parts) this.fail("expected the test name as a plain string");
          const name = this.advance().text;
          this.fnDepth++;
          const body = this.block("for the test body");
          this.fnDepth--;
          return { kind: "Test", name, body, span: this.span(t.span) };
        }
        case "import": {
          this.advance();
          if (!topLevel) this.fail("`import` must be at the top level of a file", t.span);
          if (this.tok.kind !== "string" || this.tok.parts) this.fail("expected the module path as a plain string");
          const path = this.advance().text;
          this.expect("as", "after the import path");
          const alias = this.ident("a module name").text;
          this.endStatement();
          return { kind: "Import", path, alias, span: this.span(t.span) };
        }
      }
    }
    if (this.is("{") && !this.looksLikeMap(false)) {
      const block = this.block("for the block");
      const expr: Expr = { kind: "BlockExpr", block, span: block.span };
      // a block can start an expression: `{ ... } == x` is unusual, so only a plain block is accepted here
      return { kind: "ExprStmt", expr, span: block.span };
    }
    const expr = this.expression();
    // if/match/blocks end with `}` and need no separator
    if (!["If", "Match", "Try", "BlockExpr"].includes(expr.kind)) this.endStatement();
    else this.eat(";");
    return { kind: "ExprStmt", expr, span: expr.span };
  }

  /** `return [value]` or `throw value` without the statement terminator, for use inside expressions. */
  private controlStatement(): Stmt {
    const t = this.advance();
    if (t.text === "return") {
      if (this.fnDepth === 0) this.fail("`return` can only be used inside a function", t.span);
      const ends =
        this.tok.newlineBefore ||
        this.is("}") ||
        this.is(";") ||
        this.is(",") ||
        this.is(")") ||
        this.tok.kind === "eof";
      const value = ends ? null : this.expression();
      return { kind: "Return", value, span: this.span(t.span) };
    }
    const value = this.expression();
    return { kind: "Throw", value, span: this.span(t.span) };
  }

  private loopBody(context: string): Block {
    this.loopDepth++;
    try {
      return this.block(context);
    } finally {
      this.loopDepth--;
    }
  }

  private enumDecl(): Stmt {
    const start = this.advance().span;
    const name = this.ident("an enum name").text;
    this.expect("{", "after the enum name");
    const variants: { name: string; fields: string[]; span: Span }[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const v = this.ident("a variant name");
      const fields: string[] = [];
      if (this.eat("(")) {
        while (!this.is(")")) {
          fields.push(this.ident("a field name").text);
          if (!this.eat(",")) break;
        }
        this.expect(")", "after the variant fields");
      }
      variants.push({ name: v.text, fields, span: this.span(v.span) });
      if (!this.eat(",") && !this.tok.newlineBefore && !this.is("}"))
        this.fail("expected `,` or a new line between variants");
    }
    this.expect("}", "to close the enum");
    if (variants.length === 0) this.fail("an enum needs at least one variant", start);
    return { kind: "Enum", name, variants, span: this.span(start) };
  }

  private fnNode(named: boolean): FnNode {
    const start = this.advance().span; // `fn`
    const name = named ? this.ident("a function name").text : null;
    this.expect("(", named ? "after the function name" : "after `fn`");
    const params: Param[] = [];
    const seen = new Set<string>();
    while (!this.is(")")) {
      const p = this.ident("a parameter name");
      if (seen.has(p.text)) this.fail(`duplicate parameter \`${p.text}\``, p.span);
      seen.add(p.text);
      params.push({ name: p.text, span: p.span });
      if (!this.eat(",")) break;
    }
    this.expect(")", "after the parameters");
    if (params.length > 255) this.fail("a function can have at most 255 parameters", start);
    const savedLoops = this.loopDepth;
    this.loopDepth = 0;
    this.fnDepth++;
    try {
      if (this.is("=>")) {
        const arrow = this.advance();
        const expr = this.expression();
        const body: Block = { stmts: [{ kind: "ExprStmt", expr, span: expr.span }], span: this.span(arrow.span) };
        return { name, params, body, arrow: true, span: this.span(start) };
      }
      const body = this.block(named ? "for the function body" : "or `=>` after the parameters");
      return { name, params, body, arrow: false, span: this.span(start) };
    } finally {
      this.loopDepth = savedLoops;
      this.fnDepth--;
    }
  }

  // ---------------------------------------------------------- expressions
  expression(): Expr {
    return this.assignment();
  }

  private assignment(): Expr {
    const left = this.binary(0);
    if (this.tok.kind === "op" && ASSIGN_OPS.has(this.tok.text) && !this.tok.newlineBefore) {
      const opTok = this.advance();
      if (left.kind !== "Ident" && left.kind !== "Index" && left.kind !== "Member") {
        this.fail(
          "cannot assign to this expression",
          left.span,
          "only variables, `list[i]` and `map.key` can be assigned",
        );
      }
      const value = this.assignment();
      return {
        kind: "Assign",
        target: left as AssignTarget,
        op: opTok.text as "=",
        value,
        span: this.span(left.span, value.span),
      };
    }
    return left;
  }

  private continues(t: Token): boolean {
    // a line break ends the expression, except before `.` and `|>`
    return !t.newlineBefore || t.text === "|>" || t.text === "??";
  }

  private binary(minPower: number): Expr {
    let left = this.unary(minPower);
    for (;;) {
      const t = this.tok;
      if (!(t.kind === "op" || t.kind === "keyword")) break;
      const power = INFIX[t.text];
      if (power === undefined || power <= minPower || !this.continues(t)) break;
      this.advance();
      if (t.text === "|>") {
        const target = this.binary(power);
        left = this.pipe(left, target);
        continue;
      }
      // `**` is right-associative, the rest are left-associative
      const right = this.binary(t.text === "**" ? power - 1 : power);
      const span = this.span(left.span, right.span);
      if (t.text === "and" || t.text === "or" || t.text === "??") {
        left = { kind: "Logical", op: t.text, left, right, span };
      } else if (t.text === ".." || t.text === "..=") {
        left = { kind: "Range", low: left, high: right, inclusive: t.text === "..=", span };
      } else {
        if (COMPARISON.has(t.text) && left.kind === "Binary" && COMPARISON.has(left.op)) {
          this.fail("comparisons cannot be chained", span, "write `a < b and b < c`");
        }
        left = { kind: "Binary", op: t.text as "+", left, right, span };
      }
    }
    return left;
  }

  /** `x |> f(a)` becomes `f(x, a)`, `x |> f` becomes `f(x)`. */
  private pipe(value: Expr, target: Expr): Expr {
    const span = this.span(value.span, target.span);
    if (target.kind === "Call") return { kind: "Call", callee: target.callee, args: [value, ...target.args], span };
    if (target.kind === "Invoke")
      return {
        kind: "Invoke",
        object: target.object,
        name: target.name,
        args: [value, ...target.args],
        span,
        nameSpan: target.nameSpan,
      };
    return { kind: "Call", callee: target, args: [value], span };
  }

  private unary(minPower: number): Expr {
    const t = this.tok;
    if (this.is("-")) {
      this.advance();
      // unary minus binds looser than `**`: -2 ** 2 == -4
      const operand = this.binary(11);
      return { kind: "Unary", op: "-", operand, span: this.span(t.span, operand.span) };
    }
    if (this.is("not")) {
      this.advance();
      const operand = this.binary(Math.max(minPower, 6));
      return { kind: "Unary", op: "not", operand, span: this.span(t.span, operand.span) };
    }
    return this.postfix(this.primary());
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      const t = this.tok;
      if (this.is("(") && !t.newlineBefore) {
        this.advance();
        const args = this.args(")");
        expr = { kind: "Call", callee: expr, args, span: this.span(expr.span) };
      } else if (this.is("[") && !t.newlineBefore) {
        this.advance();
        const index = this.expression();
        this.expect("]", "after the index");
        expr = { kind: "Index", object: expr, index, span: this.span(expr.span) };
      } else if (this.is(".")) {
        this.advance();
        const name = this.ident("a field or method name after `.`");
        if (this.is("(") && !this.tok.newlineBefore) {
          this.advance();
          const args = this.args(")");
          expr = {
            kind: "Invoke",
            object: expr,
            name: name.text,
            args,
            span: this.span(expr.span),
            nameSpan: name.span,
          };
        } else {
          expr = { kind: "Member", object: expr, name: name.text, span: this.span(expr.span) };
        }
      } else return expr;
    }
  }

  private args(close: string): Expr[] {
    const args: Expr[] = [];
    while (!this.is(close)) {
      args.push(this.expression());
      if (!this.eat(",")) break;
    }
    this.expect(close, "to close the argument list");
    if (args.length > 255) this.fail("a call can pass at most 255 arguments");
    return args;
  }

  private primary(): Expr {
    const t = this.tok;
    switch (t.kind) {
      case "number":
        this.advance();
        return { kind: "Number", value: t.value ?? 0, span: t.span };
      case "string":
        this.advance();
        return this.stringExpr(t);
      case "ident":
        this.advance();
        return { kind: "Ident", name: t.text, span: t.span };
      case "keyword":
        switch (t.text) {
          case "true":
          case "false":
            this.advance();
            return { kind: "Bool", value: t.text === "true", span: t.span };
          case "nil":
            this.advance();
            return { kind: "Nil", span: t.span };
          case "fn": {
            const fn = this.fnNode(false);
            return { kind: "Fn", fn, span: fn.span };
          }
          case "if":
            return this.ifExpr();
          case "match":
            return this.matchExpr();
          case "try":
            return this.tryExpr();
          case "return":
          case "throw": {
            const stmt = this.controlStatement();
            return { kind: "Control", stmt, span: stmt.span };
          }
        }
        break;
      case "op":
        if (t.text === "(") {
          this.advance();
          const inner = this.expression();
          this.expect(")", "to close the parenthesis");
          return inner;
        }
        if (t.text === "[") {
          this.advance();
          const items: Expr[] = [];
          while (!this.is("]")) {
            items.push(this.expression());
            if (!this.eat(",")) break;
          }
          this.expect("]", "to close the list");
          return { kind: "List", items, span: this.span(t.span) };
        }
        if (t.text === "{") {
          if (this.looksLikeMap(true)) return this.mapLiteral();
          const block = this.block("for the block");
          return { kind: "BlockExpr", block, span: block.span };
        }
        break;
    }
    return this.fail(`expected an expression, found ${this.describe(t)}`);
  }

  private stringExpr(t: Token): Expr {
    if (!t.parts) return { kind: "String", parts: [t.text], span: t.span };
    const parts: (string | Expr)[] = [];
    for (const part of t.parts) {
      if ("text" in part) {
        parts.push(part.text);
        continue;
      }
      const inner = new Parser(this.file, part.tokens);
      inner.fnDepth = this.fnDepth;
      inner.loopDepth = this.loopDepth;
      try {
        const expr = inner.expression();
        if (inner.tok.kind !== "eof") inner.fail(`unexpected ${inner.describe(inner.tok)} in string interpolation`);
        parts.push(expr);
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
      }
      this.diagnostics.push(...inner.diagnostics);
    }
    return { kind: "String", parts, span: t.span };
  }

  private mapLiteral(): Expr {
    const open = this.advance();
    const entries: { key: string; value: Expr; span: Span }[] = [];
    while (!this.is("}")) {
      const k = this.tok;
      let key: string;
      if (k.kind === "ident" || k.kind === "keyword") key = this.advance().text;
      else if (k.kind === "string" && !k.parts) key = this.advance().text;
      else
        return this.fail(
          `expected a key in the map literal, found ${this.describe(k)}`,
          k.span,
          'keys are names or plain strings: {name: 1, "two words": 2}',
        );
      if (this.eat(":")) {
        const value = this.expression();
        entries.push({ key, value, span: this.span(k.span, value.span) });
      } else {
        if (k.kind !== "ident") this.fail("expected `:` after the key", this.tok.span);
        entries.push({ key, value: { kind: "Ident", name: key, span: k.span }, span: k.span }); // {name} shorthand
      }
      if (!this.eat(",")) break;
    }
    this.expect("}", "to close the map");
    return { kind: "Map", entries, span: this.span(open.span) };
  }

  private ifExpr(): Expr {
    const start = this.advance().span;
    const cond = this.expression();
    const then = this.block("after the `if` condition");
    let otherwise: Block | null = null;
    if (this.is("else")) {
      this.advance();
      if (this.is("if")) {
        const nested = this.ifExpr();
        otherwise = { stmts: [{ kind: "ExprStmt", expr: nested, span: nested.span }], span: nested.span };
      } else otherwise = this.block("after `else`");
    }
    return { kind: "If", cond, then, otherwise, span: this.span(start) };
  }

  private tryExpr(): Expr {
    const start = this.advance().span;
    const body = this.block("after `try`");
    this.expect("catch", "after the `try` block");
    const name = this.tok.kind === "ident" ? this.advance().text : null;
    const handler = this.block("for the `catch` handler");
    return { kind: "Try", body, name, handler, span: this.span(start) };
  }

  private matchExpr(): Expr {
    const start = this.advance().span;
    const subject = this.expression();
    this.expect("{", "after the `match` subject");
    const arms: MatchArm[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const armStart = this.tok.span;
      const pattern = this.pattern();
      const guard = this.eat("if") ? this.expression() : null;
      this.expect("=>", "after the pattern");
      let body: Expr;
      if (this.is("break") || this.is("continue")) {
        const t = this.advance();
        if (this.loopDepth === 0) this.fail(`\`${t.text}\` can only be used inside a loop`, t.span);
        body = {
          kind: "Control",
          stmt: { kind: t.text === "break" ? "Break" : "Continue", span: t.span },
          span: t.span,
        };
      } else if (this.is("{")) {
        const block = this.block("for the match arm");
        body = { kind: "BlockExpr", block, span: block.span };
      } else body = this.expression();
      arms.push({ pattern, guard, body, span: this.span(armStart) });
      if (!this.eat(",") && !this.tok.newlineBefore && !this.is("}")) {
        this.fail("expected `,` or a new line between match arms");
      }
    }
    this.expect("}", "to close the `match`");
    if (arms.length === 0) this.fail("a `match` needs at least one arm", start);
    return { kind: "Match", subject, arms, span: this.span(start) };
  }

  // ------------------------------------------------------------- patterns
  pattern(): Pattern {
    const first = this.patternAtom();
    if (!this.is("|")) return first;
    const alternatives = [first];
    while (this.eat("|")) alternatives.push(this.patternAtom());
    const names = (p: Pattern): string => JSON.stringify(patternNames(p).sort());
    const expected = names(first);
    for (const alt of alternatives) {
      if (names(alt) !== expected) this.fail("every alternative in an `|` pattern must bind the same names", alt.span);
    }
    return { kind: "POr", alternatives, span: this.span(first.span) };
  }

  private literalNumber(): number {
    const negative = this.eat("-");
    const t = this.tok;
    if (t.kind !== "number") this.fail("expected a number in the pattern");
    this.advance();
    return negative ? -(t.value ?? 0) : (t.value ?? 0);
  }

  private patternAtom(): Pattern {
    const t = this.tok;
    if (t.kind === "number" || this.is("-")) {
      const low = this.literalNumber();
      if (this.is("..") || this.is("..=")) {
        const inclusive = this.advance().text === "..=";
        const high = this.literalNumber();
        return { kind: "PRange", low, high, inclusive, span: this.span(t.span) };
      }
      return { kind: "PLiteral", value: low, span: this.span(t.span) };
    }
    if (t.kind === "string") {
      if (t.parts) this.fail("patterns cannot contain string interpolation", t.span);
      this.advance();
      return { kind: "PLiteral", value: t.text, span: t.span };
    }
    if (t.kind === "keyword" && (t.text === "true" || t.text === "false" || t.text === "nil")) {
      this.advance();
      return { kind: "PLiteral", value: t.text === "nil" ? null : t.text === "true", span: t.span };
    }
    if (t.kind === "ident") {
      this.advance();
      if (t.text === "_") return { kind: "PWildcard", span: t.span };
      const upper = t.text[0] === t.text[0]?.toUpperCase() && /^[A-Z]/.test(t.text);
      if (this.is("(") && !this.tok.newlineBefore) {
        this.advance();
        const args: Pattern[] = [];
        while (!this.is(")")) {
          args.push(this.pattern());
          if (!this.eat(",")) break;
        }
        this.expect(")", "to close the variant pattern");
        return { kind: "PVariant", name: t.text, args, span: this.span(t.span) };
      }
      // A capitalised bare name is a variant without fields (None, Red). Lower-case names bind.
      if (upper) return { kind: "PVariant", name: t.text, args: [], span: t.span };
      return { kind: "PBind", name: t.text, span: t.span };
    }
    if (this.is("[")) {
      this.advance();
      const items: Pattern[] = [];
      let rest: { name: string | null; span: Span } | null = null;
      while (!this.is("]")) {
        if (this.is("..")) {
          const dots = this.advance();
          const name = this.tok.kind === "ident" ? this.advance().text : null;
          rest = { name: name === "_" ? null : name, span: this.span(dots.span) };
          this.eat(",");
          if (!this.is("]")) this.fail("`..rest` must be the last element of a list pattern");
          break;
        }
        items.push(this.pattern());
        if (!this.eat(",")) break;
      }
      this.expect("]", "to close the list pattern");
      return { kind: "PList", items, rest, span: this.span(t.span) };
    }
    if (this.is("{")) {
      this.advance();
      const entries: { key: string; pattern: Pattern; span: Span }[] = [];
      while (!this.is("}")) {
        const k = this.tok;
        if (k.kind !== "ident" && !(k.kind === "string" && !k.parts)) this.fail("expected a key in the map pattern");
        this.advance();
        const pattern: Pattern = this.eat(":") ? this.pattern() : { kind: "PBind", name: k.text, span: k.span };
        if (pattern.kind === "PBind" && k.kind === "string" && pattern.span === k.span) {
          this.fail('a quoted key needs an explicit pattern: {"key": name}', k.span);
        }
        entries.push({ key: k.text, pattern, span: this.span(k.span) });
        if (!this.eat(",")) break;
      }
      this.expect("}", "to close the map pattern");
      return { kind: "PMap", entries, span: this.span(t.span) };
    }
    if (t.kind === "keyword") {
      return this.fail(
        `\`${t.text}\` is a reserved word and cannot be used as a name`,
        t.span,
        `try \`${t.text}_\` instead`,
      );
    }
    return this.fail(
      `expected a pattern, found ${this.describe(t)}`,
      t.span,
      'patterns look like: 42, "text", name, _, [first, ..rest], {name}, Some(x), 1..=9',
    );
  }
}

function patternNames(p: Pattern): string[] {
  switch (p.kind) {
    case "PBind":
      return [p.name];
    case "PList":
      return [...p.items.flatMap(patternNames), ...(p.rest?.name ? [p.rest.name] : [])];
    case "PMap":
      return p.entries.flatMap((e) => patternNames(e.pattern));
    case "PVariant":
      return p.args.flatMap(patternNames);
    case "POr":
      return p.alternatives[0] ? patternNames(p.alternatives[0]) : [];
    default:
      return [];
  }
}
