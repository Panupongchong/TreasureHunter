// ============================================================
// TombstoneEntity — a disconnected player's rejoin anchor (plan §2.6).
//
// No physics body EVER (PickupEntity precedent) — reclaim is a host
// distance check; position is static and event-driven (TOMBSTONE /
// TOMBSTONE_STATE / DESPAWN), never in snapshots.
// ============================================================

import { PLAYER } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {{id:string, slot:number, x:number, y:number, baggedRelic?:boolean}} def
 */
export function createTombstone(scene, { id, slot, x, y, baggedRelic }) {
  const t = scene.add.rectangle(x, y - 13, 20, 26, 0x565d75);              // slab
  t.cap = scene.add.rectangle(x, y - 28, 12, 6, PLAYER.colors[slot % 4]);  // whose grave
  t.gem = scene.add.rectangle(x, y - 40, 10, 10, 0xf5a623).setAngle(45)
    .setVisible(!!baggedRelic);                                            // bagged-relic glyph
  t.state = { id, slot, x, y, baggedRelic: !!baggedRelic };
  return t;
}

export function setTombstoneBagged(t, bagged) {
  t.state.baggedRelic = bagged;
  t.gem.setVisible(bagged);
}

export function destroyTombstone(t) {
  t.cap.destroy();
  t.gem.destroy();
  t.destroy();
}
