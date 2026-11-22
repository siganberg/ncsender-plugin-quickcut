## What's Changed

### ✨ New Features
- Help › Experimental Features: a switch for features still being tried out (off unless you turn it on)
- Concentric Copies (experimental): cut a shape and then copies of it stepping inside or outside it, like rings on a coaster, nested frames or a star inside a star. On Circle, Rectangle, Polygon, Star, Slot and Arc Slot, by distance or ratio, with an optional shift and turn per copy

### 🔧 Improvements
- Load › Merge refuses programs that can't run as one: a typed-in bit of another size after the previous program's bit, or programs on different work offsets, and says why
- A preview caption wider than its preview is squeezed to fit

### 🐛 Bug Fixes
- Jointer: each trim now takes exactly Trim Width off the edge. Before, the first trim put the bit's center on the edge and took off the bit's radius (about 3 mm with a 1/4" bit) whatever Trim Width said
- Jointer: a Trim Width wider than the bit is refused, since it would leave strips uncut between trims
- Jointer and Planer: Overrun is measured from the bit's edge, so the bit always plunges beside the stock, never into its corner
- Cutter: the cut starts beside the stock instead of with half the bit on its corner
