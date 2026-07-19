// ============================================================
// MonsterEntity — Skulker + Brute factory (PlayerEntity pattern:
// same factory on host — dynamic arcade body — and client — visual
// proxy). All authoritative data lives in the flat `.state` blob;
// updateMonsterCosmetics is driven purely off `.state` fields the
// snapshot writes back, so ONE cosmetics path serves all modes
// (client `ai` arrives via the snapshot monsters group).
//
// Monster stun is stunnedMs + ai:'stunned' ONLY — NEVER a `stunned`
// boolean: GrappleSystem.grappleMass() would treat a stunned Brute as
// mass 1.0 and detach rule D5 would drop beams the moment a grappled
// monster is hammered (combat spec decision 5).
// ============================================================

import { MASS, MONSTERS, COLORS, FX } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {string} id wire id — the sim.monsters Map KEY (grapple contract)
 * @param {'skulker'|'brute'} type
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 * @param {{dummy?:boolean, spawnDef?:{x:number,y:number}}} [opts]
 */
export function createMonster(scene, id, type, x, y, withBody, opts = {}) {
  const cfg = MONSTERS[type];
  // WP7: procedural silhouette replaces the flat rect. cfg.color is now
  // DEAD for fill (art-spec §2.2 puts both monsters in the crimson family
  // so "red = threat" holds); the field stays declared — it is still the
  // documented tuning knob and deleting it risks an unseen reader.
  const m = scene.add.image(x, y, type === 'brute' ? 'brute' : 'skulker')
    .setDepth(type === 'brute' ? FX.depth.brute : FX.depth.skulker);

  m.state = {
    id,                      // duplicated for convenience; the Map key is authoritative
    type,                    // 'skulker' | 'brute'
    mass: MASS[type],
    hp: cfg.hp,
    ai: 'spawn',             // plan §4 enum: spawn|idle|chase|windup|attack|stunned|doorSmash|dying
    aiTimerMs: MONSTERS.spawnEmergeMs,
    facing: 1,
    stunnedMs: 0,            // NO `stunned` boolean — see header
    targetSlot: null,        // chase target (skulker / brute-no-door)
    doorTargetId: null,      // brute door objective
    dummy: !!opts.dummy,     // lobby pen: never aggros, respawns after death
    spawnDef: opts.spawnDef ?? null, // map origin (dummy respawn point)
    attackCdMs: 0,
    smashCdMs: 0,            // brute doorSmash cadence
    deaggroMs: 0,            // time spent beyond detect × deaggroRangeMult
    idleMs: 0,               // target-less time (skulker fade-despawn)
    wanderDir: 0,
    wanderTurnMs: 0,
    deathReason: null,
  };

  // ----- cosmetics (updated by updateMonsterCosmetics every frame) -----
  // Eyes are BAKED into the texture now (two small white eyes = monster,
  // vs the players' one big eye — art-spec §4.2 rule 2 shape identity).
  m._lastX = x;   // pure render state (skitter frame swap); NEVER in .state
  // Brute fists: scene-level siblings (the Brute is an Image, not a
  // Container). Positioned per frame; destroyed in destroyMonster.
  if (type === 'brute') {
    m.fistL = scene.add.image(x - 20, y + 8, 'bruteFist').setDepth(FX.depth.brute);
    m.fistR = scene.add.image(x + 20, y + 8, 'bruteFist').setDepth(FX.depth.brute);
  }
  m.hpText = scene.add.text(x, y - cfg.height / 2 - 10, '', {
    fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#ff8f8f',
  }).setOrigin(0.5).setDepth(FX.depth.overhead);
  // Lobby pen nameplate (ux-spec §6.5/§11): the affordance that tells a new
  // player this one is safe to practice on.
  m.nameplate = opts.dummy
    ? scene.add.text(x, y - cfg.height / 2 - 22, 'DUMMY', {
      fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#6b7280',
    }).setOrigin(0.5).setDepth(FX.depth.overhead)
    : null;

  if (withBody) {
    scene.physics.add.existing(m);
    // LOCKED GEOMETRY (WP7 rule): the texture is intentionally larger than
    // the body (skulker 22×18 art / 22×20 body; brute 48×56 art / 44×52
    // body), and an Image body derives from the TEXTURE. Pin it back to
    // MONSTERS.width/height so MonsterSystem._insidePit (which tests the
    // center, and which the map author already patched by 2 px) and every
    // collider behave exactly as in WP1–WP6. This also pins the body
    // against the windup scale tween the Fx half adds: an explicitly
    // sized body does not rescale with the GameObject.
    m.body.setSize(cfg.width, cfg.height, false);
    m.body.setOffset((m.width - cfg.width) / 2, (m.height - cfg.height) / 2);
    m.body.setCollideWorldBounds(true);
    m.body.setMaxVelocityY(1200);
    if (type === 'brute') {
      // NOT setImmovable: an immovable dynamic body vs a static platform
      // (both immovable) skips Arcade separation entirely — the Brute
      // would fall through the floor. pushable=false blocks player shoves
      // (dynamic-vs-dynamic exchange) while static separation still moves
      // the Brute; GrappleSystem writes velocity directly so grapples
      // still haul it. "Walking terrain" with working floors.
      m.body.pushable = false;
    }
  }
  return m;
}

