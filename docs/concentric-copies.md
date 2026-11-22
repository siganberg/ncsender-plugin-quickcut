# Concentric Copies: copies of a shape inside or outside itself

Status: built (2026-11-10 to 15), behind Help › Experimental Features. Planned 2026-11-10 as "Echoes".

## The idea

A **Concentric Copies** card, like Pattern and Chamfer, that cuts the shape and then copies of it stepping
inward or outward: concentric circles 1 in apart, nested rectangles, a star inside a star. Each copy
can also be moved and turned a little more than the last, which gives spirals, tunnels and twisted
squares.

Not called "Nesting": in CNC that means packing parts on a sheet, and people would look for that.

## Is it useful?

Yes, for a handful of real jobs, and it's fun to play with:

- **Decorative work:** coasters and trivets with rings, target boards, sign and mirror frames with
  several borders, ripple or tunnel art, twisted-square and spirograph-like patterns (rotation plus
  shrink), V-bit or engraving lines that follow a shape's outline.
- **Stepped pockets:** with a depth step per copy, a terraced bowl, a contour-map look, or a
  counterbore and its hole in one program.
- **Shop tests:** rings 1 mm apart to check a bit's real cutting size, circularity and backlash.
- **Frames from one shape:** an outside concentric copy cut through gives a ring or frame of a set width
  (better with Holding Tabs).

It isn't something a production shop asks for often, and anything more freeform belongs in CAM
(ncCut2D, ncCAM). For QuickCut's quick, parametric jobs, it's a good fit: one card, a few numbers.

## What you set

| Field | Default | Notes |
| --- | --- | --- |
| Concentric Copies on/off | off | Like Pattern: a switch that opens the card. |
| Copies | 3 | Extra copies beyond the shape itself. "As many as fit" is a later option. |
| Direction | Inside | Inside or Outside of the shape (Both later). |
| Step | 1 in / 25 mm | Label is a menu: **Distance** (same gap between every copy) or **Ratio** (each copy N% of the last, e.g. 80%). |
| Spacing | Offset | **Offset**: a true parallel outline at that distance; corners round outward and sharpen inward, like a contour. **Scale**: the same shape made smaller or bigger about its center, so a star keeps its points. For circles both are the same. |
| Shift X / Y per copy | 0 | Moves each copy's center by this much more than the last (tunnels, drifting rings). |
| Turn per copy | 0° | Turns each copy this much more than the last (twisted squares, star spirals). |
| Depth per copy | 0 | Optional: each copy this much deeper (inside) or shallower, for terraces. 0 = all at Total Depth. |

Basic default: a circle with Concentric Copies on gives the circle plus 3 concentric circles, each 1 in (or 25 mm)
inside the last.

## How each shape makes its copies

The generator already redraws shapes at an offset for chamfers (`chamferShapeProgram` takes a
`pathAt(x, y, pos)` path builder; `starOutline(params, d)` gives a star moved d in or out) and for bit
compensation. Concentric Copies reuses that:

- **Offset spacing:** each copy is the shape's own path at offset `k × step` (k = 1..Copies), negative
  inside. Circles change radius; rectangles change width, height and corner radius (an inward copy's
  corner radius shrinks to 0, then the corners stay sharp, as a real inward offset does); polygons
  change their apothem and corner radius; stars use `starOutline`.
- **Scale spacing:** each copy is the shape's parameters times `ratio^k` (Distance converts to a scale
  for the shape's size), about the shape's center. Same shape, so a star keeps its proportions; easy for
  every parametric shape.
- **Shift and turn:** copy k is moved by `k × (shiftX, shiftY)` and turned by `k × turn` about its own
  (moved) center, on top of the shape's Start Angle.
- **Order:** inside copies cut from the innermost outward, so an outside cut's part stays attached as
  long as possible; outside copies cut from the shape outward. Holding Tabs go on every copy that cuts
  through.
- **Cut type:** each copy uses the shape's cut type (Outside, Inside, On line). Pocket only makes sense
  with Depth per copy (terraces); otherwise inner pockets are cut twice, so Pocket with Concentric Copies asks for
  a depth step or switches the copies to Inside.

Start with Circle, Rectangle, Polygon and Star (their parameters scale and offset simply), then Ellipse,
Slot, Arch and the triangle and trapezoid kinds. Drill, Cutter, Planer and Jointer don't get Concentric Copies.

## Checks before Generate

- An inside copy has to stay bigger than the bit (and, for Offset, not collapse: a rectangle narrower
  than twice the offset). Say which copy fails and how many fit ("Only 2 copies fit inside at 25 mm").
- Shift and turn can push a copy out through its neighbor. Warn (amber), don't refuse: crossing lines
  can be the point of the design.
- The machine's travel, as for patterns, from the outermost copy.
- The run-time estimate counts every copy.

## Preview

All copies drawn in the top view, the shape itself in the accent color and the copies lighter; the
dimension labels show the step. Twisting the preview still turns the shape (and so all its copies).

## With Pattern and Chamfer

- **Pattern:** concentric copies belong to each copy the pattern places (a grid of ringed coasters). Positions
  come from `computePatternPositions` as now; each position runs the whole concentric copy set.
- **Chamfer:** chamfering the copies is a later step; at first the Chamfer switch and Concentric Copies don't go
  together (say so at the field).

## Saved settings and Load

Saved per shape like Pattern (`concentric: { enabled, copies, direction, stepMode, step, spacing, shiftX,
shiftY, turn, depthStep }`, lengths in mm). The program's header names it: `(Concentric copies: 3 inside, 25 mm
apart, offset)`; the file name gets `E3-in-25`.

## Testing

- Unit tests per shape: copy k equals the shape generated with the offset or scaled parameters; order;
  tabs on every copy; refusals when copies don't fit.
- Both generator copies stay in step (testkit `quickcut-sync.cjs` gains concentric copy cases).
- Harness: the card on every tab that has it, menus, preview, imperial and metric; layout audit.
- On the machine: concentric rings in MDF, measured with calipers.

## Steps

1. Ask siganberg whether he wants it in QuickCut (a short issue or Discussion with a picture).
2. Circle only: Copies, Direction, Distance, Offset; preview; header. A test zip on the Pi.
3. Rectangle, Polygon, Star; Scale spacing and Ratio steps.
4. Shift and turn per copy; Depth per copy (terraces).
5. Pattern together with Concentric Copies; the other shapes.
