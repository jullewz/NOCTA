import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Nocta, RuntimeError } from "../src/lang/index.js";
import { compileErrors, printed, run, runtimeError, value, warnings } from "./helpers.js";

describe("values and operators", () => {
  it("does arithmetic with the documented semantics", () => {
    assert.equal(value("1 + 2 * 3 - 4 / 2"), "5");
    assert.equal(value("2 ** 3 ** 2"), "512");
    assert.equal(value("-2 ** 2"), "-4");
    assert.equal(value("-7 % 3"), "2", "modulo is floored, like Python");
    assert.equal(value("0.1 + 0.2"), "0.3", "numbers print without float noise");
    assert.equal(value('"ab" * 3'), '"ababab"');
    assert.equal(value("[0] * 3"), "[0, 0, 0]");
    assert.equal(value("[1] + [2, 3]"), "[1, 2, 3]");
  });

  it("compares structurally", () => {
    assert.equal(value("[1, {a: [2]}] == [1, {a: [2]}]"), "true");
    assert.equal(value("{a: 1, b: 2} == {b: 2, a: 1}"), "true");
    assert.equal(value("Some([1]) == Some([1])"), "true");
    assert.equal(value("1..3 == 1..3"), "true");
    assert.equal(value('"a" < "b" and 2 >= 2'), "true");
  });

  it("short-circuits and treats only nil and false as falsy", () => {
    assert.equal(value("nil ?? 0 ?? 5"), "0");
    assert.equal(value('false or "x"'), '"x"');
    assert.equal(value("0 and []"), "[]");
    assert.equal(printed('fn boom() { throw "no" }\nprint(false and boom(), true or boom())'), "false true");
    assert.equal(value("not nil"), "true");
  });

  it("interpolates any expression into strings", () => {
    assert.equal(
      printed('let xs = [1, 2]\nprint("{xs} has {len(xs)} items, first {xs[0] + 10}, {"nested {xs[1]}"}")'),
      "[1, 2] has 2 items, first 11, nested 2",
    );
  });

  it("handles unicode text by code point", () => {
    assert.equal(value('len("héllo 🌍")'), "7");
    assert.equal(value('"héllo 🌍"[-1]'), '"🌍"');
    assert.equal(value('reverse("ab🌍")'), '"🌍ba"');
  });
});

describe("bindings and scope", () => {
  it("makes let immutable and var mutable", () => {
    assert.match(compileErrors("let a = 1\na = 2")[0]?.message ?? "", /declared with `let`/);
    assert.match(compileErrors("fn f() { let a = 1\n a += 1 }")[0]?.message ?? "", /declared with `let`/);
    assert.equal(value("var a = 1\na += 4\na *= 2\na"), "10");
  });

  it("shadows in inner blocks without leaking", () => {
    assert.equal(printed("let x = 1\n{ let x = 2\n print(x) }\nprint(x)"), "2\n1");
    assert.equal(compileErrors("{ let y = 1 }\nprint(y)")[0]?.code, "undefined-name");
  });

  it("catches undefined names before running anything", () => {
    const out = run('print("side effect")\nprint(undefined_thing)');
    assert.deepEqual(out.output, [], "nothing runs when compilation fails");
    assert.match(out.diagnostics[0]?.message ?? "", /is not defined/);
  });

  it("lets top-level functions call each other in any order", () => {
    assert.equal(
      value(
        "fn is_even(n) { if n == 0 { true } else { is_odd(n - 1) } }\nfn is_odd(n) { if n == 0 { false } else { is_even(n - 1) } }\nis_even(10)",
      ),
      "true",
    );
  });

  it("destructures lists and maps in let and for", () => {
    assert.equal(value("let [a, [b, c], ..rest] = [1, [2, 3], 4, 5]\n[a, b, c, rest]"), "[1, 2, 3, [4, 5]]");
    assert.equal(value('let {name, info: {age}} = {name: "Ada", info: {age: 36}}\n"{name} {age}"'), '"Ada 36"');
    assert.equal(value("var t = 0\nfor [k, v] in [[1, 2], [3, 4]] { t += k * v }\nt"), "14");
    assert.match(runtimeError("let [a, b] = [1]"), /does not match/);
  });
});

