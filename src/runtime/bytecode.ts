/** Bytecode format: opcodes, function prototypes and the disassembler. */

import type { Span } from "../lang/source.js";
import { show, type Value } from "./values.js";

export enum Op {
  Const, // k
  Nil,
  True,
  False,
  Pop,
  Dup,
  Swap,
  DupTwo, // duplicate the top two values
  Collapse, // n: pop n values from under the top value, closing their upvalues
  GetLocal, // slot
  SetLocal, // slot (keeps value)
  GetUpvalue, // index
  SetUpvalue, // index
  GetGlobal, // k (name)
  DefineGlobal, // k
  SetGlobal, // k
  Add,
  Sub,
  Mul,
  Div,
  Mod,
  Pow,
  Neg,
  Not,
  Eq,
  Ne,
  Lt,
  Le,
  Gt,
  Ge,
  Jump, // offset (absolute)
  JumpIfFalse, // offset, keeps condition
  JumpIfTrue, // offset, keeps condition
  JumpIfNotNil, // offset, keeps value
  PopJumpIfFalse, // offset, pops condition
  Call, // argc
  Invoke, // k (name), argc
  Return,
  Closure, // k (proto), then per upvalue: isLocal, index
  CloseUpvalue,
  List, // n
  Map, // n, keys come from the stack as strings
  IndexGet,
  IndexSet,
  MemberGet, // k
  MemberSet, // k
  Range, // inclusive flag
  IterInit,
  IterNext, // offset to jump to when exhausted
  Concat, // n parts, converted with str()
  // pattern matching
  MatchList, // min length, exact flag: pushes bool
  MatchMap, // pushes bool: value is a map
  MatchVariant, // k (tag), field count: pushes bool
  MatchRange, // inclusive flag: (value, low, high) -> bool
  MatchType, // k (type name): pushes bool
  HasKey, // k: pushes bool
  ListSlice, // start: pushes items[start..]
  Field, // i: pushes variant field i
  Throw,
  TryBegin, // handler offset
  TryEnd,
  MatchFail, // raises "no match arm matched"
}

/** Number of operand slots that follow each opcode (Closure has extra trailing pairs). */
export const OPERANDS: Record<Op, number> = {
  [Op.Const]: 1,
  [Op.Nil]: 0,
  [Op.True]: 0,
  [Op.False]: 0,
  [Op.Pop]: 0,
  [Op.Dup]: 0,
  [Op.Swap]: 0,
  [Op.DupTwo]: 0,
  [Op.Collapse]: 1,
  [Op.GetLocal]: 1,
  [Op.SetLocal]: 1,
  [Op.GetUpvalue]: 1,
  [Op.SetUpvalue]: 1,
  [Op.GetGlobal]: 1,
  [Op.DefineGlobal]: 1,
  [Op.SetGlobal]: 1,
  [Op.Add]: 0,
  [Op.Sub]: 0,
  [Op.Mul]: 0,
  [Op.Div]: 0,
  [Op.Mod]: 0,
  [Op.Pow]: 0,
  [Op.Neg]: 0,
  [Op.Not]: 0,
  [Op.Eq]: 0,
  [Op.Ne]: 0,
  [Op.Lt]: 0,
  [Op.Le]: 0,
  [Op.Gt]: 0,
  [Op.Ge]: 0,
  [Op.Jump]: 1,
  [Op.JumpIfFalse]: 1,
  [Op.JumpIfTrue]: 1,
  [Op.JumpIfNotNil]: 1,
  [Op.PopJumpIfFalse]: 1,
  [Op.Call]: 1,
  [Op.Invoke]: 2,
  [Op.Return]: 0,
  [Op.Closure]: 1,
  [Op.CloseUpvalue]: 0,
  [Op.List]: 1,
  [Op.Map]: 1,
  [Op.IndexGet]: 0,
  [Op.IndexSet]: 0,
  [Op.MemberGet]: 1,
  [Op.MemberSet]: 1,
  [Op.Range]: 1,
  [Op.IterInit]: 0,
  [Op.IterNext]: 1,
  [Op.Concat]: 1,
  [Op.MatchList]: 2,
  [Op.MatchMap]: 0,
  [Op.MatchVariant]: 2,
  [Op.MatchRange]: 1,
  [Op.MatchType]: 1,
  [Op.HasKey]: 1,
  [Op.ListSlice]: 1,
  [Op.Field]: 1,
  [Op.Throw]: 0,
  [Op.TryBegin]: 1,
  [Op.TryEnd]: 0,
  [Op.MatchFail]: 0,
};

