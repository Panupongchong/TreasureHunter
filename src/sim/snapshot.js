// ============================================================
// snapshot.js — the ONLY place that knows the wire shape of entities.
//
// Host: serializeWorld(sim) -> the geckos snapshot `state` object
// (plan §2.5). WP1 ships the `players` + `world` groups; later WPs add
// `monsters`, `relic`, `grapples` here and ONLY here.
//
// Client: applySnapshot(scene, ...) writes interpolated x/y onto the
// visual GameObjects and latest-value fields into their `.state`.
// ============================================================

import { DOORS, RELIC, READY } from '../config.js';
import { EV } from '../net/protocol.js';

// Player status bits (plan §2.5). WP2+ set stun/carry/channel bits.
export const ST = {
  STUNNED: 1,
  ON_GROUND: 2,
  CARRYING_HANDS: 4,
  CARRYING_BAG: 8,
  CHANNELING: 16,
  SPRINTING: 32,
  CARRIED: 64,
};

// ---- WP4 combat wire enums (ints on the wire; strings sim-side) ----
// Weapon + attack phase ride player rows as latest-value ints (`wpn`,
// `atk`) — phase enum instead of ST bits: cheaper, telegraph-readable.
export const WPN = { hammer: 0, dagger: 1 };
export const WPN_NAME = ['hammer', 'dagger'];
export const ATK = { none: 0, windup: 1, active: 2, recovery: 3 };
// Monster ai enum (plan §4 string states stay sim-side).
const AI_WIRE = { spawn: 0, idle: 1, chase: 2, windup: 3, attack: 4, stunned: 5, doorSmash: 6, dying: 7 };
const AI_NAME = ['spawn', 'idle', 'chase', 'windup', 'attack', 'stunned', 'doorSmash', 'dying'];
// Relic state enum (plan §2.5; strings sim-side, ints on the wire).
export const RS = { loose: 0, held: 1, bagged: 2, flying: 3 };
export const RS_NAME = ['loose', 'held', 'bagged', 'flying'];
// Channel-type enum (WP6 contract W7): the `cht` player-row int — channel
// bar LABELS need the type, progress alone can't name the channel.
export const CHT = {
  none: 0, revive: 1, bag: 2, unbag: 3, pickDoor: 4, crank: 5,
  ritual: 6, reclaim: 7, rack: 8, board: 9,
};
export const CHT_NAME = ['none', 'revive', 'bag', 'unbag', 'pickDoor', 'crank',
  'ritual', 'reclaim', 'rack', 'board'];

const r = Math.round;

/** @returns the snapshot `state` object for SI.snapshot.create(...) */
export function serializeWorld(sim) {
  const players = [];
  for (const p of sim.players.values()) {
    const s = p.state;
    const body = p.body;
    let st = 0;
    if (s.stunned) st |= ST.STUNNED;
    if (s.onGround) st |= ST.ON_GROUND;
    if (s.sprinting) st |= ST.SPRINTING;
    if (s.carriedBy !== null) st |= ST.CARRIED;
    // Carry bits (plan §2.5): bag = relic-in-bag; hands = any other carry
    // (relic-in-hands or a carried player). WP6 HUD icons read these.
    if (s.carrying?.kind === 'relic' && s.carrying.where === 'bag') st |= ST.CARRYING_BAG;
    else if (s.carrying) st |= ST.CARRYING_HANDS;
    players.push({
      id: 'p' + s.slot,
      x: r(p.x), y: r(p.y),
      vx: r(body.velocity.x), vy: r(body.velocity.y),
      face: s.facing,
      m: r(s.mass * 10),
      st,
      ch: s.channelProgress,
      wpn: WPN[s.weapon] ?? 0,
      atk: s.attack ? (ATK[s.attack.phase] ?? 0) : 0,
      // WP6 contract W7: stun ms left (authoritative mash-bar drain — the
      // client HUD never counts down locally) + channel-type enum (labels).
      sms: s.stunned ? r(s.stunMsLeft) : 0,
      cht: s.channel ? (CHT[s.channel.type] ?? 0) : 0,
    });
  }
  // Monster rows (WP4 combat half). ALWAYS present, even as [] — geckos
  // calcInterpolation must never see a snapshot missing the group.
  const monsters = [];
  for (const [id, m] of sim.monsters) {
    monsters.push({
      id, // the sim.monsters Map key IS the wire id ('m<n>' / map-declared)
      x: r(m.x), y: r(m.y),
      vx: r(m.body.velocity.x), vy: r(m.body.velocity.y),
      face: m.state.facing,
      hp: m.state.hp,
      ai: AI_WIRE[m.state.ai] ?? 1,
    });
  }
  // Beam rows (WP3). The `grapples` key is ALWAYS present, even as [] —
  // geckos calcInterpolation must never see a snapshot missing the group
  // it is asked to interpolate.
  const grapples = [];
  for (const [slot, g] of sim.grapples) {
    grapples.push({ id: 'g' + slot, x: r(g.x), y: r(g.y), tx: r(g.tx), ty: r(g.ty) });
  }
  // Relic row (WP5). ALWAYS present, even as [] in relic-less maps —
  // geckos group rule (monsters precedent). `hs` = holderSlot (-1 none):
  // clients attach the held/bagged view to the holder VIEW client-side
  // (both streams are 100 ms behind; attaching avoids inter-stream jitter).
  const relic = [];
  if (sim.relic) {
    const st = sim.relic.state;
    const b = sim.relic.body;
    relic.push({
      id: 'relic',
      x: r(sim.relic.x), y: r(sim.relic.y),
      vx: b.enable ? r(b.velocity.x) : 0,
      vy: b.enable ? r(b.velocity.y) : 0,
      rs: RS[st.rs] ?? 0,
      hs: st.holderSlot ?? -1,
    });
  }
  const world = [{
    id: 'w',
    clock: r(sim.world.clockMsLeft),
    noise: r(sim.world.noise),
    esc: sim.world.escalationLevel,
    // WP6 ready-ring fields (latest-value ints, ALWAYS present — geckos
    // group-shape rule; 0 outside the lobby). rz = fill 0..100, rzN =
    // players inside the zone, rzM = connected total. At 20 Hz the ring
    // steps 50 ms — the UI half lerps toward the received value
    // (presentation-only smoothing, allowed).
    rz: r(100 * Math.min(1, (sim.world.readyMs || 0) / READY.holdMs)),
    rzN: sim.world.readyN || 0,
    rzM: sim.world.readyM || 0,
  }];
  return { players, monsters, relic, grapples, world };
}

