/**
 * The browser playground: an editor with highlighting and live diagnostics, a console, a problems
 * list and a bytecode view. Everything runs locally in the page. Nothing is sent to a server.
 */

import { Nocta, NoctaError, RuntimeError, type Diagnostic } from "../lang/index.js";
import { TOUR } from "./tour.js";

const EXAMPLES: [file: string, label: string][] = [
  ["tour", "A quick tour"],
  ["hello", "Hello"],
  ["fizzbuzz", "FizzBuzz"],
  ["closures", "Closures and counters"],
  ["patterns", "Pattern matching"],
  ["algorithms", "Algorithms"],
  ["inventory", "Records and pipelines"],
  ["errors", "Errors and Result"],
  ["life", "Game of Life"],
  ["testing", "Test blocks"],
];

const KEYWORDS = new Set([
  "let",
  "var",
  "fn",
  "if",
  "else",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "return",
  "match",
  "record",
  "enum",
  "true",
  "false",
  "nil",
  "and",
  "or",
  "not",
  "try",
  "catch",
  "throw",
  "import",
  "as",
  "test",
]);
const STEP_LIMIT = 50_000_000;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const source = $<HTMLTextAreaElement>("source");
const highlight = $<HTMLPreElement>("highlight");
const gutter = $<HTMLDivElement>("gutter");
const output = $<HTMLPreElement>("output");
const problems = $<HTMLUListElement>("problems");
const problemCount = $<HTMLSpanElement>("problem-count");
const bytecode = $<HTMLPreElement>("bytecode");
const statusText = $<HTMLSpanElement>("status");
const stats = $<HTMLSpanElement>("stats");
const cursor = $<HTMLSpanElement>("cursor");
const examples = $<HTMLSelectElement>("examples");
const toast = $<HTMLDivElement>("toast");

let diagnostics: Diagnostic[] = [];
let runtimeLine = 0;
let bytecodeStale = true;

// ---------------------------------------------------------------- highlighting

type Cls = "" | "kw" | "str" | "interp" | "num" | "com" | "type" | "fn" | "op";

/** Give every character of `text[start, end)` a token class. */
function scan(text: string, start: number, end: number, out: Cls[]): void {
  let i = start;
  const fill = (from: number, to: number, cls: Cls): void => {
    for (let k = from; k < to; k++) out[k] = cls;
  };
  while (i < end) {
    const c = text[i] ?? "";
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < end && text[j] !== "\n") j++;
      fill(i, j, "com");
      i = j;
    } else if (c === '"') {
      i = scanString(text, i, end, out);
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, end));
      const len = m?.[0].length ?? 1;
      fill(i, i + len, "num");
      i += len;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, end));
      const word = m?.[0] ?? c;
      let cls: Cls = "";
      if (KEYWORDS.has(word)) cls = "kw";
      else if (/^[A-Z]/.test(word)) cls = "type";
      else if (text[i + word.length] === "(") cls = "fn";
      fill(i, i + word.length, cls);
      i += word.length;
    } else if (/[-+*/%=<>!|?.&]/.test(c)) {
      out[i] = "op";
      i++;
    } else {
      i++;
    }
  }
}

