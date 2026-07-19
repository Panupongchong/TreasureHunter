// ============================================================
// DoorEntity — all barrier types incl. crank gate (PlayerEntity factory
// pattern: same factory on host — static arcade body — and client —
// visual-only). Doors are level furniture: both sides build them from
// MAP DATA at scene create; only state changes ride DOOR_STATE events
// (they are never in snapshots, plan §2.5).
// ============================================================

import { DOORS } from '../config.js';

const COLORS = {
  door: 0x8a6d3b,
  rubble: 0x6d6d6d,
  shortcut: 0x5b7a5b,
  bridge: 0x7a5b3b,
  crankGate: 0x3b5b8a,
};

/**
 * @param {Phaser.Scene} scene
 * @param {{id, type, x, y, w, h}} def map data (top-left anchored like platforms)
 * @param {boolean} withBody host/solo: STATIC body; client: visual proxy
 */
export function createDoor(scene, def, withBody) {
  const d = scene.add.rectangle(
    def.x + def.w / 2, def.y + def.h / 2, def.w, def.h, COLORS[def.type]);
  d.state = {
    id: def.id,               // ids MUST start with 'd' (grapple wire contract)
    type: def.type,           // 'door'|'rubble'|'shortcut'|'bridge'|'crankGate'
    state: 'intact',
    smashHp: DOORS.smashHp[def.type],
    quietProgress: 0,         // 0..1, persists across interrupted channels
    crankSlots: [],           // crankGate: current simultaneous channelers
    timeCostMs: DOORS.timeCostMs[def.type],
  };
  if (withBody) scene.physics.add.existing(d, true); // STATIC body
  return d;
}

/** Visual transition — idempotent, called from the DOOR_STATE applyEvent
 *  handler on ALL modes (host body-disable happens in breakDoor, not here). */
export function setDoorBroken(d) {
  d.setAlpha(DOORS.brokenAlpha);
  d.state.state = 'broken';
}

/** Per-hit crack tint: fades toward broken as smashHp drops. */
export function setDoorDamaged(d, smashHp) {
  d.state.smashHp = smashHp;
  d.setAlpha(0.5 + 0.5 * smashHp / DOORS.smashHp[d.state.type]);
}

export function destroyDoor(d) {
  d.destroy();
}
