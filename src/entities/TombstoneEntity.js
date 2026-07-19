// ============================================================
// TombstoneEntity — a disconnected player's rejoin anchor (plan §2.6).
//
// No physics body EVER (PickupEntity precedent) — reclaim is a host
// distance check; position is static and event-driven (TOMBSTONE /
// TOMBSTONE_STATE / DESPAWN), never in snapshots.
//
// WP7: three rects → one per-slot procedural slab (the slot-color
// engraving is BAKED into tombstone0..3, so `t.cap` is gone) + the
// bagged-relic gem. `t.state.x / t.state.y` remain the LOGICAL ground
// position that HUD and RelicSystem.tombstoneSpawn read — deliberately
// distinct from the sprite's drawn position. Do not conflate them.
// ============================================================

import { FX } from '../config.js';

/**
 * @param {{id:string, slot:number, x:number, y:number, baggedRelic?:boolean}} def
 */
export function createTombstone(scene, { id, slot, x, y, baggedRelic }) {
  const t = scene.add.image(x, y - 15, `tombstone${slot % 4}`)
    .setDepth(FX.depth.furniture);
  t.gem = scene.add.image(x, y - 40, 'tombstoneGem')
    .setDepth(FX.depth.furniture + 1).setVisible(!!baggedRelic);
  t.state = { id, slot, x, y, baggedRelic: !!baggedRelic };
  return t;
}

export function setTombstoneBagged(t, bagged) {
  t.state.baggedRelic = bagged;
  t.gem.setVisible(bagged);
}

export function destroyTombstone(t) {
  t.gem.destroy();
  t.destroy();
}
