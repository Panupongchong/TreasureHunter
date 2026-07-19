// ============================================================
// events.js — the applyEvent dispatcher (plan WP1 "Exposes").
//
// ONE code path for presentation on all three GameScene modes: host and
// solo apply the events their own Sim emitted; clients apply the same
// events on receipt from the ctl channel. Later WPs extend the registry
// via registerEventHandler — never with switch statements elsewhere.
// ============================================================

import { EV } from '../net/protocol.js';
import { setDoorBroken, setDoorDamaged } from '../entities/DoorEntity.js';
import { setPickupTaken, setRitualUsed } from '../entities/PickupEntity.js';
import { createMonster, destroyMonster } from '../entities/MonsterEntity.js';
import {
  createTombstone, setTombstoneBagged, destroyTombstone,
} from '../entities/TombstoneEntity.js';
import { RS, RS_NAME } from './snapshot.js';

/** kind -> (scene, ev) => void */
const HANDLERS = new Map();

export function registerEventHandler(kind, fn) {
  HANDLERS.set(kind, fn);
}

/** Apply one authoritative event to a GameScene (any mode). */
export function applyEvent(scene, ev) {
  const fn = HANDLERS.get(ev.kind);
  if (fn) fn(scene, ev);
  // Unknown kinds are not an error: a newer host may emit kinds this
  // build doesn't render. Log once per kind for development visibility.
  else if (!applyEvent._warned?.has(ev.kind)) {
    (applyEvent._warned ||= new Set()).add(ev.kind);
    console.warn('[events] no handler for event kind:', ev.kind);
  }
}

// ---------------- WP1 baseline handlers ----------------

// Host-pushed toast text → the UI toast rail.
registerEventHandler(EV.TOAST, (scene, ev) => {
  scene.game.events.emit('ui:toast', ev.text);
});

// Ping markers (WP6): delegate to the UI half's world-space renderer
// (slot-colored triangle marker + off-screen edge indicator, ux-spec
// §7.8). Optional-chained: harmless until GameScene.spawnPingMarker
// lands (Engineer #2).
registerEventHandler(EV.PING_MARKER, (scene, ev) => scene.spawnPingMarker?.(ev));

// ---------------- WP6 UX systems ----------------

// Ready-zone completion: host/solo GameScene intercepts this in its
// event drain for the lobby→playing transition BEFORE applyEvent runs;
// on all peers this handler is the 300 ms ok-flash hook (best-effort
// cosmetic — the phase message follows within the same tick).
// `readyCompleteFlash` is the UI half's (Engineer #2).
registerEventHandler(EV.READY_COMPLETE, (scene) => {
  scene.readyCompleteFlash?.();
  scene.fx?.onReadyComplete(); // WP7 §2.9: white screen flash
});

// STAGE_CYCLE is sim-internal (filtered from broadcast AND from local
// apply by the GameScene drain — roster is the wire truth for stageId).
// Defensive no-op in case of a future emit leak.
registerEventHandler(EV.STAGE_CYCLE, () => {});

// Rejoin sync terminator (plan risk 9). WP6: also flips the client's
// replay-done flag (lives on the NET object — it survives scene
// restarts, unlike a scene field) so the UIScene toast catalog can
// suppress the history burst a joiner/rejoiner replays (contract §5.5).
registerEventHandler(EV.SYNC_DONE, (scene) => {
  if (scene.net) scene.net._replayDone = true;
});

