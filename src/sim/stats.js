// ============================================================
// stats.js — RunStats accumulator (WP1: stub counters).
//
// WP4/WP5 fill these from tick events; WP6 renders the ResultsPayload.
// ============================================================

import { RESULTS } from '../config.js';

const emptySlotStats = () => ({
  doorsSmashed: 0,
  timeCostMs: 0,
  noiseMade: 0,
  ffDealt: 0,
  throws: 0,
  stuns: 0,
});

export class RunStats {
  constructor() {
    this.perSlot = [emptySlotStats(), emptySlotStats(), emptySlotStats(), emptySlotStats()];
    this.escapeMs = 0;
    this.treasure = 0;
  }

  /** Finalized ResultsPayload shape (plan WP5): {result, reason,
   *  teamStats:{escapeMs, timeLeftMs, treasure}, perPlayer:[{slot, name,
   *  doorsSmashed, timeCostMs, noiseMade, ffDealt, throws, stuns}],
   *  award:{slot:number|null, timeCostMs, ffDealt} (WP6)}. allPlayers():
   *  a tombstoned (disconnected, slot-reserved) player still gets a row —
   *  WP6's ResultsUI must tolerate rows whose roster entry has
   *  connected:false. */
  toResultsPayload(result, reason, session, timeLeftMs) {
    return {
      result,   // 'win' | 'lose'
      reason,   // 'escaped' | 'calamity' | 'debug'
      teamStats: { escapeMs: this.escapeMs, timeLeftMs, treasure: this.treasure },
      perPlayer: session.allPlayers().map((p) => ({
        slot: p.slot,
        name: p.name,
        ...this.perSlot[p.slot],
      })),
      award: this._award(session),
    };
  }

  /**
   * "Most Ruinous Player" (WP6, host-computed — clients only render).
   * score = timeCostMs/1000 + RESULTS.ruinousFfWeight * ffDealt.
   * Highest wins; ties → lowest slot (strict > over slot-ordered
   * allPlayers). All scores 0 → {slot:null} ("NOBODY" rendering is
   * client-side copy). timeCostMs/ffDealt feed the award detail line;
   * the title STRING lives client-side (ui/ResultsUI).
   */
  _award(session) {
    let bestSlot = null;
    let bestScore = 0;
    for (const p of session.allPlayers()) {
      const s = this.perSlot[p.slot];
      const score = s.timeCostMs / 1000 + RESULTS.ruinousFfWeight * s.ffDealt;
      if (score > bestScore) {
        bestScore = score;
        bestSlot = p.slot;
      }
    }
    if (bestSlot === null) return { slot: null, timeCostMs: 0, ffDealt: 0 };
    const s = this.perSlot[bestSlot];
    return { slot: bestSlot, timeCostMs: s.timeCostMs, ffDealt: s.ffDealt };
  }
}
