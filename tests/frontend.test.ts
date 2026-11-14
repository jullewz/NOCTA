import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Lexer } from "../src/lang/lexer.js";
import { parse } from "../src/lang/parser.js";
import { closest, renderDiagnostic, SourceFile } from "../src/lang/source.js";

const lex = (text: string) => {
  const lexer = new Lexer(new SourceFile("t.nc", text));
  const tokens = lexer.tokenize();
  return { tokens, diagnostics: lexer.diagnostics };
};
const kinds = (text: string) =>
  lex(text).tokens.map((t) => (t.kind === "op" || t.kind === "keyword" ? t.text : t.kind));

describe("lexer", () => {
  it("tokenises numbers, names, keywords and longest-match operators", () => {
    assert.deepEqual(kinds("let x = 1_000.5 ..= 2e3 |> f"), [
      "let",
      "ident",
      "=",
      "number",
      "..=",
      "number",
      "|>",
      "ident",
      "eof",
    ]);
    const { tokens } = lex("1_000.5 2e3 7 1..5");
    assert.deepEqual(
      tokens.filter((t) => t.kind === "number").map((t) => t.value),
      [1000.5, 2000, 7, 1, 5],
    );
    assert.deepEqual(kinds("a ** b != c ?? d"), ["ident", "**", "ident", "!=", "ident", "??", "ident", "eof"]);
  });

  it("records line breaks and skips comments", () => {
    const { tokens } = lex("a // comment\n/* block\ncomment */ b c");
    assert.deepEqual(
      tokens.map((t) => t.newlineBefore),
      [false, true, false, true],
    );
  });

  it("cooks escapes and splits interpolation", () => {
    const plain = lex('"tab\\tquote\\" brace\\{ \\u{1F600}"').tokens[0];
    assert.equal(plain?.text, 'tab\tquote" brace{ 😀');
    const interp = lex('"a {x + 1} b {"inner {y}"}"').tokens[0];
    assert.equal(interp?.parts?.length, 4);
  });

  it("reports malformed input without crashing", () => {
    for (const bad of ['"open', '"bad \\q"', '"{unclosed"', "/* never", "a @ b", '"\\u{110000}"']) {
      const { diagnostics } = lex(bad);
      assert.ok(diagnostics.length > 0, bad);
    }
  });
});

describe("parser", () => {
  const program = (text: string) => parse(new SourceFile("t.nc", text));

  it("respects precedence and associativity", () => {
    const { program: p } = program("let x = 1 + 2 * 3 ** 2 ** 2");
    const stmt = p.stmts[0];
    assert.equal(stmt?.kind, "Let");
    const v = stmt?.kind === "Let" ? stmt.value : null;
    assert.equal(v?.kind, "Binary");
    if (v?.kind === "Binary") {
      assert.equal(v.op, "+");
      assert.equal(v.right.kind === "Binary" && v.right.op, "*");
      const pow = v.right.kind === "Binary" ? v.right.right : null;
      assert.equal(pow?.kind === "Binary" && pow.op, "**");
      assert.equal(
        pow?.kind === "Binary" && pow.right.kind === "Binary" && pow.right.op,
        "**",
        "** is right-associative",
      );
    }
  });

  it("turns pipes into calls", () => {
    const { program: p } = program("x |> f(1) |> g");
    const e = p.stmts[0]?.kind === "ExprStmt" ? p.stmts[0].expr : null;
    assert.equal(e?.kind, "Call");
    if (e?.kind === "Call") {
      assert.equal(e.callee.kind === "Ident" && e.callee.name, "g");
      const inner = e.args[0];
      assert.equal(inner?.kind === "Call" && inner.args.length, 2);
    }
  });

  it("continues expressions across lines only where it is unambiguous", () => {
    assert.equal(program("let a = 1 +\n 2").program.stmts.length, 1);
    assert.equal(program("let a = [1]\n.map(f)").program.stmts.length, 1);
    assert.equal(program("let a = 1\n-2").program.stmts.length, 2);
    assert.equal(program("f\n(1)").program.stmts.length, 2);
  });

  it("recovers after an error and reports each mistake once", () => {
    const { diagnostics } = program("let = 1\nlet ok = 2\nfn (x\nprint(ok)\nlet y = )");
    assert.ok(diagnostics.length >= 2 && diagnostics.length <= 4, diagnostics.map((d) => d.message).join(" | "));
  });

  it("rejects misplaced control flow and bad patterns", () => {
    const messages = (text: string) =>
      program(text)
        .diagnostics.map((d) => d.message)
        .join(" | ");
    assert.match(messages("break"), /only be used inside a loop/);
    assert.match(messages("return 1"), /only be used inside a function/);
    assert.match(messages("1 < 2 < 3"), /cannot be chained/);
    assert.match(messages("match x { [a, ..r, b] => 1 }"), /must be the last/);
    assert.match(messages("match x { Some(a) | None => 1 }"), /same names/);
    assert.match(messages("let let = 1"), /reserved word/);
    assert.match(messages("fn f(a, a) {}"), /duplicate parameter/);
    assert.match(messages("1 = 2"), /cannot assign/);
  });
});

describe("diagnostics", () => {
  it("renders a code frame with a caret under the span", () => {
    const file = new SourceFile("demo.nc", "let a = 1\nprint(totl)\n");
    const text = renderDiagnostic({
      severity: "error",
      code: "undefined-name",
      message: "`totl` is not defined",
      span: { start: 16, end: 20 },
      file,
      hint: "did you mean `total`?",
    });
    assert.equal(
      text,
      [
        "error[undefined-name]: `totl` is not defined",
        "  --> demo.nc:2:7",
        "  |",
        "2 | print(totl)",
        "  |       ^^^^",
        "  = hint: did you mean `total`?",
      ].join("\n"),
    );
  });

  it("suggests close names and nothing for distant ones", () => {
    assert.equal(closest("lenght", ["length", "list"]), "length");
    assert.equal(closest("prnt", ["print", "push"]), "print");
    assert.equal(closest("zebra", ["print", "push"]), undefined);
  });

  it("maps offsets to lines and columns", () => {
    const f = new SourceFile("x", "ab\ncd\n\nef");
    assert.deepEqual(f.position(0), { line: 1, column: 1 });
    assert.deepEqual(f.position(4), { line: 2, column: 2 });
    assert.deepEqual(f.position(7), { line: 4, column: 1 });
    assert.equal(f.lineText(2), "cd");
  });
});
