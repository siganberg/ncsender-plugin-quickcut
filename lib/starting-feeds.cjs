/**
 * QuickCut starting speeds and feeds.
 *
 * MUST STAY IN SYNC WITH the inline startingFeeds inside config.html
 * (the dialog can't load external JS, so this is the Node-loadable twin
 * that tests/starting-feeds.test.cjs checks that copy against).
 */
function startingFeeds(bitMm, flutes, material, limits) {
  // By material, as ncCAM's (src/core/tools.js) and Spoilboard Toolbox's:
  // the chip each tooth takes grows with the bit up to a cap; feed = RPM x
  // flutes x chip; plunge 30% of the feed; depth per pass and stepover a
  // share of the bit. HDPE takes a thick chip (a thin one melts it),
  // polycarbonate one between it and acrylic's, aluminum a small one.
  // limits: the machine's max feed ($110/$111) and spindle range ($30/$31), when known.
  var MATERIALS = {
    mdf: { rpm: 18000, chip: 0.012, maxChip: 0.25, stepdown: 0.5, stepover: 0.45 },
    softwood: { rpm: 18000, chip: 0.012, maxChip: 0.25, stepdown: 0.5, stepover: 0.45 },
    hardwood: { rpm: 18000, chip: 0.009, maxChip: 0.2, stepdown: 0.35, stepover: 0.4 },
    hdpe: { rpm: 15000, chip: 0.02, maxChip: 0.25, stepdown: 0.3, stepover: 0.4 },
    acrylic: { rpm: 16000, chip: 0.015, maxChip: 0.2, stepdown: 0.3, stepover: 0.4 },
    polycarbonate: { rpm: 16000, chip: 0.018, maxChip: 0.22, stepdown: 0.3, stepover: 0.4 },
    aluminum: { rpm: 18000, chip: 0.0045, maxChip: 0.06, stepdown: 0.1, stepover: 0.25 },
    foam: { rpm: 12000, chip: 0.02, maxChip: 0.4, stepdown: 1, stepover: 0.6 }
  };
  var m = MATERIALS[material] || MATERIALS.mdf, L = limits || {};
  var rpm = Math.round(Math.min(L.maxRpm || 24000, Math.max(L.minRpm || 0, m.rpm)));
  var chip = Math.min(m.maxChip, m.chip * bitMm), maxFeed = Math.min(L.maxFeed || 4000, 4000);
  var raw = rpm * (flutes || 2) * chip, feed = Math.round(Math.min(maxFeed, Math.max(150, raw)));
  return { rpm: rpm, chipMm: chip, feedMm: feed, capped: raw > maxFeed,
           plungeMm: Math.round(Math.max(60, feed * 0.3)), stepMm: Math.max(0.05, bitMm * m.stepdown), stepoverPct: Math.round(m.stepover * 100) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startingFeeds: startingFeeds };
}
