// ============================================================
// protocol.js — the single source of truth for the wire protocol.
//
// Message type constants (MSG.*), factory functions (shapes exist in
// exactly one file), channel routing (which message rides the reliable
// 'ctl' channel vs the unreliable 'st' channel), and the InputFrame
// pack/unpack pair. See docs/plan/implementation-plan.md §2.
// ============================================================

import { NET } from '../config.js';

export const PROTOCOL_VERSION = NET.protocolVersion;

// Channel labels (PeerJS DataConnection labels)
export const CH = {
  CTL: 'ctl', // reliable + ordered: lifecycle, roster, phase, events
  ST: 'st',   // unreliable: input up, snapshots down
};

export const MSG = {
  // client -> host
  HELLO: 'hello',
  INPUT: 'input',
  BYE: 'bye',
  // host -> client
  WELCOME: 'welcome',
  REJECT: 'reject',
  ROSTER: 'roster',
  PHASE: 'phase',
  EVENT: 'event',
  SNAP: 'snap',
  KICK: 'kick',
  // both directions (liveness)
  PING: 'ping',
};

// Routing table: message type -> channel. Anything not listed is a bug.
export const CHANNEL_OF = {
  [MSG.HELLO]: CH.CTL,
  [MSG.BYE]: CH.CTL,
  [MSG.WELCOME]: CH.CTL,
  [MSG.REJECT]: CH.CTL,
  [MSG.ROSTER]: CH.CTL,
  [MSG.PHASE]: CH.CTL,
  [MSG.EVENT]: CH.CTL,
  [MSG.KICK]: CH.CTL,
  [MSG.PING]: CH.CTL,
  [MSG.INPUT]: CH.ST,
  [MSG.SNAP]: CH.ST,
};

