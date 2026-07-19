// ============================================================
// InteractSystem — the generic hold-to-channel resolver (plan WP2:
// revive; WP4 adds pickDoor/crank/ritual/rack; WP5 adds bag/unbag/
// reclaim the same way).
//
// One channel per player at a time. Holding Interact near a valid
// target starts/continues it; releasing, leaving range, or getting
// stunned cancels. Progress is mirrored to state.channelProgress
// (0..100) for snapshots + the over-head bar.
//
// EXTERNAL channels (WP4 concept): InteractSystem owns start/validity/
// cancel, but progress + completion belong to the owning system —
// DoorSystem for pickDoor/crank (progress lives on the door and
// persists), ClockSystem for ritual (progress lives on the altar).
// Those systems override channelProgress each tick; this system must
// not decrement msLeft, complete, or overwrite the bar for them.
// Unknown channel types still cancel defensively — every new type MUST
// be registered here.
// ============================================================

import { STUN, DOORS, INTERACT, RELIC } from '../config.js';
import { EV } from '../net/protocol.js';
import { revive } from './StunSystem.js';

/** Types whose progress/completion are owned elsewhere (see header). */
const EXTERNAL = new Set(['pickDoor', 'crank', 'ritual']);

export class InteractSystem {
  update(sim, dt) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      if (s.stunned || s.carriedBy !== null) continue; // applyStun cleared it
      if ((s.staggerMsLeft ?? 0) > 0) { // WP4 light-FF stagger: input is
        s.channel = null;               // null for its duration — the active
        s.channelProgress = 0;          // channel is cancelled (feel spec §2)
        continue;
      }
      const frame = sim.inputFor(slot);

      if (!frame.interact) {
        s.channel = null;
      } else if (s.channel) {
        if (this._channelValid(sim, p, s.channel)) {
          if (!EXTERNAL.has(s.channel.type)) {
            s.channel.msLeft -= dt * 1000;
            if (s.channel.msLeft <= 0) this._complete(sim, p, s.channel);
          }
          // external: kept alive; owner system advances shared progress
        } else {
          s.channel = null;
        }
      } else {
        this._findChannel(sim, p);
      }

