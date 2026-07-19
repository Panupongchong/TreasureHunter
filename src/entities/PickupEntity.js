// ============================================================
// PickupEntity — hourglass + ritual altar (PlayerEntity factory pattern).
//
// No physics body EVER — hourglass touch is a host-side distance check
// (ClockSystem), the ritual is a channel (InteractSystem + ClockSystem).
// Both sides build pickups from MAP DATA at scene create; only state
// changes ride events (DESPAWN for taken hourglass, PICKUP_STATE for the
// spent altar) — never in snapshots (plan §2.5).
//
// WP7 note: the hourglass bob is applied to a CHILD sprite, never to
// pk.x/pk.y. ClockSystem's touch check uses a 30 px radius, so bobbing
// the GO itself would wobble the touch window by ±3 px (~10%) — a
// gameplay change, however small. The container origin stays pinned.
// ============================================================

import { COLORS, FX } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {{id, type:'hourglass'|'ritual', x, y}} def
 */
export function createPickup(scene, def) {
  let pk;
  if (def.type === 'hourglass') {
    pk = scene.add.container(def.x, def.y);
    pk.sprite = scene.add.image(0, 0, 'hourglass');
    pk.glow = scene.add.image(0, 0, 'glow64')
      .setBlendMode(Phaser.BlendModes.ADD).setTint(COLORS.gold)
      .setScale(0.5).setAlpha(0.12);
    pk.add([pk.glow, pk.sprite]);
    pk.setDepth(FX.depth.furniture);
    pk.state = { id: def.id, type: 'hourglass', taken: false };
  } else {
    // Wide dark altar slab + rune (the physical altar stays; the ritual
    // CIRCLE is a floor decal drawn once by GameScene at depth 11).
    pk = scene.add.rectangle(def.x, def.y, 84, 18, 0x2c2338).setDepth(FX.depth.furniture);
    pk.rune = scene.add.rectangle(def.x, def.y - 16, 10, 10, COLORS.stun)
      .setDepth(FX.depth.furniture);
    // Floor decal (art-spec §2.7), drawn ONCE at create — never per frame.
    // The per-channeler quadrant arcs are dynamic and belong on the
    // WorldHUD's shared clear()-per-frame Graphics, not here.
    pk.decal = scene.add.graphics().setDepth(FX.depth.decal);
    pk.decal.lineStyle(3, COLORS.stun, 0.6).strokeCircle(def.x, def.y, 46);
    pk.decal.lineStyle(1, COLORS.stun, 0.4).strokeCircle(def.x, def.y, 38);
    pk.decal.fillStyle(COLORS.stun, 0.6);
    for (const [dx, dy] of [[0, -46], [46, 0], [0, 46], [-46, 0]]) {
      pk.decal.fillPoints([
        { x: def.x + dx, y: def.y + dy - 4 }, { x: def.x + dx + 4, y: def.y + dy },
        { x: def.x + dx, y: def.y + dy + 4 }, { x: def.x + dx - 4, y: def.y + dy },
      ], true);
    }
    pk.state = { id: def.id, type: 'ritual', used: false, channelers: [], progress: 0 };
  }
  return pk;
}

/** Hourglass despawn visual (host + client via DESPAWN handler). */
export function setPickupTaken(pk) {
  pk.setVisible(false);
  pk.state.taken = true;
}

/** Spent altar stays visible, dimmed (PICKUP_STATE handler). */
export function setRitualUsed(pk) {
  pk.setAlpha(0.35);
  pk.rune?.setAlpha(0.35);
  pk.decal?.setAlpha(0.25);
  pk.state.used = true;
}

export function destroyPickup(pk) {
  pk.rune?.destroy();
  pk.decal?.destroy();
  pk.destroy();
}
