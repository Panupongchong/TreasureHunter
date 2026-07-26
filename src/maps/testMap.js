// ============================================================
// testMap.js — "The Undervault" (WP5 design spec §B, transcribed;
// EXTENDED east in the 10-minute-clock pass — see "Extension" below).
//
// Grid: 40 px tiles. World 6400×1440 (160×36 tiles); viewport 960×540 →
// camera-follow. Three horizontal decks — Ground (floor top y=1376, the
// LOUD lane), Deck B (y=1016, the QUIET lane), Attic (y=616, risk rooms)
// — cut by inner walls W1 (x=1128), W2 (x=2448), W3 (x=3184) and
// W4 (x=4784) into five acts:
//   I   entrance plaza          x   16–1128
//   II  midworks (ritual, pit, attic)  x 1152–2448
//   III old vault works         x 2472–3184
//   IV  the Cistern             x 3208–4784
//   V   the Deep Vault          x 4808–6384
// Entrance = exit (heist loop): the way out is the way in, but you're
// mass 2.0 now. All rects [x,y,w,h] top-left (mapTypes.js convention).
//
// Physics facts the layout is built on (config.js): jump apex 112 px
// (carrier 56), run-jump gap ~208 px (carrier sprint-hop ~106), safe
// fall 260 px (carrier 130), zip range 420, zip speed 900, throw range
// 412 @45°.
//
// ---- Extension: why the map doubled (3200 → 6400) ----
// Playtest: the run ended long before the clock did. Root cause is the
// grapple — a zip moves you at 900 px/s versus a 260 px/s walk, so the
// original 3200 px world was ~4 s of chained zips end to end and the
// whole heist fit in a couple of minutes. Length alone does not fix that
// (open ground is exactly what a zip eats), so the two new acts are built
// out of the three things distance actually costs:
//   1. WALLS the zip cannot clear. W3/W4 are solid ceiling→y856 like W1,
//      so every act transition is a doorway you must physically enter.
//   2. LANES THE CARRIER CANNOT USE. The Cistern causeway and both Deck B
//      runs are strung with 150–220 px gaps and 100 px steps: mass 1.0
//      passes, mass 2.0 (apex 56, hop ~106) never does. The relic goes
//      the long way, gets thrown, or gets hoisted.
//   3. FALLS THAT COST A STUN. The causeway sits 160 px over the sump —
//      safe for a scout (260), a stun for a carrier (130). With the bag
//      now bursting on stun, a bagged carrier zipping the causeway is
//      making a real bet, and the sump below is the slow, safe answer.
// Clock is 10 min (CLOCK.sessionMs), so the haul, not the approach, is
// what the countdown is for.
// ============================================================

