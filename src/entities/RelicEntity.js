// ============================================================
// RelicEntity — the objective (PlayerEntity factory pattern: same
// factory on host — dynamic arcade body — and client — visual proxy).
//
// All authoritative data lives in the flat `.state` blob (plan §4):
//   rs: 'loose'|'held'|'bagged'|'flying'    holderSlot: null|0..3
// Host: RelicSystem owns the state machine; body enabled only while
// loose/flying (held/bagged = pinned to the holder, body off — which
// also drops grapple beams on it via detach rule D4, and removes it
// from dynamicTargets). Client: rs/holderSlot arrive via RELIC_STATE
// events + the snapshot relic group; ONE cosmetics path off `.state`.
//
// No relic×player collider EVER (pickup is grab-range, not contact) —
// no self-collision on throws. relic×platforms and relic×doorsGroup
// colliders are added by GameScene.
// ============================================================

import { RELIC } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 */
export function createRelic(scene, x, y, withBody) {
  const rel = scene.add.rectangle(x, y, RELIC.width, RELIC.height, RELIC.color);
  // Flat-2D "glow": a larger translucent rect behind it (no textures).
  rel.glow = scene.add.rectangle(x, y, RELIC.width + 8, RELIC.height + 8, RELIC.color, 0.25)
    .setDepth(-1);
  rel.state = { id: 'relic', rs: 'loose', holderSlot: null, lockoutSlot: null, lockoutMs: 0 };
  if (withBody) {
    scene.physics.add.existing(rel);
    rel.body.setCollideWorldBounds(true);
    rel.body.setBounce(RELIC.bounce);       // hops visibly, settles in ~2 bounces
    rel.body.setDragX(RELIC.looseDragX);    // starts loose; throws zero it
    rel.body.setMaxVelocityY(1200);
  }
  return rel;
}

/** One cosmetics path, all modes — driven purely off `.state` (rs written
 *  by the host sim, or by snapshot/RELIC_STATE on clients). */
export function updateRelicCosmetics(rel) {
  rel.glow.setPosition(rel.x, rel.y);
  const bagged = rel.state.rs === 'bagged';
  rel.setScale(bagged ? 0.7 : 1);
  rel.glow.setScale(bagged ? 0.7 : 1);
  rel.setAlpha(bagged ? 0.85 : 1);
}

export function destroyRelic(rel) {
  rel.glow.destroy();
  rel.destroy();
}
