// Errors: throw any value, catch it with try/catch, or use Result values.
enum Account { Open(id, balance), Frozen(id) }

fn withdraw(account, amount) {
  match account {
    Frozen(id) => Err("account {id} is frozen"),
    Open(_, balance) if amount > balance => Err("insufficient funds: balance {balance}, wanted {amount}"),
    Open(id, balance) => Ok(Open(id, balance - amount)),
  }
}

for [account, amount] in [[Open(1, 100), 30], [Open(2, 10), 50], [Frozen(3), 5]] {
  match withdraw(account, amount) {
    Ok(updated) => print("ok, new balance {updated.balance}"),
    Err(message) => print("refused: {message}"),
  }
}

// Runtime errors are catchable values too.
fn safe_divide(a, b) { try { Ok(a / b) } catch e { Err(e) } }
print(safe_divide(10, 4))
print(safe_divide(1, 0))

// throw works with structured errors.
fn parse_age(text) {
  let n = num(text)
  if n == nil { throw {code: "not_a_number", input: text} }
  if n < 0 or n > 150 { throw {code: "out_of_range", input: text} }
  n
}

for input in ["42", "abc", "-3"] {
  let message = try { "age {parse_age(input)}" } catch err { "invalid ({err.code}): {repr(err.input)}" }
  print(message)
}
