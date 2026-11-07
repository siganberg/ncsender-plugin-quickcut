/**
 * QuickCut starting speeds and feeds.
 *
 * MUST STAY IN SYNC WITH the inline startingFeeds inside config.html
 * (the dialog can't load external JS, so this is the Node-loadable twin
 * that tests/starting-feeds.test.cjs checks that copy against).
 */
function startingFeeds(bitMm, flutes, material, limits, style, deep) {
  // By material, as ncCAM's (src/core/tools.js) and Spoilboard Toolbox's:
  // the chip each tooth takes grows with the bit up to a cap; feed = RPM x
  // flutes x chip; plunge 30% of the feed; depth per pass and stepover a
  // share of the bit. HDPE takes a thick chip (a thin one melts it),
  // polycarbonate one between it and acrylic's, aluminum a small one.
  // limits: the machine's max feed ($110/$111), max Z rate for the plunge ($112) and
  // spindle range ($30/$31), when known.
  // style: 'conservative' slows the feed x0.75, even when the machine's max holds it,
  // except where a thin chip melts or rubs (keepChip); 'aggressive' speeds it x1.25, up
  // to the material's chip limit and the machine's max. Depth per pass and stepover
  // x0.75 / x1.2. 'average' (or none) leaves them as is. RPM stays.
  // deep (optional): { depthMm: Total Depth, stepMm: a Depth of Cut typed by
  // hand, compression: a compression bit, fluteMm: its flute length, which
  // no pass goes deeper than }. A
  // compression bit cuts in the fewest equal passes no deeper than its
  // flutes or 3x its diameter (its down-cut top only cleans the face once
  // a pass is past its up-cut tip). A pass deeper than the bit is wide
  // loads and bends it: the chip comes down a little, to 87.5% at 2x and
  // 75% at 3x and past (in wood, heat from a thin chip matters more than
  // the bend), but not under the material's least chip (minChip, mm, by
  // the style: a thinner one rubs and burns), nor where a thin chip melts
  // (keepChip).
  var MATERIALS = {
    mdf: { rpm: 18000, chip: 0.012, maxChip: 0.25, minChip: 0.05, stepdown: 0.5, stepover: 0.45 },
    softwood: { rpm: 18000, chip: 0.012, maxChip: 0.25, minChip: 0.05, stepdown: 0.5, stepover: 0.45 },
    hardwood: { rpm: 18000, chip: 0.009, maxChip: 0.2, minChip: 0.05, stepdown: 0.35, stepover: 0.4 },
    hdpe: { rpm: 15000, chip: 0.02, maxChip: 0.25, stepdown: 0.3, stepover: 0.4, keepChip: true },
    acrylic: { rpm: 16000, chip: 0.015, maxChip: 0.2, stepdown: 0.3, stepover: 0.4, keepChip: true },
    polycarbonate: { rpm: 16000, chip: 0.018, maxChip: 0.22, stepdown: 0.3, stepover: 0.4, keepChip: true },
    aluminum: { rpm: 18000, chip: 0.0045, maxChip: 0.06, stepdown: 0.1, stepover: 0.25, keepChip: true },
    foam: { rpm: 12000, chip: 0.02, maxChip: 0.4, minChip: 0.05, stepdown: 1, stepover: 0.6 }
  };
  var m = MATERIALS[material] || MATERIALS.mdf, L = limits || {};
  var S = { conservative: { chip: 0.75, cut: 0.75 }, aggressive: { chip: 1.25, cut: 1.2 } }[style] || { chip: 1, cut: 1 };
  var rpm = Math.round(Math.min(L.maxRpm || 24000, Math.max(L.minRpm || 0, m.rpm)));
  var maxFeed = Math.min(L.maxFeed || 4000, 4000), perRev = rpm * (flutes || 2);
  var avg = Math.min(maxFeed, perRev * Math.min(m.maxChip, m.chip * bitMm));
  var raw = S.chip < 1 ? avg * (m.keepChip ? 1 : S.chip) : perRev * Math.min(m.maxChip, m.chip * bitMm * S.chip);
  var D = deep || {}, step = Math.max(0.05, bitMm * m.stepdown * S.cut), passes = 0;
  if (D.compression && D.depthMm > 0 && bitMm > 0) {
    var most = Math.min(D.fluteMm > 0 ? D.fluteMm : Infinity, 3 * bitMm);
    passes = Math.max(1, Math.ceil(D.depthMm / most - 1e-9));
    step = D.depthMm / passes;
  }
  // No pass deeper than the flutes, when the tool table gives them.
  if (D.fluteMm > 0) step = Math.min(step, D.fluteMm);
  var pass = D.stepMm > 0 ? D.stepMm : step, ratio = bitMm > 0 ? pass / bitMm : 0;
  var deepChip = 1;
  if (!m.keepChip && ratio > 1 && raw > 0) {
    var eased = raw * Math.max(0.75, 1 - 0.125 * (ratio - 1)), least = Math.min(raw, perRev * (m.minChip || 0) * S.chip);
    deepChip = Math.max(eased, least) / raw;
    raw *= deepChip;
  }
  var exact = Math.min(maxFeed, Math.max(150, raw)), feed = Math.round(exact);
  return { rpm: rpm, chipMm: exact / perRev, feedMm: feed, capped: raw > maxFeed, deepChip: deepChip, passes: passes,
           plungeMm: Math.round(Math.min(L.maxPlunge || Infinity, Math.max(60, feed * 0.3))), stepMm: step, stepoverPct: Math.round(Math.min(0.9, m.stepover * S.cut) * 100) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startingFeeds: startingFeeds };
}
