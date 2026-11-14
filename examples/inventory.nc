// Data processing with maps, pipelines and group_by.
let items = [
  {name: "keyboard", category: "input", price: 79, stock: 12},
  {name: "mouse", category: "input", price: 35, stock: 0},
  {name: "monitor", category: "display", price: 249, stock: 4},
  {name: "projector", category: "display", price: 520, stock: 1},
  {name: "headset", category: "audio", price: 99, stock: 7},
]

let in_stock = items |> filter(fn(i) => i.stock > 0)
let value = in_stock |> map(fn(i) => i.price * i.stock) |> sum
print("items in stock: {in_stock.map(fn(i) => i.name).join(", ")}")
print("stock value: {value}")

let by_category = group_by(items, fn(i) => i.category)
for category in keys(by_category).sort() {
  let group = by_category[category]
  let average = group.map(fn(i) => i.price).sum() / len(group)
  print("{pad_right(category, 8)} {len(group)} item(s), average price {fixed(average, 2)}")
}

let cheapest = items.sort(fn(i) => i.price).first()
let priciest = max(items.map(fn(i) => i.price))
print("cheapest: {cheapest.name}, most expensive price: {priciest}")

// Maps are mutable; bindings made with `let` are not.
let restock = {mouse: 25}
for item in items {
  let extra = get(restock, item.name, 0)
  item.stock += extra
}
print("mouse stock after restock: {items.find(fn(i) => i.name == "mouse").unwrap().stock}")
print(to_json(items[0]))