// Event `kind` registry — later WPs extend this list (and the applyEvent
// dispatcher in sim/events.js). Keeping the names here makes typos greppable.
export const EV = {
  SPAWN: 'spawn',
  DESPAWN: 'despawn',
  SYNC_DONE: 'syncDone',
  TOMBSTONE: 'tombstone',
    // {slot, x, y, baggedRelic} — payload finalized WP5. A disconnect
    // during PLAYING leaves a stone; the rejoiner respawns at it.
  REJOINED: 'rejoined',
  PING_MARKER: 'pingMarker',
  TOAST: 'toast', // WP1 convenience: host-pushed toast text
  STUN: 'stun',     // {slot, ms, cause}
  REVIVE: 'revive', // {slot, by} — by null = self-recovered
  GRAPPLE_ATTACH: 'grappleAttach',
    // {slot, targetKind:'terrain'|'door'|'player'|'monster'|'relic',
    //  targetId: string|null, x, y}  — x,y = anchor/impact point
  GRAPPLE_DETACH: 'grappleDetach',
    // {slot, reason:'release'|'arrived'|'blocked'|'range'|'los'|'stun'|
    //  'targetStun'|'carried'|'targetGone'|'refire'|'manual'|'caught'}
    // 'caught' (WP5): flying relic auto-caught by its own grappler
  NOISE_BURST: 'noiseBurst',
    // {x, y, amount, cause} — presentation-only event (WP7 ripple scales
    // off `amount`). WP4: addNoise() in systems/NoiseSystem.js is the ONLY
    // gauge sink AND the only emitter of this kind — systems never emit it
    // directly (the WP3 grapple emit site was refactored into addNoise).
  // ---------------- WP4 world systems ----------------
  DOOR_STATE: 'doorState',
    // {id, state:'intact'|'broken', smashHp, method:'smash'|'quiet'|null,
    //  slot:number|null} — emitted on every damageDoor hit AND on break;
    // quietProgress is never broadcast (clients see channelers' ch bars)
  TIME_COST: 'timeCost',
    // {amount, cause:'door'|'rubble'|'shortcut'|'bridge', slot|null}
  TIME_GAIN: 'timeGain',
    // {amount, cause:'hourglass'|'ritual', slot:number|null} — WP6: slot =
    // the hourglass taker (toast "+0:30 HOURGLASS (<NAME>)"); ritual is a
    // team gain → slot null. Additive field, symmetric with TIME_COST.
  ESCALATION: 'escalation', // {level:1|2} — emitted ONCE per level (monotonic)
  RUN_OVER: 'runOver',
    // lose: {result:'lose', reason:'calamity'} (ClockSystem)
    // win:  {result:'win', reason:'escaped', slot, escapeMs} (RelicSystem —
    //   slot = the carrier who crossed the exit zone). Host GameScene maps
    //   either shape to PHASE.RESULTS.
  PICKUP_STATE: 'pickupState', // {id, used:true} — spent ritual altar (stays visible)
  HARD_LANDING: 'hardLanding', // {slot, x, y} — WP7 dust/thud feel hook
  // ---------------- WP4 combat half (feel events — WP7 juice hooks) ----------------
  SWING: 'swing',              // {slot, weapon} — attack started (whiff included)
  HIT: 'hit',
    // {slot, weapon:'hammer'|'dagger'|'body'|'skulker'|'brute'|'brute'(door),
    //  targetKind:'monster'|'player'|'door', targetId, x, y, ff:bool} —
    // impact feel event (WP7 sparks/shake). slot -1 = a monster dealt it;
    // weapon 'body' = thrown/yanked player slammed into a monster.
  STAGGERED: 'staggered',      // {slot, bySlot} — light-FF micro-stagger (NOT a stun:
                               // no relic drop, no snapshot bit; motion reads it)
  MONSTER_TELEGRAPH: 'monsterTelegraph', // {id, type} — precedes EVERY monster hit by
                               // the full windup (QA-audited readability contract)
  MONSTER_ATTACK: 'monsterAttack',       // {id} — windup resolved into active frames
  MONSTER_FLINCH: 'monsterFlinch',       // {id} — dagger-interrupt on a Skulker windup
  MONSTER_DIED: 'monsterDied', // {id, bySlot|null, weapon|null, reason:'died'|'pitDeath'|
                               // 'faded'} — fires at death START ('dying' state);
                               // the DESPAWN event follows after MONSTERS.dyingMs
  // SPAWN/DESPAWN payloads now normative (no separate 'monsterSpawn' kind —
  // §2.2 defines spawn as "any entity"):
  //   spawn   {id, etype:'monster', mtype:'skulker'|'brute', x, y}
  //   despawn {id, etype:'monster'|'hourglass'|'tombstone', reason?} —
  //           reason 'pitDeath' when a monster's body overlaps a map.pits
  //           rect (MonsterSystem); tombstone despawn adds {slot} (WP5:
  //           consumed on rejoin)
  // ---------------- WP5 relic & tombstone ----------------
  RELIC_STATE: 'relicState',
    // {rs:int (snapshot.js RS enum), hs:int -1|0..3, x, y} — emitted on
    // EVERY relic transition: grab, throw, land, catch, bag, unbag,
    // stun-drop, disconnect-drop, reclaim, rejoin-restore. Also replayed
    // to every joiner (buildReplay). Continuous motion rides the snapshot
    // relic group; this event is the discrete truth.
  TOMBSTONE_STATE: 'tombstoneState',
    // {slot, baggedRelic:false} — a teammate reclaimed the bagged relic;
    // the stone stays (it is the rejoin anchor), only the glyph clears
  // ---------------- WP6 UX systems ----------------
  READY_COMPLETE: 'readyComplete',
    // {} — ReadyZoneSystem: all connected players held the vault-entrance
    // zone READY.holdMs. Broadcast like any event (clients: 300 ms ok-flash);
    // host/solo GameScene intercepts it in the drain and transitions
    // lobby → playing (the phase message follows on the same ordered ctl).
  STAGE_CYCLE: 'stageCycle',
    // {} — SIM-INTERNAL, never broadcast: GameScene filters it from the
    // drain (`continue` before applyEvent/broadcastEvent) and mutates
    // session.stageId + broadcastRoster — the roster message is the single
    // wire truth for the stage. A defensive no-op handler exists in
    // events.js in case of a future emit leak.
};

// Reject reasons
export const REJECT = {
  FULL: 'full',
  IN_RUN: 'in-run',
  VERSION: 'version',
  BAD_CODE: 'bad-code',
};

// ---------------- factories ----------------

export const makeHello = (name, token) => ({
  t: MSG.HELLO, v: PROTOCOL_VERSION,
  name: String(name).slice(0, NET.maxNameLen),
  token: token || null,
});

export const makeWelcome = (slot, token, phase, roster, ffFull, stageId) => ({
  t: MSG.WELCOME, slot, token, phase, roster, ffFull, stageId,
  hostTime: Date.now(),
});

export const makeReject = (reason) => ({ t: MSG.REJECT, reason });

export const makeRoster = (players, ffFull, stageId) => ({
  t: MSG.ROSTER, players, ffFull, stageId,
});

export const makePhase = (phase, data) => ({ t: MSG.PHASE, phase, data: data || null });

/** ev = { kind, ...payload } — spread flat into the message. */
export const makeEvent = (ev) => ({ t: MSG.EVENT, ...ev });

export const makeInput = (seq, packedFrame) => ({ t: MSG.INPUT, seq, f: packedFrame });

