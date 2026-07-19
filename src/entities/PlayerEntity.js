// ============================================================
// PlayerEntity — the player factory (plan §1).
//
// Same factory on host (dynamic arcade body) and client (visual-only,
// no body). All authoritative data lives in the flat `.state` blob so
// sim/snapshot.js can serialize mechanically; the client writes the
// same fields back from snapshots — one cosmetics path for all modes.
// ============================================================

import { PLAYER, MASS, COMBAT, UI, COLORS, FX } from '../config.js';
import { ATK } from '../sim/snapshot.js';
import { slotColor, slotColorStr } from '../fx/textures.js';

// WP6 §7.6: channel-bar fill color per channel type (host reads
// state.channel.type; clients read the wire-decoded state.channelType).
const CH_COLORS = {
  revive: UI.colors.okInt,
  bag: UI.colors.goldInt,
  unbag: UI.colors.goldInt,
  ritual: UI.colors.stunInt, // WP7: violet is the STUN/ritual reservation
                             // (art-spec §1.3 rule 5); noise went orange
  reclaim: UI.colors.warnInt,
  // pickDoor / crank / board / rack → white (text)
};

/**
 * @param {Phaser.Scene} scene
 * @param {number} slot 0..3
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 */
export function createPlayer(scene, slot, x, y, withBody) {
  // WP7: a Container (body sprite + eye + accessories + glow) replaces the
  // flat rectangle. Accessories are container CHILDREN so depth and (later)
  // squash-stretch inherit; the world-space UI bits below stay scene-level.
  const p = scene.add.container(x, y);
  p.setSize(PLAYER.width, PLAYER.height); // keeps p.width/p.height at 26×34
                                          // for HUD aim brackets (HUD.js:847)

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

  // ----- container children (WP7 art) -----
  const col = slotColor(slot);
  // Escalation-1 additive glow (art-spec §1.4) — allocated here, never at
  // runtime; the Fx half only flips visibility/alpha.
  p.glow = scene.add.image(0, 0, 'glow64')
    .setBlendMode(Phaser.BlendModes.ADD).setTint(col)
    .setScale(FX.glow.playerR * 2 / 64).setAlpha(0).setVisible(false);
  p.body_ = scene.add.image(0, 0, `player${slot % 4}`);
  p.bag = scene.add.image(0, 0, `playerBag${slot % 4}`).setVisible(false);
  p.bagGem = scene.add.image(0, 0, 'playerBagGem').setVisible(false);
  p.eye = scene.add.image(0, 0, 'playerEye');
  p.heldGem = scene.add.image(0, -28, 'relic').setScale(0.8).setVisible(false);
  // ART NODE (WP7 Fx contract). The squash-stretch and stun-rotation
  // tweens target THIS, never `p`. Arcade derives body size from the
  // GameObject's transform scale (Body.updateBounds), so scaling the
  // body-owning container would silently resize the 26×34 hitbox and
  // change fall-stun / PvP behaviour host-side while looking fine. A
  // child container at (0,0) scale (1,1) is a pure render transform:
  // identical pixels today, and the only safe tween target tomorrow.
  p.art = scene.add.container(0, 0,
    [p.glow, p.body_, p.bag, p.bagGem, p.eye, p.heldGem]);
  p.add([p.art]);

  // ----- scene-level cosmetics (world-space, NOT container children:
  // they are positioned in world coords and must never inherit the
  // container's squash-stretch — a distorted UI bar is unreadable) -----
  p.stars = scene.add.container(x, y - 28, [
    scene.add.image(-10, 0, 'star8'),
    scene.add.image(0, -4, 'star8'),
    scene.add.image(10, 0, 'star8'),
  ]).setDepth(FX.depth.overhead).setVisible(false);
  // Name label (art-spec §4.2.3). Scene-level like the bars so it never
  // inherits the art container's squash. Text is filled in by the
  // cosmetics pass from the Session mirror — no new state, no new wire
  // data. Shown for REMOTE players in a run and for everyone in the
  // lobby; hidden while a channel bar occupies the same slot.
  p.label = scene.add.text(x, y - 30, '', {
    fontFamily: 'Courier New, monospace', fontSize: '10px',
    color: slotColorStr(slot), stroke: '#0b0d14', strokeThickness: 3,
  }).setOrigin(0.5).setDepth(FX.depth.overhead).setAlpha(0.75).setVisible(false);
  // WP6 §0.4 restyle: 40x6 bar, bottom edge 10px above the sprite top
  // (center at y-30); 1px stroke via the bg rect being 2px larger.
  p.barBg = scene.add.rectangle(x, y - 30, 42, 8, 0x1a1e2c)
    .setDepth(FX.depth.overhead).setVisible(false)
    .setStrokeStyle(1, 0x2a3048);
  p.bar = scene.add.rectangle(x, y - 30, 0, 6, 0x8ef79a)
    .setDepth(FX.depth.overhead + 1).setVisible(false);
  // WP4 combat cosmetics: swing box (faint during windup = the readable
  // hammer telegraph / FF safety valve; bright during active frames) and
  // a tiny weapon glyph so the rack toggle has visible feedback.
  p.swing = scene.add.rectangle(x, y, 8, 8, 0xffffff)
    .setDepth(FX.depth.particle).setVisible(false);
  p.wpnText = scene.add.text(x, y + 2, '', {
    fontFamily: 'Courier New, monospace', fontSize: '9px', color: '#12141c',
  }).setOrigin(0.5).setDepth(FX.depth.overhead);

  if (withBody) {
    scene.physics.add.existing(p);
    // LOCKED GEOMETRY (WP7 rule). Arcade computes
    //   body.position = go.x + offset - go.displayOrigin
    // and a sized Container reports displayOrigin = size/2 (its origin is
    // a read-only 0.5). So an explicit 26×34 body at offset (0,0) lands
    // its top-left at (x-13, y-17) — byte-identical to the WP1–WP6
    // add.rectangle body. Setting it explicitly (rather than trusting
    // the centering default) also PINS the body against the scale tweens
    // the Fx half adds: an explicitly sized body does not rescale.
    p.body.setSize(PLAYER.width, PLAYER.height, false);
    p.body.setOffset(0, 0);
    p.body.setCollideWorldBounds(true);
    p.body.setMaxVelocityY(1200);
  }
  return p;
}