export const testMap = {
  id: 'test',
  name: 'The Undervault',
  width: 6400,
  height: 1440,

  platforms: [
    // ---- shell ----
    [0, 0, 6400, 16],       //  0 ceiling
    [0, 0, 16, 1440],       //  1 left wall
    [3184, 0, 24, 856],     //  2 W3 upper (was the east wall before the
                            //    extension; now the Act III|IV divider.
                            //    Ceiling to y856 — no zip-over, ever)
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
    // ---- Act III: haul shaft, old vault works ----
    [2472, 1016, 128, 16],  // 26 shaft rim W (x2472–2600)
    [2760, 1016, 284, 16],  // 27 old vault roof (x2760–3044; chimney open
                            //    3044–3184 — now a shaft down to W3's Deck B
                            //    doorway, not a dead end against the map edge)
    [2600, 1276, 48, 16],   // 28 shaft ledge 1 (mass-1 climb, rises 100)
    [2712, 1176, 48, 16],   // 29 shaft ledge 2                      *COLLAPSE*
    [2600, 1076, 48, 16],   // 30 shaft ledge 3 (hop left onto the rim edge, rise 60)
    [2848, 1032, 24, 184],  // 31 old vault front wall (roof underside to door top)
    [3004, 1344, 64, 32],   // 32 old pedestal — LOOTED. The relic moved to the
                            //    Deep Vault in Act V; this room is now a
                            //    two-doorway pass-through on the haul route
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
    [3184, 1016, 24, 200],  // 35 W3 mid (top = Deck B walkway; the ground
                            //    doorway below, y1216–1376, is left OPEN — a
                            //    bare chokepoint. Act III already gates the
                            //    haul twice, at d3 and the W2 slot)

    // ============ Act IV: THE CISTERN (x3208–4784) ============
    // Two lanes stacked 160 px apart. The SUMP (ground, y1376) is
    // continuous and slow: the only lane a hands-carrier can walk. The
    // CAUSEWAY (y1216) is four broken piers with 150/180/200 px gaps —
    // mass 1.0 clears them, mass 2.0 (hop ~106) never does. Falling off
    // the causeway is 160 px: nothing to a scout, a stun (and now a burst
    // bag) to a carrier.
    [3208, 1376, 700, 64],  // 36 sump west (x3208–3908)
    [3908, 1424, 268, 16],  // 37 drain floor (48 deep; the 268 gap is wider
                            //    than a run-jump, so everyone drops in and
                            //    hops out — and a chasing Brute dies here)
    [4176, 1376, 608, 64],  // 38 sump east (x4176–4784)
    [3208, 1016, 200, 16],  // 39 Deck B west balcony — where W3's Deck B
                            //    doorway lands you. The quiet lane ENDS here:
                            //    step off and you drop 200 px to pier 1
                            //    (safe at mass 1.0, one-way — 200 is unjumpable)
    [3440, 1216, 180, 32],  // 40 pier 1
    [3770, 1216, 180, 32],  // 41 pier 2  (gap 150)
    [4130, 1216, 160, 32],  // 42 pier 3  (gap 180)                  *COLLAPSE*
    [4490, 1216, 294, 32],  // 43 pier 4  (gap 200 — the sprint-or-swim one);
                            //    runs flush to W4, so the causeway ends by
                            //    dropping into W4's ground doorway
    [3990, 1300, 100, 16],  // 44 under-ledge: h2's perch, hanging 84 px below
                            //    the pier 2→3 gap. Doubles as the mercy catch
                            //    for a missed jump — you keep your legs but
                            //    lose the causeway, since the only way off it
                            //    is down into the drain
    [3600, 1312, 96, 16],   // 45 sump crate (anchor + hop)
    [4520, 1312, 96, 16],   // 46 sump crate 2
    [4600, 1116, 48, 16],   // 47 cistern climb 1 (+100 off pier 4)
    [4700, 1016, 84, 16],   // 48 cistern climb 2 → Deck B east landing, flush
                            //    to W4. Two 100 px steps: the quiet lane
                            //    reboards Deck B here and the carrier cannot
    // ---- W4: the Act IV|V divider (x=4784) ----
    [4784, 16, 24, 840],    // 49 W4 upper (ceiling to y856 — no zip-over)
    [4784, 1016, 24, 200],  // 50 W4 mid (top = Deck B walkway)

    // ============ Act V: THE DEEP VAULT (x4808–6384) ============
    [4808, 1376, 1576, 64], // 51 Act V ground — the long haul hall
    [4808, 1016, 320, 16],  // 52 Act V Deck B west landing (from d7)
    [5320, 1016, 420, 16],  // 53 gallery (gap 192 from the landing: mass 1.0
                            //    only)
    [5960, 1016, 300, 16],  // 54 Deep Vault roof (x5960–6260; chimney open
                            //    6260–6384). Gap 220 from the gallery is past
                            //    the run-jump limit — the roof is a ZIP-only
                            //    approach, and the chimney drop into the vault
                            //    is 360 px, so entering from above costs a stun
                            //    unless you grapple out of it
    [6048, 1032, 24, 184],  // 55 Deep Vault front wall (roof underside → d8 top)
    [6220, 1344, 64, 32],   // 56 pedestal (carrier can hop it: 32 < 56 apex)
    [5200, 1276, 48, 16],   // 57 haul shaft ledge 1 (ground→Deck B, rises 100)
    [5310, 1176, 48, 16],   // 58 haul shaft ledge 2                 *COLLAPSE*
    [5200, 1076, 48, 16],   // 59 haul shaft ledge 3 (hop right onto the
                            //    gallery edge x5320, rise 60)
    [5560, 700, 120, 160],  // 60 gantry (h3 — Act V's unsafe-drop room). Tall
                            //    face for the same reason as platform 34: a
                            //    zip off the gallery pops you over the lip.
                            //    Every exit is a 316 px drop to the gallery or
                            //    676 px to the floor — both past safe fall
    [5000, 1312, 96, 16],   // 61 Act V hall crate (anchor)
    [6384, 0, 16, 1440],    // 62 east wall (the new map edge)
  ],

  // Entrance plaza, on the ground inside the entrance zone (slot = index).
  spawns: [[208, 1340], [272, 1340], [336, 1340], [400, 1340]],

  doors: [
    // W1 ground doorway — the first loud gate (kick −10 s / quiet-lower 6 s).
    { id: 'd0', type: 'bridge',    x: 1128, y: 1216, w: 24, h: 160 },
    // W1 Deck B doorway — quiet-lane gate; once open, a straight run home.
    { id: 'd1', type: 'shortcut',  x: 1128, y: 856,  w: 24, h: 160 },
    // W2 Deck B doorway — the QUIET ROUTE's 2-player simultaneous crank
    // gate (required placement; hammer-immune). Still the only crankGate.
    { id: 'd2', type: 'crankGate', x: 2448, y: 856,  w: 24, h: 160 },
    // Old vault door — no longer holds the relic, but it is the only way
    // west out of the pass-through room (smash −20 s / pick 12 s).
    { id: 'd3', type: 'door',      x: 2848, y: 1216, w: 24, h: 160 },
    // Attic rubble — blocks the west alcove with h0 (blast −25 s / duo-clear).
    { id: 'd4', type: 'rubble',    x: 1800, y: 496,  w: 64, h: 120 },
    // W3 Deck B doorway — the quiet lane's toll into the Cistern. Cheap
    // (kick −10 s / lower 6 s) because the lane already pays at d1 and d2.
    { id: 'd5', type: 'bridge',    x: 3184, y: 856,  w: 24, h: 160 },
    // W4 ground doorway — ON THE HAUL ROUTE. Pry 9 s or break −15 s: the
    // gate the relic meets first on the way home, while the clock is
    // shortest and the team is most tempted to buy speed.
    { id: 'd6', type: 'shortcut',  x: 4784, y: 1216, w: 24, h: 160 },
    // W4 Deck B doorway — quiet lane into Act V; duo-clear rubble, so the
    // scouts pay in bodies where the haul route pays in clock.
    { id: 'd7', type: 'rubble',    x: 4784, y: 856,  w: 24, h: 160 },
    // THE vault door (smash −20 s / pick 12 s). Both lanes converge here.
    { id: 'd8', type: 'door',      x: 6048, y: 1216, w: 24, h: 160 },
  ],

  pickups: [
    // Attic, BEHIND the rubble, off the golden path (placement rule ok).
    { id: 'h0', type: 'hourglass', x: 1500, y: 580 },
    // Chimney ledge: reached by a 2-zip chain; every exit is a 344–720 px
    // drop (> 260 safe) — the unsafe-drop room (placement rule ok).
    { id: 'h1', type: 'hourglass', x: 3140, y: 620 },
    // Cistern under-ledge: one deliberate step off the causeway golden
    // path, and the only way off it is down into the drain and the sump
    // (placement rule ok).
    { id: 'h2', type: 'hourglass', x: 4040, y: 1264 },
    // Act V gantry: zip-only, and every exit is past safe fall height
    // (placement rule ok). Two new hourglasses for a map twice as long —
    // the time economy scales with the walking.
    { id: 'h3', type: 'hourglass', x: 5620, y: 664 },
    // Ritual slab, mid-map, exposed; 5 s all-players channel (+60 s once).
    { id: 'ritual', type: 'ritual', x: 1380, y: 980 },
  ],

  // Brute-baitable pits; monsters die on entry (Brutes can't jump → walk
  // off chasing a hopping player). LEVEL-BUILDER FIX vs spec (y1400→1396,
  // h24→28, bottom edge unchanged): MonsterSystem._insidePit tests the
  // monster CENTER, and a Brute (h 52) resting on the pit floor (top 1424)
  // has center y=1398 — the spec rect missed it by 2 px and Brutes would
  // never die. Ground-level walkers (center ≥1350) stay safely outside.
  // The Cistern drain uses the same 28 px band over its floor (top 1424).
  pits: [
    [1712, 1396, 268, 28],  // Act II pit
    [3908, 1396, 268, 28],  // Act IV drain
  ],

  // Escalation 2 (<3 min): pit crossing, ritual slab, both mid-climb
  // ledges, the Cistern's middle pier and Act V's mid-climb ledge — late
  // runs lose the free vertical routes and go loud.
  collapseIdx: [4, 14, 18, 29, 42, 58],

  labels: [
    { x: 80,   y: 1180, text: 'EXIT' }, // inside exitZone [16..144], not the entrance
    { x: 2900, y: 1300, text: 'OLD VAULT' },
    { x: 1380, y: 940,  text: 'RITUAL' },
    { x: 2660, y: 960,  text: 'HAUL SHAFT' },
    { x: 3560, y: 1160, text: 'CISTERN' },
    { x: 6100, y: 1300, text: 'DEEP VAULT' },
  ],

  monsterSpawns: [
    // Act II ground patrol — the pit-bait target, guards the loud lane.
    { id: 'mb0', type: 'brute',   x: 2200, y: 1324 },
    // Old vault / W3 approach guard.
    { id: 'ms0', type: 'skulker', x: 2950, y: 1350 },
    // Cistern causeway, on pier 2 — fights you where a shove is a 160 px
    // fall into the sump.
    { id: 'ms1', type: 'skulker', x: 3860, y: 1190 },
    // Sump patrol, east of the drain — the second bait target, and the
    // reason the carrier's slow lane is not a free one.
    { id: 'mb1', type: 'brute',   x: 4400, y: 1324 },
    // Deep Vault guard — denies a naive instant bag.
    { id: 'ms2', type: 'skulker', x: 6150, y: 1350 },
  ],

  // ---- WP5 objective data ----
  relicSpawn: [6252, 1320],          // on the Deep Vault pedestal (platform 56)
  exitZone:   [16, 1216, 128, 160],  // win = relic CARRIER inside this rect
  // ---- declared for later WPs (mapTypes.js) ----
  entranceZone: [160, 1216, 256, 160], // spawn/ready zone (WP6 ReadyZone)
  noSpawnZones: [[16, 976, 592, 464]], // monster-free plaza (spawn search
                                       // rejection — not yet enforced)
};
