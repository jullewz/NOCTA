#!/usr/bin/env node
/**
 * The `nocta` command.
 *
 *   nocta run FILE        run a program
 *   nocta FILE            same as `run`
 *   nocta test FILE...    run the `test` blocks of programs
 *   nocta check FILE...   report errors and warnings without running
 *   nocta disasm FILE     show the compiled bytecode
 *   nocta eval CODE       run code given on the command line
 *   nocta repl            interactive prompt (also: `nocta` with no arguments)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Nocta, NoctaError, renderDiagnostics, RuntimeError, type NoctaOptions } from "../lang/index.js";
import type { Diagnostic } from "../lang/source.js";

const VERSION = "0.1.0";
const color = process.stdout.isTTY && !process.env["NO_COLOR"];
const errColor = process.stderr.isTTY && !process.env["NO_COLOR"];
const paint = (text: string, code: string, on = color): string => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
const VIOLET = "38;2;167;139;250";
const DIM = "38;2;113;113;122";
const RED = "1;38;2;251;113;133";
const GREEN = "38;2;110;231;183";

const HELP = `${paint("nocta", `1;${VIOLET}`)} ${VERSION}: a small, expressive programming language

Usage:
  nocta [run] FILE [--steps N] [--seed N]   run a program
  nocta test FILE...                        run the test blocks in files
  nocta check FILE...                       report errors and warnings only
  nocta disasm FILE                         print the compiled bytecode
  nocta eval CODE                           run code from the command line
  nocta repl                                interactive prompt (the default)

Options:
  --steps N      stop after N instructions (guards against infinite loops)
  --seed N       seed random() for reproducible runs
  --no-warnings  hide warnings
  -h, --help     show this help
  -V, --version  show the version

Created by jullewz. https://github.com/jullewz/nocta`;

interface Flags {
  steps?: number;
  seed?: number;
  warnings: boolean;
}

/** Small deterministic generator (mulberry32) for --seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function options(flags: Flags): NoctaOptions {
  return {
    print: (line) => process.stdout.write(line + "\n"),
    ...(flags.steps !== undefined ? { maxSteps: flags.steps } : {}),
    ...(flags.seed !== undefined ? { random: seeded(flags.seed) } : {}),
    loadModule: (path, fromFile) => {
      const base = fromFile.startsWith("<") ? process.cwd() : dirname(resolve(fromFile));
      const file = resolve(base, path.endsWith(".nc") ? path : `${path}.nc`);
      if (!existsSync(file)) return null;
      return { name: displayName(file), text: readFileSync(file, "utf8") };
    },
  };
}

function displayName(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

function readSource(path: string): { name: string; text: string } {
  try {
    return { name: displayName(resolve(path)), text: readFileSync(path, "utf8") };
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
}

class UsageError extends Error {}

function report(diagnostics: Diagnostic[], flags: Flags): void {
  const shown = flags.warnings ? diagnostics : diagnostics.filter((d) => d.severity === "error");
  if (shown.length > 0) process.stderr.write(renderDiagnostics(shown, { color: errColor }) + "\n\n");
}

function reportRuntime(error: RuntimeError, nocta: Nocta): void {
  process.stderr.write(`${paint("runtime error", RED, errColor)}: ${error.message}\n`);
  const span = error.span;
  const file = span ? nocta.file(span.file) : undefined;
  if (span && file) {
    const { line, column } = file.position(span.start);
    const text = file.lineText(line);
    const gutter = String(line).length;
    const width = Math.max(1, Math.min(span.end, span.start + text.length) - span.start);
    process.stderr.write(`${" ".repeat(gutter)} ${paint("|", VIOLET, errColor)}\n`);
    process.stderr.write(`${paint(String(line), VIOLET, errColor)} ${paint("|", VIOLET, errColor)} ${text}\n`);
    process.stderr.write(
      `${" ".repeat(gutter)} ${paint("|", VIOLET, errColor)} ${" ".repeat(column - 1)}${paint("^".repeat(width), RED, errColor)}\n`,
    );
  }
  for (const frame of error.trace) process.stderr.write(`  ${paint("at", DIM, errColor)} ${frame}\n`);
}

function runFile(path: string, flags: Flags): number {
  const { name, text } = readSource(path);
  const nocta = new Nocta(options(flags));
  try {
    const result = nocta.run(name, text);
    report(result.warnings, flags);
    return 0;
  } catch (error) {
    if (error instanceof NoctaError) {
      report(nocta.compile(name, text).diagnostics, flags);
      return 1;
    }
    if (error instanceof RuntimeError) {
      reportRuntime(error, nocta);
      return 1;
    }
    throw error;
  }
}

function testFiles(paths: string[], flags: Flags): number {
  let passed = 0;
  let failed = 0;
  const started = Date.now();
  for (const path of paths) {
    const { name, text } = readSource(path);
    const nocta = new Nocta({ ...options(flags), print: () => {} });
    process.stdout.write(`${paint(name, `1;${VIOLET}`)}\n`);
    try {
      const { tests } = nocta.run(name, text);
      if (tests.length === 0) process.stdout.write(paint("  no tests\n", DIM));
      for (const r of nocta.runTests(tests)) {
        if (r.passed) {
          passed++;
          process.stdout.write(`  ${paint("✓", GREEN)} ${r.name} ${paint(`${r.ms} ms`, DIM)}\n`);
        } else {
          failed++;
          process.stdout.write(`  ${paint("✗", RED)} ${r.name}\n      ${r.error?.message ?? "failed"}\n`);
          const where = r.error?.trace.find((t) => !t.startsWith("…"));
          if (where) process.stdout.write(paint(`      at ${where}\n`, DIM));
        }
      }
    } catch (error) {
      failed++;
      if (error instanceof NoctaError) report(error.diagnostics, flags);
      else if (error instanceof RuntimeError) reportRuntime(error, nocta);
      else throw error;
    }
  }
  const summary = `${passed} passed, ${failed} failed (${Date.now() - started} ms)`;
  process.stdout.write(`\n${failed ? paint(summary, RED) : paint(summary, GREEN)}\n`);
  return failed ? 1 : 0;
}

function checkFiles(paths: string[], flags: Flags): number {
  let errors = 0;
  let warnings = 0;
  for (const path of paths) {
    const { name, text } = readSource(path);
    const out = new Nocta(options(flags)).compile(name, text);
    report(out.diagnostics, flags);
    errors += out.diagnostics.filter((d) => d.severity === "error").length;
    warnings += out.diagnostics.filter((d) => d.severity === "warning").length;
  }
  const line = `${paths.length} file${paths.length === 1 ? "" : "s"}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  process.stdout.write((errors ? paint(line, RED) : paint(line, GREEN)) + "\n");
  return errors ? 1 : 0;
}

function disasmFile(path: string, flags: Flags): number {
  const { name, text } = readSource(path);
  const nocta = new Nocta(options(flags));
  try {
    process.stdout.write(nocta.disassemble(name, text));
    return 0;
  } catch (error) {
    if (error instanceof NoctaError) {
      report(error.diagnostics, flags);
      return 1;
    }
    throw error;
  }
}

function evalCode(code: string, flags: Flags): number {
  const nocta = new Nocta(options(flags));
  try {
    const shown = nocta.eval(code, "<eval>");
    if (shown !== null) process.stdout.write(shown + "\n");
    return 0;
  } catch (error) {
    if (error instanceof NoctaError) report(error.diagnostics, flags);
    else if (error instanceof RuntimeError) reportRuntime(error, nocta);
    else throw error;
    return 1;
  }
}

/** Does this input need more lines? (unclosed brackets or a trailing operator) */
function incomplete(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth > 0 || /(\+|-|\*|\/|=|==|and|or|\|>|,|=>)\s*$/.test(text.trimEnd());
}

