// ============================================================
// testMap.js — "The Undervault" (WP5 design spec §B, transcribed).
//
// Grid: 40 px tiles. World 3200×1440 (80×36 tiles); viewport 960×540 →
// camera-follow. Three horizontal decks — Ground (floor top y=1376, the
// LOUD lane), Deck B (y=1016, the QUIET lane), Attic (y=616, risk rooms)
// — cut by two full-height inner walls, W1 (x=1128) and W2 (x=2448),
// into three acts: Act I entrance plaza, Act II midworks (ritual, pit,
// attic), Act III vault works (haul shaft, antechamber, vault).
// Entrance = exit (heist loop): the way out is the way in, but you're
// mass 2.0 now. All rects [x,y,w,h] top-left (mapTypes.js convention).
//
// Physics facts the layout is built on (config.js): jump apex 112 px
// (carrier 56), run-jump gap ~208 px (carrier sprint-hop ~106), safe
// fall 260 px (carrier 130), zip range 420, throw range 412 @45°.
// ============================================================

export const testMap = {
  id: 'test',
  name: 'The Undervault',
  width: 3200,
  height: 1440,

  platforms: [
    // ---- shell ----
    [0, 0, 3200, 16],       //  0 ceiling
    [0, 0, 16, 1440],       //  1 left wall
    [3184, 0, 16, 1440],    //  2 right wall
    // ---- Ground deck (the LOUD lane, floor top y=1376) ----
    [16, 1376, 1696, 64],   //  3 ground west (ends x1712 at the pit)
    [1816, 1376, 64, 64],   //  4 pit pillar                       *COLLAPSE*
    [1980, 1376, 1204, 64], //  5 ground east
    [1712, 1424, 268, 16],  //  6 pit floor (48 deep; players hop out,
                            //    monsters die via the pit zone below)
    // ---- Act I: entrance plaza stairs → balcony (Deck B west) ----
    [464, 1276, 112, 16],   //  7 plaza stair 1 (rises 100/100/100/60)
    [608, 1176, 112, 16],   //  8 plaza stair 2
    [464, 1076, 112, 16],   //  9 plaza stair 3
    [608, 1016, 472, 16],   // 10 Act I balcony (Deck B)
    [880, 1232, 96, 16],    // 11 Act I hall crate (grapple anchor + jump interest)
    // ---- W1: the first inner wall (x=1128) ----
    [1128, 16, 24, 840],    // 12 W1 upper (ceiling to y856 — no zip-over, ever)
    [1128, 1016, 24, 200],  // 13 W1 mid (between shortcut d1 and bridge d0
                            //    doorways; its top = Deck B walkway)
    // ---- Act II: Deck B midworks ----
    [1152, 1016, 408, 16],  // 14 ritual slab (Deck B)               *COLLAPSE*
    [1680, 1016, 432, 16],  // 15 Deck B mid-east — spans directly OVER the
                            //    pit (zip anchor: zip-over-pit for anyone)
    [2232, 1016, 240, 16],  // 16 Deck B pre-crank
    [1568, 1276, 48, 16],   // 17 ledge chain 1 (ground→Deck B, in the
                            //    1560–1680 gap between slabs 14 and 15)
    [1632, 1176, 48, 16],   // 18 ledge chain 2                      *COLLAPSE*
    [1568, 1076, 48, 16],   // 19 ledge chain 3 (hop onto edge of 14 or 15, rise 60)
    // ---- Attic (risk rooms, floor y=616) ----
    [1224, 616, 776, 16],   // 20 attic floor (x1224–2000)
    [2016, 916, 48, 16],    // 21 attic step 1 (zigzag up from slab 15, rises 100)
    [2080, 816, 48, 16],    // 22 attic step 2
    [2016, 716, 48, 16],    // 23 attic step 3 (hop left onto the attic edge)
    // ---- W2: the second inner wall (x=2448) ----
    [2448, 496, 24, 360],   // 24 W2 upper (y496–856; top reachable only from
                            //    the attic east edge — the expert parkour pass)
    [2448, 1016, 24, 280],  // 25 W2 lower (y1016–1296; top = Deck B walkway;
                            //    below it the 80 px ground doorway chokepoint)
    // ---- Act III: haul shaft, vault works ----
    [2472, 1016, 128, 16],  // 26 shaft rim W (x2472–2600)
    [2760, 1016, 284, 16],  // 27 vault roof (x2760–3044; chimney open 3044–3184)
    [2600, 1276, 48, 16],   // 28 shaft ledge 1 (mass-1 climb, rises 100)
    [2712, 1176, 48, 16],   // 29 shaft ledge 2                      *COLLAPSE*
    [2600, 1076, 48, 16],   // 30 shaft ledge 3 (hop left onto the rim edge, rise 60)
    [2848, 1032, 24, 184],  // 31 vault front wall (roof underside to door top)
    [3004, 1344, 64, 32],   // 32 pedestal (carrier can hop it: 32 < 56 apex)
    [1320, 1232, 96, 16],   // 33 Act II hall crate (anchor)
    [3100, 656, 84, 120],   // 34 chimney ledge (h1 — the unsafe-drop room).
                            //   LEVEL-BUILDER FIX vs spec (h 16→120, same top):
                            //   a 16px lip is unlandable from below — the zip's
                            //   final steering always ends in an up-block head
                            //   bonk (vy zeroed) under the lip. A tall face makes
                            //   the contact a SIDE block that keeps upward zip
                            //   momentum, so the player pops over the lip —
                            //   the intended 2-zip chain, now physically real.
                            //   Top surface, exits and drops unchanged.
  ],

  // Entrance plaza, on the ground inside the entrance zone (slot = index).
  spawns: [[208, 1340], [272, 1340], [336, 1340], [400, 1340]],

  doors: [
    // W1 ground doorway — the first loud gate (kick −10 s / quiet-lower 6 s).
    { id: 'd0', type: 'bridge',    x: 1128, y: 1216, w: 24, h: 160 },
    // W1 Deck B doorway — quiet-lane gate; once open, a straight run home.
    { id: 'd1', type: 'shortcut',  x: 1128, y: 856,  w: 24, h: 160 },
    // W2 Deck B doorway — the QUIET ROUTE's 2-player simultaneous crank
    // gate (required placement; hammer-immune).
    { id: 'd2', type: 'crankGate', x: 2448, y: 856,  w: 24, h: 160 },
    // THE vault door — both lanes converge here (smash −20 s / pick 12 s).
    { id: 'd3', type: 'door',      x: 2848, y: 1216, w: 24, h: 160 },
    // Attic rubble — blocks the west alcove with h0 (blast −25 s / duo-clear).
    { id: 'd4', type: 'rubble',    x: 1800, y: 496,  w: 64, h: 120 },
  ],

  pickups: [
    // Attic, BEHIND the rubble, off the golden path (placement rule ok).
    { id: 'h0', type: 'hourglass', x: 1500, y: 580 },
    // Chimney ledge: reached by a 2-zip chain; every exit is a 344–720 px
    // drop (> 260 safe) — the unsafe-drop room (placement rule ok).
    { id: 'h1', type: 'hourglass', x: 3140, y: 620 },
    // Ritual slab, mid-map, exposed; 5 s all-players channel (+60 s once).
    { id: 'ritual', type: 'ritual', x: 1380, y: 980 },
  ],

  // Brute-baitable pit; kills monsters on entry (Brutes can't jump → walk
  // off chasing a hopping player). LEVEL-BUILDER FIX vs spec (y1400→1396,
  // h24→28, bottom edge unchanged): MonsterSystem._insidePit tests the
  // monster CENTER, and a Brute (h 52) resting on the pit floor (top 1424)
  // has center y=1398 — the spec rect missed it by 2 px and Brutes would
  // never die. Ground-level walkers (center ≥1350) stay safely outside.
  pits: [[1712, 1396, 268, 28]],

  // Escalation 2 (<3 min): pit crossing, ritual slab, both mid-climb
  // ledges — late runs lose the free vertical routes and go loud.
  collapseIdx: [4, 14, 18, 29],

  labels: [
    { x: 80,   y: 1180, text: 'EXIT' }, // inside exitZone [16..144], not the entrance
    { x: 2950, y: 1300, text: 'VAULT' },
    { x: 1380, y: 940,  text: 'RITUAL' },
    { x: 2660, y: 960,  text: 'HAUL SHAFT' },
  ],

  monsterSpawns: [
    // Act II ground patrol — the pit-bait target, guards the loud lane.
    { id: 'mb0', type: 'brute',   x: 2200, y: 1324 },
    // Vault guard — denies a naive instant bag.
    { id: 'ms0', type: 'skulker', x: 2950, y: 1350 },
  ],

  // ---- WP5 objective data ----
  relicSpawn: [3036, 1320],          // on the pedestal (platform 32)
  exitZone:   [16, 1216, 128, 160],  // win = relic CARRIER inside this rect
  // ---- declared for later WPs (mapTypes.js) ----
  entranceZone: [160, 1216, 256, 160], // spawn/ready zone (WP6 ReadyZone)
  noSpawnZones: [[16, 976, 592, 464]], // monster-free plaza (spawn search
                                       // rejection — not yet enforced)
};