      // Bar mirror: external channels were/will be overridden by their
      // owning system this tick (Door runs before us, Clock after) —
      // don't stomp the shared progress with the msLeft formula.
      if (!s.channel) {
        s.channelProgress = 0;
      } else if (!EXTERNAL.has(s.channel.type)) {
        s.channelProgress = Math.round(100 * (1 - s.channel.msLeft / s.channel.msTotal));
      }
    }
  }

  /** Priority order, first match wins:
   *  revive > reclaim > door > ritual > board > bag/unbag > rack.
   *  (Revive stays first: rescue is the emergency. Bag/unbag are
   *  SELF-targeted and possible anywhere, so they must rank BELOW every
   *  world-targeted channel — at higher priority a relic carrier could
   *  never pick a door, crank the co-op gate, or join the ritual, and
   *  the all-players ritual would deadlock. Tech-director major fix.) */
  _findChannel(sim, p) {
    const c = p.state.carrying;
    // 1. revive
    const target = this._reviveTarget(sim, p);
    if (target) {
      requestChannel(p, {
        type: 'revive',
        targetId: target.state.slot,
        msTotal: STUN.teammateReviveMs,
      });
      return;
    }
    // 2. tombstone bagged-relic reclaim (→ the reclaimer's BAG)
    if (!c) {
      for (const [, ts] of sim.tombstones) {
        if (ts.state.baggedRelic && this._inRangeXY(p, ts, RELIC.reclaimRange)) {
          requestChannel(p, {
            type: 'reclaim',
            targetId: ts.state.id,
            msTotal: RELIC.reclaimChannelMs,
          });
          return;
        }
      }
    }
    // 3. door quiet channel: nearest intact door within interactRange
    let bestDoor = null;
    let bestDist = Infinity;
    for (const [, door] of sim.doors) {
      if (door.state.state !== 'intact') continue;
      const d = Math.max(Math.abs(door.x - p.x), Math.abs(door.y - p.y));
      if (d <= DOORS.interactRange && d < bestDist) {
        bestDist = d;
        bestDoor = door;
      }
    }
    if (bestDoor) {
      const type = bestDoor.state.type === 'crankGate' ? 'crank' : 'pickDoor';
      // msTotal only seeds the bar; authority is the door's shared progress.
      requestChannel(p, {
        type,
        targetId: bestDoor.state.id,
        msTotal: DOORS.quietMs[bestDoor.state.type],
      });
      return;
    }
    // 4. ritual altar
    for (const [, pk] of sim.pickups) {
      if (pk.state.type === 'ritual' && !pk.state.used &&
          this._inRangeXY(p, pk, INTERACT.ritualRange)) {
        requestChannel(p, {
          type: 'ritual',
          targetId: pk.state.id,
          msTotal: INTERACT.ritualChannelMs,
        });
        return;
      }
    }
    // 5. stage board (WP6, lobby, HOST-ONLY). World-targeted → ranks
    //    above the self-targeted bag/unbag. Gate on the isHost FLAG, not
    //    slot 0. Non-hosts' E near the board simply never starts a
    //    channel (their "ONLY THE HOST PICKS THE STAGE" popup line is
    //    pure UI-half presentation from the Session mirror).
    const board = sim.scene.map.board;
    if (board && sim.session.players[p.state.slot]?.isHost &&
        this._inRangeXY(p, board, INTERACT.boardRange)) {
      requestChannel(p, { type: 'board', targetId: 'board', msTotal: INTERACT.boardMs });
      return;
    }
    // 6. bag / unbag — self-targeted and possible anywhere, so it must
    //    rank below every world-targeted channel (see priority note).
    if (c?.kind === 'relic') {
      const hands = c.where === 'hands';
      requestChannel(p, {
        type: hands ? 'bag' : 'unbag',
        targetId: 'relic',
        msTotal: hands ? RELIC.bagChannelMs : RELIC.unbagChannelMs,
      });
      return;
    }
    // 7. weapon rack (lobby): interact cycles hammer <-> dagger
    const rack = sim.scene.map.weaponRack;
    if (rack && this._inRangeXY(p, rack, INTERACT.rackRange)) {
      requestChannel(p, { type: 'rack', targetId: 'rack', msTotal: INTERACT.rackMs });
    }
  }

  _channelValid(sim, p, channel) {
    switch (channel.type) {
      case 'revive': {
        const target = sim.players.get(channel.targetId);
        return !!target && target.state.stunned && this._inReviveRange(p, target);
      }
      case 'pickDoor':
      case 'crank': {
        const door = sim.doors.get(channel.targetId);
        return !!door && door.state.state === 'intact' &&
               this._inRangeXY(p, door, DOORS.interactRange);
      }
      case 'ritual': {
        const pk = sim.pickups.get(channel.targetId);
        return !!pk && !pk.state.used && this._inRangeXY(p, pk, INTERACT.ritualRange);
      }
      case 'rack':
        return !!sim.scene.map.weaponRack &&
               this._inRangeXY(p, sim.scene.map.weaponRack, INTERACT.rackRange);
      case 'board':
        return !!sim.scene.map.board &&
               !!sim.session.players[p.state.slot]?.isHost &&
               this._inRangeXY(p, sim.scene.map.board, INTERACT.boardRange);
      // WP5 relic channels — range/release cancel here; damage cancel via
      // applyStagger/applyStun nulling the channel (full reset).
      case 'bag':
        return p.state.carrying?.kind === 'relic' && p.state.carrying.where === 'hands';
      case 'unbag':
        return p.state.carrying?.kind === 'relic' && p.state.carrying.where === 'bag';
      case 'reclaim': {
        const ts = sim.tombstones.get(channel.targetId);
        return !!ts && ts.state.baggedRelic && !p.state.carrying &&
               this._inRangeXY(p, ts, RELIC.reclaimRange);
      }
      default:
        return false; // unknown types cancel until their WP lands
    }
  }

  _complete(sim, p, channel) {
    p.state.channel = null;
    switch (channel.type) {
      case 'revive': {
        const target = sim.players.get(channel.targetId);
        if (target) revive(sim, target, p.state.slot);
        break;
      }
      case 'rack':
        // Cross-half contract §0.7: this half owns the rack interaction;
        // CombatSystem owns what `weapon` DOES + its wire representation.
        p.state.weapon = ((p.state.weapon ?? 'hammer') === 'dagger') ? 'hammer' : 'dagger';
        break;
      case 'board':
        // SIM-INTERNAL event: the GameScene drain intercepts STAGE_CYCLE
        // (never broadcast — session.stageId + broadcastRoster are the
        // wire truth). See GameScene._cycleStage.
        sim.emit({ kind: EV.STAGE_CYCLE });
        break;
      // WP5 relic channels (RelicSystem owns the effect — sim.relicSys handle):
      case 'bag':
        sim.relicSys?.completeBag(sim, p);
        break;
      case 'unbag':
        sim.relicSys?.completeUnbag(sim, p);
        break;
      case 'reclaim':
        sim.relicSys?.completeReclaim(sim, p, channel.targetId);
        break;
      // external types (pickDoor/crank/ritual) never complete here.
    }
  }

  _reviveTarget(sim, p) {
    for (const [, target] of sim.players) {
      if (target === p || !target.state.stunned) continue;
      if (this._inReviveRange(p, target)) return target;
    }
    return null;
  }

  _inReviveRange(p, target) {
    return this._inRangeXY(p, target, STUN.reviveRange);
  }

  /** Chebyshev box check against anything with x/y (GO or {x,y} data). */
  _inRangeXY(p, target, range) {
    return Math.abs(target.x - p.x) <= range && Math.abs(target.y - p.y) <= range;
  }
}

/**
 * Start a channel on a player (exposed for WP4/WP5 systems). The
 * channel still needs InteractSystem to keep it valid each tick via a
 * registered type — foreign types get cancelled defensively.
 */
export function requestChannel(player, spec) {
  player.state.channel = {
    type: spec.type,
    targetId: spec.targetId,
    msLeft: spec.msTotal,
    msTotal: spec.msTotal,
  };
  return player.state.channel;
}