function repl(flags: Flags): Promise<number> {
  const nocta = new Nocta(options(flags));
  process.stdout.write(
    `${paint("nocta", `1;${VIOLET}`)} ${VERSION} ${paint("· type :help for commands, :quit to leave", DIM)}\n`,
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint("› ", VIOLET),
    terminal: process.stdin.isTTY,
  });
  let buffer = "";
  let counter = 0;
  rl.prompt();
  return new Promise((done) => {
    rl.on("line", (line) => {
      if (buffer === "" && line.trim().startsWith(":")) {
        const cmd = line.trim();
        if (cmd === ":quit" || cmd === ":q") {
          rl.close();
          return;
        }
        if (cmd === ":help") {
          process.stdout.write(
            `  :help              this message\n  :globals           names you defined\n  :builtins          built-in functions\n  :doc NAME          describe a built-in\n  :quit              leave\n  Multi-line input continues while brackets are open.\n`,
          );
        } else if (cmd === ":globals") {
          const builtins = builtinSet();
          const mine = [...nocta.vm.globals.keys()].filter((k) => !builtins.has(k));
          process.stdout.write((mine.join("  ") || "nothing defined yet") + "\n");
        } else if (cmd === ":builtins") {
          process.stdout.write(
            [...builtinSet()]
              .filter((k) => !k.startsWith("__"))
              .sort()
              .join("  ") + "\n",
          );
        } else if (cmd.startsWith(":doc")) {
          const name = cmd.slice(4).trim();
          const value = nocta.vm.globals.get(name);
          const doc = value && typeof value === "object" && "doc" in value ? String(value.doc) : "";
          process.stdout.write((doc || `no documentation for \`${name}\``) + "\n");
        } else process.stdout.write(`unknown command ${cmd}, try :help\n`);
        rl.prompt();
        return;
      }
      buffer += (buffer ? "\n" : "") + line;
      if (incomplete(buffer)) {
        rl.setPrompt(paint("… ", DIM));
        rl.prompt();
        return;
      }
      const code = buffer;
      buffer = "";
      rl.setPrompt(paint("› ", VIOLET));
      try {
        const shown = nocta.eval(code, `<repl ${++counter}>`);
        if (shown !== null) process.stdout.write(paint(shown, GREEN) + "\n");
      } catch (error) {
        if (error instanceof NoctaError) report(error.diagnostics, flags);
        else if (error instanceof RuntimeError) reportRuntime(error, nocta);
        else throw error;
      }
      rl.prompt();
    });
    rl.on("close", () => {
      process.stdout.write("\n");
      done(0);
    });
  });
}

