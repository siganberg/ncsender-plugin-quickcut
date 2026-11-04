## What's Changed

### ✨ New Features
- The Material label is now a menu of how hard the starting feeds push: Average, Conservative (lighter: Feed and Plunge ×0.75, shallower passes and less stepover) or Aggressive (heavier: ×1.25 and ×1.2, up to each material's chip limit and the machine's max). On plastics and aluminum, Conservative keeps the feed, since a thinner chip melts or rubs
- Size and feed fields take simple math: `8mm*2`, `1in+4mm`, `(1/4"+2mm)/2`
- A decimal comma works too: `1,5mm`

### 🔧 Improvements
- The starting Plunge Rate stays within your machine's Z max rate (`$112`)
- Help for each shape starts with that shape's own notes, its field tips match the shape picked, and it has diagrams for chamfers and ramps
- The README is reorganized, with screenshots and diagrams
- Label menus (like Material and Bit Diameter) are easier to tap on a touchscreen

### 🐛 Bug Fixes
- `1,000` in a field is refused rather than read as 1, since it may be a thousands separator
