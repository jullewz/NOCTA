/**
 * The Nocta virtual machine: a stack machine with call frames, closures
 * (open/closed upvalues as in Lua), exception handlers and a step budget.
 *
 * Native functions can call back into Nocta code (`map`, `sort`, ...).
 * Those calls run a nested dispatch loop that stops when the called frame
 * returns. An error thrown inside the nested call that is not caught there
 * travels out through the native function into the outer loop, where an
 * outer `try` can still catch it.
 */

import type { SourceFile } from "../lang/source.js";
import { FnProto, Op } from "./bytecode.js";
import {
  ClosureObj,
  ConstructorObj,
  DONE,
  equals,
  isCallable,
  isObj,
  IterObj,
  ListObj,
  MapObj,
  ModuleObj,
  NativeObj,
  RangeObj,
  RuntimeError,
  show,
  truthy,
  typeName,
  Upvalue,
  VariantObj,
  type NativeContext,
  type Value,
} from "./values.js";

interface Frame {
  closure: ClosureObj;
  ip: number;
  base: number;
}

interface Handler {
  frameCount: number;
  ip: number;
  sp: number;
}

export interface VMOptions {
  /** Stop with an error after this many instructions (protects the playground from infinite loops). */
  maxSteps?: number;
  maxFrames?: number;
  print?: (text: string) => void;
  /** Random source, seedable for reproducible programs. */
  random?: () => number;
  now?: () => number;
  /** Source files by name, for line numbers in stack traces. */
  files?: Map<string, SourceFile>;
}

export class VM implements NativeContext {
  readonly globals = new Map<string, Value>();
  steps = 0;
  private stack: Value[] = new Array(1024);
  private sp = 0;
  private frames: Frame[] = [];
  private handlers: Handler[] = [];
  private openUpvalues: Upvalue | null = null;
  private readonly maxSteps: number;
  private readonly maxFrames: number;
  private readonly printer: (text: string) => void;
  private readonly rand: () => number;
  private readonly clock: () => number;
  readonly files: Map<string, SourceFile>;

  constructor(options: VMOptions = {}) {
    this.maxSteps = options.maxSteps ?? Infinity;
    this.maxFrames = options.maxFrames ?? 10_000;
    this.printer = options.print ?? ((t) => console.log(t));
    this.rand = options.random ?? Math.random;
    this.clock = options.now ?? (() => Date.now());
    this.files = options.files ?? new Map();
  }

  // ------------------------------------------------------- NativeContext
  print(text: string): void {
    this.printer(text);
  }

  random(): number {
    return this.rand();
  }

  now(): number {
    return this.clock();
  }

  defineNative(native: NativeObj): void {
    this.globals.set(native.name, native);
  }

  // ------------------------------------------------------------- running
  /** Run a compiled script (or test) to completion and return its value. */
  run(proto: FnProto): Value {
    this.sp = 0;
    this.frames = [];
    this.handlers = [];
    this.openUpvalues = null;
    const closure = new ClosureObj(proto, []);
    this.push(closure);
    this.callValue(closure, 0);
    return this.execute(0);
  }

  /** Call a Nocta callable from native code. */
  call(fn: Value, args: Value[]): Value {
    if (isObj(fn) && fn.type === "native") return this.callNative(fn, args);
    if (isObj(fn) && fn.type === "constructor") return this.construct(fn, args);
    const depth = this.frames.length;
    this.push(fn);
    for (const a of args) this.push(a);
    this.callValue(fn, args.length);
    return this.execute(depth);
  }

  private push(v: Value): void {
    if (this.sp >= this.stack.length) this.stack.length *= 2;
    this.stack[this.sp++] = v;
  }

  private pop(): Value {
    return this.stack[--this.sp] as Value;
  }

  private peek(distance = 0): Value {
    return this.stack[this.sp - 1 - distance] as Value;
  }

  // -------------------------------------------------------------- errors
  private fail(message: string, value: Value = message): never {
    throw new RuntimeError(message, value);
  }

