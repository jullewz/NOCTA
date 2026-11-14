// Run with: nocta examples/modules/main.nc
import "geometry" as geo

let shapes = [geo.Circle(1), geo.Rect(3, 4)]
for s in shapes {
  print("{s}: area {fixed(geo.area(s), 2)}, perimeter {fixed(geo.perimeter(s), 2)}")
}
