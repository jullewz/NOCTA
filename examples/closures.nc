// Closures capture variables, not values: each counter has its own state.
fn make_counter(step) {
  var count = 0
  fn() {
    count += step
    count
  }
}

let by_one = make_counter(1)
let by_ten = make_counter(10)
by_one()
by_one()
by_ten()
print("by_one: {by_one()}, by_ten: {by_ten()}")

// Functions are values: compose, curry, pass around.
fn compose(f, g) { fn(x) => f(g(x)) }
let inc = fn(x) => x + 1
let double = fn(x) => x * 2
print("compose: {compose(inc, double)(5)}, {compose(double, inc)(5)}")

// Memoisation with a closure over a map.
fn memoize(f) {
  let cache = {}
  fn(n) {
    let key = str(n)
    if not has(cache, key) { cache[key] = f(n) }
    cache[key]
  }
}

var calls = 0
fn slow_square(n) {
  calls += 1
  n * n
}
let fast = memoize(slow_square)
for _ in 1..=5 { fast(12) }
print("square(12) = {fast(12)} computed {calls} time(s)")
