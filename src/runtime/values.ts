/** Runtime values, equality, display and type names. */

import type { FnProto } from "./bytecode.js";

export type Value = number | string | boolean | null | Obj;

export type Obj =
  | ListObj
  | MapObj
  | ClosureObj
  | NativeObj
  | RangeObj
  | VariantObj
  | ConstructorObj
  | ModuleObj
  | IterObj;

export class ListObj {
  readonly type = "list";
  constructor(public items: Value[]) {}
}

export class MapObj {
  readonly type = "map";
  constructor(public entries: Map<string, Value> = new Map()) {}
}

/** Captured variable. Open while its slot lives on the stack, closed (holding its own value) afterwards. */
export class Upvalue {
  closed: Value = null;
  next: Upvalue | null = null;
  constructor(
    public slot: number,
    public stack: Value[] | null,
  ) {}

  get(): Value {
    return this.stack ? (this.stack[this.slot] as Value) : this.closed;
  }

  set(value: Value): void {
    if (this.stack) this.stack[this.slot] = value;
    else this.closed = value;
  }
}

export class ClosureObj {
  readonly type = "closure";
  constructor(
    readonly proto: FnProto,
    readonly upvalues: Upvalue[],
  ) {}
}

/** A host function. `call` receives already-evaluated arguments. */
export type NativeFn = (args: Value[], ctx: NativeContext) => Value;

export interface NativeContext {
  /** Call any Nocta callable (closure, native, constructor) from native code. */
  call(fn: Value, args: Value[]): Value;
  print(text: string): void;
  random(): number;
  now(): number;
}

export class NativeObj {
  readonly type = "native";
  constructor(
    readonly name: string,
    /** Allowed argument counts: exact number, or [min, max]. */
    readonly arity: number | [number, number],
    readonly fn: NativeFn,
    readonly doc = "",
  ) {}
}

export class RangeObj {
  readonly type = "range";
  constructor(
    readonly low: number,
    readonly high: number,
    readonly inclusive: boolean,
  ) {}

  get length(): number {
    const n = Math.ceil(this.high - this.low) + (this.inclusive && Number.isInteger(this.high - this.low) ? 1 : 0);
    return Math.max(0, n);
  }
}

/** An enum variant value, e.g. `Some(3)` or `Red`. */
export class VariantObj {
  readonly type = "variant";
  constructor(
    readonly enumName: string,
    readonly tag: string,
    readonly fields: Value[],
    readonly fieldNames: readonly string[],
  ) {}
}

/** The constructor function for a variant with fields: `Circle(2)`. */
export class ConstructorObj {
  readonly type = "constructor";
  constructor(
    readonly enumName: string,
    readonly tag: string,
    readonly fieldNames: readonly string[],
  ) {}
}

export class ModuleObj {
  readonly type = "module";
  constructor(
    readonly name: string,
    readonly exports: Map<string, Value>,
  ) {}
}

/** Internal iterator used by `for` loops. Never visible to Nocta programs. */
export class IterObj {
  readonly type = "iterator";
  index = 0;
  constructor(readonly next: () => Value | typeof DONE) {}
}

export const DONE: unique symbol = Symbol("done");

export function isObj(v: Value): v is Obj {
  return typeof v === "object" && v !== null;
}

export function typeName(v: Value): string {
  if (v === null) return "nil";
  switch (typeof v) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "bool";
  }
  switch (v.type) {
    case "closure":
    case "native":
    case "constructor":
      return "function";
    case "variant":
      return v.enumName;
    default:
      return v.type;
  }
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false;
}

export function isCallable(v: Value): boolean {
  return isObj(v) && (v.type === "closure" || v.type === "native" || v.type === "constructor");
}

/** Structural equality for lists, maps, ranges and variants. Functions compare by identity. */
export function equals(a: Value, b: Value, depth = 0): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (!isObj(a) || !isObj(b) || a.type !== b.type || depth > 200) return false;
  if (a.type === "list" && b.type === "list") {
    return a.items.length === b.items.length && a.items.every((x, i) => equals(x, b.items[i] ?? null, depth + 1));
  }
  if (a.type === "map" && b.type === "map") {
    if (a.entries.size !== b.entries.size) return false;
    for (const [k, v] of a.entries) {
      if (!b.entries.has(k) || !equals(v, b.entries.get(k) ?? null, depth + 1)) return false;
    }
    return true;
  }
  if (a.type === "range" && b.type === "range") {
    return a.low === b.low && a.high === b.high && a.inclusive === b.inclusive;
  }
  if (a.type === "variant" && b.type === "variant") {
    return (
      a.enumName === b.enumName &&
      a.tag === b.tag &&
      a.fields.length === b.fields.length &&
      a.fields.every((x, i) => equals(x, b.fields[i] ?? null, depth + 1))
    );
  }
  return false;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  return String(Number(n.toPrecision(15)));
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Human-readable form. `quote` controls whether strings are shown with quotes
 * (inside collections and the REPL) or raw (top-level `print`).
 */
export function show(v: Value, quote = false, seen: Set<Obj> = new Set()): string {
  if (v === null) return "nil";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return quote ? JSON.stringify(v) : v;
  if (seen.has(v)) return "[…]";
  switch (v.type) {
    case "list": {
      seen.add(v);
      const out = `[${v.items.map((x) => show(x, true, seen)).join(", ")}]`;
      seen.delete(v);
      return out;
    }
    case "map": {
      if (v.entries.size === 0) return "{}";
      seen.add(v);
      const parts = [...v.entries].map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${show(x, true, seen)}`);
      seen.delete(v);
      return `{${parts.join(", ")}}`;
    }
    case "range":
      return `${formatNumber(v.low)}${v.inclusive ? "..=" : ".."}${formatNumber(v.high)}`;
    case "variant":
      if (v.fields.length === 0) return v.tag;
      seen.add(v);
      try {
        return `${v.tag}(${v.fields.map((x) => show(x, true, seen)).join(", ")})`;
      } finally {
        seen.delete(v);
      }
    case "closure":
      return `<fn ${v.proto.name}>`;
    case "native":
      return `<builtin ${v.name}>`;
    case "constructor":
      return `<constructor ${v.enumName}.${v.tag}>`;
    case "module":
      return `<module ${v.name}>`;
    case "iterator":
      return "<iterator>";
  }
}

/** Errors raised by Nocta code or the runtime. `value` is what `catch` receives. */
export class RuntimeError extends Error {
  override name = "RuntimeError";
  trace: string[] = [];
  constructor(
    message: string,
    readonly value: Value = message,
  ) {
    super(message);
  }
}
