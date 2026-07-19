// ============================================================
// PlayerEntity — the player factory (plan §1).
//
// Same factory on host (dynamic arcade body) and client (visual-only,
// no body). All authoritative data lives in the flat `.state` blob so
// sim/snapshot.js can serialize mechanically; the client writes the
// same fields back from snapshots — one cosmetics path for all modes.
// ============================================================

import { PLAYER, MASS, COMBAT, UI } from '../config.js';
import { ATK } from '../sim/snapshot.js';

// WP6 §7.6: channel-bar fill color per channel type (host reads
// state.channel.type; clients read the wire-decoded state.channelType).
const CH_COLORS = {
  revive: UI.colors.okInt,
  bag: UI.colors.goldInt,
  unbag: UI.colors.goldInt,
  ritual: UI.colors.noiseInt,
  reclaim: UI.colors.warnInt,
  // pickDoor / crank / board / rack → white (text)
};

/**
 * @param {Phaser.Scene} scene
 * @param {number} slot 0..3
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 */
export function createPlayer(scene, slot, x, y, withBody) {
  const p = scene.add.rectangle(x, y, PLAYER.width, PLAYER.height, PLAYER.colors[slot % 4]);

  p.state = {
    slot,
    mass: MASS.player,   // 2.0 while carrying the relic (WP5)
    facing: 1,
    onGround: false,
    sprinting: false,
    // stun (WP2)
    stunned: false,
    stunMsLeft: 0,
    fallStartY: null,
    // stacking / carrying (WP2; relic variant WP5)
    standingOnSlot: null, // riding another player's head
    ridersMass: 0,        // weight stacked on THIS player (speed calc only)
    carrying: null,       // null | {kind:'player', slot} | {kind:'relic', ...}
    carriedBy: null,      // null | slot
    // grapple (WP3) — record shape lives in systems/GrappleSystem.js
    grapple: null,        // null | {targetKind:'terrain'|'entity', targetId, ...}
    grappleCdMs: 0,       // re-fire lockout countdown
    // combat (WP4) — CombatSystem owns semantics; ??-normalized there too
    weapon: null,         // null = COMBAT.defaultWeapon (rack toggles it)
    attack: null,         // null | {phase, msLeft, hitIds, facing, hitBonusDone}
    attackCdMs: 0,        // press-to-press cooldown countdown
    attackMoveMult: 1,    // hammer windup/active movement penalty (Movement reads)
    staggerMsLeft: 0,     // light-FF micro-stagger (input nulled; NOT stun)
    attackPhase: 0,       // client mirror of the `atk` wire int (ATK enum)
    // channels (revive now; doors/bags/ritual later)
    channel: null,        // null | {type, targetId, msLeft, msTotal}
    channelProgress: 0,   // 0..100 mirror for snapshots + cosmetics
    // jump feel timers (host-side only)
    lastGroundedAt: 0,
    jumpBufferedAt: -Infinity,
  };

  // ----- cosmetics (updated by updatePlayerCosmetics every frame) -----
  p.eye = scene.add.rectangle(x, y, 5, 5, 0x12141c).setDepth(1);
  p.stars = scene.add.text(x, y - 28, '✶ ✶ ✶', {
    fontFamily: 'Courier New, monospace', fontSize: '12px', color: '#ffd23f',
  }).setOrigin(0.5).setDepth(2).setVisible(false);
  // WP6 §0.4 restyle: 40x6 bar, bottom edge 10px above the sprite top
  // (center at y-30); 1px stroke via the bg rect being 2px larger.
  p.barBg = scene.add.rectangle(x, y - 30, 42, 8, 0x1a1e2c).setDepth(2).setVisible(false)
    .setStrokeStyle(1, 0x2a3048);
  p.bar = scene.add.rectangle(x, y - 30, 0, 6, 0x8ef79a).setDepth(3).setVisible(false);
  // WP4 combat cosmetics: swing box (faint during windup = the readable
  // hammer telegraph / FF safety valve; bright during active frames) and
  // a tiny weapon glyph so the rack toggle has visible feedback pre-WP7.
  p.swing = scene.add.rectangle(x, y, 8, 8, 0xffffff).setDepth(1).setVisible(false);
  p.wpnText = scene.add.text(x, y + 2, '', {
    fontFamily: 'Courier New, monospace', fontSize: '9px', color: '#12141c',
  }).setOrigin(0.5).setDepth(1);

  if (withBody) {
    scene.physics.add.existing(p);
    p.body.setCollideWorldBounds(true);
    p.body.setMaxVelocityY(1200);
  }
  return p;
}

/** Per-frame cosmetic sync from `.state` — host and client alike. */
export function updatePlayerCosmetics(p) {
  const s = p.state;
  p.eye.setPosition(p.x + s.facing * 8, p.y - 6);
  p.eye.setVisible(!s.stunned);
  p.stars.setPosition(p.x, p.y - 28);
  p.stars.setVisible(s.stunned);
  if (s.stunned) p.stars.setAngle(p.stars.angle + 3);
  // WP6 §7.4: body tints gray while stunned, slot color restored after.
  const wantFill = s.stunned ? 0x777788 : PLAYER.colors[s.slot % 4];
  if (p.fillColor !== wantFill) p.setFillStyle(wantFill);

  const channeling = s.channelProgress > 0;
  p.barBg.setPosition(p.x, p.y - 30).setVisible(channeling);
  p.bar.setVisible(channeling);
  if (channeling) {
    const type = s.channel?.type ?? s.channelType;
    const color = CH_COLORS[type] ?? UI.colors.textInt;
    if (p.bar.fillColor !== color) p.bar.setFillStyle(color);
    const w = 40 * (s.channelProgress / 100);
    p.bar.setSize(w, 6);
    p.bar.setPosition(p.x - 20 + w / 2, p.y - 30);
  }

  // ----- combat: swing box + weapon glyph (host reads attack, client atk) -----
  const weapon = COMBAT[s.weapon] ? s.weapon : 'hammer';
  p.wpnText.setPosition(p.x, p.y + 4).setText(weapon === 'dagger' ? 'd' : 'H');
  const phase = s.attack
    ? (ATK[s.attack.phase] ?? ATK.none)
    : (s.attackPhase ?? ATK.none);
  if (phase === ATK.windup || phase === ATK.active) {
    const w = COMBAT[weapon];
    p.swing.setVisible(true)
      .setSize(w.hitboxW, w.hitboxH)
      .setPosition(p.x + s.facing * (PLAYER.width / 2 + w.hitboxW / 2), p.y)
      .setAlpha(phase === ATK.active ? 0.85 : 0.22);
  } else {
    p.swing.setVisible(false);
  }
}

export function destroyPlayer(p) {
  p.eye.destroy();
  p.stars.destroy();
  p.barBg.destroy();
  p.bar.destroy();
  p.swing.destroy();
  p.wpnText.destroy();
  p.destroy();
}
