// ============================================================
// DoorEntity — all barrier types incl. crank gate (PlayerEntity factory
// pattern: same factory on host — static arcade body — and client —
// visual-only). Doors are level furniture: both sides build them from
// MAP DATA at scene create; only state changes ride DOOR_STATE events
// (they are never in snapshots, plan §2.5).
//
// WP7: barrier textures are SIZE-PARAMETERIZED — generated from the map's
// own (type, w, h) rather than art-spec's fixed sizes, because no map in
// the project matches those sizes (the test map's barriers are 24×160 /
// 64×120, and `d0` is a VERTICAL drawbridge, not a horizontal plank).
// The GO is an add.image at the texture's NATURAL size — never
// setDisplaySize — so getBounds() (GrappleSystem._terrainRects, the
// raycast source of truth), d.width/d.height (HUD prompts + aim), and the
// derived static body are all simultaneously correct and IDENTICAL to the
// pre-WP7 add.rectangle geometry.
// ============================================================

import { DOORS, FX } from '../config.js';
import { ensureBarrierTexture, damageStage } from '../fx/textures.js';

/**
 * @param {Phaser.Scene} scene
 * @param {{id, type, x, y, w, h}} def map data (top-left anchored like platforms)
 * @param {boolean} withBody host/solo: STATIC body; client: visual proxy
 */
export function createDoor(scene, def, withBody) {
  const key = ensureBarrierTexture(scene, def.type, def.w, def.h, 0);
  const d = scene.add.image(def.x + def.w / 2, def.y + def.h / 2, key)
    .setDepth(FX.depth.barrier);
  d.state = {
    id: def.id,               // ids MUST start with 'd' (grapple wire contract)
    type: def.type,           // 'door'|'rubble'|'shortcut'|'bridge'|'crankGate'
    state: 'intact',
    smashHp: DOORS.smashHp[def.type],
    quietProgress: 0,         // 0..1, persists across interrupted channels
    crankSlots: [],           // crankGate: current simultaneous channelers
    timeCostMs: DOORS.timeCostMs[def.type],
  };
  d._def = { w: def.w, h: def.h }; // texture-generation args (render-only)
  if (withBody) scene.physics.add.existing(d, true); // STATIC body
  return d;
}

/** Visual transition — idempotent, called from the DOOR_STATE applyEvent
 *  handler on ALL modes (host body-disable happens in breakDoor, not here). */
export function setDoorBroken(d) {
  const { type } = d.state;
  const { w, h } = d._def;
  if (type === 'door') {
    // Jambs remain in the frame — the doorway reads as "opened", not gone.
    d.setTexture(ensureBarrierTexture(d.scene, type, w, h, 'broken')).setAlpha(1);
  } else {
    // rubble / shortcut / bridge / crankGate: the barrier is GONE. The Fx
    // half's debris burst + floor scuff carries the moment.
    d.setVisible(false);
  }
  d.state.state = 'broken';
}

/** Per-hit damage: a TEXTURE SWAP (cracks, then splinter notches) rather
 *  than the old alpha ramp. smashHp is already on the wire, so cracks
 *  appear identically on host and client. */
export function setDoorDamaged(d, smashHp) {
  d.state.smashHp = smashHp;
  const { type } = d.state;
  const dmg = damageStage(smashHp, DOORS.smashHp[type]);
  d.setTexture(ensureBarrierTexture(d.scene, type, d._def.w, d._def.h, dmg));
}

export function destroyDoor(d) {
  d.destroy();
}