export const makeSnap = (snapshot) => ({ t: MSG.SNAP, s: snapshot });

export const makeBye = () => ({ t: MSG.BYE });
export const makeKick = () => ({ t: MSG.KICK });
export const makePing = () => ({ t: MSG.PING });

// ---------------- InputFrame pack/unpack ----------------
//
// f = [moveX, buttons, aimX, aimY]
//   moveX: rounded to 2 decimals
//   buttons: bitmask below
//   aimX/aimY: mouse = world px (rounded ints); gamepad = unit dir * 1000

export const BTN = {
  JUMP: 1, JUMP_HELD: 2, SPRINT: 4, ATTACK: 8,
  GRAPPLE: 16, GRAPPLE_HELD: 32, INTERACT: 64, GRAB: 128,
  PING: 256, USING_GAMEPAD: 512,
};

/** @param {import('../input/InputManager.js').InputFrame} frame */
export function packInput(frame) {
  let b = 0;
  if (frame.jump) b |= BTN.JUMP;
  if (frame.jumpHeld) b |= BTN.JUMP_HELD;
  if (frame.sprint) b |= BTN.SPRINT;
  if (frame.attack) b |= BTN.ATTACK;
  if (frame.grapple) b |= BTN.GRAPPLE;
  if (frame.grappleHeld) b |= BTN.GRAPPLE_HELD;
  if (frame.interact) b |= BTN.INTERACT;
  if (frame.grab) b |= BTN.GRAB;
  if (frame.ping) b |= BTN.PING;
  if (frame.usingGamepad) b |= BTN.USING_GAMEPAD;
  const scale = frame.usingGamepad ? 1000 : 1;
  return [
    Math.round(frame.moveX * 100) / 100,
    b,
    Math.round(frame.aimX * scale),
    Math.round(frame.aimY * scale),
  ];
}

/** Inverse of packInput. Returns a full InputFrame object. */
export function unpackInput(f) {
  const [moveX, b, ax, ay] = f;
  const usingGamepad = !!(b & BTN.USING_GAMEPAD);
  const scale = usingGamepad ? 1000 : 1;
  return {
    moveX,
    jump: !!(b & BTN.JUMP),
    jumpHeld: !!(b & BTN.JUMP_HELD),
    sprint: !!(b & BTN.SPRINT),
    attack: !!(b & BTN.ATTACK),
    grapple: !!(b & BTN.GRAPPLE),
    grappleHeld: !!(b & BTN.GRAPPLE_HELD),
    interact: !!(b & BTN.INTERACT),
    grab: !!(b & BTN.GRAB),
    ping: !!(b & BTN.PING),
    aimX: ax / scale,
    aimY: ay / scale,
    usingGamepad,
  };
}

/** An InputFrame with nothing pressed (disconnected/stunned slots). */
export function nullInput() {
  return {
    moveX: 0, jump: false, jumpHeld: false, sprint: false,
    attack: false, grapple: false, grappleHeld: false,
    interact: false, grab: false, ping: false,
    aimX: 0, aimY: 0, usingGamepad: false,
  };
}

/**
 * Merge a newly received frame into a buffered one, OR-ing the edge flags
 * so a jump press is never lost between consumes (plan §2.4). Analog and
 * held values take the newest frame's values.
 */
export function mergeInput(buffered, next) {
  if (!buffered) return { ...next };
  return {
    ...next,
    jump: buffered.jump || next.jump,
    attack: buffered.attack || next.attack,
    grapple: buffered.grapple || next.grapple,
    grab: buffered.grab || next.grab,
    ping: buffered.ping || next.ping,
  };
}

/** Consume the one-shot edge flags off a buffered frame (host, per tick). */
export function clearEdges(frame) {
  frame.jump = false;
  frame.attack = false;
  frame.grapple = false;
  frame.grab = false;
  frame.ping = false;
}

/** 8 random hex chars — the per-run player identity token (plan §2.6). */
export function makeToken() {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** 4 random uppercase letters — the room code. */
export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < NET.codeLength; i++) {
    s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  }
  return s;
}

/** sessionStorage key for the per-run token of a room. */
export const tokenStorageKey = (roomCode) => 'vb-token-' + roomCode;

/** sessionStorage key holding the most recent room CODE a client joined —
 *  the menu's "[ REJOIN LAST ROOM <CODE> ]" shortcut renders iff this key
 *  AND tokenStorageKey(code) both exist (WP6). Written by ClientNet on
 *  welcome; cleared on kick and on a dead-token 'in-run' reject. */
export const LAST_ROOM_KEY = 'vb-last-room';
