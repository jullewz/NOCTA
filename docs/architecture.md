# Architecture

Nocta turns source text into bytecode and runs it on a stack machine. Every stage lives in its own file and has no
runtime dependencies. The compiler and VM use no Node.js APIs, so the same code runs in the CLI and the browser.

```text
source ──► Lexer ──► Parser ──► Compiler ──► FnProto (bytecode) ──► VM
            │          │            │                                 │
            └──────────┴────────────┴──► Diagnostic[]                 └──► RuntimeError (message, span, trace)
```

| File | Role |
| --- | --- |
| `src/lang/source.ts` | `SourceFile` (offset to line and column), `Diagnostic`, `NoctaError`, the rustc-style renderer, edit distance for "did you mean" |
| `src/lang/lexer.ts` | Tokens, string interpolation, escapes, the `newlineBefore` flag that ends statements |
| `src/lang/ast.ts` | Expression, statement and pattern node types |
| `src/lang/parser.ts` | Pratt parser with error recovery |
| `src/lang/compiler.ts` | Name resolution, scopes, closures, pattern compilation, warnings |
| `src/lang/index.ts` | The public `Nocta` class: compile, run, eval, tests, modules |
| `src/runtime/values.ts` | Value representation, equality, printing |
| `src/runtime/bytecode.ts` | Opcodes, `Chunk`, `FnProto`, the disassembler |
| `src/runtime/vm.ts` | The interpreter loop, calls, exceptions, upvalues, stack traces |
| `src/runtime/stdlib.ts` | The built-in functions |

## Lexer

The lexer produces a flat token list. Each token records whether a line break came before it. The parser uses that
flag to end statements, so Nocta needs no semicolons and still knows that `f\n(x)` is two statements.

A string with `{...}` becomes a token with `parts`: literal text and nested token lists. The lexer runs a nested
lexer over each interpolated part, so any expression works inside a string.

## Parser

The parser is a Pratt parser. Each infix operator has a binding power:

| Power | Operators |
| --- | --- |
| 2 | `\|>` |
| 3 | `??` |
| 4 | `or` |
| 5 | `and` |
| 7 | comparisons (non-associative) |
| 8 | `..` `..=` |
| 9 | `+` `-` |
| 10 | `*` `/` `%` |
| 11 | unary `-` and `not` |
| 12 | `**` (right-associative) |

The parser rewrites pipelines on the spot: `x |> f(a)` becomes the call `f(x, a)` and `x |> obj.m()` becomes the
method call `obj.m(x)`.

**Recovery.** After a syntax error the parser records a diagnostic and skips to the next statement boundary: a new
line or `;` at the same brace depth. One typo produces one error, and errors further down still get reported.

**Ambiguity of `{`.** In expression position `{` starts a map when the next tokens are `}` or a key followed by
`:`, `,` or `}`. Otherwise it starts a block. This looks at two tokens and needs no backtracking.

## Compiler

The compiler walks the AST once and emits bytecode into a `FnProto` per function. It resolves every name while it
compiles:

1. A **local** lives in a stack slot of the current frame (`GetLocal slot`).
2. An **upvalue** is a local of an enclosing function, captured by a closure (`GetUpvalue index`).
3. A **global** is a top-level name or a built-in (`GetGlobal name`).

A name that is none of these is a compile error, with a hint found by edit distance over every visible name.
Top-level functions and enums are declared before any code is compiled, so they can refer to each other in any
order.

**Exact stack depth.** The compiler tracks how many values are on the stack at every instruction. A local's slot is
its real position, even when it is declared in the middle of an expression such as `[1, match x { n => n }]`,
where the list's first item sits below the match subject. `break`, `continue` and `return` pop exactly what lies
above their target.

**Scopes and blocks.** A block that is used as a value ends with `Collapse n`: it removes the block's `n` locals
from under the result and closes any upvalues they hold. A block used as a statement pops its locals instead.

**Closures.** Following the design of clox, a captured local stays on the stack while its function runs. An
`Upvalue` object points at the slot. When the slot goes out of scope, `CloseUpvalue` copies the value into the
upvalue, and every closure that shares it keeps seeing the same variable. Loop bodies are new scopes, so each
iteration's closures get their own variables.

**Patterns** compile in two phases. The test phase checks the shape without binding anything: `MatchList`,
`MatchMap`, `HasKey`, `MatchVariant` and `MatchRange` push booleans followed by `PopJumpIfFalse` to the next arm.
The binding phase runs only when the whole pattern matched. It reads each bound value by its path from the subject,
for example field 1 of index 0, and declares it as a local. An `|` pattern that binds names becomes one arm per
alternative. A failed guard pops the arm's bindings before it tries the next arm.

**Enums.** `enum Shape { Circle(r) }` compiles to a call of the internal `__variant` native, which creates a
constructor, and a map `Shape` that holds every constructor.

**Warnings.** Unused locals, unreachable match arms and duplicate map keys produce warnings with stable codes.

## Values

```ts
type Value = number | string | boolean | null | Obj;
```

