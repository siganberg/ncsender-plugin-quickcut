# Changes on this fork, as PRs

Each change is a PR on [siganberg/ncsender-plugin-quickcut](https://github.com/siganberg/ncsender-plugin-quickcut), made
from siganberg's `main` at **0fd08fe** (Planer/Jointer/Rectangle redesign), with its branch on
[tmuka/ncsender-plugin-quickcut](https://github.com/tmuka/ncsender-plugin-quickcut). `combined/0.1.23` is siganberg's
`main` with all of them merged, for testing on a machine; nothing is committed there directly except this file.

**Merging them all:** a few touch the same lines. `fix/tabs-fit-edges` and `fix/tab-markers` (the `tabIntervals`
call in `tabPlaces`: keep `var bit` and pass `real || segs`), and `feat/flute-depth-note`, `fix/chamfer-vbit` and
`fix/tab-markers` (the notes added to the run note: keep all). In the flute note merge, check `showTabsNote` keeps its
closing brace: without it the page still parses, but the note by Generate disappears. `combined/0.1.23` has them
resolved.

## Open on siganberg/ncsender-plugin-quickcut

#19 to #23 are stacked: each builds on the one before. #29, #31 and #32 build on them too.

| PR | Branch | What it does |
| --- | --- | --- |
| #11 | `fix/cutter-bit-in-waste` | Cutter figure: the bit runs in the waste, its edge on the cut line. |
| #12 | `fix/flutes-no-table-info` | Flutes shows when the picked tool has no flute count, so it can be typed. |
| #13 | `fix/unit-comma-message` | Unit fields say why `1,000` is refused. |
| #14 | `fix/machine-limits` | Rates, RPM and depth past the machine's limits are flagged. |
| #15 | `fix/label-menu-focus` | Label menus lose ncSender's focus box over the field below; the label lights up instead. |
| #16 | `fix/tab-markers` | Previews draw holding tabs as the stretch of the bit's path they leave standing. |
| #17 | `fix/tabs-nothing-to-hold` | No tabs on an Inside cut that clears the whole inside. |
| #18 | `fix/tabs-fit-edges` | Tabs the full-depth passes would cut through, or left on a point, are dropped, with a warning. |
| #19 | `feat/new-preview-rect-kinds` | The new top view (stock, animated bit path, the bit) for Trapezoid, Triangle, Arch and Ellipse, through one shared renderer. |
| #20 | `feat/new-preview-circle` | Circle in the new top view. |
| #21 | `feat/new-preview-polygon` | Polygon and Star in the new top view. |
| #22 | `feat/new-preview-slot` | Slot and Arc Slot in the new top view. |
| #23 | `feat/new-preview-keyhole` | Keyhole in the new top view. |
| #24 | `fix/hatch-contrast` | A stronger hatch on the stock that comes away. |
| #25 | `fix/preview-bit-size` | The bit drawn to scale (a small one still big enough to see), its cut off the edge; Inset label size. |
| #26 | `fix/chamfer-rect-kind` | Chamfer's Rect edge names the Rectangle card's shape, and a menu picks it. |
| #27 | `feat/flute-depth-note` | A note by Generate when Total Depth goes past the tool's flutes. |
| #28 | `fix/chamfer-vbit` | Chamfer picks a V-bit from the tool table, warns when the bit isn't one, and leaves the shape's Depth of Cut alone. |
| #29 | `fix/tab-preview-per-copy` | Previews draw a pattern's tabs on each copy, follow arcs, and leave out the tabs the program drops; the side view only says tabs hold the part when some are cut (builds on #16 to #23). |
| #30 | `fix/chamfer-pattern-gaps` | Chamfer measures a pattern's X / Y Gap on the cut, instead of taking it as the distance between centers (the bevels were cut in the wrong places). |
| #31 | `fix/chamfer-preview-stock` | An Outside chamfer's preview keeps the stock and the cut's slot round each part, framed like the shape's own; the side view goes under the Chamfer card so the top view keeps its full height (builds on #19). |
| #32 | `fix/triangle-pattern-labels` | In a pattern, a triangle's sizes and angles go on the copy facing open stock, not all on the first (builds on #19). |
| #33 | `fix/tool-column-contrast` | The Tool column sits on the panel without its own strip or edges, its fields in the cards' color. |
| #34 | `fix/tool-column-align` | The Tool column's titles as the cards', and its rows level with the cards' beside it (builds on #33). |
| #35 | `feat/depth-aware-feeds` | Starting feeds by depth: compression bits cut in fewer, deeper passes in wood; deep passes ease the chip; no pass deeper than the flutes. |
| #36 | `feat/feeds-help` | Help: Feeds & Speeds, the starting feeds for every bit in the tool table (builds on #35). |
| #37 | `feat/st-stock-depth` | A Stock button by Total Depth with Spoilboard Toolbox's stock thickness, when it's installed and has one. |
| #38 | `fix/reopen-last-tab` | Reopens on the remembered tab, not Chamfer. |
| #39 | `feat/tool-menu-magazine` | Tool menu: the tools in the magazine first, by slot, with their Tool ID. |