  /** Where the current frame is, as "name (file:line:col)". */
  private location(frame: Frame, ip = frame.ip - 1): string {
    const proto = frame.closure.proto;
    const span = proto.chunk.spans[Math.max(0, Math.min(ip, proto.chunk.spans.length - 1))];
    const file = this.files.get(proto.file);
    if (!span || !file) return `${proto.name} (${proto.file})`;
    const { line, column } = file.position(span.start);
    return `${proto.name} (${proto.file}:${line}:${column})`;
  }

  /** The source span of the instruction being executed, used to point at errors. */
  currentSpan(): { file: string; start: number; end: number } | null {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return null;
    const span = frame.closure.proto.chunk.spans[Math.max(0, frame.ip - 1)];
    return span ? { file: frame.closure.proto.file, ...span } : null;
  }

  /** Stack trace, innermost first, with runs of identical frames collapsed (deep recursion). */
  private trace(): string[] {
    const out: string[] = [];
    let previous = "";
    let repeats = 0;
    const flush = (): void => {
      if (repeats > 0)
        out.push(`… the frame above repeats ${repeats.toLocaleString("en-US")} more time${repeats === 1 ? "" : "s"}`);
      repeats = 0;
    };
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const line = this.location(this.frames[i] as Frame);
      if (line === previous) {
        repeats++;
        continue;
      }
      flush();
      out.push(line);
      previous = line;
      if (out.length >= 40) {
        out.push(`… ${i} more frame${i === 1 ? "" : "s"}`);
        return out;
      }
    }
    flush();
    return out;
  }

  /** Unwind to the nearest handler at or above `stopDepth`, or rethrow out of this execute() call. */
  private raise(error: RuntimeError, stopDepth: number): void {
    const handler = this.handlers[this.handlers.length - 1];
    if (handler && handler.frameCount > stopDepth) {
      this.handlers.pop();
      this.frames.length = handler.frameCount;
      this.closeUpvalues(handler.sp);
      this.sp = handler.sp;
      const frame = this.frames[this.frames.length - 1] as Frame;
      frame.ip = handler.ip;
      this.push(error.value);
      return;
    }
    if (error.trace.length === 0) {
      error.trace = this.trace();
      error.span = this.currentSpan();
    }
    // drop the frames of this nested execution before leaving it
    this.frames.length = stopDepth;
    throw error;
  }

  // ------------------------------------------------------------- calling
  private callValue(callee: Value, argc: number): void {
    if (isObj(callee)) {
      if (callee.type === "closure") {
        const proto = callee.proto;
        if (argc !== proto.arity) {
          this.fail(`${proto.name}() takes ${proto.arity} argument${proto.arity === 1 ? "" : "s"} but got ${argc}`);
        }
        if (this.frames.length >= this.maxFrames) {
          this.fail(`stack overflow: more than ${this.maxFrames} nested calls (infinite recursion?)`);
        }
        this.frames.push({ closure: callee, ip: 0, base: this.sp - argc - 1 });
        return;
      }
      if (callee.type === "native") {
        const args = this.stack.slice(this.sp - argc, this.sp) as Value[];
        const result = this.callNative(callee, args);
        this.sp -= argc + 1;
        this.push(result);
        return;
      }
      if (callee.type === "constructor") {
        const args = this.stack.slice(this.sp - argc, this.sp) as Value[];
        const result = this.construct(callee, args);
        this.sp -= argc + 1;
        this.push(result);
        return;
      }
    }
    this.fail(`cannot call a ${typeName(callee)} (${show(callee, true)})`);
  }

  private callNative(fn: NativeObj, args: Value[]): Value {
    const arity = fn.arity;
    const [min, max] = typeof arity === "number" ? [arity, arity] : arity;
    if (args.length < min || args.length > max) {
      const expected = min === max ? String(min) : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      this.fail(`${fn.name}() takes ${expected} argument${min === 1 && max === 1 ? "" : "s"} but got ${args.length}`);
    }
    return fn.fn(args, this);
  }

  private construct(ctor: ConstructorObj, args: Value[]): Value {
    if (args.length !== ctor.fieldNames.length) {
      this.fail(
        `${ctor.tag}() takes ${ctor.fieldNames.length} argument${ctor.fieldNames.length === 1 ? "" : "s"} but got ${args.length}`,
      );
    }
    return new VariantObj(ctor.enumName, ctor.tag, args, ctor.fieldNames);
  }

  private captureUpvalue(slot: number): Upvalue {
    let prev: Upvalue | null = null;
    let up = this.openUpvalues;
    while (up && up.slot > slot) {
      prev = up;
      up = up.next;
    }
    if (up && up.slot === slot) return up;
    const created = new Upvalue(slot, this.stack);
    created.next = up;
    if (prev) prev.next = created;
    else this.openUpvalues = created;
    return created;
  }

  private closeUpvalues(fromSlot: number): void {
    while (this.openUpvalues && this.openUpvalues.slot >= fromSlot) {
      const up = this.openUpvalues;
      up.closed = this.stack[up.slot] as Value;
      up.stack = null;
      this.openUpvalues = up.next;
    }
  }

  // ------------------------------------------------------------ dispatch
  /** Run until the frame count drops back to `stopDepth`, then return the value it returned. */
  private execute(stopDepth: number): Value {
    for (;;) {
      try {
        return this.dispatch(stopDepth);
      } catch (error) {
        if (error instanceof RuntimeError) {
          this.raise(error, stopDepth);
          continue;
        }
        if (error instanceof RangeError && /call stack/i.test(error.message)) {
          this.raise(new RuntimeError("stack overflow: native recursion is too deep"), stopDepth);
          continue;
        }
        throw error;
      }
    }
  }

  private dispatch(stopDepth: number): Value {
    let frame = this.frames[this.frames.length - 1] as Frame;
    let code = frame.closure.proto.chunk.code;
    let constants = frame.closure.proto.chunk.constants;
    const stack = this.stack;
    const maxSteps = this.maxSteps;

    for (;;) {
      if (++this.steps > maxSteps) {
        this.fail(`step limit of ${maxSteps.toLocaleString("en-US")} instructions reached (infinite loop?)`);
      }
      const op = code[frame.ip++] as Op;
      switch (op) {
        case Op.Const:
          this.push(constants[code[frame.ip++] as number] as Value);
          break;
        case Op.Nil:
          this.push(null);
          break;
        case Op.True:
          this.push(true);
          break;
        case Op.False:
          this.push(false);
          break;
        case Op.Pop:
          this.sp--;
          break;
        case Op.Dup:
          this.push(this.peek());
          break;
        case Op.Swap: {
          const a = this.pop();
          const b = this.pop();
          this.push(a);
          this.push(b);
          break;
        }
        case Op.DupTwo: {
          const a = this.peek(1);
          const b = this.peek(0);
          this.push(a);
          this.push(b);
          break;
        }
        case Op.Collapse: {
          const n = code[frame.ip++] as number;
          const top = this.pop();
          this.closeUpvalues(this.sp - n);
          this.sp -= n;
          this.push(top);
          break;
        }
        case Op.GetLocal:
          this.push(stack[frame.base + (code[frame.ip++] as number)] as Value);
          break;
        case Op.SetLocal:
          stack[frame.base + (code[frame.ip++] as number)] = this.peek();
          break;
        case Op.GetUpvalue:
          this.push((frame.closure.upvalues[code[frame.ip++] as number] as Upvalue).get());
          break;
        case Op.SetUpvalue:
          (frame.closure.upvalues[code[frame.ip++] as number] as Upvalue).set(this.peek());
          break;
        case Op.GetGlobal: {
          const name = constants[code[frame.ip++] as number] as string;
          const value = this.globals.get(name);
          if (value === undefined) {
            if (!this.globals.has(name)) this.fail(`\`${name}\` is used before it is defined`);
          }
          this.push(value ?? null);
          break;
        }
        case Op.DefineGlobal:
          this.globals.set(constants[code[frame.ip++] as number] as string, this.pop());
          break;
        case Op.SetGlobal: {
          const name = constants[code[frame.ip++] as number] as string;
          if (!this.globals.has(name)) this.fail(`\`${name}\` is assigned before it is defined`);
          this.globals.set(name, this.peek());
          break;
        }
        case Op.Add: {
          const b = this.pop();
          const a = this.pop();
          if (typeof a === "number" && typeof b === "number") this.push(a + b);
          else if (typeof a === "string" && typeof b === "string") this.push(a + b);
          else if (isObj(a) && a.type === "list" && isObj(b) && b.type === "list")
            this.push(new ListObj([...a.items, ...b.items]));
          else if (typeof a === "string" || typeof b === "string") {
            this.fail(`cannot add ${typeName(a)} and ${typeName(b)} (to build text, use interpolation: "{a}{b}")`);
          } else this.fail(`cannot add ${typeName(a)} and ${typeName(b)}`);
          break;
        }
        case Op.Sub:
        case Op.Mul:
        case Op.Div:
        case Op.Mod:
        case Op.Pow:
          this.arith(op);
          break;
        case Op.Neg: {
          const a = this.pop();
          if (typeof a !== "number") this.fail(`cannot negate a ${typeName(a)}`);
          this.push(-a);
          break;
        }
        case Op.Not:
          this.push(!truthy(this.pop()));
          break;
        case Op.Eq: {
          const b = this.pop();
          this.push(equals(this.pop(), b));
          break;
        }
        case Op.Ne: {
          const b = this.pop();
          this.push(!equals(this.pop(), b));
          break;
        }
        case Op.Lt:
        case Op.Le:
        case Op.Gt:
        case Op.Ge:
          this.compare(op);
          break;
        case Op.Jump:
          frame.ip = code[frame.ip] as number;
          break;
        case Op.JumpIfFalse: {
          const target = code[frame.ip++] as number;
          if (!truthy(this.peek())) frame.ip = target;
          break;
        }
        case Op.JumpIfTrue: {
          const target = code[frame.ip++] as number;
          if (truthy(this.peek())) frame.ip = target;
          break;
        }
        case Op.JumpIfNotNil: {
          const target = code[frame.ip++] as number;
          if (this.peek() !== null) frame.ip = target;
          break;
        }
        case Op.PopJumpIfFalse: {
          const target = code[frame.ip++] as number;
          if (!truthy(this.pop())) frame.ip = target;
          break;
        }
        case Op.Call: {
          const argc = code[frame.ip++] as number;
          this.callValue(this.peek(argc), argc);
          frame = this.frames[this.frames.length - 1] as Frame;
          code = frame.closure.proto.chunk.code;
          constants = frame.closure.proto.chunk.constants;
          break;
        }
        case Op.Invoke: {
          const name = constants[code[frame.ip++] as number] as string;
          const argc = code[frame.ip++] as number;
          this.invoke(name, argc);
          frame = this.frames[this.frames.length - 1] as Frame;
          code = frame.closure.proto.chunk.code;
          constants = frame.closure.proto.chunk.constants;
          break;
        }
        case Op.Return: {
          const result = this.pop();
          const finished = this.frames.pop() as Frame;
          this.closeUpvalues(finished.base);
          while (
            this.handlers.length > 0 &&
            (this.handlers[this.handlers.length - 1] as Handler).frameCount > this.frames.length
          ) {
            this.handlers.pop();
          }
          this.sp = finished.base;
          if (this.frames.length === stopDepth) return result;
          this.push(result);
          frame = this.frames[this.frames.length - 1] as Frame;
          code = frame.closure.proto.chunk.code;
          constants = frame.closure.proto.chunk.constants;
          break;
        }
        case Op.Closure: {
          const proto = constants[code[frame.ip++] as number] as unknown as FnProto;
          const upvalues: Upvalue[] = [];
          for (let i = 0; i < proto.upvalues.length; i++) {
            const isLocal = code[frame.ip++] === 1;
            const index = code[frame.ip++] as number;
            upvalues.push(
              isLocal ? this.captureUpvalue(frame.base + index) : (frame.closure.upvalues[index] as Upvalue),
            );
          }
          this.push(new ClosureObj(proto, upvalues));
          break;
        }
        case Op.CloseUpvalue:
          this.closeUpvalues(this.sp - 1);
          this.sp--;
          break;
        case Op.List: {
          const n = code[frame.ip++] as number;
          const items = stack.slice(this.sp - n, this.sp) as Value[];
          this.sp -= n;
          this.push(new ListObj(items));
          break;
        }
        case Op.Map: {
          const n = code[frame.ip++] as number;
          const entries = new Map<string, Value>();
          for (let i = this.sp - n * 2; i < this.sp; i += 2) entries.set(stack[i] as string, stack[i + 1] as Value);
          this.sp -= n * 2;
          this.push(new MapObj(entries));
          break;
        }
        case Op.IndexGet: {
          const index = this.pop();
          this.push(this.indexGet(this.pop(), index));
          break;
        }
        case Op.IndexSet: {
          const value = this.pop();
          const index = this.pop();
          this.indexSet(this.pop(), index, value);
          this.push(value);
          break;
        }
        case Op.MemberGet: {
          const name = constants[code[frame.ip++] as number] as string;
          this.push(this.member(this.pop(), name));
          break;
        }
        case Op.MemberSet: {
          const name = constants[code[frame.ip++] as number] as string;
          const value = this.pop();
          const target = this.pop();
          if (!isObj(target) || target.type !== "map")
            this.fail(`cannot set field \`${name}\` on a ${typeName(target)}`);
          target.entries.set(name, value);
          this.push(value);
          break;
        }
        case Op.Range: {
          const inclusive = code[frame.ip++] === 1;
          const high = this.pop();
          const low = this.pop();
          if (typeof low !== "number" || typeof high !== "number") {
            this.fail(`a range needs numbers, got ${typeName(low)}..${typeName(high)}`);
          }
          this.push(new RangeObj(low, high, inclusive));
          break;
        }
        case Op.IterInit:
          this.push(this.iterator(this.pop()));
          break;
        case Op.IterNext: {
          const target = code[frame.ip++] as number;
          const it = this.peek() as unknown as IterObj;
          const next = it.next();
          if (next === DONE) frame.ip = target;
          else this.push(next);
          break;
        }
        case Op.Concat: {
          const n = code[frame.ip++] as number;
          let text = "";
          for (let i = this.sp - n; i < this.sp; i++) text += show(stack[i] as Value);
          this.sp -= n;
          this.push(text);
          break;
        }
        case Op.MatchList: {
          const min = code[frame.ip++] as number;
          const exact = code[frame.ip++] === 1;
          const v = this.pop();
          this.push(isObj(v) && v.type === "list" && (exact ? v.items.length === min : v.items.length >= min));
          break;
        }
        case Op.MatchMap: {
          const v = this.pop();
          this.push(isObj(v) && v.type === "map");
          break;
        }
        case Op.MatchVariant: {
          const key = constants[code[frame.ip++] as number] as string;
          const count = code[frame.ip++] as number;
          const v = this.pop();
          this.push(isObj(v) && v.type === "variant" && `${v.enumName}.${v.tag}` === key && v.fields.length === count);
          break;
        }
        case Op.MatchRange: {
          const inclusive = code[frame.ip++] === 1;
          const high = this.pop() as number;
          const low = this.pop() as number;
          const v = this.pop();
          this.push(typeof v === "number" && v >= low && (inclusive ? v <= high : v < high));
          break;
        }
        case Op.MatchType: {
          const name = constants[code[frame.ip++] as number] as string;
          this.push(typeName(this.pop()) === name);
          break;
        }
        case Op.HasKey: {
          const key = constants[code[frame.ip++] as number] as string;
          const v = this.pop();
          this.push(isObj(v) && v.type === "map" && v.entries.has(key));
          break;
        }
        case Op.ListSlice: {
          const from = code[frame.ip++] as number;
          const v = this.pop() as ListObj;
          this.push(new ListObj(v.items.slice(from)));
          break;
        }
        case Op.Field: {
          const i = code[frame.ip++] as number;
          const v = this.pop() as VariantObj;
          this.push(v.fields[i] ?? null);
          break;
        }
        case Op.Throw: {
          const value = this.pop();
          const message = typeof value === "string" ? value : show(value, true);
          throw new RuntimeError(message, value);
        }
        case Op.TryBegin: {
          const target = code[frame.ip++] as number;
          this.handlers.push({ frameCount: this.frames.length, ip: target, sp: this.sp });
          break;
        }
        case Op.TryEnd:
          this.handlers.pop();
          break;
        case Op.MatchFail: {
          const subject = stack[this.sp - 1] as Value;
          this.fail(`no match arm matched the value ${show(subject, true)}`);
          break;
        }
        default:
          throw new Error(`unknown opcode ${String(op)} at ${frame.ip - 1}`);
      }
    }
  }

  // ---------------------------------------------------------- operations
  private arith(op: Op): void {
    const b = this.pop();
    const a = this.pop();
    const sym = op === Op.Sub ? "-" : op === Op.Mul ? "*" : op === Op.Div ? "/" : op === Op.Mod ? "%" : "**";
    if (typeof a === "number" && typeof b === "number") {
      switch (op) {
        case Op.Sub:
          this.push(a - b);
          return;
        case Op.Mul:
          this.push(a * b);
          return;
        case Op.Div:
          if (b === 0) this.fail("division by zero");
          this.push(a / b);
          return;
        case Op.Mod:
          if (b === 0) this.fail("modulo by zero");
          this.push(((a % b) + b) % b);
          return;
        default:
          this.push(a ** b);
          return;
      }
    }
    if (op === Op.Mul) {
      const [seq, n] = typeof b === "number" ? [a, b] : [b, a];
      if (typeof n === "number" && Number.isInteger(n) && n >= 0) {
        if (typeof seq === "string") {
          if (seq.length * n > 50_000_000) this.fail("string repetition is too large");
          this.push(seq.repeat(n));
          return;
        }
        if (isObj(seq) && seq.type === "list") {
          if (seq.items.length * n > 10_000_000) this.fail("list repetition is too large");
          const items: Value[] = [];
          for (let i = 0; i < n; i++) items.push(...seq.items);
          this.push(new ListObj(items));
          return;
        }
      }
    }
    this.fail(`cannot apply \`${sym}\` to ${typeName(a)} and ${typeName(b)}`);
  }

  private compare(op: Op): void {
    const b = this.pop();
    const a = this.pop();
    if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) {
      this.fail(`cannot compare ${typeName(a)} with ${typeName(b)}`);
    }
    const x = a as number;
    const y = b as number;
    this.push(op === Op.Lt ? x < y : op === Op.Le ? x <= y : op === Op.Gt ? x > y : x >= y);
  }

  private normalizeIndex(index: Value, length: number, what: string): number {
    if (typeof index !== "number" || !Number.isInteger(index))
      this.fail(`${what} indices must be whole numbers, got ${show(index, true)}`);
    const i = index < 0 ? length + index : index;
    if (i < 0 || i >= length) this.fail(`index ${index} is out of range for a ${what} of length ${length}`);
    return i;
  }

  indexGet(target: Value, index: Value): Value {
    if (isObj(target)) {
      if (target.type === "list") return target.items[this.normalizeIndex(index, target.items.length, "list")] as Value;
      if (target.type === "map") {
        if (typeof index !== "string") this.fail(`map keys are strings, got ${typeName(index)}`);
        return target.entries.get(index) ?? null;
      }
      if (target.type === "module") return this.member(target, String(index));
    }
    if (typeof target === "string") {
      const chars = [...target];
      return chars[this.normalizeIndex(index, chars.length, "string")] as string;
    }
    return this.fail(`cannot index a ${typeName(target)}`);
  }

  private indexSet(target: Value, index: Value, value: Value): void {
    if (isObj(target) && target.type === "list") {
      target.items[this.normalizeIndex(index, target.items.length, "list")] = value;
      return;
    }
    if (isObj(target) && target.type === "map") {
      if (typeof index !== "string") this.fail(`map keys are strings, got ${typeName(index)}`);
      target.entries.set(index, value);
      return;
    }
    if (typeof target === "string") this.fail("strings cannot be changed in place; build a new one");
    this.fail(`cannot assign into a ${typeName(target)}`);
  }

  private member(target: Value, name: string): Value {
    if (isObj(target)) {
      if (target.type === "map") return target.entries.get(name) ?? null;
      if (target.type === "module") {
        if (!target.exports.has(name)) this.fail(`module \`${target.name}\` has no member \`${name}\``);
        return target.exports.get(name) as Value;
      }
      if (target.type === "variant") {
        const i = target.fieldNames.indexOf(name);
        if (i >= 0) return target.fields[i] as Value;
        this.fail(
          `${target.tag} has no field \`${name}\`${target.fieldNames.length ? ` (fields: ${target.fieldNames.join(", ")})` : ""}`,
        );
      }
    }
    return this.fail(
      `a ${typeName(target)} has no field \`${name}\` (to call a function, add parentheses: .${name}())`,
    );
  }

  /**
   * `obj.name(args)`. A map field holding a function is called directly.
   * Otherwise `name` is looked up as a global function and called with
   * `obj` as its first argument, so `[3, 1].sort()` means `sort([3, 1])`.
   */
  private invoke(name: string, argc: number): void {
    const receiver = this.peek(argc);
    if (isObj(receiver) && (receiver.type === "map" || receiver.type === "module")) {
      const field = receiver.type === "map" ? receiver.entries.get(name) : receiver.exports.get(name);
      if (field !== undefined && isCallable(field)) {
        this.stack[this.sp - argc - 1] = field;
        this.callValue(field, argc);
        return;
      }
      if (receiver.type === "module") this.fail(`module \`${receiver.name}\` has no function \`${name}\``);
    }
    const fn = this.globals.get(name);
    if (fn === undefined || !isCallable(fn)) {
      this.fail(`a ${typeName(receiver)} has no method \`${name}\``);
    }
    // shift the arguments up by one to make room for the function below the receiver
    this.push(null);
    for (let i = this.sp - 1; i > this.sp - argc - 2; i--) this.stack[i] = this.stack[i - 1] as Value;
    this.stack[this.sp - argc - 2] = fn;
    this.callValue(fn, argc + 1);
  }

  iterator(v: Value): IterObj {
    if (isObj(v)) {
      if (v.type === "list") {
        const items = v.items;
        let i = 0;
        return new IterObj(() => (i < items.length ? (items[i++] as Value) : DONE));
      }
      if (v.type === "range") {
        const { low, high, inclusive } = v;
        let current = low;
        return new IterObj(() => {
          if (inclusive ? current > high : current >= high) return DONE;
          return current++;
        });
      }
      if (v.type === "map") {
        const keys = [...v.entries.keys()];
        let i = 0;
        return new IterObj(() => (i < keys.length ? (keys[i++] as string) : DONE));
      }
      if (v.type === "iterator") return v;
    }
    if (typeof v === "string") {
      const chars = [...v];
      let i = 0;
      return new IterObj(() => (i < chars.length ? (chars[i++] as string) : DONE));
    }
    return this.fail(`cannot loop over a ${typeName(v)} (lists, ranges, strings and maps can be looped over)`);
  }

  /** Module support for `import`: export every global defined by another program. */
  static moduleFrom(name: string, vm: VM, builtins: Set<string>): ModuleObj {
    const exports = new Map<string, Value>();
    for (const [k, v] of vm.globals) if (!builtins.has(k) && !k.startsWith("__")) exports.set(k, v);
    return new ModuleObj(name, exports);
  }
}

declare module "./values.js" {
  interface RuntimeError {
    span?: { file: string; start: number; end: number } | null;
  }
}
