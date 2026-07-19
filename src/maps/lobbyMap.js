// ============================================================
// lobbyMap.js — the lobby practice arena (geometry only for WP1).
//
// The lobby IS GameScene with this map (plan §3.1). Later WPs add the
// dummy monster, smashable door, grapple anchor, boost ledge, weapon
// rack, vault-entrance ready zone, and stage board on top of this
// geometry — leave room for them.
// ============================================================

export const lobbyMap = {
  id: 'lobby',
  name: 'The Hideout',
  width: 960,
  height: 540,
  platforms: [
    [0, 528, 960, 12],   // floor
    [0, 0, 12, 540],     // left wall
    [948, 0, 12, 540],   // right wall
    [0, 0, 960, 12],     // ceiling
    [60, 440, 200, 14],  // low left shelf
    [700, 440, 200, 14], // low right shelf (future: dummy monster pen)
    [380, 370, 200, 14], // center step
    [120, 300, 160, 14], // mid left
    [680, 300, 160, 14], // mid right (future: boost ledge target)
    [400, 200, 160, 14], // high center (future: grapple anchor overhead)
  ],
  spawns: [
    // Slot-3 spawn 660→620 (WP6): [660,480] put the player body (±13 px)
    // inside door d0's static body (x 660..674) — pre-existing WP4 flaw.
    [140, 480], [820, 480], [300, 480], [620, 480],
  ],
  // WP6 vault-entrance ready zone (ReadyZoneSystem; the UI half draws the
  // 120×8 gold strip + VAULT ENTRANCE label + fill ring from this rect).
  // 120 px strip centered x=480, floor-anchored: standing player center
  // y≈511 is inside.
  readyZone: { x: 420, y: 468, w: 120, h: 60 },
  // WP6 stage board (host-only interact channel; on the floor, left of
  // the zone — the 48 px prompt radii of board/zone/rack never overlap).
  board: { x: 320, y: 496 },
  // ---- WP4 practice furniture ----
  doors: [
    { id: 'd0', type: 'door', x: 660, y: 458, w: 14, h: 70 }, // gates the dummy pen
  ],
  pickups: [],
  weaponRack: { x: 160, y: 430 }, // on the low left shelf
  labels: [
    { x: 480, y: 185, text: 'ANCHOR' },   // over the high-center platform
    { x: 800, y: 425, text: 'DUMMY PEN' },
    { x: 160, y: 415, text: 'WEAPONS' },
    { x: 320, y: 468, text: 'STAGE BOARD' },
    // 'VAULT ENTRANCE' label + gold strip are DRAWN by the UI half from
    // readyZone (ux-spec-mandated styling) — deliberately not label data.
  ],
  monsterSpawns: [
    { id: 'dummy0', type: 'skulker', x: 800, y: 500, dummy: true },
  ],
};
