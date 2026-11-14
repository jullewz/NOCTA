/**
 * Compiler: AST to bytecode.
 *
 * - Locals live in stack slots, resolved at compile time. Captured locals
 *   become upvalues (closures work like Lua's).
 * - Top-level names are globals. Every name is checked at compile time, so
 *   a typo is reported with a "did you mean" hint before the program runs.
 * - `let` bindings are immutable, `var` bindings are mutable.
 * - Blocks, `if`, `match` and `try` are expressions with a value.
 * - Patterns compile in two phases: tests that never leave values on the
 *   stack (so failing is a plain jump), then bindings.
 */

import { Chunk, FnProto, Op } from "../runtime/bytecode.js";
import type { Block, Expr, FnNode, Pattern, Program, Stmt } from "./ast.js";
import { patternBindings } from "./ast.js";
import { closest, type Diagnostic, type SourceFile, type Span } from "./source.js";

export interface VariantInfo {
  enumName: string;
  tag: string;
  fields: string[];
}

/** State that survives between compilations (the REPL compiles one input at a time). */
export interface CompilerEnv {
  /** Global name to mutability. */
  globals: Map<string, { mutable: boolean }>;
  variants: Map<string, VariantInfo>;
}

export function newEnv(builtins: Iterable<string>): CompilerEnv {
  const globals = new Map<string, { mutable: boolean }>();
  for (const name of builtins) globals.set(name, { mutable: false });
  const variants = new Map<string, VariantInfo>([
    ["Some", { enumName: "Option", tag: "Some", fields: ["value"] }],
    ["None", { enumName: "Option", tag: "None", fields: [] }],
    ["Ok", { enumName: "Result", tag: "Ok", fields: ["value"] }],
    ["Err", { enumName: "Result", tag: "Err", fields: ["error"] }],
  ]);
  return { globals, variants };
}

export interface CompiledTest {
  name: string;
  proto: FnProto;
  span: Span;
}

export interface CompileResult {
  script: FnProto;
  tests: CompiledTest[];
  diagnostics: Diagnostic[];
}

class CompileError extends Error {}

interface Local {
  name: string;
  /** Stack slot relative to the frame base. Not the same as the index in `locals`:
   *  temporaries of an enclosing expression can sit between two locals. */
  slot: number;
  depth: number;
  mutable: boolean;
  captured: boolean;
  used: boolean;
  span: Span;
  /** Warn when unused. Off for parameters and hidden temporaries. */
  warn: boolean;
}

interface Loop {
  start: number;
  breaks: number[];
  continues: number[];
  /** Stack depth at the top of each iteration. */
  depth: number;
  tryDepth: number;
  /** -1 means `continue` jumps to `start`; otherwise it is patched later. */
  continueTarget: number;
}

type Step =
  | { kind: "index"; i: number }
  | { kind: "key"; key: string }
  | { kind: "field"; i: number }
  | { kind: "slice"; from: number };

/** How each instruction changes the stack height. */
function stackEffect(op: Op, operands: number[]): number {
  const n = operands[0] ?? 0;
  switch (op) {
    case Op.Const:
    case Op.Nil:
    case Op.True:
    case Op.False:
    case Op.Dup:
    case Op.GetLocal:
    case Op.GetUpvalue:
    case Op.GetGlobal:
    case Op.Closure:
    case Op.IterNext:
      return 1;
    case Op.DupTwo:
      return 2;
    case Op.Pop:
    case Op.DefineGlobal:
    case Op.PopJumpIfFalse:
    case Op.CloseUpvalue:
    case Op.IndexGet:
    case Op.MemberSet:
    case Op.Range:
    case Op.Throw:
    case Op.Return:
    case Op.Add:
    case Op.Sub:
    case Op.Mul:
    case Op.Div:
    case Op.Mod:
    case Op.Pow:
    case Op.Eq:
    case Op.Ne:
    case Op.Lt:
    case Op.Le:
    case Op.Gt:
    case Op.Ge:
      return -1;
    case Op.IndexSet:
    case Op.MatchRange:
      return -2;
    case Op.Collapse:
      return -n;
    case Op.Call:
      return -n;
    case Op.Invoke:
      return -(operands[1] ?? 0);
    case Op.List:
    case Op.Concat:
      return 1 - n;
    case Op.Map:
      return 1 - 2 * n;
    default:
      return 0; // Swap, Set*, Neg, Not, jumps, MemberGet, IterInit, matching tests, Try*, MatchFail
  }
}

class FnCompiler {
  readonly locals: Local[] = [];
  readonly loops: Loop[] = [];
  scopeDepth = 0;
  tryDepth = 0;
  /** Values on this function's stack at the current point of the code (slot 0 holds the function). */
  depth = 1;

  constructor(
    readonly proto: FnProto,
    readonly enclosing: FnCompiler | null,
  ) {}

  get chunk(): Chunk {
    return this.proto.chunk;
  }
}

