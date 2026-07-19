// ============================================================
// Interpolator — thin wrapper around @geckos.io/snapshot-interpolation.
//
// One SnapshotInterpolation instance, 100 ms buffer (LOCKED). Clients
// render interpolated x/y per state group and read everything else as
// latest-value from the newest vault snapshot (plan §2.5).
// ============================================================

import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation';
import { NET } from '../config.js';

export class Interpolator {
  constructor() {
    this.si = new SnapshotInterpolation(NET.snapshotHz);
    this.si.interpolationBuffer.value = NET.interpBufferMs;
  }

  /** Feed one received snapshot ({id, time, state}). Vault sorts by time. */
  addSnapshot(snap) {
    try {
      this.si.snapshot.add(snap);
    } catch (_) { /* malformed/stale snap — drop (plan risk 5) */ }
  }

  /**
   * Interpolated entities for one state group, or null before the buffer
   * has two snapshots.
   * @param {string} params e.g. 'x y'   @param {string} group e.g. 'players'
   */
  interp(params, group) {
    const res = this.si.calcInterpolation(params, group);
    return res ? res.state : null;
  }

  /** Newest raw snapshot state (latest-value reads), or null. */
  latest() {
    return this.si.vault.get()?.state || null;
  }
}