/**
 * Ordered event list reconstructing discrete world state for a rejoiner
 * (plan risk 9). Sent on ctl AFTER welcome, BEFORE syncDone (HostNet
 * getReplay seam). Pristine doors/pickups are skipped — the rejoiner
 * rebuilt them from map data at scene create. snapshot.js stays the only
 * wire-shape knower, so this serialization lives here.
 * WP5 appends tombstones + relicState (in that order — see below).
 */
export function buildReplay(sim) {
  const evs = [];
  if (sim.world.escalationLevel >= 1) evs.push({ kind: EV.ESCALATION, level: 1 });
  if (sim.world.escalationLevel >= 2) evs.push({ kind: EV.ESCALATION, level: 2 });
  for (const [, d] of sim.doors) {
    const s = d.state;
    if (s.state === 'broken' || s.smashHp < DOORS.smashHp[s.type]) {
      evs.push({
        kind: EV.DOOR_STATE, id: s.id, state: s.state,
        smashHp: s.smashHp, method: null, slot: null,
      });
    }
  }
  for (const [, pk] of sim.pickups) {
    if (pk.state.taken) evs.push({ kind: EV.DESPAWN, id: pk.state.id, etype: 'hourglass' });
    if (pk.state.used) evs.push({ kind: EV.PICKUP_STATE, id: pk.state.id, used: true });
  }
  for (const [id, m] of sim.monsters) {
    // Skip dying monsters (contract seam 8): their DESPAWN may have been
    // broadcast before the rejoiner connected — replaying the spawn would
    // leave a permanent ghost view once the sim row disappears.
    if (m.state.ai === 'dying') continue;
    evs.push({
      kind: EV.SPAWN, id, etype: 'monster', mtype: m.state.type,
      x: r(m.x), y: r(m.y),
    });
  }
  // WP5: tombstones BEFORE relicState — a bagged-at-tombstone relic must
  // be able to resolve its anchor when the RELIC_STATE lands.
  for (const [, ts] of sim.tombstones) {
    const s = ts.state;
    evs.push({ kind: EV.TOMBSTONE, slot: s.slot, x: s.x, y: s.y, baggedRelic: s.baggedRelic });
  }
  if (sim.relic) {
    const s = sim.relic.state;
    evs.push({
      kind: EV.RELIC_STATE, rs: RS[s.rs] ?? 0, hs: s.holderSlot ?? -1,
      x: r(sim.relic.x), y: r(sim.relic.y),
    });
  }
  return evs;
}

export const slotOfId = (id) => Number(id.slice(1));

