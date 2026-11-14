import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtimeError, value } from "./helpers.js";

describe("standard library", () => {
  it("collections", () => {
    assert.equal(value("[1, 2, 3, 4].filter(fn(x) => x % 2 == 0).map(fn(x) => x * x)"), "[4, 16]");
    assert.equal(value("reduce([1, 2, 3], fn(a, x) => a * 10 + x, 0)"), "123");
    assert.equal(value('sort(["pear", "fig", "apple"], fn(s) => len(s))'), '["fig", "pear", "apple"]');
    assert.equal(value('[[2, "b"], [1, "z"], [1, "a"]].sort()'), '[[1, "a"], [1, "z"], [2, "b"]]');
    assert.equal(value('zip([1, 2, 3], ["a", "b"])'), '[[1, "a"], [2, "b"]]');
    assert.equal(value("[1, 1, 2, [3], [3]].unique()"), "[1, 2, [3]]");
    assert.equal(value("chunks(1..=7, 3)"), "[[1, 2, 3], [4, 5, 6], [7]]");
    assert.equal(value("flatten([[1], [2, [3]], 4])"), "[1, 2, [3], 4]");
    assert.equal(
      value('group_by([1, 2, 3, 4], fn(n) => if n % 2 == 0 { "even" } else { "odd" })'),
      "{odd: [1, 3], even: [2, 4]}",
    );
    assert.equal(value("[min([4, 2, 8]), max(4, 9, 1), sum(1..=100)]"), "[2, 9, 5050]");
    assert.equal(value("[any([0, nil]), all([1, true]), count(1..10, fn(n) => n > 5)]"), "[true, true, 4]");
    assert.equal(
      value('[take(1..10, 2), drop([1, 2, 3], 2), slice([1, 2, 3, 4], 1, 3), slice("hello", 1)]'),
      '[[1, 2], [3], [2, 3], "ello"]',
    );
    assert.equal(
      value("var xs = [1, 2]\nxs.push(3, 4)\nxs.insert(0, 0)\n[xs.pop(), xs.remove_at(-1), xs]"),
      "[4, 3, [0, 1, 2]]",
    );
    assert.equal(value("[range(3), range(1, 10, 4), range(5, 0, -2)]"), "[[0, 1, 2], [1, 5, 9], [5, 3, 1]]");
    assert.equal(value("[find([1, 5, 9], fn(x) => x > 4), find([], fn(x) => true)]"), "[Some(5), None]");
    assert.equal(
      value('[contains([1, 2], 2), contains("team", "ea"), index_of([5, 6], 6), index_of("héllo", "l")]'),
      "[true, true, 1, 2]",
    );
  });

  it("strings", () => {
    assert.equal(value('split("a,b,,c", ",")'), '["a", "b", "", "c"]');
    assert.equal(value('split("  lots   of space ")'), '["lots", "of", "space"]');
    assert.equal(value('["x", 1, nil].join("-")'), '"x-1-nil"');
    assert.equal(
      value('[upper("ab"), lower("CD"), trim("  e  "), replace("a-b-c", "-", "+")]'),
      '["AB", "cd", "e", "a+b+c"]',
    );
    assert.equal(
      value('[pad_left(7, 3, "0"), pad_right("ab", 4) + "|", fixed(3.14159, 2)]'),
      '["007", "ab  |", "3.14"]',
    );
    assert.equal(
      value('[starts_with("nocta", "no"), ends_with("nocta", "ta"), code("A"), char(97)]'),
      '[true, true, 65, "a"]',
    );
    assert.equal(value('lines("a\\nb\\r\\nc")'), '["a", "b", "c"]');
  });

  it("maps", () => {
    assert.equal(
      value("let m = {b: 2, a: 1}\n[keys(m), values(m), entries(m)]"),
      '[["b", "a"], [2, 1], [["b", 2], ["a", 1]]]',
    );
    assert.equal(
      value('let m = {a: 1}\n[has(m, "a"), get(m, "z", 0), m.missing, merge(m, {b: 2})]'),
      "[true, 0, nil, {a: 1, b: 2}]",
    );
    assert.equal(value('let m = {a: 1, b: 2}\ndelete(m, "a")\nm'), "{b: 2}");
    assert.equal(value("let a = {x: [1]}\nlet b = copy(a)\nb.y = 2\n[a, b]"), "[{x: [1]}, {x: [1], y: 2}]");
  });

  it("conversions and math", () => {
    assert.equal(
      value('[num("42"), num(" 3.5 "), num("x"), num(true), int(-3.7), str(1.5), type([]), type(Some(1))]'),
      '[42, 3.5, nil, 1, -3, "1.5", "list", "Option"]',
    );
    assert.equal(value("[abs(-2), floor(2.7), ceil(2.1), round(2.567, 2), sqrt(81)]"), "[2, 2, 3, 2.57, 9]");
    assert.equal(value('[len([1, 2]), len("abc"), len({a: 1}), len(0..5), len(1..=5)]'), "[2, 3, 1, 5, 5]");
    assert.match(runtimeError("sqrt(-1)"), /negative/);
  });

  it("option and result helpers", () => {
    assert.equal(
      value(
        '[unwrap(Some(3)), unwrap_or(None, 4), unwrap(Ok(5)), unwrap_or(Err("x"), 6), is_some(None), is_ok(Ok(1))]',
      ),
      "[3, 4, 5, 6, false, true]",
    );
    assert.match(runtimeError("unwrap(None)"), /called on None/);
    assert.match(runtimeError('unwrap(Err("bad"))'), /Err\("bad"\)/);
  });

  it("json round trips", () => {
    assert.equal(
      value('from_json(to_json({a: [1, true, nil, "s"], b: {c: 2.5}}))'),
      '{a: [1, true, nil, "s"], b: {c: 2.5}}',
    );
    assert.equal(value("to_json([1, {a: 2}], 0)"), '"[1,{\\"a\\":2}]"');
    assert.match(runtimeError('from_json("\\{nope")'), /invalid JSON/);
  });

  it("random functions use the host's seeded source", () => {
    const a = value('[random_int(1, 6), random_int(1, 6), choice(["a", "b", "c"]), shuffle(1..=5)]');
    assert.equal(a, value('[random_int(1, 6), random_int(1, 6), choice(["a", "b", "c"]), shuffle(1..=5)]'));
    assert.equal(value("let xs = (1..=200).map(fn(_) => random_int(1, 3))\n[min(xs), max(xs)]"), "[1, 3]");
  });

  it("validates arguments with clear messages", () => {
    assert.match(runtimeError("map(5, fn(x) => x)"), /map\(\) expects a list, range, string or map, got a number/);
    assert.match(runtimeError('sort([1, "a"])'), /cannot compare/);
    assert.match(runtimeError("keys([1])"), /keys\(\) expects a map, got a list/);
    assert.match(runtimeError("upper(1)"), /expects a string, got a number/);
    assert.match(runtimeError("chunks([1], 0)"), /at least 1/);
    assert.match(runtimeError('assert(1 == 2, "math")'), /assertion failed: math/);
  });
});

describe("get", () => {
  it("reads list items and map values with a default", () => {
    assert.equal(value("get([1, 2, 3], 1)"), "2");
    assert.equal(value("get([1, 2, 3], -1)"), "3");
    assert.equal(value("get([1, 2, 3], 9, 0)"), "0");
    assert.equal(value('get({a: 1}, "b", "none")'), '"none"');
    assert.match(runtimeError('get([1], "x")'), /whole number index/);
  });
});
