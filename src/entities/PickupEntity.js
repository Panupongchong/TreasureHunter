// ============================================================
// PickupEntity — hourglass + ritual altar (PlayerEntity factory pattern).
//
// No physics body EVER — hourglass touch is a host-side distance check
// (ClockSystem), the ritual is a channel (InteractSystem + ClockSystem).
// Both sides build pickups from MAP DATA at scene create; only state
// changes ride events (DESPAWN for taken hourglass, PICKUP_STATE for the
// spent altar) — never in snapshots (plan §2.5).
// ============================================================

/**
 * @param {Phaser.Scene} scene
 * @param {{id, type:'hourglass'|'ritual', x, y}} def
 */
export function createPickup(scene, def) {
  let pk;
  if (def.type === 'hourglass') {
    // Small yellow diamond (rotated rect).
    pk = scene.add.rectangle(def.x, def.y, 14, 14, 0xffd23f).setAngle(45);
    pk.state = { id: def.id, type: 'hourglass', taken: false };
  } else {
    // Wide dark altar slab + rune rect.
    pk = scene.add.rectangle(def.x, def.y, 84, 18, 0x2c2338);
    pk.rune = scene.add.rectangle(def.x, def.y - 16, 10, 10, 0x8a5bd6);
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
  pk.state.used = true;
}

export function destroyPickup(pk) {
  pk.rune?.destroy();
  pk.destroy();
}