let cachedBuiltins: Set<string> | null = null;
function builtinSet(): Set<string> {
  cachedBuiltins ??= new Set(new Nocta().vm.globals.keys());
  return cachedBuiltins;
}

async function main(argv: string[]): Promise<number> {
  const flags: Flags = { warnings: true };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP + "\n");
      return 0;
    }
    if (a === "-V" || a === "--version") {
      process.stdout.write(`nocta ${VERSION}\n`);
      return 0;
    }
    if (a === "--steps" || a === "--seed") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new UsageError(`${a} needs a whole number`);
      if (a === "--steps") flags.steps = n;
      else flags.seed = n;
    } else if (a === "--no-warnings") flags.warnings = false;
    else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else rest.push(a);
  }
  const [command, ...args] = rest;
  switch (command) {
    case undefined:
    case "repl":
      return repl(flags);
    case "run":
      if (args.length !== 1) throw new UsageError("usage: nocta run FILE");
      return runFile(args[0] as string, flags);
    case "test":
      if (args.length === 0) throw new UsageError("usage: nocta test FILE...");
      return testFiles(args, flags);
    case "check":
      if (args.length === 0) throw new UsageError("usage: nocta check FILE...");
      return checkFiles(args, flags);
    case "disasm":
      if (args.length !== 1) throw new UsageError("usage: nocta disasm FILE");
      return disasmFile(args[0] as string, flags);
    case "eval":
      if (args.length !== 1) throw new UsageError('usage: nocta eval "CODE"');
      return evalCode(args[0] as string, flags);
    default:
      if (args.length === 0 && (command.endsWith(".nc") || existsSync(command))) return runFile(command, flags);
      throw new UsageError(`unknown command "${command}"`);
  }
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`nocta: ${error.message}\nRun \`nocta --help\` for usage.\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  },
);