/** Per-frame cosmetic sync from `.state` — host and client alike.
 *  The windup flash IS the WP4 telegraph readability cue (feel spec §3):
 *  ship-now minimal, WP7 replaces it with real FX keyed off events. */
export function updateMonsterCosmetics(m) {
  const s = m.state;
  const now = Date.now();
  m.setFlipX(s.facing < 0);                                 // eyes are baked in
  m.hpText.setPosition(m.x, m.y - m.height / 2 - 10);
  m.hpText.setText('|'.repeat(Math.max(0, s.hp)));

  // Windup telegraph — UNCHANGED cadence (90 ms) and duration. This is a
  // QA-signed-off readability contract, so only the mechanism changed:
  // setTintFill preserves the full-white flash read on a textured sprite.
  if (s.ai === 'windup' && Math.floor(now / 90) % 2 === 0) m.setTintFill(COLORS.white);
  else m.clearTint();

  // Skitter: a 2-FRAME TEXTURE SWAP, never a re-generate. "Moving" is
  // derived from the rendered x delta so clients (which have no body)
  // animate identically to the host.
  if (s.type === 'skulker') {
    const moving = Math.abs(m.x - m._lastX) > 0.4;
    m.setTexture(moving && Math.floor(now / 90) % 2 ? 'skulkerLegsUp' : 'skulker');
  }
  m._lastX = m.x;

  let alpha = 1;
  if (s.ai === 'spawn') alpha = 0.45;                       // emerging
  else if (s.ai === 'dying') alpha = Math.max(0.05, m.alpha - 0.06); // fade out
  m.setAlpha(alpha);
  m.hpText.setAlpha(alpha);
  m.nameplate?.setPosition(m.x, m.y - m.height / 2 - 22).setAlpha(alpha);
  if (m.fistL) {
    // _fistLift is a render-only offset the Fx windup tween drives (never
    // in .state). Outside the windup it decays back to rest here, so the
    // slam reads even though positions are rewritten every frame.
    if (s.ai !== 'windup' && m._fistLift) {
      m._fistLift = Math.abs(m._fistLift) < 0.4 ? 0 : m._fistLift * 0.7;
    }
    const lift = m._fistLift || 0;
    m.fistL.setPosition(m.x - 20, m.y + 8 + lift).setAlpha(alpha);
    m.fistR.setPosition(m.x + 20, m.y + 8 + lift).setAlpha(alpha);
  }

  // Stun wobble stays. Art-spec's ±1 px chase x-jitter is DROPPED and
  // replaced by a ±1.5° angle jitter: the monster IS the physics GO, so a
  // position jitter would be a position write (contract §9-E). Angle does
  // not affect the axis-aligned Arcade body.
  if (s.ai === 'stunned') m.setAngle(Math.sin(now / 60) * 12);
  else if (s.ai === 'chase') m.setAngle(Math.sin(now / 42) * 1.5);
  else m.setAngle(0);
}

export function destroyMonster(m) {
  m.hpText.destroy();
  m.nameplate?.destroy();
  m.fistL?.destroy();
  m.fistR?.destroy();
  m.destroy();
}
