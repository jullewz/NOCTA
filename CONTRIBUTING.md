# Contributing to Nocta

Thanks for your interest. Bug reports, language proposals and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/jullewz/nocta.git
cd nocta
npm install
npm run watch     # terminal 1: recompile on change
npm run serve     # terminal 2: playground at http://127.0.0.1:5173
```

Run a file with `node dist/src/cli/main.js run FILE`, or `npm link` once to get the `nocta` command.

## Before a pull request

```bash
npm test
npm run typecheck
npm run format:check
```

## Where things go

Read [docs/architecture.md](docs/architecture.md) first. Short version:

| Change | Files |
| --- | --- |
| New syntax | `ast.ts`, `parser.ts`, `compiler.ts`, tests in `tests/frontend.test.ts` and `tests/language.test.ts` |
| New instruction | `bytecode.ts` (`Op`, `OPERANDS`), `stackEffect` in `compiler.ts`, `dispatch` in `vm.ts` |
| New built-in function | `stdlib.ts`, with a doc string in the form `"name(args): description"` |
| New diagnostic | a stable kebab-case code, and a row in the table in `docs/language.md` |

### Adding a built-in function

1. Add an entry to the table in `src/runtime/stdlib.ts`. Validate arguments with `expect(...)` so errors read
   `sort() expects a list, got a number`.
2. Add it to a group in `scripts/stdlib-docs.mjs` and run `npm run docs`.
3. Add tests to `tests/stdlib.test.ts`, including the error case.

### Adding an instruction

The compiler tracks the exact stack depth, so every new opcode needs its stack effect in `stackEffect`. A wrong
effect shows up as wrong local slots: the tests for expressions inside lists and calls catch most mistakes.

## Rules

- No runtime dependencies. The compiler and runtime must not import Node.js modules, because the playground runs
  them in the browser.
- Every error message says what went wrong and, where possible, how to fix it.
- Examples in `examples/` have their exact output checked in `tests/expected/`. Update the `.out` file when you
  change an example on purpose.
- Strict TypeScript and Prettier formatting.

## Proposing language changes

Open an issue with the language proposal template first. Show the code you want to write and the code you write
today. Small and predictable beats clever.
