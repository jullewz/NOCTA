/** The program the playground opens with. Kept apart from the DOM code so the tests can run it. */
export const TOUR = `// Welcome to Nocta. Press Ctrl+Enter (or Run) to run this program.

enum Shape {
  Circle(r)
  Rect(w, h)
}

fn area(shape) {
  match shape {
    Circle(r) => PI * r ** 2
    Rect(w, h) => w * h
  }
}

let shapes = [Circle(1), Rect(3, 4), Circle(2.5)]

// pipelines read left to right
let total = shapes |> map(area) |> sum()
print("total area: {round(total, 2)}")

// closures keep their own state
fn counter() {
  var n = 0
  fn() {
    n += 1
    n
  }
}
let next = counter()
next()
next()
print("counter is at {next()}")

// errors are values you can match on
fn parse_age(text) {
  let n = num(text)
  if n == nil { Err("not a number: {text}") }
  else if n < 0 { Err("an age cannot be negative") }
  else { Ok(n) }
}

for input in ["42", "-3", "old"] {
  match parse_age(input) {
    Ok(age) => print("ok: {age}")
    Err(why) => print("error: {why}")
  }
}

test "areas" {
  assert_eq(area(Rect(2, 5)), 10)
}
`;