// Entity lifecycle. Doors/pickups (and map-declared monsters like the
// lobby dummy) need NO spawn events: both host and client build them
// from MAP DATA at scene create — they are level furniture; only state
// changes ride events (plan §2.5). Runtime monster spawns DO ride SPAWN:
// the client creates a body-less view; the host applying its own event
// is a no-op via the existence check (MonsterSystem already made the GO).
registerEventHandler(EV.SPAWN, (scene, ev) => {
  if (ev.etype !== 'monster') return; // other etypes: WP5/WP6 (tombstone…)
  scene.worldUI?.onMonsterSpawn(ev); // WP6 §7.2: one-shot '!' world marker
  scene.fx?.onMonsterSpawn(ev);      // WP7 §3.9 ring burst + telegraph
  if (scene.monsters.has(ev.id)) return;
  scene.monsters.set(ev.id, createMonster(scene, ev.id, ev.mtype, ev.x, ev.y, false));
});
registerEventHandler(EV.DESPAWN, (scene, ev) => {
  scene.fx?.onDespawn(ev); // WP7: pickup pop (reads the GO before teardown)
  if (ev.etype === 'hourglass') {
    const pk = scene.pickups?.get(ev.id);
    if (pk) setPickupTaken(pk);
  } else if (ev.etype === 'monster') {
    // Client view teardown. Host/solo: MonsterSystem._despawn already
    // removed + destroyed the GO before emitting — the get misses.
    const m = scene.monsters?.get(ev.id);
    if (m) {
      scene.monsters.delete(ev.id);
      destroyMonster(m);
    }
  } else if (ev.etype === 'tombstone') {
    // Consumed on rejoin (host/solo: RelicSystem.consumeTombstone already
    // removed + destroyed it — the get misses).
    const ts = scene.tombstones?.get(ev.id);
    if (ts) {
      scene.tombstones.delete(ev.id);
      destroyTombstone(ts);
    }
  }
});

// ---------------- WP5 relic & tombstone ----------------

registerEventHandler(EV.RELIC_STATE, (scene, ev) => {
  const rel = scene.relic;
  if (!rel) return;
  rel.state.rs = RS_NAME[ev.rs] ?? 'loose';
  rel.state.holderSlot = ev.hs < 0 ? null : ev.hs;
  // Clients snap discretely on loose/flying transitions; continuous
  // motion rides the snapshot relic group. Host/solo: sim already moved it.
  if (!scene.sim && (ev.rs === RS.loose || ev.rs === RS.flying)) {
    rel.setPosition(ev.x, ev.y);
  }
  scene.fx?.onRelicState(ev); // WP7: transition pips — AFTER the state write
});

registerEventHandler(EV.TOMBSTONE, (scene, ev) => {
  // A rejoiner replaying its OWN stone must never remove/re-add the
  // local view (the host despawns the stone right after the join).
  if (ev.slot === scene.session.localSlot) return;
  const id = 't' + ev.slot;
  if (!scene.tombstones.has(id)) { // host: already created by RelicSystem
    scene.tombstones.set(id, createTombstone(scene, { id, ...ev }));
  }
  scene._removePlayer(ev.slot); // host: already removed → no-op
  scene.fx?.onTombstone(ev);
});

registerEventHandler(EV.TOMBSTONE_STATE, (scene, ev) => {
  const ts = scene.tombstones?.get('t' + ev.slot);
  if (ts) setTombstoneBagged(ts, ev.baggedRelic);
  scene.fx?.onTombstoneState(ev);
});

registerEventHandler(EV.REJOINED, (scene, ev) => {
  // Client-side view re-add (the view was removed by the TOMBSTONE
  // handler). WP6: REJOINED precedes the stone's DESPAWN on ordered ctl,
  // so the local stone view still stands — spawn the returning view AT
  // the stone (instead of teleporting in from spawnFor for the ~100 ms
  // until the first snapshot) and fire the UI half's rejoin-flash hook.
  // No stone view (the rejoiner's own slot — its TOMBSTONE replay
  // handler skipped the local stone; or a host applying a leaked copy):
  // plain re-add, no flash — existing behavior. Idempotent; position
  // self-corrects from the next snapshot.
  const stone = scene.tombstones?.get('t' + ev.slot);
  scene._addPlayer(ev.slot, stone ? [stone.x, stone.y] : null);
  if (stone) scene.spawnRejoinFlash?.(stone.x, stone.y, ev.slot);
  // WP7: ring burst + (for the local slot) re-point the camera at the
  // freshly re-added view — the old one was destroyed by TOMBSTONE.
  scene.fx?.onRejoined(ev);
  // toast ("<NAME> IS BACK") rides the ui:event relay — UIScene catalog.
});

