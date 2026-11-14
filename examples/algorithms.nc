// Classic algorithms, written idiomatically.

fn quicksort(xs) {
  match xs {
    [] => [],
    [pivot, ..rest] => {
      let smaller = rest.filter(fn(x) => x < pivot)
      let larger = rest.filter(fn(x) => x >= pivot)
      quicksort(smaller) + [pivot] + quicksort(larger)
    },
  }
}

fn sieve(limit) {
  let is_prime = [true] * (limit + 1)
  is_prime[0] = false
  is_prime[1] = false
  var i = 2
  while i * i <= limit {
    if is_prime[i] {
      var j = i * i
      while j <= limit {
        is_prime[j] = false
        j += i
      }
    }
    i += 1
  }
  (0..=limit).filter(fn(n) => is_prime[n])
}

fn binary_search(xs, target) {
  var low = 0
  var high = len(xs) - 1
  while low <= high {
    let mid = floor((low + high) / 2)
    match xs[mid] {
      v if v == target => return Some(mid),
      v if v < target => low = mid + 1,
      _ => high = mid - 1,
    }
  }
  None
}

fn gcd(a, b) { if b == 0 { a } else { gcd(b, a % b) } }

fn collatz_length(n) {
  var steps = 0
  var x = n
  while x != 1 {
    x = if x % 2 == 0 { x / 2 } else { 3 * x + 1 }
    steps += 1
  }
  steps
}

let data = [38, 27, 43, 3, 9, 82, 10, 3]
print("quicksort:     {quicksort(data)}")
let primes = sieve(60)
print("primes < 60:   {primes}")
print("search 43:     {binary_search(primes, 43)}")
print("search 44:     {binary_search(primes, 44)}")
print("gcd(1071, 462) = {gcd(1071, 462)}")
let longest = (1..30).map(fn(n) => [collatz_length(n), n]).sort().last()
print("longest Collatz below 30: n = {longest[1]} with {longest[0]} steps")
