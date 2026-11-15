## What's Changed

### ✨ New Features
- Pens and drag knives: a tool whose type in ncSender's tool table is Pen or Drag Knife never starts the spindle, and goes no deeper than its Max plunge
- Pens, drag knives and tools named "laser" go straight down at the start of each cut, with no ramps or helices, on every shape. A laser keeps its M3: Spindle RPM is its power
- Starting feeds for a pen or drag knife: 75 in/min (slower with Conservative, faster with Aggressive), and the whole depth in one pass. What you type with the tool is remembered for it
- Without a tool changer, QuickCut uses the tool in the spindle when Bit Diameter is its size, with no need to tap the label first

### 🔧 Improvements
- The Tool Library picker shows the tool's number and name on one line, the same size as Type a Size
- The tool menu puts the picked tool first with its size, slot and details, shows each tool's number in color with its size beside it, and is as wide as its longest tool
- `0,125` reads as a decimal, and `1,125` says why it isn't read

### 🐛 Bug Fixes
- With a pen, drag knife or laser, circles cut a lap at every depth, and pockets lift before moving back between depths
- A chamfer with a pen, drag knife or laser is refused with a note pointing to the Tool card: it takes a spinning V-bit
- The tool menu no longer opens off the edge of the dialog, or shifts the page, the first time it opens