Numbers, strings, booleans and `nil` are JavaScript primitives. Everything else is a class: `ListObj`, `MapObj`
(a JavaScript `Map` with string keys, so insertion order is kept), `ClosureObj`, `NativeObj`, `RangeObj`,
`VariantObj`, `ConstructorObj`, `ModuleObj` and `IterObj`. `equals` compares structure. `show` prints values the
way the REPL does, and handles cycles.

## Bytecode

A `Chunk` is a flat `number[]` of opcodes and operands, a constant table with deduplication, and a source span per
instruction. Jump operands are absolute offsets. Run `nocta disasm FILE` or open the Bytecode tab in the
playground to see the output. This is the start of `area` from the README:

```text
== area (arity 1, 0 upvalues, 53 bytes) ==
00000    7  GetLocal           1
00002    8  GetLocal           2
00004    |  MatchVariant       0    1 Shape.Circle 1
00007    |  PopJumpIfFalse    25
00009    |  GetLocal           2
...
```

| Group | Instructions |
| --- | --- |
| Constants and stack | `Const k`, `Nil`, `True`, `False`, `Pop`, `Dup`, `Swap`, `DupTwo`, `Collapse n` |
| Variables | `GetLocal`/`SetLocal slot`, `GetUpvalue`/`SetUpvalue i`, `GetGlobal`/`DefineGlobal`/`SetGlobal k` |
| Arithmetic and logic | `Add`, `Sub`, `Mul`, `Div`, `Mod`, `Pow`, `Neg`, `Not`, `Eq`, `Ne`, `Lt`, `Le`, `Gt`, `Ge` |
| Jumps | `Jump`, `JumpIfFalse`, `JumpIfTrue`, `JumpIfNotNil` (these keep the value), `PopJumpIfFalse` |
| Calls | `Call argc`, `Invoke name argc` (method syntax), `Return`, `Closure k ...captures`, `CloseUpvalue` |
| Data | `List n`, `Map n`, `IndexGet`, `IndexSet`, `MemberGet k`, `MemberSet k`, `Range incl`, `Concat n` |
| Iteration | `IterInit`, `IterNext exit` |
| Patterns | `MatchList min exact`, `MatchMap`, `MatchVariant tag n`, `MatchRange incl`, `MatchType k`, `HasKey k`, `ListSlice start`, `Field i`, `MatchFail` |
| Errors | `Throw`, `TryBegin handler`, `TryEnd` |

`Invoke name argc` looks up `name` on the receiver first. A map field that holds a function is called. Otherwise
the VM falls back to the global function of that name with the receiver as the first argument. This is how
`xs.map(f)` reaches the built-in `map`.

## Virtual machine

The VM keeps one value stack, a list of call frames (`closure`, `ip`, `base`) and a list of exception handlers
(`frameCount`, `ip`, `sp`). Slot 0 of every frame holds the function being called. Arguments follow it.

**Exceptions.** `TryBegin` pushes a handler. When a `throw` or a runtime error happens, `raise` takes the newest
handler, drops the frames above it, closes upvalues above its stack pointer, restores the stack and jumps to the
`catch` code with the error value on top. Without a handler the error leaves the VM as a `RuntimeError` that carries
the source span and a stack trace.

**Re-entrancy.** Built-ins like `map` and `sort` call back into Nocta code. `execute(stopDepth)` runs the
interpreter loop until the frame count drops back to `stopDepth`, so a native can call a closure and get its result
like any JavaScript function. A handler outside the native's call still catches errors thrown inside the callback,
because `raise` only uses handlers above `stopDepth` and otherwise rethrows through the native.

**Guards.** Every instruction counts toward `maxSteps`. A call deeper than `maxFrames` (10,000) raises a catchable
"stack overflow". Stack traces fold runs of identical frames into one line, so deep recursion produces a readable
trace.

## Modules and tests

`import "path" as name` compiles to a call of the internal `__import` native. The host's `loadModule` callback finds
and reads the file. The CLI resolves paths relative to the importing file. The module runs in its own `Nocta`
instance, and its globals become the fields of a `ModuleObj`. Modules are cached, and a module that is still loading
when it is imported again is reported as a circular import.

`test` blocks compile to separate functions. `nocta run` ignores them. `nocta test` runs the program, then calls each
test function and reports the ones that raised an error.

## Embedding API

```ts
const nocta = new Nocta({
  print: (line) => {},          // where print() writes
  maxSteps: 1_000_000,          // instruction budget
  maxFrames: 10_000,            // call depth
  random: () => 0.5,            // random source, for reproducible runs
  now: () => Date.now(),        // clock() source
  loadModule: (path, from) => ({ name: "geo.nc", text: "..." }), // or null
});

nocta.compile(name, text)        // { script, tests, diagnostics }: never throws for program errors
nocta.run(name, text)            // { value, warnings, tests }: throws NoctaError or RuntimeError
nocta.eval(text)                 // the last value as the REPL shows it, or null
nocta.runTests(tests)            // [{ name, passed, error, ms }]
nocta.disassemble(name, text)    // the bytecode listing
```

One `Nocta` instance keeps its globals between calls, which is how the REPL remembers earlier lines. A compile
error leaves the instance unchanged.