/** A string starting at the quote at `i`. Interpolated `{...}` parts are highlighted as code. */
function scanString(text: string, i: number, end: number, out: Cls[]): number {
  out[i++] = "str";
  while (i < end && text[i] !== '"' && text[i] !== "\n") {
    if (text[i] === "\\") {
      out[i++] = "str";
      if (i < end) out[i++] = "str";
    } else if (text[i] === "{") {
      out[i] = "interp";
      let depth = 1;
      let j = i + 1;
      while (j < end && depth > 0 && text[j] !== "\n") {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        else if (text[j] === '"') {
          // skip a nested string
          j++;
          while (j < end && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        }
        if (depth > 0) j++;
      }
      scan(text, i + 1, j, out);
      if (j < end && text[j] === "}") out[j++] = "interp";
      i = j;
    } else {
      out[i++] = "str";
    }
  }
  if (i < end && text[i] === '"') out[i++] = "str";
  return i;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(): void {
  const text = source.value;
  const classes: Cls[] = new Array<Cls>(text.length).fill("");
  scan(text, 0, text.length, classes);
  // squiggles: 0 none, 1 warning, 2 error
  const marks = new Uint8Array(text.length);
  for (const d of diagnostics) {
    const level = d.severity === "error" ? 2 : 1;
    const from = Math.min(d.span.start, Math.max(0, text.length - 1));
    const to = Math.max(from + 1, Math.min(d.span.end, text.length));
    for (let k = from; k < to; k++) marks[k] = Math.max(marks[k] ?? 0, level);
  }
  let html = "";
  let k = 0;
  while (k < text.length) {
    const cls = classes[k];
    const mark = marks[k];
    let j = k + 1;
    while (j < text.length && classes[j] === cls && marks[j] === mark && text[j] !== "\n") j++;
    const chunk = escapeHtml(text.slice(k, j));
    const names = [cls ? `t-${cls}` : "", mark ? `squiggle${mark === 1 ? " w" : ""}` : ""].filter(Boolean).join(" ");
    html += names ? `<span class="${names}">${chunk}</span>` : chunk;
    k = j;
  }
  highlight.innerHTML = html + "\n";

  const lines = text.split("\n").length;
  const errorLines = new Set<number>();
  const warnLines = new Set<number>();
  for (const d of diagnostics)
    (d.severity === "error" ? errorLines : warnLines).add(d.file.position(d.span.start).line);
  if (runtimeLine) errorLines.add(runtimeLine);
  let numbers = "";
  for (let n = 1; n <= lines; n++) {
    const cls = errorLines.has(n) ? "err" : warnLines.has(n) ? "warn" : "";
    numbers += (cls ? `<span class="${cls}">${n}</span>` : String(n)) + "\n";
  }
  gutter.innerHTML = numbers;
}

// ---------------------------------------------------------------- diagnostics

function check(): void {
  const nocta = new Nocta({ print: () => {} });
  diagnostics = nocta.compile("main.nc", source.value).diagnostics;
  showProblems();
  render();
}

function showProblems(): void {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  problemCount.hidden = diagnostics.length === 0;
  problemCount.textContent = String(diagnostics.length);
  problemCount.classList.toggle("warn", errors === 0);
  if (diagnostics.length === 0) {
    problems.innerHTML = `<li class="empty">No problems found.</li>`;
    return;
  }
  problems.innerHTML = "";
  for (const d of diagnostics) {
    const { line, column } = d.file.position(d.span.start);
    const li = document.createElement("li");
    li.className = d.severity;
    li.innerHTML =
      `<span class="where">${line}:${column}</span>${escapeHtml(d.severity)}: ${escapeHtml(d.message)}` +
      (d.hint ? `<span class="hint">hint: ${escapeHtml(d.hint)}</span>` : "");
    li.addEventListener("click", () => jumpTo(d.span.start, d.span.end));
    problems.appendChild(li);
  }
}

function jumpTo(start: number, end: number): void {
  source.focus();
  source.setSelectionRange(start, end);
  const line = source.value.slice(0, start).split("\n").length;
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 21;
  const editor = $<HTMLDivElement>("editor");
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  updateCursor();
}

// ---------------------------------------------------------------- running

function append(text: string, cls = ""): void {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
}

function run(withTests: boolean): void {
  selectTab("output");
  output.textContent = "";
  runtimeLine = 0;
  bytecodeStale = true;
  let printed = 0;
  const nocta = new Nocta({
    maxSteps: STEP_LIMIT,
    print: (line) => {
      printed++;
      if (printed <= 5000) append(line + "\n");
      else if (printed === 5001) append("… output truncated after 5000 lines\n", "dim");
    },
  });
  const started = performance.now();
  try {
    const { warnings, tests } = nocta.run("main.nc", source.value);
    diagnostics = warnings;
    if (withTests) {
      if (tests.length === 0) append("this program has no `test` blocks\n", "dim");
      const results = nocta.runTests(tests);
      for (const r of results) {
        if (r.passed) append(`✓ ${r.name}\n`, "ok");
        else append(`✗ ${r.name}: ${r.error?.message ?? "failed"}\n`, "err");
      }
      const failed = results.filter((r) => !r.passed).length;
      const plural = results.length === 1 ? "test" : "tests";
      setStatus(
        failed ? `${failed} of ${results.length} ${plural} failed` : `${results.length} ${plural} passed`,
        failed ? "err" : "ok",
      );
    } else {
      if (printed === 0) append("(the program printed nothing)\n", "dim");
      setStatus("Finished", "ok");
    }
  } catch (error) {
    if (error instanceof NoctaError) {
      diagnostics = error.diagnostics;
      append(
        `${error.diagnostics.filter((d) => d.severity === "error").length} compile error(s). See Problems.\n`,
        "err",
      );
      setStatus("Compile error", "err");
      showProblems();
      selectTab("problems");
    } else if (error instanceof RuntimeError) {
      const span = error.span;
      let where = "";
      if (span) {
        const pos = nocta.file(span.file)?.position(span.start);
        if (pos) {
          runtimeLine = pos.line;
          where = ` (line ${pos.line}, column ${pos.column})`;
        }
      }
      append(`runtime error${where}: ${error.message}\n`, "err");
      for (const frame of error.trace) append(`  at ${frame}\n`, "dim");
      setStatus("Runtime error", "err");
    } else {
      append(`internal error: ${String(error)}\n`, "err");
      setStatus("Internal error", "err");
    }
  }
  const ms = performance.now() - started;
  stats.textContent = `${nocta.vm.steps.toLocaleString()} steps · ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  showProblems();
  render();
}

function setStatus(text: string, cls: "ok" | "err" | "" = ""): void {
  statusText.textContent = text;
  statusText.className = cls;
}

function showBytecode(): void {
  if (!bytecodeStale) return;
  bytecodeStale = false;
  try {
    const listing = new Nocta({ print: () => {} }).disassemble("main.nc", source.value);
    bytecode.innerHTML = escapeHtml(listing).replace(/^(==.*==)$/gm, '<span class="fn">$1</span>');
  } catch (error) {
    bytecode.textContent = error instanceof NoctaError ? "Fix the compile errors to see the bytecode." : String(error);
  }
}

// ---------------------------------------------------------------- tabs, editing, sharing

function selectTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
    const on = tab.dataset["tab"] === name;
    tab.setAttribute("aria-selected", String(on));
    $(`panel-${tab.dataset["tab"] ?? ""}`).hidden = !on;
  }
  if (name === "bytecode") showBytecode();
}

function updateCursor(): void {
  const before = source.value.slice(0, source.selectionStart);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  cursor.textContent = `${line}:${column}`;
}

let timer = 0;
function changed(): void {
  bytecodeStale = true;
  runtimeLine = 0;
  render();
  window.clearTimeout(timer);
  timer = window.setTimeout(check, 250);
}

function insert(text: string): void {
  // execCommand keeps the browser's undo history; fall back to setRangeText where it is missing
  if (!document.execCommand("insertText", false, text)) {
    source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
    changed();
  }
}

source.addEventListener("input", changed);
source.addEventListener("keyup", updateCursor);
source.addEventListener("click", updateCursor);
source.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    run(event.shiftKey);
    return;
  }
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    insert("  ");
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    // keep the indentation of the current line, and indent once more after `{`, `[` or `(`
    const before = source.value.slice(0, source.selectionStart);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    let indent = /^\s*/.exec(line)?.[0] ?? "";
    if (/[{[(]\s*$/.test(line)) indent += "  ";
    event.preventDefault();
    insert("\n" + indent);
  }
});

for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
  tab.addEventListener("click", () => selectTab(tab.dataset["tab"] ?? "output"));
}
$("run").addEventListener("click", () => run(false));
$("test").addEventListener("click", () => run(true));

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function notify(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  window.setTimeout(() => (toast.hidden = true), 2200);
}

$("share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#code=${encode(source.value)}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    notify("Link copied to the clipboard");
  } catch {
    notify("The link is in the address bar");
  }
});

function load(text: string): void {
  source.value = text;
  source.setSelectionRange(0, 0);
  $<HTMLDivElement>("editor").scrollTop = 0;
  output.textContent = "";
  stats.textContent = "";
  setStatus("Ready");
  changed();
  updateCursor();
}

for (const [file, label] of EXAMPLES) {
  const option = document.createElement("option");
  option.value = file;
  option.textContent = label;
  examples.appendChild(option);
}
examples.addEventListener("change", async () => {
  const file = examples.value;
  if (file === "tour") {
    load(TOUR);
    return;
  }
  try {
    const response = await fetch(`examples/${file}.nc`);
    if (!response.ok) throw new Error(String(response.status));
    load(await response.text());
    history.replaceState(null, "", location.pathname);
  } catch {
    notify(`Could not load examples/${file}.nc`);
  }
});

// start with shared code if the link carries some
let initial = TOUR;
const shared = /#code=([A-Za-z0-9_-]+)/.exec(location.hash);
if (shared?.[1]) {
  try {
    initial = decode(shared[1]);
  } catch {
    notify("The shared link is damaged. Showing the tour instead.");
  }
}
load(initial);
check();