/** Per-frame cosmetic sync from `.state` — host and client alike. */
export function updatePlayerCosmetics(p) {
  const s = p.state;
  // Eye/bag/gem offsets are CONTAINER-LOCAL now; the body sprite is
  // symmetric, so facing only flips the accessories (never the container:
  // flipping it would mirror the whole physics-carrying transform).
  p.eye.setPosition(s.facing * 5, -7).setFlipX(s.facing < 0);
  p.eye.setTexture(s.stunned ? 'playerEyeX' : 'playerEye');
  p.stars.setPosition(p.x, p.y - 28);
  p.stars.setVisible(s.stunned);
  if (s.stunned) p.stars.setAngle(p.stars.angle + 3);
  // WP6 §7.4: body tints gray while stunned, slot color restored after.
  // Tint the SPRITE, never the container (art-spec §1.3 rule 6: the stun
  // desaturation is the only body tint in the game).
  // An Fx white blink (FF-heavy hit, revive) owns the tint until its
  // deadline — otherwise this unconditional setTint would clear the
  // tintFill in the same frame it was set and the flash never rendered.
  if ((p.body_._fxFlashUntil ?? 0) > (p.scene?.time.now ?? 0)) {
    p.body_.setTintFill(COLORS.white);
  } else {
    p.body_.setTint(s.stunned ? COLORS.stunTint : 0xffffff);
  }

  // ----- carry accessories (derived, no new state) -----
  const bagged = !!(s.carryingBag || s.carrying?.where === 'bag');
  p.bag.setVisible(bagged).setPosition(-s.facing * 10, -2);
  p.bagGem.setVisible(bagged).setPosition(-s.facing * 10, -5);
  // Relic-in-hands. Host has s.carrying.{kind,where}; the client wire only
  // has s.carryingHands, which is ALSO true for carrying a player — so
  // clients disambiguate against the relic view, whose rs/holderSlot both
  // already ride the snapshot. No new data.
  const rel = p.scene?.relic;
  const hands = s.carrying
    ? (s.carrying.kind === 'relic' && s.carrying.where === 'hands')
    : !!(s.carryingHands && rel && rel.state.rs === 'held' &&
         rel.state.holderSlot === s.slot);
  p.heldGem.setVisible(hands);

  const channeling = s.channelProgress > 0;

  // ----- name label (art-spec §4.2.3) -----
  // Everyone in the lobby (so you learn who is who); remotes only during a
  // run (your own name over your head is noise). Yields the slot to the
  // channel bar, which occupies the same y.
  const sess = p.scene?.session;
  const inLobby = sess?.phase === 'lobby';
  const showLabel = !!sess && !channeling && !s.stunned &&
    (inLobby || s.slot !== sess.localSlot);
  p.label.setVisible(showLabel);
  if (showLabel) {
    const name = sess.players?.[s.slot]?.name;
    if (name && p.label.text !== name) p.label.setText(name);
    p.label.setPosition(p.x, p.y - 30);
  }

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
  // Container children (glow, body_, bag, bagGem, eye, heldGem) die with
  // p.destroy(); only the SCENE-LEVEL cosmetics need explicit destroys.
  // Keeping that split explicit is what stops the per-restart leak (the
  // scene restarts ~6× per session).
  p.stars.destroy();
  p.label.destroy();
  p.barBg.destroy();
  p.bar.destroy();
  p.swing.destroy();
  p.wpnText.destroy();
  p.destroy();
}
