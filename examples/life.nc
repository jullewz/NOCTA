// Conway's Game of Life on a small wrapping board.
let width = 20
let height = 10

fn empty_board() { (0..height).map(fn(_) => [false] * width) }

fn place(board, cells) {
  for [x, y] in cells { board[y][x] = true }
  board
}

fn neighbours(board, x, y) {
  var n = 0
  for dy in -1..=1 {
    for dx in -1..=1 {
      if dx == 0 and dy == 0 { continue }
      if board[(y + dy) % height][(x + dx) % width] { n += 1 }
    }
  }
  n
}

fn step(board) {
  (0..height).map(fn(y) => (0..width).map(fn(x) => match [board[y][x], neighbours(board, x, y)] {
    [true, 2] | [true, 3] => true,
    [false, 3] => true,
    _ => false,
  }))
}

fn render(board) { board.map(fn(row) => row.map(fn(c) => if c { "█" } else { "·" }).join("")).join("\n") }

let glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]
let blinker = [[12, 4], [13, 4], [14, 4]]
var board = place(empty_board(), glider + blinker)
for generation in 0..4 {
  print("generation {generation}:")
  print(render(board))
  board = step(board)
}
let alive = board.map(fn(row) => row.count(fn(c) => c)).sum()
print("alive after 4 generations: {alive}")
