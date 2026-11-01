## What's Changed

### ✨ New Features
- Five new shapes, each with its own tab: Trapezoid, Triangle, Arch, Ellipse and Star
- Triangle is defined by what you know: 3 sides, 2 sides and an angle, a base and 2 angles, or a base and height
- Chamfer the edges of any shape with a V-bit, inside or outside, right after the cut or on a hole you already cut; it reads the V-bit's angle from the tool table
- Starting feeds by material: pick a material and flute count, and the RPM, feed, plunge, depth of cut and stepover fill in for your bit
- A run time and travel check beside Generate, with a warning when the program would run past the machine's travel
- A side view of the depth passes and holding tabs
- With a tool changer, pick the bit from the tool table and the program starts with a tool change (M6); the tool in the spindle is listed first, with a filter to find a tool

### 🔧 Improvements
- Every pass ramps in at 5 degrees or less instead of plunging straight down
- Errors show under the field that needs fixing, and the footer says how many are left
- Each program says where to set Z0 and X0 Y0
- Shapes are a grid of icons in the sidebar, and every tab fits on a 1080 pixel tall screen
- The Tool and Spindle cards scroll with the tab, with a one-line summary that stays in view
- Planer refuses a Target Thickness that would cut into the wasteboard
- Quicker to open and to type in on a Raspberry Pi
