// FizzBuzz with pattern matching on a pair of booleans.
fn fizzbuzz(n) {
  match [n % 3 == 0, n % 5 == 0] {
    [true, true] => "FizzBuzz",
    [true, false] => "Fizz",
    [false, true] => "Buzz",
    _ => str(n),
  }
}

print((1..=15).map(fizzbuzz).join(" "))
