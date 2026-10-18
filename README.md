# QuickCut

Quick g-code for the everyday CNC ops — shapes, surfacing, edge work — straight from a dialog in ncSender. For the times you'd otherwise open your CAM tool just to cut one rectangle, flatten a spoilboard, or true up a rough edge.

## What it makes

**Shapes** (inner/outer cut, corner radius where applicable, origin selection):
- Rectangle — Inner (perimeter), Inner (clearing), Outer; **Start Angle** turns it about its center (CCW); twist the preview to turn it by dragging (half degrees, sticking at miter angles; see [Pattern preview](#pattern-preview)). The preview shows the corner radius and the angle as you type, and a tap on a corner (or the center) makes that point X0 Y0
- Circle — Inner (perimeter), Inner (clearing), Outer, with helical entry + final finish pass; tap a corner of the circle's box, a quadrant point or the center on the preview to make it X0 Y0 (the same points as the Origin picker)
- Polygon — 3 to 12 sides, sized **Across Corners**, **Across Flats** or by **Edge Length** (pick it in the dropdown over the size; switching converts the number), Inner (perimeter), Inner (clearing), Outer; optional **Corner Radius** rounds every corner (up to fully round); twist the preview to change the Start Angle (in half degrees, sticking at miter angles such as 22.5° and 36°; see [Pattern preview](#pattern-preview)), or tap a corner (or the polygon's own center, which on an odd-sided polygon isn't the middle of the Origin box) to make it X0 Y0
- Slot — straight or arc (curved) slot with round ends: Center line, Inner (perimeter), Inner (clearing), Outer; an arc is given by radius and sweep, or by chord and rise; see [Slot](#slot)
- Keyhole — hanging slot cut with a keyhole bit; see [Keyhole](#keyhole)
- Drill — holes the size of the bit, with optional pecking; see [Drill](#drill)

Every shape preview marks X0 Y0 with a small crosshair. Every shape can be kept a set distance in from its origin with an [inset](#origin-inset), and repeated with a [pattern](#patterns). Rectangle, Circle, Polygon, and Slot profile cuts can leave [holding tabs](#holding-tabs).

**Ops:**
- Planer — surface a flat region with zigzag or spiral raster. Three modes:
  - Target Depth (flatten an uneven top)
  - Target Thickness (measured from wasteboard up)
  - Wasteboard Surfacing (auto-uses machine travel from grblHAL `$130`/`$131`); with a keepout zone on (ncSender Pro's, or the ATCi tool rack's `$684`-`$687` with `$683` Enable), **Avoid Keepout Zone** leaves out each zone plus the bit radius
- Jointer — make a straight reference edge. Trim Width × Number of Trims off the chosen side, single-direction cuts so climb/conventional stays consistent (or **Both Ways**, alternating trims to save the trip back)
- Cutter — cold-saw-style parting cut. Single cut line at a target dimension (bit-radius compensated), multi-pass Z to reduce bit load (**Both Ways** alternates the passes to save the trip back)

**Common:**
- Units — metric + imperial (honors ncSender's `unitsPreference`)
- Safe Z — honors ncSender's core `safeZHeight` setting; falls back to machine Z0 when unset
- Pattern (shapes only) — Linear, Honeycomb, or Circular; see [Patterns](#patterns)
- Unit entry — type `.25in`, `1/4"`, or `6.35mm` into size and feed fields; see [Typing units](#typing-units)
- Measure pattern angle — the **Measure** link on a Linear/Honeycomb pattern measures the angle of a line on the workpiece, from a point typed in or grabbed from the machine; see [Measuring an angle](#measuring-an-angle)
- Multi-session tab persistence, per-shape saved settings
- Help — the **Help** button at the bottom of the sidebar explains the tab you're on, including the tips that otherwise only show when you hover over a field with a mouse (so touchscreen users can read them too). **Back** returns to the tab with everything as you left it. Every tab has its own help: **All help topics** at the top lists them all, with a line on what each tab does, so you can read about another tab without leaving this one. Each help page and the list end with a link to the [ncSender manual's QuickCut page](https://docs.ncsender.xyz/plugins/quickcut/). The first time QuickCut opens in a browser, it starts on **All help topics**; **Back** goes to Rectangle.
- Touch tooltips — a field touched (or tabbed to) and left for a second shows its tip just below it, like a mouse hover would. The **Touch Tooltips** switch at the top right of Help turns them off.

## Slot

A slot with half-round ends, e.g. an adjustment slot for a bolt, a slot for a track or a fence, or a curved slot for a tilting table or a router-lift trunnion.

- **Straight:** **Length** is overall, from end to end including the round ends, at **Angle** (counter-clockwise from +X). **Width** is the finished width.
- **Arc**, by **Radius & Sweep:** **Radius** is from the arc's center to the middle of the slot. The slot starts at **Start Angle** (counter-clockwise from +X) and runs **Sweep** degrees counter-clockwise, or clockwise if negative.
- **Arc**, by **Chord & Rise**, for when you can measure the ends but not the center: **Chord** is the straight distance between the centers of the two ends, **Rise** how far the middle of the slot bulges out from that line, and **Angle** the direction it bulges toward (90° = toward the back). The program header gives the radius and angles they work out to: radius = (chord² / 4 + rise²) / (2 × rise).
- **Cut Type:**
  - **Center line** runs the bit once along the middle of the slot, so the slot is the bit's width (Width is greyed out). Each Depth of Cut pass goes the other way along it.
  - **Inner (perimeter)** cuts round the inside of the outline; **Inner (clearing)** clears it with rings out from the center line, **Stepover** apart; **Outer (part)** cuts round the outside, for a slot-shaped part.
- Twist the preview to turn the slot (it changes Angle, Start Angle or the bulge Angle). It moves in half degrees and sticks within 1° of the miter angles listed under [Pattern preview](#pattern-preview) (0, 15, 18, 22.5, 30, 36, 45° …): a straight slot's direction, or on an arc the radius line to the middle of the slot. Tap an **end** of the slot, at its center, or an arc's **center**, to make it X0 Y0. The 9-dot picker's points are the box around the slot, as on the other shapes, and work with an [inset](#origin-inset). On a straight slot you can also tap a **corner** (where a long side meets an end) or the **middle of a long side**, at any angle, like a turned Rectangle's corners: on a Center line cut that puts that edge of the cut on X0 Y0. Along X or Y the picker's edge points do the same, since the box includes the bit.
- Holding tabs and patterns work as on the other shapes. A pattern places each copy by its center, which for an arc slot is the arc's center, so a **ring of arc slots** is a **Circular (Path Direction)** pattern with **Radius 0**: each copy turns about that center (4 copies with a 90° Sweep make a full circle, a smaller Sweep leaves gaps between them). On an arc the inner edge is cut with clockwise arcs (G2), the rest counter-clockwise (G3).
- **Grid** pattern (straight slots): a grid of grooves, e.g. a decorative grid or a waffle board.
  1. Choose **Straight** as the Slot Type and **Center line** as the Cut Type (one bit-wide groove per line).
  2. Turn on **Pattern** and choose **Grid**.
  3. Set **Columns** and **Column Spacing** (the lines running front to back, spaced along X) and **Rows** and **Row Spacing** (the lines running left to right, spaced along Y). With **Extent** on, the spacing fields become the grid's overall Width and Height instead.
  4. Optionally set a pattern **Angle** to turn the whole grid.

  How it's cut:
  - Every line spans the grid: rows run from the first column to the last, and columns from the first row to the last, so the outer lines meet at the corners. With 4 columns 20 apart and 3 rows 30 apart, the rows and columns are all 60 long.
  - The Slot's own Length and Angle don't apply (they're greyed out).
  - The rows are cut first, then the columns. Each line gets all its depth passes, alternating direction each pass, before the next. With the Center line cut the lines go back and forth: each one starts at the end nearer where the previous one finished, so the hop between lines is short rather than back across the grid.
  - The **Origin** and **Inset** use the box around the whole cut, including the bit's width. With a corner or edge origin, the outer lines therefore sit one bit radius in from X0 Y0 (the edge of the groove touches the origin).

  **Using a V-bit:** set **Inset** to the negative bit radius (e.g. −3.175 for a 6.35 mm / ¼" V-bit, using the Bit Diameter you entered) so the first row and column run exactly along X0 and Y0, not a bit radius inside them. A V-bit's groove width depends on depth, so placing the line centres on the origin is what you usually want.

  **Before cutting stock, air carve it:** zero Z above the work (or raise it), run the program, and check that the first lines and the grid's extent start where you expect.
- **Rounding a stock corner:** zero X/Y on the corner, then Arc, **Radius** = corner radius + bit radius, **Start Angle** facing the corner (front-left 180, front-right 270, back-right 0, back-left 90), **Sweep** 90, **Center line**, that corner as the Origin, and **Inset** = minus the bit diameter. The bit's centre runs a bit radius outside the finished edge, starting and ending a bit radius outside the two stock edges, level with the tangent points, so the round blends into them. E.g. a 10 mm round with a 6 mm bit: Radius 13, Inset −6. (The Origin box includes the bit's own width on a Center line cut, which is why the inset is a whole bit diameter.)
- A slot that can't be cut is caught before Generate, at the field to change: an arc as wide as its radius, ends that would overlap (Chord shorter than the Width, or a Sweep too close to a full circle), or an inner cut no wider than the bit.

## Keyhole

Cuts a hanging slot with a keyhole (T-slot) bit, the kind used to hang a sign or picture on a screw. The bit's head is wider than its neck, so it can only enter and leave the wood through the plunge hole:

1. Plunge straight down to **Total Depth** at the Plunge Rate.
2. Cut forward **Slot Length** along **Slot Angle** (counter-clockwise from +X; 90° runs toward the back, +Y). Slot Angle starts at 90°; like the other settings, the value you last generated with is remembered. You can also twist the preview to turn the slot, like the other shape previews; it moves in half degrees, snaps to 0°, 90°, 180° and 270° within 5°, and sticks within 1° of the other miter angles listed under [Pattern preview](#pattern-preview).
3. Retrace exactly back to the plunge hole.
4. Retract.

- **Origin:** by default X0 Y0 is the plunge hole (the first one, when a pattern is on): the ring in the Origin picker. The picker's other points are the corners, edge midpoints, and center of the whole cut (every keyhole's head swept along its slot), as on the other shapes. On the preview, tap the plunge hole or one of those box points to pick it.
- Set **Bit Diameter** to the bit's head diameter.
- There's no Depth of Cut: the slot is always one pass at full depth, because a shallower pass would cut the narrow neck slot out to the full head width. Total Depth is to the bottom of the head.
- Patterns work as on the other shapes. With **Circular (Path Direction)**, or **Rotate shapes** on an angled Linear pattern, each slot turns with its copy.

## Drill

Plunges a hole the size of the bit, or one at every position of a [pattern](#patterns): shelf-pin rows, threaded-insert grids, pilot holes.

- **Origin** works as on Circle: the center (the default) puts a single hole at X0 Y0; with a pattern, each point is a corner, edge midpoint, or the center of the box around all the holes.
- With a pattern you can also **tap a hole in the preview** to make that hole X0 Y0. It's filled in, the crosshair moves onto it, and the 9 dots go blank; tap a dot to go back. The hole is remembered by its column and row (or its number on a Circular pattern), so it stays the same hole when you change a count. If the pattern no longer has that hole, the origin falls back to the center. Past 2500 holes (50 × 50) the preview just shows the count; you can still generate.
- Hole diameter is the **Bit Diameter**. Every Z move uses the **Plunge Rate**; Feed Rate isn't used and is greyed out on this tab.
- **Peck Depth** 0 drills in one plunge. Otherwise each peck goes that much deeper, then:
  - **Full (clear chips)** rapids up to 2 mm (0.079") above the surface to clear chips, then rapids back down to 0.5 mm (0.02") above the bottom of the hole and continues.
  - **Short (break chips)** backs off 0.5 mm (0.02") to snap the chip and continues.
- **Dwell at Bottom** pauses at full depth to clean up the hole floor.

The moves are written out in full rather than as G81/G83 canned cycles, which plain grbl doesn't support and which the visualizer wouldn't show.

## Holding tabs

A through cut frees the part, or the drop-out of an inner cut, on the last pass, where it can shift into the bit. Turn on **Holding Tabs** (in the Depth card of Rectangle, Circle, Polygon, and Slot) to leave small bridges that hold it until you cut them with a knife or saw.

- **Tabs** is how many per shape, **Tab Width** is each tab's width at the part edge, and **Tab Height** is how much material each tab leaves standing above the bottom of the cut. Tab Height has to be less than Total Depth.
- A pass is added at exactly Total Depth − Tab Height, so tabs come out at the height you set. Passes below that lift over each tab; passes above it are unchanged.
- On the tool path each tab spans Tab Width + Bit Diameter, because the bit takes a radius off each side of the tab.
- Tabs go on straight edges rather than corners: each side gets a share by its length, centred along it, so 4 tabs on a rectangle give one in the middle of each side. A circle's tabs are evenly spaced, and so are any that don't fit on the sides. Tabs that won't fit at all (too many, too wide) are dropped, with a warning in the G-code.
- Tabs apply to Inner (perimeter) and Outer cuts. They're hidden for clearing, which never frees anything, and for a Slot's Center line cut.
- The shape previews show where the tabs will be. With a pattern, every copy gets its own tabs, and they turn with the copy.

## Origin inset

Beside each Origin picker on Rectangle, Circle, Polygon, Slot, Keyhole and Drill, **Inset** keeps the cut that far in from the origin point, toward the shape, without moving the work offset:

- From a **corner** it moves both ways: front-left moves the cut +X and +Y, back-right −X and −Y.
- From an **edge** midpoint it moves across that edge only: front-center moves the cut +Y and keeps it centred side to side.
- It doesn't apply to the **center**, a tapped corner or hole, or Keyhole's plunge hole, and is greyed out there.
- A **negative** inset moves the cut that far *out* past the origin instead, e.g. to round a stock corner with a Slot (below).
- The shape and pattern previews show it: a short dashed dimension from the X0 Y0 crosshair to the box around the cut, along X and/or Y, labelled with the inset.

With a pattern it applies to the box around all the copies, so a grid of holes can start a set margin in from the edges of the stock instead of on them. The preview leaves room for it, with the crosshair at X0 Y0 out at the stock corner, and the program header notes it (`Origin: front-left, inset 10mm`).

For example, a **cutting board juice groove** 10 mm in from the edges of a 300 × 200 board: zero X/Y on the board's front-left corner, then a Rectangle 280 × 180, Inner (perimeter), origin front-left, inset 10. A second run with inset 0 and Outer (part) at 300 × 200 cuts the board to its final size from the same zero.

## Patterns

Turn on the **Pattern** switch on a Rectangle, Circle, Polygon, Slot, Keyhole, or Drill to cut several copies in one program. The spindle and coolant start once; each copy gets its own approach, plunge, and retract. The **Origin** you pick applies to the bounding box of the whole pattern, not to each copy. (Keyhole's picker also offers its plunge hole, the default.)

| Style | What it does |
| --- | --- |
| Linear | A grid of rows and columns. |
| Grid | Slot only, straight slots: lines instead of copies. **Rows** lines run along X and **Columns** lines run along Y, spaced by Row Spacing and Column Spacing, and each line spans the grid, so the outer lines meet at the corners. The Slot's Length and Angle are greyed out; the pattern Angle turns the whole grid. Use the **Center line** cut type for a grid of grooves. |
| Honeycomb | Like Linear, plus a shifted row (offset by half a step in both directions) between each pair of rows. **Symmetric Ends** drops one copy from each shifted row so both ends of the pattern line up. |
| Circular (Identical) | *Count* copies on a circle of *Radius*, starting at *Start Angle* and spread over *Total Angle* (see below). Every copy keeps the same orientation. |
| Circular (Path Direction) | Same as above, but each copy turns with the circle: the first copy (at the Start Angle) looks like the shape preview, and each later copy is turned by how far round the circle it is from the first. |

### Pattern preview

With **Pattern** on, a preview beside the pattern fields shows the whole pattern and updates as you type: every copy's toolpath, a dot the size of the bit where each copy plunges, a crosshair at X0 Y0, and under the copy count the pattern's overall size (the area the bit reaches, X × Y). It's drawn from the same code as Generate, so Origin, Inset, Angle, Rotate shapes, Extent, Symmetric Ends and both Circular styles all match the program. It shows one depth pass and the outline of a clearing cut. Above 500 copies it shows only where each copy starts; above 3000 it shows the count.

**Click a blank spot** on any preview, this one or a shape preview, to enlarge it over the dialog; click a blank spot again or press **Esc** to go back to editing (Esc only closes QuickCut when nothing is enlarged). Clicks on a corner, end, hole or side still pick it, and drags still turn, in the small or enlarged view. While you drag an enlarged preview, the field being set and its value (e.g. **Start Angle 22.5°**) show in large type at the top. Drag it (small or enlarged) to turn the pattern: the **Angle** for Linear and Honeycomb, the **Start Angle** for Circular. Dragging (here and on every shape preview) moves in half degrees, snaps square (0, 90, 180, 270°) within 5°, and sticks within a degree of the other common miter angles, 180/n for n = 3, 4, 5, 6, 8, 10 and 12 (60, 45, 36, 30, 22.5, 18 and 15° and their multiples), e.g. 22.5° to line a pattern up with an octagon.

### Circular Total Angle

**Total Angle** (default 360°) is the arc the circular copies are spread over, counter-clockwise from the Start Angle, as in a CAD circular pattern:

- **360°** spaces the copies evenly all the way round (6 copies are 60° apart), the same as before.
- **Less than 360°** puts the first and last copy at the two ends of the arc and spaces the rest evenly between: 5 copies over 90° are 22.5° apart, at 0°, 22.5°, 45°, 67.5°, and 90° from the Start Angle.
- **Negative** runs clockwise. 0 isn't allowed, since every copy would land in the same place.

The G-code header adds `total=90°` when it isn't 360.

### Spacing or extent

Linear and Honeycomb normally take a **Spacing**: the center-to-center distance between neighbouring copies. Turn on **Extent** to give the distance from the first copy's center to the last instead, and QuickCut spreads the copies evenly over it, like the Extent option in a CAD linear pattern. For example, X Count 5 with X Extent 400 puts the copies 100 apart; change the count and they re-space to fit the same 400. Hover the Extent label to see the spacing it works out to.

- Flipping the switch converts the numbers so the pattern stays where it is (X Spacing 25 with X Count 5 becomes X Extent 100).
- At an angle it works the same way, along and across the angled row (**Extent** / **Row Extent**).
- On Honeycomb the extent covers the main rows; the shifted rows still sit half a step in between, and overhang by half a step unless **Symmetric Ends** is on.
- The G-code header gives both, e.g. `Pattern: Linear 5x1 [extent X=400, Y=0; dX=100, dY=0]`.

### Linear and Honeycomb at an angle

Linear and Honeycomb have an **Angle (°)** field, measured counter-clockwise from +X. The **Measure** link beside it opens the [Measure Pattern Angle](#measuring-an-angle) page to measure the angle on the machine. At 0° the pattern runs along the machine axes, and the fields read *X Count / X Spacing / Y Count / Y Spacing*.

At any other angle the whole grid is turned about the first copy, and the fields change to (hover a label for a reminder):

- **Count** — copies per row
- **Spacing** — center-to-center distance between copies along the angled row
- **Rows** — number of rows
- **Row Spacing** — distance between rows, at right angles to the row

For example, 5 circles at 36° with a spacing of 20 places every center exactly 20 apart on a 36° line. You don't need to work out X and Y offsets yourself.

Spacings can be negative to run the row (or the rows) the other way.

Rectangles, polygons, and keyholes also get a **Rotate shapes** switch, shown beside the Angle when it isn't 0. Off, each copy stays square to the machine axes and only its position follows the angle. On, each copy is turned by the same angle so it sits square to the row. Circles look the same either way, so they don't have the switch.

## Measuring an angle

The **Measure Pattern Angle** page shows the angle and distance of a line from the work origin (X0 Y0) to a second point on it. Use it to match a pattern to a line on the workpiece, such as an edge that isn't square to the machine. This can be helpful for patterns that don't align with the X or Y-axis.

It has no sidebar button: open it with the **Measure** link beside a Linear or Honeycomb pattern's **Angle (°)** field. The page title names the shape it was opened from.

1. Jog to a point on the line and zero X and Y in your work coordinate system.
2. Set the **Second Point Coordinate** further along the same line. Farther apart gives a more accurate angle. Either:
   - jog to it and press **Grab Current**, which copies the machine's work X/Y into the **Second Point Coordinate** X and Y fields; or
   - type its work X/Y into those fields (units like `1in` or `25.4mm` are accepted, as in the other size fields).

   The point only changes when you type or press **Grab Current**, so jogging afterwards doesn't change the angle. It's remembered with QuickCut's settings, so the next time you open the page, from any shape or after restarting, it starts with the same point. Clear both fields to forget it.
3. Read the **Angle** (counter-clockwise from +X, between −180° and 180°) and **Distance**.
4. Press **Use …° for** *shape* to put the angle in that shape's pattern and go back to it. **Back** returns without changing anything.

Below the result, **Live machine position** shows the current work, machine, and origin (WCO) X/Y. It updates about twice a second while the page is open; it's for reference and doesn't change the angle. **Grab Current** reads a fresh position before copying it.

ncSender reports positions in mm and assumes the controller does too (grblHAL `$13=0`). With `$13=1` the angle is still correct, but the distance and coordinates are not.

## Typing units

Size, depth, distance, and feed fields accept a unit. When you leave the field, it's converted to a plain number in the units QuickCut is using (inches with G20, mm with G21, following ncSender's units setting):

| You type | Metric shows | Imperial shows |
| --- | --- | --- |
| `.25in`, `.25"`, `1/4"`, `0.25 inch` | 6.35 | 0.25 |
| `6.35mm`, `0.635cm` | 6.35 | 0.25 |
| `1-1/2"` or `1 1/2 in` | 38.1 | 1.5 |
| `5/4"` (fractions over 1 work too) | 31.75 | 1.25 |
| `1/4` (no unit) | 0.25 | 0.25 |
| `100ipm`, `100 in/min` (feed fields) | 2540 | 100 |
| `2540 mm/min` or `2540mm/m` (feed fields) | 2540 | 100 |
| `25mm/s`, `25 mm/sec` (feed fields) | 1500 | 59.0551 |
| `1ips`, `1 in/s` (feed fields) | 1524 | 60 |

Feeds are always per minute, so per-second entries are multiplied by 60, and `/m` means per minute. A number with no unit is taken to be in the current units already. Text that can't be read is left as typed, and the field shows a "must be a number" warning. Counts, angles, RPM, and percentages are plain numbers.

### Arrow keys

With a keyboard, Up / Down Arrow steps any number field, with modifiers like Chrome DevTools (except Ctrl, which is a fine 0.001 step instead of 100). Steps are in the units shown (mm or inches):

| Keys | Step |
| --- | --- |
| Up / Down | 1 |
| Shift + Up / Down | 10 |
| Alt (Option) + Up / Down | 0.1 |
| Ctrl (Command) + Up / Down | 0.001 |

Unit text such as `1/4"` is converted first, so Up turns it into 7.35 in metric. Count fields always step by at least 1. A step that would go below a field's minimum stops at it if it's a whole number (1 on counts, 0 on Peck Depth); otherwise the value stays put, so Down from 1 mm never lands on an odd minimum like 0.1 mm.

## Loading settings from a saved program

Every program QuickCut generates ends with its settings: a few comment lines after `M30`, under `(QuickCut settings - used by Load)`. The readable summary at the top and the G-code itself are unchanged.

**Load**, beside **Save to File Manager** at the top right of each tab, lists the programs in File Manager › QuickCut, newest first, with a filter box. Pick one and QuickCut switches to that program's tab and fills it with the values it was made with: shape, depths, tool, origin and inset, holding tabs, pattern, spindle and coolant. Nothing is generated or run; check the values (your bit may differ) and press Generate.

- Turn on **Save to File Manager** so generated programs are kept there to Load later. Each is named after what it cuts, like the BoxJoints plugin's files: the shape, its main sizes as short tags, the depth, the cut type, any pattern, and the units, e.g. `QuickCut-Rectangle_W-120_H-80_R-6_D-6_Outer_P-3x2_mm.nc` or `QuickCut-Slot_Grid-4x3_Sp-20x30_D-2_Center_mm.nc`. A name that's already taken gets " (2)", " (3)" and so on.
- To share a setup, share the program file: anyone who puts it in their File Manager › QuickCut folder can Load its settings, change what they need, and regenerate.
- Programs made before this feature, or by other software, have no settings and say so.
- The settings are stored in mm, so a program made in inches loads correctly in metric and the other way round.
- The comment lines are kept under 70 characters because ncSender sends comment lines to the controller as well; GRBL and grblHAL ignore them.

## Install

Install via ncSender's Plugin Manager, or drop the release zip into `~/Library/Application Support/ncSender/plugins/com.ncsender.quickcut/`.

## Development

```
npm test       # run node --test on the extracted generators
```

Generators live in two places on purpose:
- `config.html` — the copy the browser dialog runs (ncSenderPro V2's plugin server serves this HTML directly; external `<script src>` won't resolve)
- `lib/*.cjs` — Node-loadable twin used by tests, kept in sync by hand

Every fix to a generator must be applied to BOTH. The same goes for the unit-entry parser (`parseUnitValue` in `config.html` and `lib/unit-input.cjs`); `tests/unit-input.test.cjs` fails if the two copies differ.

## License

Dual-licensed under a permissive plugin license and GPL-3.0. See `LICENSE` and `LICENSE-GPL-3.0`.
