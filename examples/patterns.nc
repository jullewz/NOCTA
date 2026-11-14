// Enums and pattern matching: a tiny expression evaluator.
enum Expr {
  Num(value),
  Add(left, right),
  Mul(left, right),
  Neg(inner),
  Var(name),
}

fn eval_expr(e, env) {
  match e {
    Num(v) => v,
    Add(a, b) => eval_expr(a, env) + eval_expr(b, env),
    Mul(a, b) => eval_expr(a, env) * eval_expr(b, env),
    Neg(x) => -eval_expr(x, env),
    Var(name) => match get(env, name) {
      nil => throw "unbound variable {name}",
      value => value,
    },
  }
}

fn show_expr(e) {
  match e {
    Num(v) => str(v),
    Add(a, b) => "({show_expr(a)} + {show_expr(b)})",
    Mul(a, b) => "{show_expr(a)} * {show_expr(b)}",
    Neg(x) => "-{show_expr(x)}",
    Var(name) => name,
  }
}

// Algebraic simplification, written as rewrite rules.
fn simplify(e) {
  match e {
    Add(Num(0), x) | Add(x, Num(0)) => simplify(x),
    Mul(Num(1), x) | Mul(x, Num(1)) => simplify(x),
    Mul(Num(0), _) | Mul(_, Num(0)) => Num(0),
    Add(a, b) => Add(simplify(a), simplify(b)),
    Mul(a, b) => Mul(simplify(a), simplify(b)),
    Neg(Neg(x)) => simplify(x),
    other => other,
  }
}

let expr = Add(Mul(Num(1), Var("x")), Add(Num(0), Mul(Num(3), Neg(Neg(Var("y"))))))
print("expression: {show_expr(expr)}")
print("simplified: {show_expr(simplify(expr))}")
print("value:      {eval_expr(expr, {x: 4, y: 5})}")

let result = try { eval_expr(Var("z"), {}) } catch e { "error: {e}" }
print(result)

// Patterns work on lists, maps and ranges too.
fn describe(value) {
  match value {
    [] => "an empty list",
    [only] => "a list with just {only}",
    [first, second, ..rest] => "a list starting {first}, {second} and {len(rest)} more",
    {name, age} if age >= 18 => "{name}, an adult",
    {name} => "{name}, age unknown or under 18",
    0 => "zero",
    1..=9 => "a digit",
    n if type(n) == "number" => "the number {n}",
    _ => "something else: {repr(value)}",
  }
}

for v in [[], [7], [1, 2, 3, 4], {name: "Ada", age: 36}, {name: "Kid", age: 9}, 0, 7, 42, "text"] {
  print(describe(v))
}
