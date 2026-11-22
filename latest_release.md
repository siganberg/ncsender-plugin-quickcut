## What's Changed

### ✨ New Features
- Load › Merge: combine saved QuickCut programs into one job to run again (for example holes, a pocket and an outline). Each keeps its own tool change; a repeated tool change is left out, and a program without one gets a pause to check the bit
- Previews: the shape top views enlarge again (click a blank spot or the corner button), and every enlarged preview zooms with the wheel or a pinch, moves with a drag, and has −, +, Fit and × buttons
- Star: the Inner Diameter label is a menu with Inner Ratio (%) and Classic Star (%), so changing the Diameter keeps the star's shape. New stars start at 5 points and 38.5%
- The tool change line names the picked tool: `M6 T3 ; Tool change: 1/4" Downcut`

### 🔧 Improvements
- QuickCut opens straight into your tab, units and tool, without showing defaults first and redrawing, and its startup reads run together

### 🐛 Bug Fixes
- Label menus are no longer cut off in ncSender (X Gap showed as "X G"), and refit when renamed
