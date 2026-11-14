# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions can change the language.

## [0.1.0] - 2026-11-14

First public release.

### Language

- `let` and `var` bindings, blocks, `if`, `while`, `for`, `break`, `continue`, `return`
- Numbers, strings with `{}` interpolation, booleans, `nil`, lists, maps, ranges
- Functions, closures with shared mutable captures, method-call syntax for every function, `|>` pipelines
- `match` with literal, range, list (with `..rest`), map, variant, `|` and guard patterns; destructuring `let` and `for`
- `enum` declarations, built-in `Option` (`Some`, `None`) and `Result` (`Ok`, `Err`)
- `throw` of any value, `try`/`catch` expressions, catchable runtime errors and stack overflows
- `import "path" as name` modules
- `test "name" { }` blocks

### Tooling

- Bytecode compiler with compile-time name resolution and exact stack tracking
- Stack-based virtual machine with re-entrant natives, a step limit and folded stack traces
- Diagnostics with source frames, hints and codes: `syntax`, `undefined-name`, `immutable`, `unused-variable`,
  `unreachable`, `duplicate-key`
- About 85 built-in functions, documented in `docs/stdlib.md`
- `nocta` CLI: `run`, `test`, `check`, `disasm`, `eval` and a multi-line REPL
- Browser playground with highlighting, live diagnostics, a test runner, a bytecode view, examples and share links

[0.1.0]: https://github.com/jullewz/nocta/releases/tag/v0.1.0