/** Interpolated `grapples` rows -> [{slot, x, y, tx, ty}]. Null-safe. */
export function decodeGrappleRows(interpRows) {
  if (!interpRows) return [];
  return interpRows.map((row) => ({
    slot: slotOfId(row.id), x: row.x, y: row.y, tx: row.tx, ty: row.ty,
  }));
}

/**
 * Client render step: write interpolated positions + latest-value fields.
 * @param {Map<number, any>} views slot -> player GameObject (visual proxy)
 * @param {Array|null} interpPlayers interpolated `players` entities (x y)
 * @param {object|null} latest newest vault snapshot state (non-lerped fields)
 */
export function applySnapshot(views, interpPlayers, latest) {
  if (interpPlayers) {
    for (const row of interpPlayers) {
      const view = views.get(slotOfId(row.id));
      if (view) view.setPosition(row.x, row.y);
    }
  }
  if (latest?.players) {
    for (const row of latest.players) {
      const view = views.get(slotOfId(row.id));
      if (!view) continue;
      view.state.facing = row.face >= 0 ? 1 : -1;
      view.state.mass = row.m / 10;
      view.state.stunned = !!(row.st & ST.STUNNED);
      view.state.onGround = !!(row.st & ST.ON_GROUND);
      view.state.sprinting = !!(row.st & ST.SPRINTING);
      view.state.carriedBy = (row.st & ST.CARRIED) ? -1 : null; // slot unknown, presence is enough
      view.state.carryingHands = !!(row.st & ST.CARRYING_HANDS);
      view.state.carryingBag = !!(row.st & ST.CARRYING_BAG);
      view.state.channelProgress = row.ch;
      view.state.weapon = WPN_NAME[row.wpn] ?? 'hammer';
      view.state.attackPhase = row.atk ?? 0; // ATK int — cosmetics read it
      view.state.stunMsLeft = row.sms ?? 0;  // WP6: HUD mash bar (wire truth)
      view.state.channelType = CHT_NAME[row.cht ?? 0] ?? 'none'; // WP6: bar labels
    }
  }
  return latest?.world?.[0] || null; // world row for the HUD
}

/**
 * Client render step for the relic (WP5). Latest-value rs/holderSlot →
 * `.state`; position from the HOLDER VIEW while held/bagged (client-side
 * attach, zero inter-stream jitter), else from the interpolated relic row
 * (loose/flying, and bagged-at-tombstone — the host pinned the GO there,
 * so the row position is already correct).
 * @param {any|null} view the relic GameObject (visual proxy), or null
 * @param {Array|null} interpRows interpolated `relic` entities (x y)
 * @param {object|null} latest newest vault snapshot state
 * @param {Map<number, any>} playerViews slot -> player view
 */
export function applyRelicSnapshot(view, interpRows, latest, playerViews) {
  if (!view) return;
  const row = latest?.relic?.[0];
  if (row) {
    view.state.rs = RS_NAME[row.rs] ?? 'loose';
    view.state.holderSlot = row.hs < 0 ? null : row.hs;
  }
  const st = view.state;
  const holder = (st.rs === 'held' || st.rs === 'bagged')
    ? playerViews.get(st.holderSlot) : null;
  if (holder) {
    const f = holder.state.facing;
    if (st.rs === 'held') {
      view.setPosition(holder.x + f * RELIC.holdOffsetX, holder.y + RELIC.holdOffsetY);
    } else {
      view.setPosition(holder.x - f * RELIC.bagOffsetX, holder.y + RELIC.bagOffsetY);
    }
  } else if (interpRows?.[0]) {
    view.setPosition(interpRows[0].x, interpRows[0].y);
  }
}

/**
 * Client render step for monsters (mirrors the players path): interp
 * rows → positions; latest rows → facing/hp/ai into `.state` (the one
 * cosmetics path keys telegraph/death visuals off `ai`). Rows whose id
 * has no view yet are skipped — the SPAWN event hasn't landed (§2.2
 * race rule; ctl is ordered, sub-frame at worst).
 * @param {Map<string, any>} views id -> monster GameObject (visual proxy)
 */
export function applyMonsterSnapshot(views, interpMonsters, latest) {
  if (interpMonsters) {
    for (const row of interpMonsters) {
      const view = views.get(row.id);
      if (view) view.setPosition(row.x, row.y);
    }
  }
  if (latest?.monsters) {
    for (const row of latest.monsters) {
      const view = views.get(row.id);
      if (!view) continue;
      view.state.facing = row.face >= 0 ? 1 : -1;
      view.state.hp = row.hp;
      view.state.ai = AI_NAME[row.ai] ?? 'idle';
    }
  }
}
