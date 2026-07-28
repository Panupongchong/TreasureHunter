// ============================================================
// zipArena.js — "Zip Arena". The feel test for TRAVERSAL.zip, not a level.
//
// World 2560×1200, 40 px grid, ground top y=1136. It opts in with
// `traversal: 'zip'`, which is the ONLY thing separating it from the
// shipped maps: a LOW jump (0.7× → 55 px apex, half the normal 112),
// auto-climb one tile, terrain attaches at anchor points only, two-stage
// zip (hook → reel → let go), and the hook is a THROWN body with its own
// gravity. testMap and shaftMap keep the full jump and the hitscan zip and
// are unaffected — both modes run in one build.
//
// The low jump and the step law are the same statement said twice: 55 px
// clears station A's one-tile block and cannot touch the two-tile one, so
// every distance below still means what the station comments say it means.
// What the jump adds is the small stuff between hooks — hopping the lip you
// are standing next to instead of negotiating with it.
//
// Read west to east; every station answers one question, and THE ROAD
// (platform 3) runs unbroken underneath so you can always walk back.
//
//   A  x600–1000   the step law. A 40 px block you climb without
//                  thinking, then an 80 px one you cannot. Both sit ON
//                  the road, deliberately: a hands-carrier (step 40/2 =
//                  20 px) is stopped by the SMALL one, so the relic has
//                  to be bagged to go home. "In hands is a transfer
//                  state" is not a rule here, it is the terrain
//   B  x1120–1720  the lip ladder. Three exposed lips, 200/270/300 px
//                  apart: ordinary hook-reel-hook climbing, and the
//                  baseline for how a plain zip should feel at 650
//   C  x1770–2140  authored anchors. Two mid-air points (map.anchors)
//                  are the only way to the perch — the shelf below is
//                  467 px short of it, past the 420 range. This is the
//                  designer's grip on pacing: no anchor, no route
//   D  x2280–2544  the ferry. A deck 400 px up whose lips are SUPPRESSED
//                  (noAnchorIdx), so terrain offers nothing. The only
//                  way up is hooking a body — the dummy Brute standing on
//                  it, or a teammate. Bodies are the traversal network
//   E  x1900–2140  the drop test. Perch → shelf is 480 (past the 260
//                  safe fall = stun); shelf → road is 160 (free)
//
// Relic loop: pedestal at the east end, exit zone at the west end, so a
// full haul crosses every station. Two dummy Brutes are anchors, not
// threats (they never aggro): one on the ferry, one loose on the road as
// a launcher to test letting go with speed.
// ============================================================

export const zipArena = {
  id: 'zip',
  name: 'Zip Arena',
  traversal: 'zip',
  width: 2560,
  height: 1200,

  platforms: [
    [0, 0, 2560, 16],       //  0 ceiling (lips suppressed — world corners
                            //    are not interesting hooks)
    [0, 0, 16, 1200],       //  1 left wall  (16 px wide: too thin for lips)
    [2544, 0, 16, 1200],    //  2 right wall
    [16, 1136, 2528, 64],   //  3 THE ROAD — unbroken, the only lane a
                            //    hands-carrier can use, and your walk back
    // ---- A: the step law ----
    [600, 1096, 160, 40],   //  4 one tile (40). Auto-climbed at mass 1.0,
                            //    NEVER at 2.0 — this is the block that
                            //    stops the relic
    [840, 1056, 160, 80],   //  5 two tiles (80). Hook its lip; nobody walks
                            //    up this
    // ---- B: the lip ladder ----
    [1120, 976, 120, 16],   //  6 rung 1 (160 above the road)
    [1360, 856, 120, 16],   //  7 rung 2
    [1600, 776, 120, 16],   //  8 rung 3
    // ---- C/E: the perch and the shelf under it ----
    [1900, 496, 240, 16],   //  9 the perch. 467 px above the shelf lips, so
                            //    it is out of range from below: reachable
                            //    ONLY through the two authored anchors
    [1900, 976, 240, 16],   // 10 the shelf (easy hook off the road, 160 up).
                            //    Perch → shelf is a 480 px drop: a stun
    // ---- D: the ferry ----
    [2280, 736, 264, 16],   // 11 SMOOTH DECK — in noAnchorIdx, so it has no
                            //    lips at all. 400 px up, nothing to hook:
                            //    a body is the only way
    // ---- the objective ----
    [2400, 1104, 64, 32],   // 12 pedestal
  ],

  // Mid-air attach points with no platform under them. The whole premise
  // of anchorsOnly: travel time is a level-design decision.
  anchors: [
    { x: 1770, y: 900 },  // ~220 from the road below
    { x: 1850, y: 720 },  // ~197 from the first, ~235 to the perch lip
  ],

  // Platforms that contribute NO lips: the ceiling (noise) and the ferry
  // deck (the point of station D).
  noAnchorIdx: [0, 11],

  spawns: [[208, 1100], [272, 1100], [336, 1100], [400, 1100]],

  labels: [
    { x: 100,  y: 1060, text: 'EXIT' },
    { x: 600,  y: 1050, text: 'A: ONE TILE, FREE' },
    { x: 840,  y: 1010, text: 'TWO TILES, HOOK' },
    { x: 1120, y: 930,  text: 'B: LIP LADDER' },
    { x: 1700, y: 940,  text: 'C: AUTHORED ANCHORS' },
    { x: 1900, y: 450,  text: 'PERCH — 480 DROP' },
    { x: 2280, y: 690,  text: 'D: FERRY (NO LIPS)' },
    { x: 2360, y: 1060, text: 'RELIC' },
  ],

  monsterSpawns: [
    // Anchors with legs. Dummies never aggro — they are here to be hooked.
    { id: 'md0', type: 'brute', x: 2400, y: 684,  dummy: true }, // on the ferry
    { id: 'md1', type: 'brute', x: 2150, y: 1084, dummy: true }, // road launcher
  ],

  relicSpawn: [2432, 1080],
  exitZone:   [16, 976, 128, 160],
  entranceZone: [160, 976, 256, 160],
  noSpawnZones: [[16, 976, 592, 160]],
};
