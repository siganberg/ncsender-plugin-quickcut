## What's Changed

### ✨ New Features
- Corner Relief for inside Rectangle and Polygon cuts, with a choice of Dog-bone or T-bone corners so square parts fit into the pocket. On Polygons, T-bones turn the same way around the shape
- Corner Relief is greyed out when your bit can already cut the Corner Radius
- Click Bit Diameter to fill in the diameter of the tool that is loaded
- Linear and Honeycomb patterns have a new Gap option that sets how much stock is left between copies. On an Outer cut, Gap is measured between the parts and is never less than one bit diameter
- Spacing, Extent and Gap now sit in each axis's spacing menu. Extent is measured center to center, and a new Overall mode measures edge to edge so every copy fits inside it
- Honeycomb Y Count is now the actual number of rows, and Honeycomb Y Spacing is measured row to row
- The Circular pattern has a Radius menu with Center, Inside or Outside. Inside and Outside measure to the solid edges, or to the part on an Outer cut
- Inset can measure to the edge of the cut or to the centers of the copies

### 🔧 Improvements
- The pattern preview draws each copy the same way the shape previews do, keeps dashed corners, tints areas where copies overlap, and shows the Circular pattern's radius circle
- The pattern preview shows Spacing, Extent and Gap measurements, and tells you why it is empty when there is nothing to show
- Slot shape problems now show as soon as you leave the field
- The magnified origin view also shows the dashed edge of the cut
- The Load panel now looks like ncSender's File Manager
- The Inset menu uses "XY" when X and Y are set separately, to save space
- When you switch an Inset back, only the values that still work are restored

### 🐛 Bug Fixes
- Clearings no longer leave islands at high stepover, and rounded Polygon clearings no longer crash
- Polygon clearing steps down to the next pass without lifting
- Polygon Depth of Cut can no longer be set higher than Total Depth
- Feeds show whole numbers, and values are kept when you switch units
- Load's confirmation bubble uses the theme's accent colour
- The Jointer "# of Trims" label fits on one line
- Note bubbles close as soon as you click or move focus elsewhere
