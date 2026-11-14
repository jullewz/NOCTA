/** Abstract syntax tree. Every node carries a source span for diagnostics. */

import type { Span } from "./source.js";

export type Expr =
  | { kind: "Number"; value: number; span: Span }
  | { kind: "String"; parts: (string | Expr)[]; span: Span }
  | { kind: "Bool"; value: boolean; span: Span }
  | { kind: "Nil"; span: Span }
  | { kind: "Ident"; name: string; span: Span }
  | { kind: "List"; items: Expr[]; span: Span }
  | { kind: "Map"; entries: { key: string; value: Expr; span: Span }[]; span: Span }
  | { kind: "Unary"; op: "-" | "not"; operand: Expr; span: Span }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: "Logical"; op: "and" | "or" | "??"; left: Expr; right: Expr; span: Span }
  | { kind: "Range"; low: Expr; high: Expr; inclusive: boolean; span: Span }
  | { kind: "Assign"; target: AssignTarget; op: "=" | "+=" | "-=" | "*=" | "/="; value: Expr; span: Span }
  | { kind: "Call"; callee: Expr; args: Expr[]; span: Span }
  | { kind: "Invoke"; object: Expr; name: string; args: Expr[]; span: Span; nameSpan: Span }
  | { kind: "Index"; object: Expr; index: Expr; span: Span }
  | { kind: "Member"; object: Expr; name: string; span: Span }
  | { kind: "Fn"; fn: FnNode; span: Span }
  | { kind: "If"; cond: Expr; then: Block; otherwise: Block | null; span: Span }
  | { kind: "Match"; subject: Expr; arms: MatchArm[]; span: Span }
  | { kind: "Try"; body: Block; name: string | null; handler: Block; span: Span }
  | { kind: "BlockExpr"; block: Block; span: Span }
  /** `return`, `throw`, `break` or `continue` used where a value is expected. It never produces a value. */
  | { kind: "Control"; stmt: Stmt; span: Span };

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "**" | "==" | "!=" | "<" | "<=" | ">" | ">=";

export type AssignTarget =
  | { kind: "Ident"; name: string; span: Span }
  | { kind: "Index"; object: Expr; index: Expr; span: Span }
  | { kind: "Member"; object: Expr; name: string; span: Span };

export interface Param {
  name: string;
  span: Span;
}

export interface FnNode {
  name: string | null;
  params: Param[];
  body: Block;
  /** True for `fn(x) => expr`. */
  arrow: boolean;
  span: Span;
}

export interface Block {
  stmts: Stmt[];
  span: Span;
}

export interface MatchArm {
  pattern: Pattern;
  guard: Expr | null;
  body: Expr;
  span: Span;
}

export type Pattern =
  | { kind: "PWildcard"; span: Span }
  | { kind: "PBind"; name: string; span: Span }
  | { kind: "PLiteral"; value: number | string | boolean | null; span: Span }
  | { kind: "PRange"; low: number; high: number; inclusive: boolean; span: Span }
  | { kind: "PList"; items: Pattern[]; rest: { name: string | null; span: Span } | null; span: Span }
  | { kind: "PMap"; entries: { key: string; pattern: Pattern; span: Span }[]; span: Span }
  | { kind: "PVariant"; name: string; args: Pattern[]; span: Span }
  | { kind: "POr"; alternatives: Pattern[]; span: Span };

export type Stmt =
  | { kind: "Let"; pattern: Pattern; mutable: boolean; value: Expr; span: Span }
  | { kind: "FnDecl"; fn: FnNode; span: Span }
  | { kind: "Enum"; name: string; variants: { name: string; fields: string[]; span: Span }[]; span: Span }
  | { kind: "ExprStmt"; expr: Expr; span: Span }
  | { kind: "While"; cond: Expr; body: Block; span: Span }
  | { kind: "For"; pattern: Pattern; iterable: Expr; body: Block; span: Span }
  | { kind: "Break"; span: Span }
  | { kind: "Continue"; span: Span }
  | { kind: "Return"; value: Expr | null; span: Span }
  | { kind: "Throw"; value: Expr; span: Span }
  | { kind: "Test"; name: string; body: Block; span: Span }
  | { kind: "Import"; path: string; alias: string; span: Span };

export interface Program {
  stmts: Stmt[];
  span: Span;
}

/** Names bound by a pattern, in source order. */
export function patternBindings(p: Pattern): { name: string; span: Span }[] {
  switch (p.kind) {
    case "PBind":
      return [{ name: p.name, span: p.span }];
    case "PList":
      return [...p.items.flatMap(patternBindings), ...(p.rest?.name ? [{ name: p.rest.name, span: p.rest.span }] : [])];
    case "PMap":
      return p.entries.flatMap((e) => patternBindings(e.pattern));
    case "PVariant":
      return p.args.flatMap(patternBindings);
    case "POr":
      return p.alternatives[0] ? patternBindings(p.alternatives[0]) : [];
    default:
      return [];
  }
}

/** True when the pattern matches every value (so `let` can use it without a failure path). */
export function isIrrefutable(p: Pattern): boolean {
  return p.kind === "PBind" || p.kind === "PWildcard";
}
