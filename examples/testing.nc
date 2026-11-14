// Run with: nocta test examples/testing.nc
fn slugify(text) {
  text.lower().trim().split().join("-")
}

fn median(xs) {
  let sorted = xs.sort()
  let n = len(sorted)
  if n == 0 { return None }
  Some(if n % 2 == 1 { sorted[n / 2 - 0.5] } else { (sorted[n / 2 - 1] + sorted[n / 2]) / 2 })
}

test "slugify joins words with dashes" {
  assert_eq(slugify("  Hello Nocta World "), "hello-nocta-world")
}

test "median of odd and even lists" {
  assert_eq(median([5, 1, 3]), Some(3))
  assert_eq(median([4, 1, 3, 2]), Some(2.5))
  assert_eq(median([]), None)
}

test "errors can be asserted" {
  let caught = try { [1, 2][9] } catch e { e }
  assert(contains(caught, "out of range"), "expected an index error")
}