export class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  private fn!: FnCompiler;
  private readonly tests: CompiledTest[] = [];

  constructor(
    private readonly file: SourceFile,
    private readonly env: CompilerEnv,
  ) {}

  // ------------------------------------------------------------ entry
  compile(program: Program, options: { returnLast?: boolean } = {}): CompileResult {
    const proto = new FnProto("<script>", 0, this.file.name, program.span);
    this.fn = new FnCompiler(proto, null);
    this.fn.locals.push(this.local("", program.span, false));
    // Hoist top-level declarations so functions can call each other in any order.
    for (const stmt of program.stmts) {
      if (stmt.kind === "FnDecl" && stmt.fn.name) this.declareGlobal(stmt.fn.name, false, stmt.span, true);
      if (stmt.kind === "Enum") {
        this.declareEnum(stmt);
        for (const v of stmt.variants) this.declareGlobal(v.name, false, v.span, true);
        this.declareGlobal(stmt.name, false, stmt.span, true);
      }
    }
    program.stmts.forEach((stmt, i) => {
      try {
        // The REPL shows the value of the last expression.
        if (options.returnLast && i === program.stmts.length - 1 && stmt.kind === "ExprStmt") {
          this.expression(stmt.expr);
          this.emit(Op.Return, stmt.span);
          return;
        }
        this.statement(stmt);
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
      }
    });
    this.emit(Op.Nil, program.span);
    this.emit(Op.Return, program.span);
    return { script: proto, tests: this.tests, diagnostics: this.diagnostics };
  }

  // ----------------------------------------------------------- helpers
  private error(message: string, span: Span, hint?: string, code = "compile"): never {
    this.diagnostics.push({ severity: "error", code, message, span, file: this.file, ...(hint ? { hint } : {}) });
    throw new CompileError(message);
  }

  private warn(message: string, span: Span, code: string, hint?: string): void {
    this.diagnostics.push({ severity: "warning", code, message, span, file: this.file, ...(hint ? { hint } : {}) });
  }

  private emit(op: Op, span: Span, ...operands: number[]): number {
    const at = this.fn.chunk.emit(op, span);
    for (const operand of operands) this.fn.chunk.emit(operand, span);
    this.fn.depth += stackEffect(op, operands);
    return at;
  }

  private constant(value: Parameters<Chunk["constant"]>[0]): number {
    return this.fn.chunk.constant(value);
  }

  private emitJump(op: Op, span: Span): number {
    this.emit(op, span, 0xffff);
    return this.fn.chunk.code.length - 1;
  }

  private patch(at: number): void {
    this.fn.chunk.code[at] = this.fn.chunk.code.length;
  }

  private local(name: string, span: Span, mutable: boolean, warn = false, slot = 0): Local {
    return { name, slot, depth: this.fn ? this.fn.scopeDepth : 0, mutable, captured: false, used: false, span, warn };
  }

  private get isGlobalScope(): boolean {
    return this.fn.enclosing === null && this.fn.scopeDepth === 0;
  }

  private declareGlobal(name: string, mutable: boolean, span: Span, hoisted = false): void {
    const existing = this.env.globals.get(name);
    if (existing && !hoisted && BUILTIN_GUARD.has(name)) {
      this.error(
        `\`${name}\` is a built-in function and cannot be redefined`,
        span,
        `choose another name, like \`my_${name}\``,
      );
    }
    this.env.globals.set(name, { mutable });
  }

  private declareLocal(name: string, span: Span, mutable: boolean, warn = true): number {
    const fn = this.fn;
    for (let i = fn.locals.length - 1; i >= 0; i--) {
      const l = fn.locals[i] as Local;
      if (l.depth < fn.scopeDepth) break;
      if (l.name === name && name !== "" && !name.startsWith("(")) {
        this.error(
          `\`${name}\` is already declared in this scope`,
          span,
          "use a different name, or assign with `=` if it is a `var`",
        );
      }
    }
    if (fn.locals.length >= 250) this.error("too many local variables in one function (the limit is 250)", span);
    // the value for this local is the one on top of the stack
    const local = this.local(name, span, mutable, warn && !name.startsWith("_") && !name.startsWith("("), fn.depth - 1);
    local.depth = fn.scopeDepth;
    fn.locals.push(local);
    fn.proto.maxLocals = Math.max(fn.proto.maxLocals, local.slot + 1);
    return local.slot;
  }

  /** Bind the value on top of the stack to `name`: a new local, or a global at the top level. */
  private bind(name: string, span: Span, mutable: boolean): void {
    if (this.isGlobalScope) {
      this.declareGlobal(name, mutable, span);
      this.emit(Op.DefineGlobal, span, this.constant(name));
    } else {
      this.declareLocal(name, span, mutable);
    }
  }

  private beginScope(): void {
    this.fn.scopeDepth++;
  }

  /** Close the scope. With `keepValue`, the value on top of the stack survives. */
  private endScope(span: Span, keepValue: boolean): void {
    const fn = this.fn;
    fn.scopeDepth--;
    let count = 0;
    while (fn.locals.length > 0 && (fn.locals[fn.locals.length - 1] as Local).depth > fn.scopeDepth) {
      const l = fn.locals.pop() as Local;
      if (l.warn && !l.used)
        this.warn(
          `unused variable \`${l.name}\``,
          l.span,
          "unused-variable",
          `prefix it with an underscore (\`_${l.name}\`) if this is intended`,
        );
      count++;
      if (!keepValue) this.emit(l.captured ? Op.CloseUpvalue : Op.Pop, span);
    }
    if (keepValue && count > 0) this.emit(Op.Collapse, span, count);
  }

  /** Pop everything above stack depth `target` (locals and temporaries) without forgetting the locals. */
  private discardTo(target: number, span: Span): void {
    const saved = this.fn.depth;
    for (let slot = saved - 1; slot >= target; slot--) {
      const local = this.fn.locals.find((l) => l.slot === slot && l.depth > 0);
      this.emit(local?.captured ? Op.CloseUpvalue : Op.Pop, span);
    }
    this.fn.depth = saved; // the code after a jump is unreachable; keep the bookkeeping of the fall-through path
  }

  // --------------------------------------------------------- resolution
  private resolveLocal(fn: FnCompiler, name: string): number {
    for (let i = fn.locals.length - 1; i >= 0; i--) if ((fn.locals[i] as Local).name === name) return i;
    return -1;
  }

  private resolveUpvalue(fn: FnCompiler, name: string): number {
    if (!fn.enclosing) return -1;
    const local = this.resolveLocal(fn.enclosing, name);
    if (local >= 0) {
      const l = fn.enclosing.locals[local] as Local;
      l.captured = true;
      l.used = true;
      return this.addUpvalue(fn, true, l.slot, name);
    }
    const up = this.resolveUpvalue(fn.enclosing, name);
    return up >= 0 ? this.addUpvalue(fn, false, up, name) : -1;
  }

  private addUpvalue(fn: FnCompiler, isLocal: boolean, index: number, name: string): number {
    const existing = fn.proto.upvalues.findIndex((u) => u.isLocal === isLocal && u.index === index);
    if (existing >= 0) return existing;
    fn.proto.upvalues.push({ isLocal, index, name });
    return fn.proto.upvalues.length - 1;
  }

  /** Find the mutability of a local or upvalue binding. */
  private upvalueMutable(fn: FnCompiler, name: string): boolean {
    for (let f: FnCompiler | null = fn.enclosing; f; f = f.enclosing) {
      const i = this.resolveLocal(f, name);
      if (i >= 0) return (f.locals[i] as Local).mutable;
    }
    return false;
  }

  private visibleNames(): string[] {
    const names = new Set<string>();
    for (let f: FnCompiler | null = this.fn; f; f = f.enclosing)
      for (const l of f.locals) if (l.name && !l.name.startsWith("(")) names.add(l.name);
    for (const g of this.env.globals.keys()) if (!g.startsWith("__")) names.add(g);
    return [...names];
  }

  private unknown(name: string, span: Span): never {
    const suggestion = closest(name, this.visibleNames());
    return this.error(
      `\`${name}\` is not defined`,
      span,
      suggestion ? `did you mean \`${suggestion}\`?` : undefined,
      "undefined-name",
    );
  }

  private variable(name: string, span: Span): void {
    const slot = this.resolveLocal(this.fn, name);
    if (slot >= 0) {
      const l = this.fn.locals[slot] as Local;
      l.used = true;
      this.emit(Op.GetLocal, span, l.slot);
      return;
    }
    const up = this.resolveUpvalue(this.fn, name);
    if (up >= 0) {
      this.emit(Op.GetUpvalue, span, up);
      return;
    }
    if (!this.env.globals.has(name)) this.unknown(name, span);
    this.emit(Op.GetGlobal, span, this.constant(name));
  }

  private assignVariable(name: string, span: Span): void {
    const slot = this.resolveLocal(this.fn, name);
    const immutable = (where: string): never =>
      this.error(
        `cannot assign to \`${name}\`: it was declared with \`let\`${where}`,
        span,
        `declare it with \`var ${name}\` to make it mutable`,
        "immutable",
      );
    if (slot >= 0) {
      const l = this.fn.locals[slot] as Local;
      if (!l.mutable) immutable("");
      this.emit(Op.SetLocal, span, l.slot);
      return;
    }
    const up = this.resolveUpvalue(this.fn, name);
    if (up >= 0) {
      if (!this.upvalueMutable(this.fn, name)) immutable(" in an enclosing function");
      this.emit(Op.SetUpvalue, span, up);
      return;
    }
    const g = this.env.globals.get(name);
    if (!g) this.unknown(name, span);
    if (!g.mutable) immutable("");
    this.emit(Op.SetGlobal, span, this.constant(name));
  }

  // --------------------------------------------------------- statements
  private statement(stmt: Stmt): void {
    switch (stmt.kind) {
      case "Let": {
        if (stmt.pattern.kind === "PBind") {
          // a function value gets the variable's name, for nicer traces
          this.expression(stmt.value, stmt.value.kind === "Fn" ? stmt.pattern.name : undefined);
          this.bind(stmt.pattern.name, stmt.pattern.span, stmt.mutable);
        } else if (stmt.pattern.kind === "PWildcard") {
          this.expression(stmt.value);
          this.emit(Op.Pop, stmt.span);
        } else {
          this.destructure(stmt.pattern, stmt.value, stmt.mutable, stmt.span);
        }
        return;
      }
      case "FnDecl": {
        const name = stmt.fn.name ?? "<fn>";
        if (this.isGlobalScope) {
          this.function(stmt.fn, name);
          this.emit(Op.DefineGlobal, stmt.span, this.constant(name));
        } else {
          // reserve the slot first so the function can call itself
          this.emit(Op.Nil, stmt.span);
          this.declareLocal(name, stmt.span, false);
          const local = this.fn.locals[this.fn.locals.length - 1] as Local;
          local.used = true;
          this.function(stmt.fn, name);
          this.emit(Op.SetLocal, stmt.span, local.slot);
          this.emit(Op.Pop, stmt.span);
        }
        return;
      }
      case "Enum":
        this.enumDecl(stmt);
        return;
      case "ExprStmt":
        this.expression(stmt.expr);
        this.emit(Op.Pop, stmt.span);
        return;
      case "While":
        this.whileLoop(stmt);
        return;
      case "For":
        this.forLoop(stmt);
        return;
      case "Break":
      case "Continue": {
        const loop = this.fn.loops[this.fn.loops.length - 1];
        if (!loop) this.error(`\`${stmt.kind.toLowerCase()}\` outside of a loop`, stmt.span);
        for (let i = loop.tryDepth; i < this.fn.tryDepth; i++) this.emit(Op.TryEnd, stmt.span);
        this.discardTo(loop.depth, stmt.span);
        if (stmt.kind === "Break") loop.breaks.push(this.emitJump(Op.Jump, stmt.span));
        else if (loop.continueTarget < 0) this.emit(Op.Jump, stmt.span, loop.start);
        else loop.continues.push(this.emitJump(Op.Jump, stmt.span));
        return;
      }
      case "Return": {
        const before = this.fn.depth;
        if (stmt.value) this.expression(stmt.value);
        else this.emit(Op.Nil, stmt.span);
        this.emit(Op.Return, stmt.span);
        this.fn.depth = before;
        return;
      }
      case "Throw": {
        const before = this.fn.depth;
        this.expression(stmt.value);
        this.emit(Op.Throw, stmt.span);
        this.fn.depth = before;
        return;
      }
      case "Test": {
        const saved = this.fn;
        const proto = new FnProto(`test "${stmt.name}"`, 0, this.file.name, stmt.span);
        this.fn = new FnCompiler(proto, saved);
        this.fn.locals.push(this.local("", stmt.span, false));
        try {
          this.block(stmt.body, true);
          this.emit(Op.Return, stmt.span);
        } finally {
          this.fn = saved;
        }
        if (proto.upvalues.length > 0) this.error("tests cannot capture local variables", stmt.span);
        this.tests.push({ name: stmt.name, proto, span: stmt.span });
        return;
      }
      case "Import": {
        if (!this.isGlobalScope) this.error("`import` must be at the top level", stmt.span);
        this.emit(Op.GetGlobal, stmt.span, this.constant("__import"));
        this.emit(Op.Const, stmt.span, this.constant(stmt.path));
        this.emit(Op.Call, stmt.span, 1);
        this.bind(stmt.alias, stmt.span, false);
        return;
      }
    }
  }

  private declareEnum(stmt: Extract<Stmt, { kind: "Enum" }>): void {
    for (const v of stmt.variants) {
      const prior = this.env.variants.get(v.name);
      if (prior && prior.enumName !== stmt.name && ["Option", "Result"].includes(prior.enumName)) {
        this.error(`\`${v.name}\` is a built-in variant of ${prior.enumName}`, v.span, "choose another variant name");
      }
      this.env.variants.set(v.name, { enumName: stmt.name, tag: v.name, fields: v.fields });
    }
  }

  private enumDecl(stmt: Extract<Stmt, { kind: "Enum" }>): void {
    this.declareEnum(stmt);
    // Each variant becomes a binding: a value for plain variants, a constructor for variants with fields.
    // The enum name is bound to a map of its variants, so `Shape.Circle(2)` works too.
    for (const v of stmt.variants) {
      this.emit(Op.GetGlobal, v.span, this.constant("__variant"));
      this.emit(Op.Const, v.span, this.constant(stmt.name));
      this.emit(Op.Const, v.span, this.constant(v.name));
      for (const f of v.fields) this.emit(Op.Const, v.span, this.constant(f));
      this.emit(Op.List, v.span, v.fields.length);
      this.emit(Op.Call, v.span, 3);
      this.bind(v.name, v.span, false);
      if (!this.isGlobalScope) (this.fn.locals[this.fn.locals.length - 1] as Local).warn = false;
    }
    for (const v of stmt.variants) {
      this.emit(Op.Const, v.span, this.constant(v.name));
      this.variable(v.name, v.span);
    }
    this.emit(Op.Map, stmt.span, stmt.variants.length);
    this.bind(stmt.name, stmt.span, false);
    if (!this.isGlobalScope) (this.fn.locals[this.fn.locals.length - 1] as Local).warn = false;
  }

  private whileLoop(stmt: Extract<Stmt, { kind: "While" }>): void {
    const start = this.fn.chunk.code.length;
    const loop: Loop = {
      start,
      breaks: [],
      continues: [],
      depth: this.fn.depth,
      tryDepth: this.fn.tryDepth,
      continueTarget: -1,
    };
    this.expression(stmt.cond);
    const exit = this.emitJump(Op.PopJumpIfFalse, stmt.span);
    this.fn.loops.push(loop);
    this.block(stmt.body, false);
    this.fn.loops.pop();
    this.emit(Op.Jump, stmt.span, start);
    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
  }

  private forLoop(stmt: Extract<Stmt, { kind: "For" }>): void {
    this.beginScope();
    this.expression(stmt.iterable);
    this.emit(Op.IterInit, stmt.iterable.span);
    this.declareLocal("(iter)", stmt.iterable.span, false, false);
    const start = this.fn.chunk.code.length;
    const loop: Loop = {
      start,
      breaks: [],
      continues: [],
      depth: this.fn.depth,
      tryDepth: this.fn.tryDepth,
      continueTarget: -1,
    };
    const exit = this.emitJump(Op.IterNext, stmt.span);
    this.beginScope();
    if (stmt.pattern.kind === "PBind") this.declareLocal(stmt.pattern.name, stmt.pattern.span, false);
    else if (stmt.pattern.kind === "PWildcard") this.declareLocal("(item)", stmt.pattern.span, false, false);
    else {
      this.declareLocal("(item)", stmt.pattern.span, false, false);
      this.bindPattern(stmt.pattern, this.fn.locals.length - 1, "the loop item does not match the pattern", false);
    }
    this.fn.loops.push(loop);
    this.block(stmt.body, false);
    this.fn.loops.pop();
    this.endScope(stmt.span, false);
    this.emit(Op.Jump, stmt.span, start);
    this.patch(exit);
    this.fn.depth = loop.depth; // IterNext pushes nothing when it exits
    for (const b of loop.breaks) this.patch(b);
    this.endScope(stmt.span, false);
  }

  /** `let [a, b] = value`: match or throw, then bind. */
  private destructure(pattern: Pattern, value: Expr, mutable: boolean, span: Span): void {
    if (this.isGlobalScope) {
      // evaluate into a temporary scope, then copy bindings into globals
      this.beginScope();
      this.expression(value);
      const slot = this.declareLocal("(value)", span, false, false);
      this.patternTest(pattern, slot, span, "the value does not match the pattern");
      for (const b of patternBindings(pattern)) {
        this.emitPath(slot, this.pathTo(pattern, b.name) ?? [], b.span);
        this.declareGlobal(b.name, mutable, b.span);
        this.emit(Op.DefineGlobal, b.span, this.constant(b.name));
      }
      this.endScope(span, false);
      return;
    }
    this.expression(value);
    const slot = this.declareLocal("(value)", span, false, false);
    this.bindPattern(pattern, slot, "the value does not match the pattern", mutable);
  }

  /** Test a pattern against the local in `slot`; throw on failure; bind its names as locals. */
  private bindPattern(pattern: Pattern, slot: number, message: string, mutable: boolean): void {
    this.patternTest(pattern, slot, pattern.span, message);
    for (const b of patternBindings(pattern)) {
      this.emitPath(slot, this.pathTo(pattern, b.name) ?? [], b.span);
      this.declareLocal(b.name, b.span, mutable);
    }
  }

  private patternTest(pattern: Pattern, slot: number, span: Span, message: string): void {
    const fails: number[] = [];
    this.test(pattern, slot, [], fails);
    if (fails.length === 0) return;
    const ok = this.emitJump(Op.Jump, span);
    for (const f of fails) this.patch(f);
    const depth = this.fn.depth;
    this.emit(Op.Const, span, this.constant(message));
    this.emit(Op.Throw, span);
    this.fn.depth = depth;
    this.patch(ok);
  }

  // --------------------------------------------------------- functions
  private function(node: FnNode, name: string): void {
    const saved = this.fn;
    const proto = new FnProto(name, node.params.length, this.file.name, node.span);
    this.fn = new FnCompiler(proto, saved);
    this.fn.locals.push(this.local("", node.span, false));
    this.beginScope();
    for (const p of node.params) {
      this.fn.depth++; // the caller pushed the argument
      this.declareLocal(p.name, p.span, false, false);
    }
    try {
      this.block(node.body, true);
      this.emit(Op.Return, node.span);
    } finally {
      this.fn = saved;
    }
    this.emit(Op.Closure, node.span, this.constant(proto as never));
    for (const u of proto.upvalues) {
      this.fn.chunk.emit(u.isLocal ? 1 : 0, node.span);
      this.fn.chunk.emit(u.index, node.span);
    }
  }

  /** Compile a block in its own scope. With `wantValue`, leaves the value of its last expression. */
  private block(block: Block, wantValue: boolean): void {
    this.beginScope();
    const stmts = block.stmts;
    stmts.forEach((stmt, i) => {
      const last = i === stmts.length - 1;
      try {
        if (last && wantValue && stmt.kind === "ExprStmt") this.expression(stmt.expr);
        else {
          this.statement(stmt);
          if (last && wantValue) this.emit(Op.Nil, stmt.span);
        }
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        if (last && wantValue) this.emit(Op.Nil, stmt.span);
      }
      if (
        !last &&
        (stmt.kind === "Return" || stmt.kind === "Break" || stmt.kind === "Continue" || stmt.kind === "Throw")
      ) {
        const next = stmts[i + 1] as Stmt;
        this.warn("unreachable code", next.span, "unreachable", `it follows a \`${stmt.kind.toLowerCase()}\``);
      }
    });
    if (stmts.length === 0 && wantValue) this.emit(Op.Nil, block.span);
    this.endScope(block.span, wantValue);
  }

  // -------------------------------------------------------- expressions
  private expression(e: Expr, nameHint?: string): void {
    switch (e.kind) {
      case "Number":
        this.emit(Op.Const, e.span, this.constant(e.value));
        return;
      case "String": {
        if (e.parts.length === 1 && typeof e.parts[0] === "string") {
          this.emit(Op.Const, e.span, this.constant(e.parts[0]));
          return;
        }
        for (const part of e.parts) {
          if (typeof part === "string") this.emit(Op.Const, e.span, this.constant(part));
          else this.expression(part);
        }
        this.emit(Op.Concat, e.span, e.parts.length);
        return;
      }
      case "Bool":
        this.emit(e.value ? Op.True : Op.False, e.span);
        return;
      case "Nil":
        this.emit(Op.Nil, e.span);
        return;
      case "Ident":
        this.variable(e.name, e.span);
        return;
      case "List":
        if (e.items.length > 255)
          this.error("a list literal can have at most 255 items", e.span, "build it with push()");
        for (const item of e.items) this.expression(item);
        this.emit(Op.List, e.span, e.items.length);
        return;
      case "Map": {
        if (e.entries.length > 255) this.error("a map literal can have at most 255 entries", e.span);
        const seen = new Set<string>();
        for (const entry of e.entries) {
          if (seen.has(entry.key))
            this.warn(`duplicate key \`${entry.key}\`, the last one wins`, entry.span, "duplicate-key");
          seen.add(entry.key);
          this.emit(Op.Const, entry.span, this.constant(entry.key));
          this.expression(entry.value);
        }
        this.emit(Op.Map, e.span, e.entries.length);
        return;
      }
      case "Unary":
        this.expression(e.operand);
        this.emit(e.op === "-" ? Op.Neg : Op.Not, e.span);
        return;
      case "Binary": {
        this.expression(e.left);
        this.expression(e.right);
        const ops: Record<string, Op> = {
          "+": Op.Add,
          "-": Op.Sub,
          "*": Op.Mul,
          "/": Op.Div,
          "%": Op.Mod,
          "**": Op.Pow,
          "==": Op.Eq,
          "!=": Op.Ne,
          "<": Op.Lt,
          "<=": Op.Le,
          ">": Op.Gt,
          ">=": Op.Ge,
        };
        this.emit(ops[e.op] as Op, e.span);
        return;
      }
      case "Logical": {
        this.expression(e.left);
        const op = e.op === "and" ? Op.JumpIfFalse : e.op === "or" ? Op.JumpIfTrue : Op.JumpIfNotNil;
        const end = this.emitJump(op, e.span);
        this.emit(Op.Pop, e.span);
        this.expression(e.right);
        this.patch(end);
        return;
      }
      case "Range":
        this.expression(e.low);
        this.expression(e.high);
        this.emit(Op.Range, e.span, e.inclusive ? 1 : 0);
        return;
      case "Assign":
        this.assignment(e);
        return;
      case "Call": {
        this.expression(e.callee);
        for (const a of e.args) this.expression(a);
        this.emit(Op.Call, e.span, e.args.length);
        return;
      }
      case "Invoke": {
        this.expression(e.object);
        for (const a of e.args) this.expression(a);
        this.emit(Op.Invoke, e.nameSpan, this.constant(e.name), e.args.length);
        return;
      }
      case "Index":
        this.expression(e.object);
        this.expression(e.index);
        this.emit(Op.IndexGet, e.span);
        return;
      case "Member":
        this.expression(e.object);
        this.emit(Op.MemberGet, e.span, this.constant(e.name));
        return;
      case "Fn":
        this.function(e.fn, e.fn.name ?? nameHint ?? "<anonymous>");
        return;
      case "If": {
        this.expression(e.cond);
        const elseJump = this.emitJump(Op.PopJumpIfFalse, e.span);
        const branchDepth = this.fn.depth;
        this.block(e.then, true);
        const end = this.emitJump(Op.Jump, e.span);
        this.patch(elseJump);
        this.fn.depth = branchDepth;
        if (e.otherwise) this.block(e.otherwise, true);
        else this.emit(Op.Nil, e.span);
        this.patch(end);
        return;
      }
      case "BlockExpr":
        this.block(e.block, true);
        return;
      case "Match":
        this.match(e);
        return;
      case "Control": {
        const depth = this.fn.depth;
        this.statement(e.stmt);
        // never reached, but keeps the stack balanced for the surrounding expression
        this.fn.depth = depth;
        this.emit(Op.Nil, e.span);
        return;
      }
      case "Try": {
        const handler = this.emitJump(Op.TryBegin, e.span);
        const tryDepth = this.fn.depth;
        this.fn.tryDepth++;
        try {
          this.block(e.body, true);
        } finally {
          this.fn.tryDepth--;
        }
        this.emit(Op.TryEnd, e.span);
        const end = this.emitJump(Op.Jump, e.span);
        this.patch(handler);
        this.fn.depth = tryDepth + 1; // the VM restores the stack and pushes the error
        this.beginScope();
        if (e.name) this.declareLocal(e.name, e.span, false);
        else this.declareLocal("(error)", e.span, false, false);
        this.block(e.handler, true);
        this.endScope(e.span, true);
        this.patch(end);
        return;
      }
    }
  }

  private assignment(e: Extract<Expr, { kind: "Assign" }>): void {
    const arith: Record<string, Op> = { "+=": Op.Add, "-=": Op.Sub, "*=": Op.Mul, "/=": Op.Div };
    const t = e.target;
    if (t.kind === "Ident") {
      if (e.op !== "=") this.variable(t.name, t.span);
      this.expression(e.value);
      if (e.op !== "=") this.emit(arith[e.op] as Op, e.span);
      this.assignVariable(t.name, t.span);
      return;
    }
    if (t.kind === "Index") {
      this.expression(t.object);
      this.expression(t.index);
      if (e.op !== "=") {
        this.emit(Op.DupTwo, e.span);
        this.emit(Op.IndexGet, e.span);
      }
      this.expression(e.value);
      if (e.op !== "=") this.emit(arith[e.op] as Op, e.span);
      this.emit(Op.IndexSet, e.span);
      return;
    }
    this.expression(t.object);
    if (e.op !== "=") {
      this.emit(Op.Dup, e.span);
      this.emit(Op.MemberGet, e.span, this.constant(t.name));
    }
    this.expression(e.value);
    if (e.op !== "=") this.emit(arith[e.op] as Op, e.span);
    this.emit(Op.MemberSet, e.span, this.constant(t.name));
  }

  // ------------------------------------------------------------- match
  private match(e: Extract<Expr, { kind: "Match" }>): void {
    this.beginScope();
    this.expression(e.subject);
    const subject = this.declareLocal("(subject)", e.subject.span, false, false);
    const ends: number[] = [];
    // expand top-level or-patterns that bind names into separate arms
    const arms = e.arms.flatMap((arm) =>
      arm.pattern.kind === "POr" && patternBindings(arm.pattern).length > 0
        ? arm.pattern.alternatives.map((alt) => ({ ...arm, pattern: alt }))
        : [arm],
    );
    let exhaustive = false;
    const armDepth = this.fn.depth;
    arms.forEach((arm, index) => {
      if (exhaustive) {
        this.warn("this arm can never match: an earlier arm matches everything", arm.span, "unreachable");
        return;
      }
      this.fn.depth = armDepth;
      this.beginScope();
      const fails: number[] = [];
      this.test(arm.pattern, subject, [], fails);
      for (const b of patternBindings(arm.pattern)) {
        this.emitPath(subject, this.pathTo(arm.pattern, b.name) ?? [], b.span);
        this.declareLocal(b.name, b.span, false);
      }
      const bindings = patternBindings(arm.pattern).length;
      let guardFail = -1;
      if (arm.guard) {
        this.expression(arm.guard);
        guardFail = this.emitJump(Op.PopJumpIfFalse, arm.span);
      }
      this.expression(arm.body);
      this.endScope(arm.span, true);
      ends.push(this.emitJump(Op.Jump, arm.span));
      if (guardFail >= 0) {
        this.patch(guardFail);
        // the bindings are still on the stack: drop them before trying the next arm
        this.fn.depth = armDepth + bindings;
        for (let i = 0; i < bindings; i++) this.emit(Op.CloseUpvalue, arm.span);
      }
      for (const f of fails) this.patch(f);
      this.fn.depth = armDepth;
      if (fails.length === 0 && !arm.guard && index < arms.length) exhaustive = true;
    });
    if (!exhaustive) this.emit(Op.MatchFail, e.span);
    for (const end of ends) this.patch(end);
    this.fn.depth = armDepth + 1; // every arm leaves exactly one value
    this.endScope(e.span, true);
  }

  /** Path from the subject to the value bound to `name`. */
  private pathTo(p: Pattern, name: string, path: Step[] = []): Step[] | null {
    switch (p.kind) {
      case "PBind":
        return p.name === name ? path : null;
      case "PList": {
        for (let i = 0; i < p.items.length; i++) {
          const found = this.pathTo(p.items[i] as Pattern, name, [...path, { kind: "index", i }]);
          if (found) return found;
        }
        if (p.rest?.name === name) return [...path, { kind: "slice", from: p.items.length }];
        return null;
      }
      case "PMap":
        for (const entry of p.entries) {
          const found = this.pathTo(entry.pattern, name, [...path, { kind: "key", key: entry.key }]);
          if (found) return found;
        }
        return null;
      case "PVariant":
        for (let i = 0; i < p.args.length; i++) {
          const found = this.pathTo(p.args[i] as Pattern, name, [...path, { kind: "field", i }]);
          if (found) return found;
        }
        return null;
      case "POr":
        return p.alternatives[0] ? this.pathTo(p.alternatives[0], name, path) : null;
      default:
        return null;
    }
  }

  private emitPath(slot: number, path: Step[], span: Span): void {
    this.emit(Op.GetLocal, span, slot);
    for (const step of path) {
      if (step.kind === "index") {
        this.emit(Op.Const, span, this.constant(step.i));
        this.emit(Op.IndexGet, span);
      } else if (step.kind === "key") {
        this.emit(Op.Const, span, this.constant(step.key));
        this.emit(Op.IndexGet, span);
      } else if (step.kind === "field") this.emit(Op.Field, span, step.i);
      else this.emit(Op.ListSlice, span, step.from);
    }
  }

  /** Emit tests for `p`. Every failing check jumps (with a clean stack) to a jump in `fails`. */
  private test(p: Pattern, slot: number, path: Step[], fails: number[]): void {
    const check = (span: Span): void => {
      fails.push(this.emitJump(Op.PopJumpIfFalse, span));
    };
    switch (p.kind) {
      case "PWildcard":
      case "PBind":
        return;
      case "PLiteral":
        this.emitPath(slot, path, p.span);
        if (p.value === null) this.emit(Op.Nil, p.span);
        else if (p.value === true) this.emit(Op.True, p.span);
        else if (p.value === false) this.emit(Op.False, p.span);
        else this.emit(Op.Const, p.span, this.constant(p.value));
        this.emit(Op.Eq, p.span);
        check(p.span);
        return;
      case "PRange":
        this.emitPath(slot, path, p.span);
        this.emit(Op.Const, p.span, this.constant(p.low));
        this.emit(Op.Const, p.span, this.constant(p.high));
        this.emit(Op.MatchRange, p.span, p.inclusive ? 1 : 0);
        check(p.span);
        return;
      case "PList":
        this.emitPath(slot, path, p.span);
        this.emit(Op.MatchList, p.span, p.items.length, p.rest ? 0 : 1);
        check(p.span);
        p.items.forEach((item, i) => this.test(item, slot, [...path, { kind: "index", i }], fails));
        return;
      case "PMap":
        this.emitPath(slot, path, p.span);
        this.emit(Op.MatchMap, p.span);
        check(p.span);
        for (const entry of p.entries) {
          this.emitPath(slot, path, entry.span);
          this.emit(Op.HasKey, entry.span, this.constant(entry.key));
          check(entry.span);
          this.test(entry.pattern, slot, [...path, { kind: "key", key: entry.key }], fails);
        }
        return;
      case "PVariant": {
        const info = this.env.variants.get(p.name);
        if (!info) {
          const suggestion = closest(p.name, this.env.variants.keys());
          this.error(
            `unknown variant \`${p.name}\``,
            p.span,
            suggestion ? `did you mean \`${suggestion}\`?` : "declare it in an `enum`",
            "undefined-name",
          );
        }
        if (info.fields.length !== p.args.length) {
          this.error(
            `\`${p.name}\` has ${info.fields.length} field${info.fields.length === 1 ? "" : "s"}, but the pattern gives ${p.args.length}`,
            p.span,
          );
        }
        this.emitPath(slot, path, p.span);
        this.emit(Op.MatchVariant, p.span, this.constant(`${info.enumName}.${info.tag}`), info.fields.length);
        check(p.span);
        p.args.forEach((arg, i) => this.test(arg, slot, [...path, { kind: "field", i }], fails));
        return;
      }
      case "POr": {
        if (patternBindings(p).length > 0) {
          this.error(
            "an `|` pattern that binds names must be the whole pattern of a match arm",
            p.span,
            "split it into separate arms",
          );
        }
        const successes: number[] = [];
        p.alternatives.forEach((alt, i) => {
          const last = i === p.alternatives.length - 1;
          if (last) {
            this.test(alt, slot, path, fails);
            return;
          }
          const local: number[] = [];
          this.test(alt, slot, path, local);
          successes.push(this.emitJump(Op.Jump, alt.span));
          for (const f of local) this.patch(f);
        });
        for (const s of successes) this.patch(s);
        return;
      }
    }
  }
}

/** Names that would break the runtime if a program redefined them. */
const BUILTIN_GUARD = new Set(["print", "len", "__import", "__variant"]);
