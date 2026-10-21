## What's Changed

### ✨ New Features
- New Slot tab for straight and arc slots, with holding tabs, Cut Type beside Width, and a Radius and Sweep row that puts Sweep before Start Angle
- Grid pattern for straight slots, with center lines cut back and forth
- Ring of arc slots by setting the pattern Radius to 0
- Live pattern preview beside the pattern fields, showing the pattern's overall size
- Click a blank spot on any preview to enlarge it, then drag to turn the pattern or shape; the angle is shown while you drag, and Esc closes the enlarged view
- Preview twists use half degrees with miter stops, and snap square within 5 degrees
- Inset from the origin, with separate Inset X and Inset Y; a negative inset moves the cut out past the origin, and previews show the Inset
- Load a tab's settings from a saved QuickCut program, with a search box to find files
- Saved programs get descriptive names
- Polygon size can be set across corners, across flats, or by edge length
- Keyhole can be sized by Slot Length or Slot Ratio, starts with a 3/8 inch bit, and shows a surface outline
- Both Ways cut direction on the Jointer and the Cutter
- Wasteboard Surfacing can avoid the ncSender Pro keepout zone and the ATCi tool rack keepout, and works on machines whose coordinates run negative
- Tooltips for every field, menu and switch, shown after 1 second of touch or keyboard focus, with a Touch Tooltips switch at the top right of Help
- New All help topics page, linked from every Help page and shown the first time you open Help

### 🔧 Improvements
- Pick the Origin by tapping the preview on Circle, Keyhole, Rectangle edge middles, and straight slot corners and long sides
- Magnified origin view attached to the preview corner, and you can tap slot points inside it
- Larger tap targets on the Origin picker's dots, faint hints showing where you can tap, and a pointer cursor over pickable points
- Keyhole now uses the standard Origin picker, and the Planer's Origin picker sits under its preview
- Shape previews mark the cut's other edge for perimeter and outer cuts, and Outer previews hatch only the band the bit removes
- Previews show the shape as typed even when the bit rounds its corners
- Dimensions are clearer: arrows end on the outline, Polygon Edge Length is dimensioned outside the edge, and labels match the Inset accent style
- Jointer preview draws each trim with its feed arrow
- More compact Shape and Depth layout on every shape tab
- Field problems stay on the field until fixed without moving the cursor, and error messages clear on any edit, on Generate, and when the dialog closes

### 🐛 Bug Fixes
- Fixed Climb and Conventional being swapped on some Jointer and Cutter sides
- Fixed the Origin picker's corner dots hanging past the card's left edge
