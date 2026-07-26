// ============================================================
// shaftMap.js — "The Deep Shaft". The vertical counterpart to testMap.
//
// Grid: 40 px tiles. World 1920×3200 (48×80 tiles) — HALF the width of
// The Undervault and MORE THAN TWICE its height; total area ~1.33×.
// Viewport 960×540 → camera-follow (both axes exceed it).
//
// The loop is inverted vs testMap: you spawn at the TOP (exit deck L7)
// and the relic sits at the BOTTOM (the vault). Descent is cheap —
// gravity does it. The escape is a 2800 px CLIMB while mass 2.0.
//
// Eight decks, 400 px apart (floor tops y=3136, 2736, 2336, 1936, 1536,
// 1136, 736, 336). Each deck leaves a 688 px shaft open, alternating
// EAST / WEST, so the route is a switchback: the only way between decks
// is the ledge chain in that level's shaft (chains A–G, bottom to top).
//
// Physics facts the layout is built on (config.js): jump apex 112 px
// (carrier 56), run-jump gap ~208 px (carrier sprint-hop ~106), safe
// fall 260 px (carrier 130), zip range 420, throw range 412 @45°.
//
// THE CENTRAL TENSION: every chain ledge rises exactly 100 px. A mass-1.0
// player clears that (apex 112). A relic carrier (apex 56) CANNOT clear a
// single one. So the relic physically cannot walk home — it has to be
// grapple-hoisted deck by deck, thrown up to a teammate, or unbagged and
// relayed. The map never says this; the mass rule enforces it.
// Corollary for descent: an open-shaft plunge is 400 px (> 260 safe fall)
// = stun, but the chain ledges break it into safe 100 px hops. Fast route
// costs a stun, careful route costs time — the usual axis.
//
// All rects [x,y,w,h] top-left (mapTypes.js convention); pickups,
// relicSpawn and monsterSpawns are CENTERS.
// ============================================================

