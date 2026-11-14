// A module: every top-level name is exported.
enum Shape { Circle(radius), Rect(width, height) }

fn area(shape) {
  match shape {
    Circle(r) => PI * r * r,
    Rect(w, h) => w * h,
  }
}

fn perimeter(shape) {
  match shape {
    Circle(r) => 2 * PI * r,
    Rect(w, h) => 2 * (w + h),
  }
}