export class Chunk {
  readonly code: number[] = [];
  readonly constants: Value[] = [];
  /** Source span for every byte of `code`, for errors and traces. */
  readonly spans: Span[] = [];
  private readonly constantIndex = new Map<string, number>();

  emit(byte: number, span: Span): number {
    this.code.push(byte);
    this.spans.push(span);
    return this.code.length - 1;
  }

  /** Add a constant, reusing an existing slot for equal numbers and strings. */
  constant(value: Value): number {
    const key =
      typeof value === "string"
        ? `s:${value}`
        : typeof value === "number"
          ? `n:${Object.is(value, -0) ? "-0" : value}`
          : null;
    if (key !== null) {
      const found = this.constantIndex.get(key);
      if (found !== undefined) return found;
    }
    this.constants.push(value);
    const index = this.constants.length - 1;
    if (key !== null) this.constantIndex.set(key, index);
    return index;
  }
}

export interface UpvalueRef {
  isLocal: boolean;
  index: number;
  name: string;
}

export class FnProto {
  readonly type = "proto";
  readonly chunk = new Chunk();
  upvalues: UpvalueRef[] = [];
  /** Highest number of local slots in use at once, for diagnostics. */
  maxLocals = 0;

  constructor(
    public name: string,
    public arity: number,
    readonly file: string,
    readonly span: Span,
  ) {}
}

function isProto(v: unknown): v is FnProto {
  return typeof v === "object" && v !== null && (v as { type?: string }).type === "proto";
}

/** Human-readable listing of a function and every nested function. */
export function disassemble(proto: FnProto, position?: (offset: number) => { line: number }): string {
  const out: string[] = [];
  const queue: FnProto[] = [proto];
  const seen = new Set<FnProto>();
  while (queue.length > 0) {
    const fn = queue.shift() as FnProto;
    if (seen.has(fn)) continue;
    seen.add(fn);
    const { chunk } = fn;
    out.push(`== ${fn.name} (arity ${fn.arity}, ${fn.upvalues.length} upvalues, ${chunk.code.length} bytes) ==`);
    let lastLine = -1;
    for (let ip = 0; ip < chunk.code.length; ) {
      const op = chunk.code[ip] as Op;
      const line = position ? position(chunk.spans[ip]?.start ?? 0).line : -1;
      const lineCol = line === lastLine ? "   |" : String(line).padStart(4);
      lastLine = line;
      const name = Op[op] ?? `?${op}`;
      const n = OPERANDS[op] ?? 0;
      const args = chunk.code.slice(ip + 1, ip + 1 + n);
      let detail = "";
      if (
        [
          Op.Const,
          Op.GetGlobal,
          Op.DefineGlobal,
          Op.SetGlobal,
          Op.MemberGet,
          Op.MemberSet,
          Op.HasKey,
          Op.MatchType,
        ].includes(op)
      ) {
        detail = show(chunk.constants[args[0] ?? 0] ?? null, true);
      } else if (op === Op.Invoke || op === Op.MatchVariant) {
        detail = `${show(chunk.constants[args[0] ?? 0] ?? null)} ${args[1]}`;
      } else if (op === Op.Closure) {
        const target = chunk.constants[args[0] ?? 0];
        if (isProto(target)) {
          detail = `<fn ${target.name}>`;
          queue.push(target);
          const pairs: string[] = [];
          for (let u = 0; u < target.upvalues.length; u++) {
            const isLocal = chunk.code[ip + 2 + u * 2];
            const index = chunk.code[ip + 3 + u * 2];
            pairs.push(`${isLocal ? "local" : "upvalue"} ${index}`);
          }
          if (pairs.length) detail += `  captures ${pairs.join(", ")}`;
          out.push(
            `${String(ip).padStart(5, "0")} ${lineCol}  ${name.padEnd(15)} ${String(args[0]).padStart(4)}  ${detail}`,
          );
          ip += 2 + target.upvalues.length * 2;
          continue;
        }
      }
      const argText = args.map((a) => String(a).padStart(4)).join(" ");
      out.push(
        `${String(ip).padStart(5, "0")} ${lineCol}  ${name.padEnd(15)} ${argText.padEnd(9)} ${detail}`.trimEnd(),
      );
      ip += 1 + n;
    }
    out.push("");
  }
  return out.join("\n");
}
