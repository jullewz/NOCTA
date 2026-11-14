# The Nocta language

This guide covers every feature of Nocta 0.1. Each example runs as shown. Paste any of them into the playground or
run them with `nocta eval`.

- [Basics](#basics)
- [Values and types](#values-and-types)
- [Variables](#variables)
- [Operators](#operators)
- [Strings](#strings)
- [Lists, maps and ranges](#lists-maps-and-ranges)
- [Control flow](#control-flow)
- [Functions and closures](#functions-and-closures)
- [Method calls and pipelines](#method-calls-and-pipelines)
- [Pattern matching](#pattern-matching)
- [Enums, Option and Result](#enums-option-and-result)
- [Errors](#errors)
- [Modules](#modules)
- [Tests](#tests)
- [Diagnostics](#diagnostics)
- [Limits](#limits)

## Basics

A program is a list of statements. A new line ends a statement. Use `;` to put two statements on one line.
Comments start with `//` and run to the end of the line.

```nocta
print("hello")      // hello
let a = 1; let b = 2
```

A line that ends in the middle of an expression continues on the next line. So does a line that starts with
`|>`, `??` or `.`:

```nocta
let total = [1, 2, 3]
  |> map(fn(n) => n * 10)
  |> sum()
```

Function calls and indexing must start on the same line as the value: `f\n(x)` is two statements.

## Values and types

| Type | Examples | `type(value)` |
| --- | --- | --- |
| nil | `nil` | `"nil"` |
| boolean | `true`, `false` | `"boolean"` |
| number | `42`, `3.14`, `1_000_000`, `1e-3` | `"number"` |
| string | `"text"`, `"sum: {1 + 2}"` | `"string"` |
| list | `[1, "two", [3]]` | `"list"` |
| map | `{name: "Ada", "with space": 1}` | `"map"` |
| range | `0..10`, `1..=9` | `"range"` |
| function | `fn(x) => x`, `print` | `"function"` |
| enum value | `Some(1)`, `Circle(2)` | the enum name, e.g. `"Option"` |

Numbers are 64-bit floats. They print with up to 15 significant digits, so `0.1 + 0.2` prints `0.3`.

**Truthiness.** Only `nil` and `false` are false. `0`, `""` and `[]` are true.

**Equality.** `==` compares structure: `[1, {a: 2}] == [1, {a: 2}]` is `true`. Functions are equal only to
themselves.

## Variables

`let` makes a binding that cannot be reassigned. `var` makes one that can.

```nocta
let limit = 10
var count = 0
count += 1          // also -=, *=, /=
limit = 11          // compile error: cannot assign to `limit`: it was declared with `let`
```

`let` stops reassignment, not mutation: a list bound with `let` still accepts `push`.

Names are resolved at compile time. Using an undefined name is a compile error with a suggestion for the closest
known name. Declaring the same name twice in one scope is an error. An inner scope can shadow an outer name.

Blocks `{ ... }` make a new scope. Unused local variables produce a warning. Prefix a name with `_` to silence it.

## Operators

From lowest to highest precedence:

| Operators | Meaning |
| --- | --- |
| `\|>` | pipeline: `x \|> f(a)` is `f(x, a)` |
| `??` | `a ?? b` is `a` unless `a` is `nil` |
| `or` | returns the first true operand, or the last |
| `and` | returns the first false operand, or the last |
| `==` `!=` `<` `<=` `>` `>=` | comparisons (they do not chain) |
| `..` `..=` | ranges, end excluded or included |
| `+` `-` | add, subtract; `+` also joins strings and lists |
| `*` `/` `%` | multiply, divide, floored modulo |
| `-` `not` | unary minus, logical not |
| `**` | power, right-associative: `2 ** 3 ** 2` is `512` |

Details:

- `/` always divides exactly: `7 / 2` is `3.5`. Use `floor(7 / 2)` or `int(7 / 2)` for whole numbers.
- `%` is floored like Python: `-7 % 3` is `2`.
- Dividing by zero is a runtime error, not `INF`.
- `"ab" * 3` is `"ababab"` and `[0] * 3` is `[0, 0, 0]`.
- `<` and friends compare two numbers or two strings. Mixing types is an error.
- `"a" + 1` is an error. Use interpolation: `"a{1}"`.
- `-2 ** 2` is `-4`: the power binds tighter than the minus.

## Strings

Strings use double quotes. Anything in `{ }` is evaluated and inserted:

```nocta
let name = "Ada"
print("{name} has {len(name)} letters")   // Ada has 3 letters
print("braces: \{ and \}")                // braces: { and }
```

Escapes: `\n` `\t` `\r` `\0` `\\` `\"` `\{` `\}` and `\u{1F600}`.

Strings are immutable and indexed by code point, so `"héllo"[1]` is `"é"` and `len("héllo")` is `5`. Negative
indexes count from the end. See the [standard library](stdlib.md#strings) for `split`, `join`, `replace`,
`pad_left` and the rest.

## Lists, maps and ranges

```nocta
let xs = [10, 20, 30]
xs[0]               // 10
xs[-1]              // 30
xs[1] = 25          // lists are mutable
xs.push(40)

let user = {name: "Ada", age: 36}
user.name           // "Ada"
user["age"]         // 36
user.email          // nil: a missing key reads as nil
user.email = "ada@example.com"
let city = "Oslo"
let place = {city}  // shorthand for {city: city}
```

Map keys are strings. Write a key as a name (`{age: 1}`) or a string (`{"first name": "Ada"}`). Maps keep insertion
order.

Reading a list index outside the list is a runtime error. Use `get(xs, i)` or `first(xs)` for a nil result
instead.

Ranges are lazy sequences of numbers: `0..3` is 0, 1, 2 and `0..=3` adds 3. Use `list(range)` to make a list.

**A note on `{`.** At the start of an expression, `{` opens a map when it is followed by `}` or by a key and `:`,
`,` or `}`. Otherwise it opens a block. So `{a: 1}` and `{a}` are maps, and `{ let a = 1\n a }` is a block.

## Control flow

`if`, `match`, `try` and blocks are expressions. Their value is the value of their last expression.

```nocta
let label = if score >= 90 { "A" } else if score >= 75 { "B" } else { "C" }

let area = {
  let w = 3
  let h = 4
  w * h
}
```

An `if` without `else` gives `nil` when the condition is false.

Loops:

```nocta
for item in ["a", "b"] { print(item) }
for i in 0..3 { print(i) }
for [key, value] in entries({x: 1}) { print("{key}={value}") }
for key in {x: 1, y: 2} { print(key) }     // maps loop over their keys
for ch in "hey" { print(ch) }              // strings loop over characters

var n = 3
while n > 0 {
  n -= 1
  if n == 1 { continue }
  print(n)
}
```

`break` and `continue` work in both loops. They can also be the body of a match arm:
`match x { 0 => break, n => n }`.

## Functions and closures

```nocta
fn add(a, b) { a + b }          // the last expression is returned
fn sign(n) {
  if n < 0 { return -1 }        // or return early
  if n == 0 { return 0 }
  1
}
let square = fn(x) => x * x     // expression body
let shout = fn(text) {
  let loud = upper(text)
  "{loud}!"
}
```

Functions are values. They can be stored, passed and returned. Calling a function with the wrong number of
arguments is a runtime error that names the function. Top-level functions can call each other in any order.

Functions capture the variables around them. Captured `var` variables stay shared and mutable:

```nocta
fn counter() {
  var n = 0
  fn() {
    n += 1
    n
  }
}
let next = counter()
next()
next()              // 2
```

Each loop iteration gets fresh variables, so closures made in a loop capture that iteration's value.

## Method calls and pipelines

`value.f(a, b)` calls `f(value, a, b)` when `value` has no field named `f`. This works for every function,
built-in or your own:

```nocta
fn twice(x) { x * 2 }
[3, 1, 2].sort().map(twice)     // [2, 4, 6]
"a,b".split(",").join(" + ")    // "a + b"
```

When a map has a field holding a function, `m.f(x)` calls that function instead: `{f: fn(x) => x}.f(1)` is `1`.

`|>` passes the left side as the first argument. A bare function name works too:

```nocta
let words = "the quick brown fox"
  |> split(" ")
  |> filter(fn(w) => len(w) > 3)
  |> map(upper)
```

## Pattern matching

`match` tries each arm in order and runs the first that matches. Arms are separated by commas or new lines.

```nocta
fn describe(value) {
  match value {
    nil => "nothing"
    0 => "zero"
    1..=9 => "a digit"
    "hi" | "hello" => "a greeting"
    [] => "an empty list"
    [x] => "one item: {x}"
    [first, ..rest] => "{first} and {len(rest)} more"
    {name, age} if age >= 18 => "{name}, an adult"
    {name} => "{name}"
    Some(inner) => "some {inner}"
    n if type(n) == "number" => "the number {n}"
    _ => "something else"
  }
}
```

| Pattern | Matches |
| --- | --- |
| `_` | anything, binds nothing |
| `name` | anything, binds it to `name` |
| `42`, `"text"`, `true`, `nil` | an equal value |
| `1..10`, `1..=9` | a number in the range |
| `[a, b]` | a list of exactly two items |
| `[a, ..rest]`, `[a, ..]` | a list of at least one item |
| `{key, other: pattern}` | a map with these keys (extra keys are fine) |
| `Circle(r)`, `None` | an enum variant |
| `p1 \| p2` | either pattern |
| `pattern if condition` | the pattern, when the guard is true |

A capitalised name in a pattern is a variant (`None`, `Red`), a lower-case name is a binding. Patterns nest
freely: `{pos: [x, y]}` or `Some(Rect(w, h))`.

When no arm matches, `match` raises a runtime error that shows the value. An arm after a catch-all arm gets an
"unreachable" warning.

`let` and `for` take patterns too. A failed `let` pattern is a runtime error:

```nocta
let [x, y] = [3, 4]
let {name, langs: [main, ..]} = {name: "Ada", langs: ["en", "fr"]}
for [i, word] in enumerate(["a", "b"]) { print("{i}: {word}") }
```

## Enums, Option and Result

```nocta
enum Color { Red, Green, Blue }
enum Shape {
  Circle(radius)
  Rect(width, height)
}

let s = Rect(3, 4)
s.width             // 3: fields are readable by name
type(s)             // "Shape"
Shape.Circle        // the constructor, through the enum
s == Rect(3, 4)     // true
```

Variants without fields are values (`Red`). Variants with fields are constructors (`Circle(2)`). Calling a
constructor with the wrong number of arguments is an error.

Two enums are built in:

- `Option`: `Some(value)` and `None`, for values that might be missing.
- `Result`: `Ok(value)` and `Err(error)`, for operations that might fail.

`unwrap`, `unwrap_or`, `is_some` and `is_ok` work on both. Functions like `find` return an `Option`.

## Errors

Any value can be thrown. `try`/`catch` is an expression:

```nocta
fn parse_age(text) {
  let n = num(text)
  if n == nil { throw {code: "not_a_number", input: text} }
  n
}

let age = try { parse_age("abc") } catch err { -1 }
let message = try { 1 / 0 } catch e { "failed: {e}" }   // runtime errors are caught as strings
```

The `catch` name is optional: `try { risky() } catch { "fallback" }`.

An uncaught error stops the program and prints the message, the source line and a stack trace. Deep recursion
becomes a catchable "stack overflow" error after 10,000 nested calls. Long runs of the same frame are folded in the
trace.

## Modules

Every top-level name in a file is exported. Import a file relative to the importing file, without the `.nc`
extension:

```nocta
// geometry.nc
fn area(w, h) { w * h }

// main.nc
import "geometry" as geo
print(geo.area(3, 4))
```

A module runs once, the first time it is imported. Its globals do not leak into the importer. Circular imports are
an error. The playground has no file system, so it cannot import modules.

## Tests

`test` blocks sit next to the code they check. `nocta run` skips them and `nocta test` runs them:

```nocta
fn slugify(text) { text.lower().trim().split().join("-") }

test "slugify joins words with dashes" {
  assert_eq(slugify("  Hello Nocta World "), "hello-nocta-world")
}
```

A test passes when it finishes without an error. `assert(condition, message?)` and
`assert_eq(actual, expected, message?)` raise errors with clear messages. Each test runs after the program's
top-level code, so it sees every global.

## Diagnostics

The compiler reports every error it finds, not only the first. Each diagnostic has a code:

| Code | Severity | Example |
| --- | --- | --- |
| `syntax` | error | a missing `)` or an unexpected token |
| `undefined-name` | error | using a name that was never declared, with a "did you mean" hint |
| `immutable` | error | assigning to a `let` binding |
| `unused-variable` | warning | a local variable that is never read |
| `unreachable` | warning | a match arm after a catch-all arm |
| `duplicate-key` | warning | the same key twice in a map literal |

`nocta check` reports diagnostics without running the program. `--no-warnings` hides warnings.

## Limits

- 50 million instructions in the playground. The CLI has no limit unless you pass `--steps N`.
- 10,000 nested calls.
- 250 local variables per function and 65,536 constants per chunk.
- Reserved words: `let var fn if else while for in break continue return match record enum true false nil and or
  not try catch throw import as test`. `record` has no meaning yet.
