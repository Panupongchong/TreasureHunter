// ============================================================
// Sim — host/solo authoritative simulation orchestrator (plan §3.2).
//
// Owns the entity collections and the per-tick event queue. Systems are
// registered in tick order and called as sys.update(sim, dt). WP1 ships
// the shell with an empty system list; WP2+ add systems — they only ever
// add systems and entities, never touch net code.
//
// Structural rule: Sim emits events; it NEVER touches rendering or the
// network. GameScene drains sim.update()'s returned events and both
// applies them locally and (host mode) hands them to HostNet.
// ============================================================

import { CLOCK } from '../config.js';
import { RunStats } from './stats.js';
import { nullInput } from '../net/protocol.js';

export class Sim {
  /**
   * @param {Phaser.Scene} scene host/solo GameScene (for physics access)
   * @param {import('../net/Session.js').Session} session
   */
  constructor(scene, session) {
    this.scene = scene;
    this.session = session;

    /** @type {Array<{update: (sim: Sim, dt: number) => void}>} */
    this.systems = [];

    // Entity collections. Values are Phaser GameObjects carrying a flat
    // `.state` blob (plan §3.3) so snapshot.js can serialize mechanically.
    this.players = new Map();   // slot -> player GO
    this.monsters = new Map();  // id -> monster GO   (WP4 combat half)
    this.doors = new Map();     // id -> door GO      (WP4)
    this.pickups = new Map();   // id -> pickup GO    (WP4: hourglass/ritual)
    this.relic = null;          // relic GO, set by GameScene (WP5)
    this.tombstones = new Map(); // id 't<slot>' -> tombstone GO (WP5)
    this.grapples = new Map();  // ownerSlot -> beam record (WP3, see GrappleSystem)

    /**
     * NoiseSystem -> MonsterSystem spawn queue (cross-half contract §0.3).
     * NoiseSystem pushes {x, y, reason:'noise'}; MonsterSystem drains it in
     * its update (it runs BEFORE NoiseSystem in tick order, so consumption
     * is next tick — accepted 1-tick latency) and decides skulker vs brute.
     * @type {Array<{x:number, y:number, reason:string}>}
     */
    this.spawnRequests = [];
    /** {x,y} of the last noise burst — spawn placement focus (v1: last
     *  burst, not a true centroid; the gauge-filling burst is by definition
     *  the latest loud thing). */
    this.noiseFocus = null;

    /** Freshest InputFrame per slot; null = disconnected/stunned. */
    this.inputs = [null, null, null, null];

    /** Events produced this tick, drained by update(). */
    this.events = [];

    this.stats = new RunStats();

    this.world = {
      clockMsLeft: CLOCK.sessionMs,
      clockRunning: false, // lobby: false; ClockSystem (WP4) flips it
      noise: 0,
      escalationLevel: 0,
    };
  }

  registerSystem(sys) {
    this.systems.push(sys);
    sys.init?.(this); // e.g. PvPCollisionSystem sets up its collider
  }

  /** @param {number} slot @param {object|null} frame full InputFrame */
  setInput(slot, frame) {
    this.inputs[slot] = frame;
  }

  /** InputFrame for a slot, never null (disconnected slots get no-input). */
  inputFor(slot) {
    return this.inputs[slot] || nullInput();
  }

  /** Queue an event: { kind, ...payload }. */
  emit(ev) {
    this.events.push(ev);
  }

  /**
   * One sim tick. Runs every system in registration order, then drains
   * and returns this tick's events.
   * @param {number} dt seconds, already clamped by the caller (≤ 50 ms)
   */
  update(dt) {
    for (const sys of this.systems) sys.update(this, dt);
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }
}
