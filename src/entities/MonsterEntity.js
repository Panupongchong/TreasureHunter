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

import { MASS, MONSTERS } from '../config.js';

/**
 * @param {Phaser.Scene} scene
 * @param {string} id wire id — the sim.monsters Map KEY (grapple contract)
 * @param {'skulker'|'brute'} type
 * @param {boolean} withBody host/solo: dynamic body; client: visual proxy
 * @param {{dummy?:boolean, spawnDef?:{x:number,y:number}}} [opts]
 */
export function createMonster(scene, id, type, x, y, withBody, opts = {}) {
  const cfg = MONSTERS[type];
  const m = scene.add.rectangle(x, y, cfg.width, cfg.height, cfg.color);

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
  m.eye = scene.add.rectangle(x, y, 4, 4, 0x12141c).setDepth(1);
  m.hpText = scene.add.text(x, y - cfg.height / 2 - 10, '', {
    fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#ff8f8f',
  }).setOrigin(0.5).setDepth(2);
  // Lobby pen nameplate (ux-spec §6.5/§11): the affordance that tells a new
  // player this one is safe to practice on.
  m.nameplate = opts.dummy
    ? scene.add.text(x, y - cfg.height / 2 - 22, 'DUMMY', {
      fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#6b7280',
    }).setOrigin(0.5).setDepth(2)
    : null;

  if (withBody) {
    scene.physics.add.existing(m);
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
  const cfg = MONSTERS[s.type];
  m.eye.setPosition(m.x + s.facing * (m.width / 2 - 4), m.y - m.height / 4);
  m.hpText.setPosition(m.x, m.y - m.height / 2 - 10);
  m.hpText.setText('|'.repeat(Math.max(0, s.hp)));

  m.setFillStyle(s.ai === 'windup' && Math.floor(Date.now() / 90) % 2 === 0
    ? 0xffffff : cfg.color);

  let alpha = 1;
  if (s.ai === 'spawn') alpha = 0.45;                       // emerging
  else if (s.ai === 'dying') alpha = Math.max(0.05, m.alpha - 0.06); // fade out
  m.setAlpha(alpha);
  m.eye.setAlpha(alpha).setVisible(s.ai !== 'dying');
  m.hpText.setAlpha(alpha);
  m.nameplate?.setPosition(m.x, m.y - m.height / 2 - 22).setAlpha(alpha);

  m.setAngle(s.ai === 'stunned' ? Math.sin(Date.now() / 60) * 12 : 0);
}

export function destroyMonster(m) {
  m.eye.destroy();
  m.hpText.destroy();
  m.nameplate?.destroy();
  m.destroy();
}
