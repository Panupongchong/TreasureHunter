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

import { RELIC, COLORS, FX } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 */
export function createRelic(scene, x, y, withBody) {
  // The DIAMOND is the single most important silhouette in the game: it
  // is the only diamond, and #ffb52e vs player 0's #ffd23f is not enough
  // separation on its own. Never render the relic as a rect.
  // RELIC.color is now dead for fill; the constant stays declared.
  const rel = scene.add.image(x, y, 'relic').setDepth(FX.depth.relic);
  rel.glow = scene.add.image(x, y, 'glow64')
    .setBlendMode(Phaser.BlendModes.ADD).setTint(COLORS.gold)
    .setScale(FX.glow.relicR * 2 / 64).setAlpha(FX.glow.relicAlpha)
    .setDepth(FX.depth.relic - 1);
  rel.glint = scene.add.image(x - 4, y - 8, 'relicGlint')
    .setAlpha(0.7).setDepth(FX.depth.relic + 1);
  rel.state = { id: 'relic', rs: 'loose', holderSlot: null, lockoutSlot: null, lockoutMs: 0 };
  if (withBody) {
    scene.physics.add.existing(rel);
    // LOCKED GEOMETRY: 22×28 art over the unchanged 22×22 body. rel.x/rel.y
    // still mean the CENTER, so RELIC.pickupRadius (a center-to-center
    // check in RelicSystem) is unaffected by the taller sprite.
    rel.body.setSize(RELIC.width, RELIC.height, false);
    rel.body.setOffset(0, (28 - RELIC.height) / 2);
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
  // A CARRIED relic is drawn by whoever carries it — the holder's heldGem
  // (hands) / bag + bagGem, or the tombstone's gem when the holder
  // disconnected. WP7 added those accessories without muting this view,
  // which rendered the gem TWICE (once in front of the carrier, once
  // above their head). This entity draws the relic only when it is
  // genuinely loose in the world (loose | flying).
  const carried = rel.state.rs === 'held' || rel.state.rs === 'bagged';
  rel.setVisible(!carried);
  rel.glow.setVisible(!carried);
  rel.glint.setVisible(!carried);
  if (carried) return;
  // Only 'loose' | 'flying' reach here, so the old bagged scaling/alpha
  // branches were dead — a loose relic is always full size and opaque.
  const base = FX.glow.relicR * 2 / 64;
  // Loose-relic bob is applied to the GLOW/GLINT only, never to rel.y:
  // on the host rel.y is physics truth and on the client it is the
  // interpolated snapshot row — writing it would fight applyRelicSnapshot
  // every frame (contract §9-F). ±2 px on a halo reads the same.
  const t = Date.now();
  const bob = rel.state.rs === 'loose' ? Math.sin(t / 1400 * Math.PI * 2) * 2 : 0;
  rel.glow.setPosition(rel.x, rel.y + bob).setScale(base);
  rel.glint.setPosition(rel.x - 4, rel.y - 8 + bob)
    .setAlpha(0.8 + 0.2 * Math.sin(t / 625 * Math.PI));
  rel.setScale(1);
  rel.setAlpha(1);
}

export function destroyRelic(rel) {
  rel.glow.destroy();
  rel.glint.destroy();
  rel.destroy();
}