describe("functions and closures", () => {
  it("returns the last expression, or an explicit return", () => {
    assert.equal(value('fn f(x) { if x > 0 { return "pos" }\n "other" }\n[f(1), f(-1)]'), '["pos", "other"]');
    assert.equal(value("let sq = fn(x) => x * x\nsq(9)"), "81");
  });

  it("captures variables by reference and keeps them alive", () => {
    assert.equal(value("fn counter() { var n = 0\n fn() { n += 1\n n } }\nlet c = counter()\nc()\nc()\nc()"), "3");
    assert.equal(value("var shared = 0\nlet inc = fn() => shared += 1\ninc()\ninc()\nshared"), "2");
  });

  it("gives each loop iteration its own variable", () => {
    assert.equal(value("let fs = []\nfor i in 0..3 { fs.push(fn() => i) }\nfs.map(fn(f) => f())"), "[0, 1, 2]");
  });

  it("supports deep recursion and reports runaway recursion", () => {
    assert.equal(value("fn sum_to(n) { if n == 0 { 0 } else { n + sum_to(n - 1) } }\nsum_to(5000)"), "12502500");
    assert.match(runtimeError("fn f(n) { f(n + 1) }\nf(0)"), /stack overflow/);
  });

  it("checks argument counts", () => {
    assert.match(runtimeError("fn f(a, b) { a }\nf(1)"), /takes 2 arguments but got 1/);
    assert.match(runtimeError("len()"), /takes 1 argument/);
    assert.match(runtimeError("5()"), /cannot call a number/);
  });

  it("calls any function as a method on its first argument", () => {
    assert.equal(value("[3, 1, 2].sort().reverse().map(fn(x) => x * 10)"), "[30, 20, 10]");
    assert.equal(value('fn shout(s) { upper(s) + "!" }\n"hi".shout()'), '"HI!"');
    assert.equal(value('let obj = {greet: fn(n) => "hi {n}"}\nobj.greet("there")'), '"hi there"');
    assert.match(runtimeError("[1].nonexistent()"), /has no method `nonexistent`/);
  });
});

describe("control flow", () => {
  it("treats if, match, blocks and try as expressions", () => {
    assert.equal(value('let x = if 1 > 2 { "a" } else if 2 > 1 { "b" } else { "c" }\nx'), '"b"');
    assert.equal(value("let y = { let a = 2\n a * 21 }\ny"), "42");
    assert.equal(value("if false { 1 }"), null);
  });

  it("breaks and continues nested loops, including inside try and match", () => {
    assert.equal(
      value("var out = []\nfor i in 0..10 { if i % 2 == 0 { continue }\n if i > 7 { break }\n out.push(i) }\nout"),
      "[1, 3, 5, 7]",
    );
    assert.equal(value("var n = 0\nwhile true { try { n += 1\n if n == 3 { break } } catch e { } }\nn"), "3");
    assert.equal(
      value("var seen = []\nfor x in [1, 2, 3, 4] { match x { 2 => continue, 4 => break, v => seen.push(v) } }\nseen"),
      "[1, 3]",
    );
  });

  it("iterates lists, ranges, strings and maps", () => {
    assert.equal(value('var s = ""\nfor c in "abc" { s = c + s }\ns'), '"cba"');
    assert.equal(value("var t = 0\nfor i in 1..=4 { t += i }\nt"), "10");
    assert.equal(value("var ks = []\nfor k in {x: 1, y: 2} { ks.push(k) }\nks"), '["x", "y"]');
    assert.match(runtimeError("for x in 5 { }"), /cannot loop over a number/);
  });
});

