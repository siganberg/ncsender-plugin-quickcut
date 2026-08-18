# QuickCut

Quick g-code for the everyday CNC ops — shapes, surfacing, edge work — straight from a dialog in ncSender. For the times you'd otherwise open your CAM tool just to cut one rectangle, flatten a spoilboard, or true up a rough edge.

## What it makes

**Shapes** (inner/outer cut, corner radius where applicable, origin selection):
- Rectangle — Inner (perimeter), Inner (clearing), Outer, with optional Linear or Circular pattern
- Circle — Inner (perimeter), Inner (clearing), Outer, with helical entry + final finish pass
- Polygon — *coming soon*

**Ops:**
- Planer — surface a flat region with zigzag or spiral raster. Three modes:
  - Target Depth (flatten an uneven top)
  - Target Thickness (measured from wasteboard up)
  - Wasteboard Surfacing (auto-uses machine travel from grblHAL `$130`/`$131`)
- Jointer — make a straight reference edge. Trim Width × Number of Trims off the chosen side, single-direction cuts so climb/conventional stays consistent
- Cutter — cold-saw-style parting cut. Single cut line at a target dimension (bit-radius compensated), multi-pass Z to reduce bit load

**Common:**
- Units — metric + imperial (honors ncSender's `unitsPreference`)
- Safe Z — honors ncSender's core `safeZHeight` setting; falls back to machine Z0 when unset
- Pattern (shapes only) — Linear (X × Y with signed distances) or Circular (N around a radius)
- Multi-session tab persistence, per-shape saved settings

## Install

Install via ncSender's Plugin Manager, or drop the release zip into `~/Library/Application Support/ncSender/plugins/com.ncsender.quickcut/`.

## Development

```
npm test       # run node --test on the extracted generators
```

Generators live in two places on purpose:
- `config.html` — the copy the browser dialog runs (ncSenderPro V2's plugin server serves this HTML directly; external `<script src>` won't resolve)
- `lib/*.cjs` — Node-loadable twin used by tests, kept in sync by hand

Every fix to a generator must be applied to BOTH.

## License

Dual-licensed under a permissive plugin license and GPL-3.0. See `LICENSE` and `LICENSE-GPL-3.0`.