// ---------------- WP3 grapple lifecycle ----------------
// Beam rendering is snapshot-driven (the `grapples` group); these exist
// for WP7 FX hooks and to keep clients warning-free. NOISE_BURST fills
// the gauge host-side once WP4's NoiseSystem lands.
registerEventHandler(EV.GRAPPLE_ATTACH, (scene, ev) => scene.fx?.onGrappleAttach(ev));
registerEventHandler(EV.GRAPPLE_DETACH, (scene, ev) => scene.fx?.onGrappleDetach(ev));
// WP6 §10 shipped the world ripple + loud-event shake in WorldHUD. WP7
// supersedes BOTH with the art-spec §3.5 amount-scaled triple ring and
// the single shake arbiter. Either/or, never both — two ripples on one
// event is a defect, and two shake owners defeat the never-stack rule.
// WorldHUD's version stays as the fallback for an Fx-less scene.
registerEventHandler(EV.NOISE_BURST, (scene, ev) => {
  if (scene.fx) scene.fx.onNoiseBurst(ev);
  else scene.worldUI?.onNoiseBurst(ev);
});

// ---------------- WP4 world systems ----------------
// One presentation path, all modes: the host applies its own sim's events
// through these exact handlers (idempotent where the sim already mutated).

registerEventHandler(EV.DOOR_STATE, (scene, ev) => {
  const d = scene.doors?.get(ev.id);
  if (!d) return;
  if (ev.state === 'broken') setDoorBroken(d); // idempotent (host already sim-broke it)
  else setDoorDamaged(d, ev.smashHp);
  scene.fx?.onDoorState(ev); // WP7: debris/dust/shake, half-count on a hit
});

// WP6: the ux-spec §9 toast copy + §7.1 clock delta floats for
// TIME_COST/TIME_GAIN, and the §7.9 escalation banner, all live in the
// UIScene catalog fed by the 'ui:event' relay — world-side handlers are
// no-ops (WP7 adds tint/collapse FX on ESCALATION).
registerEventHandler(EV.TIME_COST, (scene) => scene.fx?.onTimeDelta(-1));
registerEventHandler(EV.TIME_GAIN, (scene) => scene.fx?.onTimeDelta(1));
registerEventHandler(EV.ESCALATION, (scene, ev) => scene.fx?.onEscalation(ev.level));

registerEventHandler(EV.PICKUP_STATE, (scene, ev) => {
  const pk = scene.pickups?.get(ev.id);
  if (pk) setRitualUsed(pk);
  scene.fx?.onPickupUsed(ev);
});

// Host/solo GameScene maps RUN_OVER to PHASE.RESULTS after the event
// drain (the authoritative transition rides the phase message); clients
// just follow that phase. WP7 adds calamity FX here.
registerEventHandler(EV.RUN_OVER, (scene, ev) => scene.fx?.onRunOver(ev));

registerEventHandler(EV.HARD_LANDING, (scene, ev) => scene.fx?.onHardLanding(ev));

// ---------------- WP4 combat half feel events ----------------
// Presentation-only hooks: the WP4 readability cues (windup flash, stun
// wobble, dying fade) are driven from `.state.ai`/`attackPhase` in the
// entity cosmetics, NOT from these events — they exist for WP7 juice
// (sparks, shake, swing arcs) and to keep clients warning-free.
// STUN/REVIVE had NO handler before WP7 (applyEvent logged "no handler"
// once per kind on every peer). The stun POSE — rotation, X-eyes, stars,
// gray tint — stays state-driven so it survives a snapshot-only client
// and a rejoin replay; these hooks own only the one-shot impact.
registerEventHandler(EV.STUN, (scene, ev) => scene.fx?.onStun(ev));
registerEventHandler(EV.REVIVE, (scene, ev) => scene.fx?.onRevive(ev));

registerEventHandler(EV.SWING, (scene, ev) => scene.fx?.onSwing(ev));
registerEventHandler(EV.HIT, (scene, ev) => scene.fx?.onHit(ev));
registerEventHandler(EV.STAGGERED, (scene, ev) => {
  scene.worldUI?.onStagger(ev);  // WP6: channel-interrupt heuristic (§7.6)
  scene.fx?.onStaggered(ev);     // WP7: feet puff + art-node jitter
});
registerEventHandler(EV.MONSTER_TELEGRAPH, (scene, ev) => scene.fx?.onMonsterTelegraph(ev));
registerEventHandler(EV.MONSTER_ATTACK, (scene, ev) => scene.fx?.onMonsterAttack(ev));
registerEventHandler(EV.MONSTER_FLINCH, (scene, ev) => scene.fx?.onMonsterFlinch(ev));
registerEventHandler(EV.MONSTER_DIED, (scene, ev) => scene.fx?.onMonsterDied(ev));
