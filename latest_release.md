## What's Changed

### ✨ New Features
- Pattern Angle: a Stock button beside each Pattern Angle (Rectangle, Circle, Polygon, Slot, Keyhole, Drill). When Spoilboard Toolbox has placed the stock at an angle against its pins, a click fills Angle with the stock's angle and turns Rotate shapes on, so the copies line up with the stock. Use an origin at the center or a point of the first copy: a corner of the pattern's box is measured square to the machine, and a warning says so

### 🔧 Improvements
- Programs retract with $SAFEZ on ncSender 2.0.228 or later (Pro 2.0.326 or later), so the lift follows ncSender's Safe Z setting at run time instead of a fixed G53 G0 Z that can trip the Z limit switch. Older versions get the same retract as before
- Circle: a hole barely wider than the bit now spirals down at the Plunge Rate (no faster than the Feed), at the speed the machine can reach on so small a circle, instead of creeping down at 5 degrees. A 1/2" bit in a 13.4 mm hole went down at about 80 mm/min before. Steeper than 45 degrees it plunges straight down and cuts a lap at each depth. Compression and down-cut bits keep the slow 5 degree spiral there, and the note beside Generate says why
