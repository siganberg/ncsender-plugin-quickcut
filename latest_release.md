## What's Changed

### ✨ New Features
- A full-size dialog, with Shapes in one sidebar group and the tool and spindle settings in a band of their own
- Cutter, Drill, Planer, Jointer and every shape have new previews: the stock, the bit running the cut, the waste coming away, sizes in pills, and side views of the depth passes
- Planer: Conventional, Climb or Both Ways, a spiral from the inside or outside, and wasteboard zero at the front-left of the travel
- Chamfer works on every edge: Holes, Circle, Rectangle (and Trapezoid, Triangle, Arch, Ellipse), Polygon and Star, Slot and Arc Slot, Keyhole, and the edge a Cutter program leaves
- Chamfer holes and small Inside circles with a single plunge, like a countersink
- Starting feeds know the depth: a compression bit in wood cuts in the fewest equal passes, a deep pass takes a slightly thinner chip, and no pass goes deeper than the flutes
- Help has a Feeds & Speeds page for every bit in your tool table, with a Print link
- The tool menu lists the tools in the magazine first, by slot
- A Stock button by Total Depth, with Spoilboard Toolbox's stock thickness

### 🔧 Improvements
- Settings save as you edit, not only on Generate
- Chamfer picks a V-bit from your tool table and remembers the one you use
- Holding tabs show where the program really leaves them, on every copy of a pattern; tabs that would be cut through or left on a point are dropped, with a note
- Notes by Generate that don't stop you are amber; red is kept for something to fix
- Rates, RPM and depth past your machine's limits are flagged
- The flute note only shows when Total Depth is well past the flutes
- The previews' animations pause after ten minutes untouched

### 🐛 Bug Fixes
- A pattern's X / Y Gap is measured on the cut when chamfering, so the bevels land on the parts and holes
- QuickCut reopens on the tab you left, not Chamfer
- Cutter figure: the bit runs in the waste, its edge on the cut line
- Flutes can be typed when the tool table doesn't give the count
- `1,000` in a field says why it isn't read
- Label menus no longer draw a focus box over the field below