describe("pattern matching", () => {
  it("matches literals, ranges, guards, alternatives and bindings", () => {
    const classify =
      'fn c(n) { match n { 0 => "zero", 1 | 2 | 3 => "small", 4..10 => "medium", n if n < 0 => "negative", _ => "large" } }\n';
    assert.equal(value(classify + "[0, 2, 9, 10, -5].map(c)"), '["zero", "small", "medium", "large", "negative"]');
  });

  it("matches nested lists, maps and enum variants", () => {
    const code = `enum Tree { Leaf(value), Node(left, right) }
fn total(t) { match t { Leaf(v) => v, Node(l, r) => total(l) + total(r) } }
fn depth(t) { match t { Leaf(_) => 1, Node(l, r) => 1 + max(depth(l), depth(r)) } }
let t = Node(Leaf(1), Node(Leaf(2), Node(Leaf(3), Leaf(4))))
[total(t), depth(t), match {pos: [3, 4]} { {pos: [x, y]} => x * y }]`;
    assert.equal(value(code), "[10, 4, 12]");
  });

  it("exposes variant fields by name and through the enum map", () => {
    assert.equal(value("enum Shape { Rect(w, h) }\nlet r = Shape.Rect(2, 5)\nr.w * r.h"), "10");
    assert.match(runtimeError("enum Shape { Rect(w, h) }\nRect(1, 2).radius"), /has no field `radius`/);
    assert.match(runtimeError("enum Shape { Rect(w, h) }\nRect(1)"), /takes 2 arguments/);
  });

  it("fails clearly when nothing matches, and warns about unreachable arms", () => {
    assert.match(runtimeError("match 7 { 1 => 1 }"), /no match arm matched the value 7/);
    assert.ok(warnings("let x = match 1 { _ => 1, 2 => 2 }").some((w) => /never match/.test(w.message)));
    assert.match(compileErrors("match 1 { Sone(x) => x }")[0]?.hint ?? "", /Some/);
    assert.match(compileErrors("match 1 { Some(a, b) => a }")[0]?.message ?? "", /has 1 field/);
  });
});

describe("errors", () => {
  it("catches thrown values of any type", () => {
    assert.equal(value("try { throw {code: 42} } catch e { e.code }"), "42");
    assert.equal(value("try { 1 } catch e { 2 }"), "1");
  });

  it("catches runtime errors, including ones raised inside callbacks", () => {
    assert.equal(value("try { [1, 2, 3].map(fn(x) => 10 / (x - 2)) } catch e { e }"), '"division by zero"');
    assert.equal(value('[1, 2].map(fn(x) => try { [][x] } catch e { "caught" })'), '["caught", "caught"]');
  });

  it("unwinds nested functions to the right handler and restores the stack", () => {
    const code = `fn inner(n) { if n == 0 { throw "bottom" }
 inner(n - 1) }
let r = try { inner(50) } catch e { "got {e}" }
let after = [1, 2, 3].sum()
[r, after]`;
    assert.equal(value(code), '["got bottom", 6]');
  });

  it("reports uncaught errors with a trace through every frame", () => {
    const out = run("fn a() { b() }\nfn b() { [].pop() }\na()");
    assert.match(out.error?.message ?? "", /pop\(\) on an empty list/);
    assert.deepEqual(
      out.error?.trace.map((t) => t.split(" ")[0]),
      ["b", "a", "<script>"],
    );
  });

  it("stops infinite loops with the step limit", () => {
    const out = run("while true { }", { maxSteps: 10_000 });
    assert.match(out.error?.message ?? "", /step limit/);
  });

  it("gives friendly messages for common type mistakes", () => {
    assert.match(runtimeError('"total: " + 5'), /use interpolation/);
    assert.match(runtimeError("[1, 2][2]"), /index 2 is out of range for a list of length 2/);
    assert.match(runtimeError("[1].length"), /add parentheses/);
    assert.match(runtimeError('1 < "2"'), /cannot compare number with string/);
    assert.match(runtimeError("1 / 0"), /division by zero/);
    assert.match(runtimeError('let s = "abc"\ns[0] = "x"'), /cannot be changed in place/);
  });
});

describe("warnings", () => {
  it("flags unused locals, unreachable code and duplicate keys", () => {
    const codes = (code: string) => warnings(code).map((w) => w.code);
    assert.deepEqual(codes("fn f() { let unused = 1\n 2 }"), ["unused-variable"]);
    assert.deepEqual(codes("fn f() { let _ignored = 1\n 2 }"), []);
    assert.deepEqual(codes("fn f() { return 1\n print(2) }"), ["unreachable"]);
    assert.deepEqual(codes("let m = {a: 1, a: 2}"), ["duplicate-key"]);
  });
});

