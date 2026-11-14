import { Nocta, NoctaError, RuntimeError, type NoctaOptions } from "../src/lang/index.js";
import type { Diagnostic } from "../src/lang/source.js";

export interface Outcome {
  output: string[];
  value: string | null;
  error?: RuntimeError;
  diagnostics: Diagnostic[];
}

/** Run a program and capture everything it printed, plus its errors. */
export function run(code: string, options: NoctaOptions = {}): Outcome {
  const output: string[] = [];
  const nocta = new Nocta({ print: (line) => output.push(line), random: mulberry(1), ...options });
  try {
    const value = nocta.eval(code, "test.nc");
    const diagnostics = nocta.compile("again.nc", code).diagnostics;
    return { output, value, diagnostics };
  } catch (error) {
    if (error instanceof NoctaError) return { output, value: null, diagnostics: error.diagnostics };
    if (error instanceof RuntimeError) return { output, value: null, error, diagnostics: [] };
    throw error;
  }
}

/** Value of the last expression, as the REPL shows it. Throws on errors so tests fail loudly. */
export function value(code: string): string | null {
  const out = run(code);
  if (out.error) throw new Error(`runtime error: ${out.error.message}`);
  const errors = out.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`compile error: ${errors.map((d) => d.message).join("; ")}`);
  return out.value;
}

export function printed(code: string): string {
  const out = run(code);
  if (out.error) throw new Error(`runtime error: ${out.error.message}`);
  const errors = out.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`compile error: ${errors.map((d) => d.message).join("; ")}`);
  return out.output.join("\n");
}

export function runtimeError(code: string): string {
  const out = run(code);
  if (!out.error)
    throw new Error(
      `expected a runtime error, got value ${out.value} and diagnostics ${out.diagnostics.map((d) => d.message)}`,
    );
  return out.error.message;
}

export function compileErrors(code: string): Diagnostic[] {
  return run(code).diagnostics.filter((d) => d.severity === "error");
}

export function warnings(code: string): Diagnostic[] {
  return new Nocta().compile("w.nc", code).diagnostics.filter((d) => d.severity === "warning");
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
