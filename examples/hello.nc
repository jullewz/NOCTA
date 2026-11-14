// Hello, Nocta. Run with: nocta examples/hello.nc
let name = "world"
print("Hello, {name}!")

let languages = ["Nocta", "Lua", "Rust", "Python"]
for [i, lang] in enumerate(languages) {
  print("{i + 1}. {lang} has {len(lang)} letters")
}
