## What's Changed

### ✨ New Features
- Wasteboard Surfacing: Bit Edge Past Travel (on by default). The bit's center goes to the edge of the machine's travel, so its edge surfaces a bit radius past it: all of the bed it can reach. Turn it off when a frame, clamp or stop is that close. The top view shows the travel as a dashed outline inside the surfaced bed
- Wasteboard Surfacing: around a keepout zone at an edge or corner, one continuous zigzag. Each pass stops short of the zone, with an extra pass along its edges, so there's no lift, re-plunge or seam between areas

### 🔧 Improvements
- Planer: zigzag turnarounds are rounded, so the machine keeps speed through the turn instead of burning in the corner
- Planer: the first pass, which cuts the full bit width, runs at 70% feed
- Starting feeds: a big bit turns slower (down to 12000 RPM or the spindle's minimum) rather than take a thin chip, then gets up to the machine's max feed. A 2" 3-flute in MDF starts at 12000 RPM and 9000 mm/min instead of rubbing and burning at 18000 RPM and 4000 mm/min. Small bits and drills are unchanged
- Wasteboard Surfacing keeps keepout zones 3 mm (1/8 in) clear beyond the bit radius
- A warning beside Generate when X0 Y0 is inside an ncSender keepout zone, since ncSender won't start the program

### 🐛 Bug Fixes
- Wasteboard Surfacing: the program is made from where X0 Y0 really is once the machine is homed. Before, an X0 Y0 a few mm off the travel's corner (as homing's pull-off leaves it) moved the cut that far, so a wide bit could run into a keepout zone