export const shaftMap = {
  id: 'shaft',
  name: 'The Deep Shaft',
  width: 1920,
  height: 3200,

  platforms: [
    // ---- shell ----
    [0, 0, 1920, 16],       //  0 ceiling
    [0, 0, 16, 3200],       //  1 left wall
    [1904, 0, 16, 3200],    //  2 right wall
    // ---- L0: vault floor (bottom, top y=3136), cut by the brute pit ----
    [16, 3136, 1400, 64],   //  3 vault floor west (ends x1416 at the pit)
    [1684, 3136, 220, 64],  //  4 vault floor east (chain A's landing side)
    [1416, 3184, 268, 16],  //  5 pit floor (48 deep; players hop out, monsters
                            //    die via the pit zone below). Gap 268 > the
                            //    208 run-jump gap: a carrier CANNOT jump it and
                            //    must drop in and be hauled, or go around east.
    // ---- the vault chamber (west end of L0) ----
    [16, 2936, 568, 16],    //  6 vault roof (its top is the west descent lane:
                            //    L1 → roof is 200, roof → floor is 200, both
                            //    under the 260 safe fall. One-way: 200 px is
                            //    unjumpable, so west is descent-only and chain
                            //    A is the sole ascent out of the vault.)
    [560, 2952, 24, 24],    //  7 vault front wall (roof underside → door top)
    [300, 3104, 64, 32],    //  8 relic pedestal (32 < carrier apex 56: a
                            //    carrier can still hop off it)
    // ---- L1 deck (top y=2736), shaft open EAST x1216–1904 ----
    [16, 2736, 1200, 16],   //  9 L1 deck
    // ---- chain A: L0 → L1, in the east shaft, hugging L1's edge ----
    [1300, 3036, 48, 16],   // 10 A1
    [1420, 2936, 48, 16],   // 11 A2 (directly over the pit)        *COLLAPSE*
    [1300, 2836, 48, 16],   // 12 A3 → hop left onto L1's edge (x1216, rise 100)
    // ---- L2 deck (top y=2336), shaft open WEST x16–704 ----
    [704, 2336, 1200, 16],  // 13 L2 deck
    // ---- chain B: L1 → L2, west shaft ----
    [560, 2636, 48, 16],    // 14 B1
    [660, 2536, 48, 16],    // 15 B2
    [560, 2436, 48, 16],    // 16 B3 → hop right onto L2's edge (x704) *COLLAPSE*
    // ---- L3 deck (top y=1936), shaft open EAST ----
    [16, 1936, 1200, 16],   // 17 L3 deck
    // ---- chain C: L2 → L3, east shaft ----
    [1300, 2236, 48, 16],   // 18 C1
    [1420, 2136, 48, 16],   // 19 C2
    [1300, 2036, 48, 16],   // 20 C3 → hop left onto L3's edge (x1216)
    // ---- L4 deck (top y=1536), shaft open WEST — the midpoint deck ----
    [704, 1536, 1200, 16],  // 21 L4 deck (widest continuous floor: the ritual
                            //    room and the natural regroup/hoist staging post)
    // ---- chain D: L3 → L4, west shaft ----
    [560, 1836, 48, 16],    // 22 D1
    [660, 1736, 48, 16],    // 23 D2                                 *COLLAPSE*
    [560, 1636, 48, 16],    // 24 D3 → hop right onto L4's edge (x704)
    // ---- L5 deck (top y=1136), shaft open EAST ----
    [16, 1136, 1200, 16],   // 25 L5 deck
    // ---- chain E: L4 → L5, east shaft ----
    [1300, 1436, 48, 16],   // 26 E1
    [1420, 1336, 48, 16],   // 27 E2
    [1300, 1236, 48, 16],   // 28 E3 → hop left onto L5's edge (x1216)
    // ---- L6 deck (top y=736), shaft open WEST ----
    [704, 736, 1200, 16],   // 29 L6 deck
    // ---- chain F: L5 → L6, west shaft ----
    [560, 1036, 48, 16],    // 30 F1
    [660, 936, 48, 16],     // 31 F2                                 *COLLAPSE*
    [560, 836, 48, 16],     // 32 F3 → hop right onto L6's edge (x704)
    // ---- L7: the exit deck (top y=336), shaft open EAST x1016–1904 ----
    [16, 336, 1000, 16],    // 33 exit deck — spawn, entrance AND exit
    // ---- chain G: L6 → L7, east shaft (the last climb, fully exposed) ----
    [1100, 636, 48, 16],    // 34 G1
    [1220, 536, 48, 16],    // 35 G2
    [1100, 436, 48, 16],    // 36 G3 → hop left onto L7's edge (x1016)
    // ---- the chimney: a 2-zip detour off the east shaft for h1 ----
    [1500, 1180, 48, 16],   // 37 zip anchor 1 (from L5's east edge, ~290 px)
    [1780, 1000, 100, 120], // 38 chimney ledge (h1). Tall face, not a 16 px lip
                            //    — same fix as testMap's platform 34: a thin lip
                            //    ends a zip in a head bonk, a tall face keeps the
                            //    upward momentum so you pop over. Every exit from
                            //    it is a 536 px drop to L4 (> 260) — the
                            //    unsafe-drop room.
    // ---- floating crates: grapple anchors + jump interest ----
    [880, 2632, 96, 16],    // 39 L1 crate
    [1000, 1432, 96, 16],   // 40 L4 crate
  ],

  // On the exit deck, inside the entrance zone (slot = index). You start
  // where you must return to.
  spawns: [[208, 300], [272, 300], [336, 300], [400, 300]],

  doors: [
    // THE vault door, bottom of the world (smash −20 s / pick 12 s).
    { id: 'd0', type: 'door',      x: 560,  y: 2976, w: 24, h: 160 },
    // L5 rubble sealing the west alcove that holds h0 (blast −25 s / duo-clear).
    // The L5 golden path runs east-edge → west chain F at x560, so x300 is
    // genuinely off it.
    { id: 'd1', type: 'rubble',    x: 300,  y: 1016, w: 64, h: 120 },
    // L4 crank gate — sits between chain D's landing (x704) and chain E's
    // start (x1300), so the 2-player simultaneous crank is unavoidable on the
    // haul route. Hammer-immune: you cannot buy your way past this one.
    { id: 'd2', type: 'crankGate', x: 1200, y: 1376, w: 24, h: 160 },
    // L6 shortcut — between chain F's landing (x704) and chain G (x1100).
    { id: 'd3', type: 'shortcut',  x: 900,  y: 576,  w: 24, h: 160 },
    // L1 bridge — between chain A's landing (east edge) and chain B (x560).
    // The first gate the relic meets on the way out (kick −10 s / lower 6 s).
    { id: 'd4', type: 'bridge',    x: 700,  y: 2576, w: 24, h: 160 },
  ],

  pickups: [
    // L5 west alcove, behind d1's rubble (placement rule ok).
    { id: 'h0', type: 'hourglass', x: 180,  y: 1100 },
    // Chimney ledge, reached by the 2-zip chain off L5; every exit is a
    // 536 px drop (> 260 safe) — the unsafe-drop room (placement rule ok).
    { id: 'h1', type: 'hourglass', x: 1830, y: 964 },
    // L4, the midpoint deck: the one place the whole team passes twice.
    { id: 'ritual', type: 'ritual', x: 900,  y: 1500 },
  ],

  // Brute-baitable pit in the vault floor; kills monsters on entry. Zone sits
  // just above the pit floor (top 3184) so a resting Brute's CENTER lands
  // inside it — same 28 px band testMap needed after its 2 px miss.
  pits: [[1416, 3156, 268, 28]],

  // Escalation 2 (<3 min): one rung out of chains A, B, D and F. Losing a
  // single rung breaks that chain's 100 px cadence into a 200 px gap — the
  // free vertical route is gone and the haul has to go loud or grapple.
  collapseIdx: [11, 16, 23, 31],

  labels: [
    { x: 80,   y: 240,  text: 'EXIT' },
    { x: 300,  y: 3060, text: 'VAULT' },
    { x: 900,  y: 1460, text: 'RITUAL' },
    { x: 1560, y: 2500, text: 'THE SHAFT' },
  ],

  monsterSpawns: [
    // Vault-floor patrol, on the pit side — the bait target.
    { id: 'mb0', type: 'brute',   x: 900,  y: 3084 },
    // L4 guard: the crank gate takes two players, so something has to
    // threaten the two who are busy cranking.
    { id: 'ms0', type: 'skulker', x: 1500, y: 1510 },
    // L2 patrol — harasses the mid-climb.
    { id: 'ms1', type: 'skulker', x: 1600, y: 2310 },
  ],

  // ---- objective data ----
  relicSpawn: [332, 3080],           // on the pedestal (platform 8)
  exitZone:   [16, 176, 128, 160],   // win = relic CARRIER inside, atop L7
  // ---- declared for later WPs (mapTypes.js) ----
  entranceZone: [160, 176, 256, 160],
  noSpawnZones: [[16, 176, 700, 160]], // monster-free exit deck landing
};
