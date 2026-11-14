/**
 * Public API: compile and run Nocta programs.
 *
 *   const nocta = new Nocta({ print: (line) => console.log(line) });
 *   const result = nocta.run("main.nc", 'print("hello")');
 */

import { disassemble, type FnProto } from "../runtime/bytecode.js";
import { builtinNames, builtins, variantNative } from "../runtime/stdlib.js";
import { ClosureObj, ModuleObj, NativeObj, RuntimeError, show, type Value } from "../runtime/values.js";
import { VM, type VMOptions } from "../runtime/vm.js";
import { Compiler, newEnv, type CompiledTest, type CompilerEnv } from "./compiler.js";
import { parse } from "./parser.js";
import { NoctaError, SourceFile, type Diagnostic } from "./source.js";

export interface NoctaOptions extends VMOptions {
  /** Resolve and read an imported module. Return null when it does not exist. */
  loadModule?: (path: string, fromFile: string) => { name: string; text: string } | null;
}

export interface CompileOutput {
  file: SourceFile;
  script: FnProto;
  tests: CompiledTest[];
  diagnostics: Diagnostic[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: RuntimeError;
  ms: number;
}

export class Nocta {
  readonly vm: VM;
  private readonly env: CompilerEnv;
  private readonly files = new Map<string, SourceFile>();
  private readonly builtinSet: Set<string>;
  private readonly loading = new Set<string>();
  private readonly modules = new Map<string, ModuleObj>();

  constructor(private readonly options: NoctaOptions = {}) {
    this.vm = new VM({ ...options, files: this.files });
    const { natives, constants } = builtins();
    for (const n of natives) this.vm.defineNative(n);
    for (const [name, value] of constants) this.vm.globals.set(name, value);
    this.vm.defineNative(variantNative);
    this.vm.defineNative(new NativeObj("__import", 1, ([path]) => this.importModule(String(path))));
    this.builtinSet = new Set(builtinNames());
    this.env = newEnv(this.builtinSet);
  }

  /** Parse and compile. Never throws for program errors: they come back as diagnostics. */
  compile(name: string, text: string, options: { returnLast?: boolean } = {}): CompileOutput {
    const file = new SourceFile(name, text);
    this.files.set(name, file);
    const parsed = parse(file);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      return { file, script: null as unknown as FnProto, tests: [], diagnostics: parsed.diagnostics };
    }
    // compile against a copy of the environment so a failed compilation leaves no half-declared names behind
    const env: CompilerEnv = { globals: new Map(this.env.globals), variants: new Map(this.env.variants) };
    const result = new Compiler(file, env).compile(parsed.program, options);
    const diagnostics = [...parsed.diagnostics, ...result.diagnostics];
    if (!diagnostics.some((d) => d.severity === "error")) {
      for (const [k, v] of env.globals) this.env.globals.set(k, v);
      for (const [k, v] of env.variants) this.env.variants.set(k, v);
    }
    return { file, script: result.script, tests: result.tests, diagnostics };
  }

  /** Compile and run. Throws NoctaError for compile errors and RuntimeError for runtime errors. */
  run(
    name: string,
    text: string,
    options: { returnLast?: boolean } = {},
  ): { value: Value; warnings: Diagnostic[]; tests: CompiledTest[] } {
    const out = this.compile(name, text, options);
    const errors = out.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) throw new NoctaError(errors);
    const value = this.vm.run(out.script);
    return { value, warnings: out.diagnostics.filter((d) => d.severity === "warning"), tests: out.tests };
  }

  /** REPL: run one input and return the value of its last expression, shown as the REPL would. */
  eval(text: string, name = "<repl>"): string | null {
    const { value } = this.run(name, text, { returnLast: true });
    return value === null ? null : show(value, true);
  }

  /** Run the `test` blocks of an already executed program. */
  runTests(tests: CompiledTest[]): TestResult[] {
    return tests.map((t) => {
      const started = this.vm.now();
      try {
        this.vm.call(new ClosureObj(t.proto, []), []);
        return { name: t.name, passed: true, ms: this.vm.now() - started };
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        return { name: t.name, passed: false, error, ms: this.vm.now() - started };
      }
    });
  }

  disassemble(name: string, text: string): string {
    const out = this.compile(name, text);
    const errors = out.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) throw new NoctaError(errors);
    let listing = disassemble(out.script, (offset) => out.file.position(offset));
    for (const t of out.tests) listing += disassemble(t.proto, (offset) => out.file.position(offset));
    return listing;
  }

  file(name: string): SourceFile | undefined {
    return this.files.get(name);
  }

  private importModule(path: string): Value {
    const from = this.vm.currentSpan()?.file ?? "<main>";
    const loaded = this.options.loadModule?.(path, from);
    if (!loaded) throw new RuntimeError(`cannot import "${path}": module not found`);
    const cached = this.modules.get(loaded.name);
    if (cached) return cached;
    if (this.loading.has(loaded.name)) throw new RuntimeError(`circular import of "${path}"`);
    this.loading.add(loaded.name);
    try {
      // a module runs in its own interpreter, so its globals do not leak into the importer
      const child = new Nocta(this.options);
      for (const [k, v] of this.modules) child.modules.set(k, v);
      for (const k of this.loading) child.loading.add(k);
      try {
        child.run(loaded.name, loaded.text);
      } catch (error) {
        if (error instanceof NoctaError) {
          throw new RuntimeError(
            `cannot import "${path}": ${error.diagnostics.length} error(s) in ${loaded.name}: ${error.diagnostics[0]?.message ?? ""}`,
          );
        }
        if (error instanceof RuntimeError)
          throw new RuntimeError(`error while importing "${path}": ${error.message}`, error.value);
        throw error;
      }
      const module = VM.moduleFrom(path.replace(/^.*[\\/]/, "").replace(/\.nc$/, ""), child.vm, this.builtinSet);
      this.modules.set(loaded.name, module);
      return module;
    } finally {
      this.loading.delete(loaded.name);
    }
  }
}

export { NoctaError, RuntimeError, SourceFile, show };
export { renderDiagnostic, renderDiagnostics, type Diagnostic } from "./source.js";