describe("the interpreter API", () => {
  it("keeps state between REPL inputs and only commits names that compiled", () => {
    const nocta = new Nocta({ print: () => {} });
    nocta.eval("let base = 10");
    nocta.eval("fn add(x) { x + base }");
    assert.equal(nocta.eval("add(5)"), "15");
    assert.throws(() => nocta.eval("let broken = undefined_name"));
    assert.throws(() => nocta.eval("broken"), /not defined/);
  });

  it("runs test blocks and reports failures individually", () => {
    const nocta = new Nocta({ print: () => {} });
    const { tests } = nocta.run(
      "t.nc",
      'fn double(x) { x * 2 }\ntest "works" { assert_eq(double(2), 4) }\ntest "fails" { assert_eq(double(2), 5) }',
    );
    const results = nocta.runTests(tests);
    assert.deepEqual(
      results.map((r) => r.passed),
      [true, false],
    );
    assert.match(results[1]?.error?.message ?? "", /expected 5, got 4/);
  });

  it("imports modules through the host loader, once, with isolated globals", () => {
    let loads = 0;
    const modules: Record<string, string> = {
      util: "let secret = 7\nfn triple(x) { x * 3 }",
      loop: 'import "loop" as again',
    };
    const nocta = new Nocta({
      print: () => {},
      loadModule: (path) => {
        loads++;
        const text = modules[path];
        return text === undefined ? null : { name: `${path}.nc`, text };
      },
    });
    assert.equal(nocta.eval('import "util" as u\nimport "util" as v\n[u.triple(u.secret), v.secret]'), "[21, 7]");
    assert.equal(loads, 2, "the loader is consulted, but the module runs only once");
    assert.throws(() => nocta.eval("secret"), /not defined/);
    assert.throws(
      () => nocta.eval('import "missing" as m'),
      (e) => e instanceof RuntimeError && /not found/.test(e.message),
    );
    assert.throws(
      () => nocta.eval('import "loop" as l'),
      (e) => e instanceof RuntimeError && /circular import/.test(e.message),
    );
  });

  it("disassembles every function", () => {
    const listing = new Nocta().disassemble("d.nc", "fn add(a, b) { a + b }\nprint(add(1, 2))");
    assert.match(listing, /== <script>/);
    assert.match(listing, /== add \(arity 2/);
    assert.match(listing, /Closure/);
    assert.match(listing, /\s+Add/);
  });
});

describe("examples", () => {
  const cases = ["hello", "fizzbuzz", "closures", "patterns", "algorithms", "inventory", "life", "errors"];
  for (const name of cases) {
    it(`examples/${name}.nc prints the expected output`, () => {
      const code = readFileSync(new URL(`../../examples/${name}.nc`, import.meta.url), "utf8");
      const expected = readFileSync(new URL(`../../tests/expected/${name}.out`, import.meta.url), "utf8");
      assert.equal(printed(code) + "\n", expected);
    });
  }

  it("examples/testing.nc passes its own tests", () => {
    const code = readFileSync(new URL("../../examples/testing.nc", import.meta.url), "utf8");
    const nocta = new Nocta({ print: () => {} });
    const { tests } = nocta.run("testing.nc", code);
    assert.equal(tests.length, 3);
    assert.ok(nocta.runTests(tests).every((r) => r.passed));
  });
});

describe("playground", () => {
  it("runs the tour program without warnings and passes its test", async () => {
    const { TOUR } = await import("../src/web/tour.js");
    const lines: string[] = [];
    const nocta = new Nocta({ print: (line) => lines.push(line) });
    const { warnings, tests } = nocta.run("tour.nc", TOUR);
    assert.deepEqual(warnings, []);
    assert.equal(lines[0], "total area: 34.78");
    assert.ok(nocta.runTests(tests).every((t) => t.passed));
  });
});
