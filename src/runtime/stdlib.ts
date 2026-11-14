/**
 * The standard library. Every function validates its arguments and reports
 * mistakes in Nocta terms ("sort() expects a list, got a map").
 *
 * Because `obj.name(args)` calls the global `name` with `obj` first, every
 * function here doubles as a method: `[3, 1, 2].sort().reverse()`.
 */

import {
  ConstructorObj,
  equals,
  formatNumber,
  isCallable,
  isObj,
  ListObj,
  MapObj,
  NativeObj,
  RangeObj,
  RuntimeError,
  show,
  truthy,
  typeName,
  VariantObj,
  type NativeContext,
  type NativeFn,
  type Value,
} from "./values.js";

const fail = (message: string): never => {
  throw new RuntimeError(message);
};

function expect<T>(fn: string, value: Value, ok: (v: Value) => v is T & Value, what: string): T {
  if (!ok(value)) fail(`${fn}() expects ${what}, got ${describe(value)}`);
  return value as T;
}

function describe(v: Value): string {
  const t = typeName(v);
  return /^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`;
}

const isNum = (v: Value): v is number => typeof v === "number";
const isStr = (v: Value): v is string => typeof v === "string";
const isList = (v: Value): v is ListObj => isObj(v) && v.type === "list";
const isMap = (v: Value): v is MapObj => isObj(v) && v.type === "map";
const isFn = (v: Value): v is Value => isCallable(v);
const isInt = (v: Value): v is number => typeof v === "number" && Number.isInteger(v);

/** Items of anything iterable, as an array. */
export function items(fn: string, v: Value): Value[] {
  if (isList(v)) return v.items;
  if (isObj(v) && v.type === "range") {
    const out: Value[] = [];
    const end = v.inclusive ? v.high : v.high - 1e-12;
    if (Math.abs(v.high - v.low) > 50_000_000) fail(`${fn}(): range is too large to materialise`);
    for (let x = v.low; x <= end; x++) out.push(x);
    return out;
  }
  if (typeof v === "string") return [...v];
  if (isMap(v)) return [...v.entries.keys()];
  return fail(`${fn}() expects a list, range, string or map, got ${describe(v)}`);
}

function compareValues(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (isList(a) && isList(b)) {
    for (let i = 0; i < Math.min(a.items.length, b.items.length); i++) {
      const c = compareValues(a.items[i] ?? null, b.items[i] ?? null);
      if (c !== 0) return c;
    }
    return a.items.length - b.items.length;
  }
  return fail(`cannot compare ${describe(a)} with ${describe(b)} while sorting`);
}

const SOME = (v: Value): VariantObj => new VariantObj("Option", "Some", [v], ["value"]);
const NONE = new VariantObj("Option", "None", [], []);

function toJson(v: Value, depth = 0): unknown {
  if (depth > 100) fail("to_json(): value is nested too deeply");
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) fail("to_json(): numbers must be finite");
    return v;
  }
  if (v.type === "list") return v.items.map((x) => toJson(x, depth + 1));
  if (v.type === "map") return Object.fromEntries([...v.entries].map(([k, x]) => [k, toJson(x, depth + 1)]));
  if (v.type === "variant") return { [v.tag]: v.fields.map((x) => toJson(x, depth + 1)) };
  return fail(`to_json(): cannot convert ${describe(v)}`);
}

function fromJson(x: unknown): Value {
  if (x === null || typeof x === "boolean" || typeof x === "number" || typeof x === "string") return x;
  if (Array.isArray(x)) return new ListObj(x.map(fromJson));
  return new MapObj(new Map(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, fromJson(v)])));
}

type Def = [name: string, arity: number | [number, number], doc: string, fn: NativeFn];

const DEFS: Def[] = [
  // ------------------------------------------------------------ core
  [
    "print",
    [0, Infinity],
    "print(values...): write values separated by spaces",
    (args, ctx) => {
      ctx.print(args.map((a) => show(a)).join(" "));
      return null;
    },
  ],
  ["str", 1, "str(value): convert to a string", ([v]) => show(v ?? null)],
  ["repr", 1, "repr(value): string with quotes, as the REPL shows it", ([v]) => show(v ?? null, true)],
  [
    "num",
    1,
    "num(value): parse a number; nil if it is not one",
    ([v]) => {
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.trim().replace(/_/g, ""));
        return Number.isNaN(n) ? null : n;
      }
      return null;
    },
  ],
  ["int", 1, "int(n): truncate towards zero", ([v]) => Math.trunc(expect("int", v ?? null, isNum, "a number"))],
  ["type", 1, "type(value): the type name", ([v]) => typeName(v ?? null)],
  [
    "len",
    1,
    "len(x): length of a list, string, map or range",
    ([v]) => {
      if (isList(v ?? null)) return (v as ListObj).items.length;
      if (typeof v === "string") return [...v].length;
      if (isMap(v ?? null)) return (v as MapObj).entries.size;
      if (isObj(v ?? null) && (v as RangeObj).type === "range") return (v as RangeObj).length;
      return fail(`len() expects a list, string, map or range, got ${describe(v ?? null)}`);
    },
  ],
  [
    "assert",
    [1, 2],
    "assert(condition, message?): fail when the condition is false",
    ([c, m]) => {
      if (!truthy(c ?? null)) fail(`assertion failed${m !== undefined ? `: ${show(m)}` : ""}`);
      return null;
    },
  ],
  [
    "assert_eq",
    [2, 3],
    "assert_eq(actual, expected, message?): fail when not equal",
    ([a, b, m]) => {
      if (!equals(a ?? null, b ?? null)) {
        fail(
          `assertion failed${m !== undefined ? ` (${show(m)})` : ""}: expected ${show(b ?? null, true)}, got ${show(a ?? null, true)}`,
        );
      }
      return null;
    },
  ],
  [
    "error",
    1,
    'error(message): an error value; use with `throw error("...")`',
    ([m]) => new MapObj(new Map([["error", m ?? null]])),
  ],
  ["clock", 0, "clock(): milliseconds since 1970", (_args, ctx) => ctx.now()],

  // ------------------------------------------------------------ lists
  [
    "push",
    [2, Infinity],
    "push(list, values...): append, return the list",
    ([l, ...vs]) => {
      const list = expect("push", l ?? null, isList, "a list");
      list.items.push(...vs);
      return list;
    },
  ],
  [
    "pop",
    1,
    "pop(list): remove and return the last item",
    ([l]) => {
      const list = expect("pop", l ?? null, isList, "a list");
      if (list.items.length === 0) fail("pop() on an empty list");
      return list.items.pop() as Value;
    },
  ],
  [
    "insert",
    3,
    "insert(list, index, value): insert before index",
    ([l, i, v]) => {
      const list = expect("insert", l ?? null, isList, "a list");
      const idx = expect("insert", i ?? null, isInt, "a whole-number index");
      if (idx < 0 || idx > list.items.length) fail(`insert(): index ${idx} is out of range`);
      list.items.splice(idx, 0, v ?? null);
      return list;
    },
  ],
  [
    "remove_at",
    2,
    "remove_at(list, index): remove and return an item",
    ([l, i]) => {
      const list = expect("remove_at", l ?? null, isList, "a list");
      let idx = expect("remove_at", i ?? null, isInt, "a whole-number index");
      if (idx < 0) idx += list.items.length;
      if (idx < 0 || idx >= list.items.length) fail(`remove_at(): index ${i as number} is out of range`);
      return list.items.splice(idx, 1)[0] as Value;
    },
  ],
  ["first", 1, "first(xs): first item, or nil", ([v]) => items("first", v ?? null)[0] ?? null],
  [
    "last",
    1,
    "last(xs): last item, or nil",
    ([v]) => {
      const xs = items("last", v ?? null);
      return xs[xs.length - 1] ?? null;
    },
  ],
  [
    "slice",
    [2, 3],
    "slice(xs, start, end?): a part of a list or string",
    ([v, a, b]) => {
      const start = expect("slice", a ?? null, isInt, "a whole-number start");
      const end = b === undefined || b === null ? undefined : expect("slice", b, isInt, "a whole-number end");
      if (typeof v === "string") return [...v].slice(start, end).join("");
      return new ListObj(items("slice", v ?? null).slice(start, end));
    },
  ],
  [
    "reverse",
    1,
    "reverse(xs): reversed copy",
    ([v]) =>
      typeof v === "string" ? [...v].reverse().join("") : new ListObj([...items("reverse", v ?? null)].reverse()),
  ],
  [
    "contains",
    2,
    "contains(xs, value): membership; substring for strings; key for maps",
    ([c, x]) => {
      if (typeof c === "string") return c.includes(expect("contains", x ?? null, isStr, "a string to search for"));
      if (isMap(c ?? null)) return (c as MapObj).entries.has(String(x));
      return items("contains", c ?? null).some((y) => equals(y, x ?? null));
    },
  ],
  [
    "index_of",
    2,
    "index_of(xs, value): position, or -1",
    ([c, x]) => {
      if (typeof c === "string") {
        const at = c.indexOf(expect("index_of", x ?? null, isStr, "a string to search for"));
        return at < 0 ? -1 : [...c.slice(0, at)].length;
      }
      return items("index_of", c ?? null).findIndex((y) => equals(y, x ?? null));
    },
  ],
  [
    "sort",
    [1, 2],
    "sort(xs, key?): sorted copy, optionally by a key function",
    ([v, key], ctx) => {
      const xs = [...items("sort", v ?? null)];
      if (key === undefined) return new ListObj(xs.sort(compareValues));
      expect("sort", key, isFn, "a key function");
      const keyed = xs.map((x) => ({ x, k: ctx.call(key, [x]) }));
      keyed.sort((a, b) => compareValues(a.k, b.k));
      return new ListObj(keyed.map((p) => p.x));
    },
  ],
  [
    "map",
    2,
    "map(xs, f): apply f to every item",
    ([v, f], ctx) => {
      expect("map", f ?? null, isFn, "a function");
      return new ListObj(items("map", v ?? null).map((x) => ctx.call(f as Value, [x])));
    },
  ],
  [
    "filter",
    2,
    "filter(xs, f): items where f is truthy",
    ([v, f], ctx) => {
      expect("filter", f ?? null, isFn, "a function");
      return new ListObj(items("filter", v ?? null).filter((x) => truthy(ctx.call(f as Value, [x]))));
    },
  ],
  [
    "reduce",
    3,
    "reduce(xs, f, initial): fold left with f(acc, item)",
    ([v, f, init], ctx) => {
      expect("reduce", f ?? null, isFn, "a function");
      let acc = init ?? null;
      for (const x of items("reduce", v ?? null)) acc = ctx.call(f as Value, [acc, x]);
      return acc;
    },
  ],
  [
    "each",
    2,
    "each(xs, f): call f for every item",
    ([v, f], ctx) => {
      expect("each", f ?? null, isFn, "a function");
      for (const x of items("each", v ?? null)) ctx.call(f as Value, [x]);
      return null;
    },
  ],
  [
    "find",
    2,
    "find(xs, f): Some(first item where f is truthy), or None",
    ([v, f], ctx) => {
      expect("find", f ?? null, isFn, "a function");
      for (const x of items("find", v ?? null)) if (truthy(ctx.call(f as Value, [x]))) return SOME(x);
      return NONE;
    },
  ],
  [
    "any",
    [1, 2],
    "any(xs, f?): true if any item (or f(item)) is truthy",
    ([v, f], ctx) => items("any", v ?? null).some((x) => truthy(f === undefined ? x : ctx.call(f, [x]))),
  ],
  [
    "all",
    [1, 2],
    "all(xs, f?): true if every item (or f(item)) is truthy",
    ([v, f], ctx) => items("all", v ?? null).every((x) => truthy(f === undefined ? x : ctx.call(f, [x]))),
  ],
  [
    "count",
    2,
    "count(xs, f): number of items where f is truthy",
    ([v, f], ctx) => items("count", v ?? null).filter((x) => truthy(ctx.call(f ?? null, [x]))).length,
  ],
  [
    "sum",
    1,
    "sum(xs): add numbers",
    ([v]) => items("sum", v ?? null).reduce<number>((a, x) => a + expect("sum", x, isNum, "numbers"), 0),
  ],
  ["min", [1, Infinity], "min(xs) or min(a, b, ...): smallest value", (args) => extreme("min", args, -1)],
  ["max", [1, Infinity], "max(xs) or max(a, b, ...): largest value", (args) => extreme("max", args, 1)],
  [
    "zip",
    2,
    "zip(a, b): list of [a_i, b_i] pairs",
    ([a, b]) => {
      const xs = items("zip", a ?? null);
      const ys = items("zip", b ?? null);
      return new ListObj(xs.slice(0, Math.min(xs.length, ys.length)).map((x, i) => new ListObj([x, ys[i] ?? null])));
    },
  ],
  [
    "enumerate",
    1,
    "enumerate(xs): list of [index, item] pairs",
    ([v]) => new ListObj(items("enumerate", v ?? null).map((x, i) => new ListObj([i, x]))),
  ],
  [
    "flatten",
    1,
    "flatten(xs): concatenate a list of lists",
    ([v]) => new ListObj(items("flatten", v ?? null).flatMap((x) => (isList(x) ? x.items : [x]))),
  ],
  [
    "unique",
    1,
    "unique(xs): items without duplicates, in order",
    ([v]) => {
      const out: Value[] = [];
      for (const x of items("unique", v ?? null)) if (!out.some((y) => equals(x, y))) out.push(x);
      return new ListObj(out);
    },
  ],
  [
    "take",
    2,
    "take(xs, n): the first n items",
    ([v, n]) =>
      new ListObj(items("take", v ?? null).slice(0, Math.max(0, expect("take", n ?? null, isInt, "a count")))),
  ],
  [
    "drop",
    2,
    "drop(xs, n): everything after the first n items",
    ([v, n]) => new ListObj(items("drop", v ?? null).slice(Math.max(0, expect("drop", n ?? null, isInt, "a count")))),
  ],
  [
    "chunks",
    2,
    "chunks(xs, size): split into lists of at most size items",
    ([v, n]) => {
      const size = expect("chunks", n ?? null, isInt, "a size");
      if (size < 1) fail("chunks(): size must be at least 1");
      const xs = items("chunks", v ?? null);
      const out: Value[] = [];
      for (let i = 0; i < xs.length; i += size) out.push(new ListObj(xs.slice(i, i + size)));
      return new ListObj(out);
    },
  ],
  [
    "group_by",
    2,
    "group_by(xs, f): map from str(f(item)) to the items with that key",
    ([v, f], ctx) => {
      const groups = new Map<string, Value>();
      for (const x of items("group_by", v ?? null)) {
        const key = show(ctx.call(f ?? null, [x]));
        const bucket = (groups.get(key) as ListObj | undefined) ?? new ListObj([]);
        bucket.items.push(x);
        groups.set(key, bucket);
      }
      return new MapObj(groups);
    },
  ],
  ["list", 1, "list(xs): a new list from any iterable", ([v]) => new ListObj([...items("list", v ?? null)])],
  [
    "range",
    [1, 3],
    "range(end) / range(start, end, step?): list of numbers",
    ([a, b, s]) => {
      const start = b === undefined ? 0 : expect("range", a ?? null, isNum, "numbers");
      const end = b === undefined ? expect("range", a ?? null, isNum, "numbers") : expect("range", b, isNum, "numbers");
      const step = s === undefined ? 1 : expect("range", s, isNum, "a step");
      if (step === 0) fail("range(): step cannot be 0");
      if (Math.abs((end - start) / step) > 10_000_000) fail("range(): too many items");
      const out: Value[] = [];
      for (let x = start; step > 0 ? x < end : x > end; x += step) out.push(x);
      return new ListObj(out);
    },
  ],

  // ---------------------------------------------------------- strings
  [
    "split",
    [1, 2],
    "split(text, separator?): split on a separator, or on whitespace",
    ([t, sep]) => {
      const text = expect("split", t ?? null, isStr, "a string");
      if (sep === undefined) return new ListObj(text.trim() === "" ? [] : text.trim().split(/\s+/));
      return new ListObj(text.split(expect("split", sep, isStr, "a string separator")));
    },
  ],
  [
    "join",
    [1, 2],
    "join(xs, separator?): join items into a string",
    ([v, sep]) =>
      items("join", v ?? null)
        .map((x) => show(x))
        .join(sep === undefined ? "" : expect("join", sep, isStr, "a string separator")),
  ],
  ["upper", 1, "upper(text)", ([t]) => expect("upper", t ?? null, isStr, "a string").toUpperCase()],
  ["lower", 1, "lower(text)", ([t]) => expect("lower", t ?? null, isStr, "a string").toLowerCase()],
  [
    "trim",
    1,
    "trim(text): remove surrounding whitespace",
    ([t]) => expect("trim", t ?? null, isStr, "a string").trim(),
  ],
  [
    "starts_with",
    2,
    "starts_with(text, prefix)",
    ([t, p]) =>
      expect("starts_with", t ?? null, isStr, "a string").startsWith(
        expect("starts_with", p ?? null, isStr, "a string prefix"),
      ),
  ],
  [
    "ends_with",
    2,
    "ends_with(text, suffix)",
    ([t, p]) =>
      expect("ends_with", t ?? null, isStr, "a string").endsWith(
        expect("ends_with", p ?? null, isStr, "a string suffix"),
      ),
  ],
  [
    "replace",
    3,
    "replace(text, old, new): replace every occurrence",
    ([t, a, b]) =>
      expect("replace", t ?? null, isStr, "a string")
        .split(expect("replace", a ?? null, isStr, "a string"))
        .join(expect("replace", b ?? null, isStr, "a string")),
  ],
  [
    "chars",
    1,
    "chars(text): list of characters",
    ([t]) => new ListObj([...expect("chars", t ?? null, isStr, "a string")]),
  ],
  [
    "lines",
    1,
    "lines(text): list of lines",
    ([t]) => new ListObj(expect("lines", t ?? null, isStr, "a string").split(/\r?\n/)),
  ],
  [
    "pad_left",
    [2, 3],
    "pad_left(value, width, fill?)",
    ([v, w, f]) =>
      show(v ?? null).padStart(
        expect("pad_left", w ?? null, isInt, "a width"),
        f === undefined ? " " : expect("pad_left", f, isStr, "a fill string"),
      ),
  ],
  [
    "pad_right",
    [2, 3],
    "pad_right(value, width, fill?)",
    ([v, w, f]) =>
      show(v ?? null).padEnd(
        expect("pad_right", w ?? null, isInt, "a width"),
        f === undefined ? " " : expect("pad_right", f, isStr, "a fill string"),
      ),
  ],
  [
    "code",
    1,
    "code(char): Unicode code point",
    ([c]) => expect("code", c ?? null, isStr, "a character").codePointAt(0) ?? fail("code() of an empty string"),
  ],
  [
    "char",
    1,
    "char(code): character for a code point",
    ([n]) => {
      const c = expect("char", n ?? null, isInt, "a code point");
      if (c < 0 || c > 0x10ffff) fail("char(): code point out of range");
      return String.fromCodePoint(c);
    },
  ],
  [
    "fixed",
    2,
    "fixed(n, digits): format with a fixed number of decimals",
    ([n, d]) =>
      expect("fixed", n ?? null, isNum, "a number").toFixed(
        Math.min(20, Math.max(0, expect("fixed", d ?? null, isInt, "a digit count"))),
      ),
  ],

  // ------------------------------------------------------------- maps
  ["keys", 1, "keys(map)", ([m]) => new ListObj([...expect("keys", m ?? null, isMap, "a map").entries.keys()])],
  ["values", 1, "values(map)", ([m]) => new ListObj([...expect("values", m ?? null, isMap, "a map").entries.values()])],
  [
    "entries",
    1,
    "entries(map): list of [key, value] pairs",
    ([m]) =>
      new ListObj([...expect("entries", m ?? null, isMap, "a map").entries].map(([k, v]) => new ListObj([k, v]))),
  ],
  ["has", 2, "has(map, key)", ([m, k]) => expect("has", m ?? null, isMap, "a map").entries.has(String(k))],
  [
    "get",
    [2, 3],
    "get(collection, key, default?): a map value or list item, or the default when it is missing",
    ([m, k, d]) => {
      if (m instanceof ListObj) {
        if (typeof k !== "number" || !Number.isInteger(k))
          throw new RuntimeError(`get() expects a whole number index for a list, got ${typeName(k ?? null)}`);
        const i = k < 0 ? m.items.length + k : k;
        return i >= 0 && i < m.items.length ? (m.items[i] as Value) : (d ?? null);
      }
      const map = expect("get", m ?? null, isMap, "a map or a list");
      return map.entries.has(String(k)) ? (map.entries.get(String(k)) as Value) : (d ?? null);
    },
  ],
  [
    "delete",
    2,
    "delete(map, key): remove a key, return the map",
    ([m, k]) => {
      const map = expect("delete", m ?? null, isMap, "a map");
      map.entries.delete(String(k));
      return map;
    },
  ],
  [
    "merge",
    2,
    "merge(a, b): new map with the entries of both (b wins)",
    ([a, b]) =>
      new MapObj(
        new Map([
          ...expect("merge", a ?? null, isMap, "a map").entries,
          ...expect("merge", b ?? null, isMap, "a map").entries,
        ]),
      ),
  ],
  [
    "copy",
    1,
    "copy(xs): shallow copy of a list or map",
    ([v]) => {
      if (isList(v ?? null)) return new ListObj([...(v as ListObj).items]);
      if (isMap(v ?? null)) return new MapObj(new Map((v as MapObj).entries));
      return v ?? null;
    },
  ],

  // ------------------------------------------------------------- math
  ["abs", 1, "abs(n)", ([n]) => Math.abs(expect("abs", n ?? null, isNum, "a number"))],
  ["floor", 1, "floor(n)", ([n]) => Math.floor(expect("floor", n ?? null, isNum, "a number"))],
  ["ceil", 1, "ceil(n)", ([n]) => Math.ceil(expect("ceil", n ?? null, isNum, "a number"))],
  [
    "round",
    [1, 2],
    "round(n, digits?)",
    ([n, d]) => {
      const x = expect("round", n ?? null, isNum, "a number");
      const f = 10 ** (d === undefined ? 0 : expect("round", d, isInt, "a digit count"));
      return Math.round(x * f) / f;
    },
  ],
  [
    "sqrt",
    1,
    "sqrt(n)",
    ([n]) => {
      const x = expect("sqrt", n ?? null, isNum, "a number");
      if (x < 0) fail("sqrt() of a negative number");
      return Math.sqrt(x);
    },
  ],
  ["sin", 1, "sin(radians)", ([n]) => Math.sin(expect("sin", n ?? null, isNum, "a number"))],
  ["cos", 1, "cos(radians)", ([n]) => Math.cos(expect("cos", n ?? null, isNum, "a number"))],
  [
    "atan2",
    2,
    "atan2(y, x)",
    ([y, x]) =>
      Math.atan2(expect("atan2", y ?? null, isNum, "a number"), expect("atan2", x ?? null, isNum, "a number")),
  ],
  ["log", 1, "log(n): natural logarithm", ([n]) => Math.log(expect("log", n ?? null, isNum, "a number"))],
  ["random", 0, "random(): number in [0, 1)", (_a, ctx) => ctx.random()],
  [
    "random_int",
    2,
    "random_int(low, high): whole number in [low, high]",
    ([a, b], ctx) => {
      const lo = expect("random_int", a ?? null, isInt, "whole numbers");
      const hi = expect("random_int", b ?? null, isInt, "whole numbers");
      if (hi < lo) fail("random_int(): high must not be below low");
      return lo + Math.floor(ctx.random() * (hi - lo + 1));
    },
  ],
  [
    "choice",
    1,
    "choice(xs): a random item",
    ([v], ctx) => {
      const xs = items("choice", v ?? null);
      if (xs.length === 0) fail("choice() of an empty collection");
      return xs[Math.floor(ctx.random() * xs.length)] as Value;
    },
  ],
  [
    "shuffle",
    1,
    "shuffle(xs): shuffled copy",
    ([v], ctx) => {
      const xs = [...items("shuffle", v ?? null)];
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(ctx.random() * (i + 1));
        [xs[i], xs[j]] = [xs[j] as Value, xs[i] as Value];
      }
      return new ListObj(xs);
    },
  ],

  // ------------------------------------------------------ option/result
  [
    "unwrap",
    1,
    "unwrap(x): the value inside Some/Ok, or throw",
    ([v]) => {
      if (isObj(v ?? null) && (v as VariantObj).type === "variant") {
        const x = v as VariantObj;
        if (x.tag === "Some" || x.tag === "Ok") return x.fields[0] ?? null;
        if (x.tag === "None") fail("unwrap() called on None");
        if (x.tag === "Err") fail(`unwrap() called on Err(${show(x.fields[0] ?? null, true)})`);
      }
      return fail(`unwrap() expects an Option or Result, got ${describe(v ?? null)}`);
    },
  ],
  [
    "unwrap_or",
    2,
    "unwrap_or(x, default): value inside Some/Ok, or the default",
    ([v, d]) => {
      if (isObj(v ?? null) && (v as VariantObj).type === "variant") {
        const x = v as VariantObj;
        if (x.tag === "Some" || x.tag === "Ok") return x.fields[0] ?? null;
        if (x.tag === "None" || x.tag === "Err") return d ?? null;
      }
      return fail(`unwrap_or() expects an Option or Result, got ${describe(v ?? null)}`);
    },
  ],
  [
    "is_some",
    1,
    "is_some(x)",
    ([v]) => isObj(v ?? null) && (v as VariantObj).type === "variant" && (v as VariantObj).tag === "Some",
  ],
  [
    "is_ok",
    1,
    "is_ok(x)",
    ([v]) => isObj(v ?? null) && (v as VariantObj).type === "variant" && (v as VariantObj).tag === "Ok",
  ],

  // ------------------------------------------------------------- json
  [
    "to_json",
    [1, 2],
    "to_json(value, indent?): JSON text",
    ([v, indent]) =>
      JSON.stringify(
        toJson(v ?? null),
        null,
        indent === undefined ? undefined : expect("to_json", indent, isInt, "an indent"),
      ),
  ],
  [
    "from_json",
    1,
    "from_json(text): parse JSON into lists and maps",
    ([t]) => {
      try {
        return fromJson(JSON.parse(expect("from_json", t ?? null, isStr, "a string")));
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        return fail(`from_json(): invalid JSON (${(error as Error).message})`);
      }
    },
  ],
];

function extreme(fn: string, args: Value[], sign: number): Value {
  const xs = args.length === 1 ? items(fn, args[0] ?? null) : args;
  if (xs.length === 0) fail(`${fn}() of an empty collection`);
  return xs.reduce((best, x) => (compareValues(x, best) * sign > 0 ? x : best));
}

export interface Builtins {
  natives: NativeObj[];
  constants: [string, Value][];
}

export function builtins(): Builtins {
  const natives = DEFS.map(([name, arity, doc, fn]) => new NativeObj(name, arity, fn, doc));
  const constants: [string, Value][] = [
    ["PI", Math.PI],
    ["E", Math.E],
    ["INF", Infinity],
    ["Some", new ConstructorObj("Option", "Some", ["value"])],
    ["None", NONE],
    ["Ok", new ConstructorObj("Result", "Ok", ["value"])],
    ["Err", new ConstructorObj("Result", "Err", ["error"])],
  ];
  return { natives, constants };
}

/** Names the compiler should treat as defined. */
export function builtinNames(): string[] {
  return [...DEFS.map((d) => d[0]), "PI", "E", "INF", "Some", "None", "Ok", "Err", "__import", "__variant"];
}

/** The native used by `enum` declarations to create variant values and constructors. */
export const variantNative = new NativeObj("__variant", 3, ([enumName, tag, fields]) => {
  const names = (fields as ListObj).items.map(String);
  if (names.length === 0) return new VariantObj(enumName as string, tag as string, [], []);
  return new ConstructorObj(enumName as string, tag as string, names);
});

export { formatNumber, type NativeContext };
