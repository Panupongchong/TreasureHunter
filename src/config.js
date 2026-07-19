// ============================================================
// Vaultbreakers — central tuning config.
// Every gameplay constant lives here. See CLAUDE.md for the
// design rationale behind each value.
// ============================================================

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

// ---------- Physics (mass-based core rule; see CLAUDE.md) ----------
export const PHYSICS = {
  gravityY: 1400,          // px/s^2
  baseMoveSpeed: 260,      // px/s at mass 1.0
  baseSprintMult: 1.45,
  accel: 2200,             // ground acceleration px/s^2
  airAccelMult: 0.6,       // weaker control in the air
  friction: 1800,          // deceleration when no input, px/s^2
  baseJumpVelocity: 560,   // px/s at mass 1.0
  jumpCutMult: 0.45,       // releasing jump early cuts upward velocity (variable jump)
  coyoteMs: 90,            // grace period after leaving a ledge
  jumpBufferMs: 120,       // grace period for early jump presses
};

// speedMult = 1/mass, jumpMult = 1/sqrt(mass) — the one weight rule.
export const massSpeedMult = (mass) => 1 / mass;
export const massJumpMult = (mass) => 1 / Math.sqrt(mass);

// ---------- Masses (player = 1.0) ----------
export const MASS = {
  player: 1.0,
  relic: 1.0,      // carrier mass = player + relic
  skulker: 0.5,
  brute: 3.0,
};

// ---------- Stun ----------
export const STUN = {
  selfRecoverMs: 6000,
  teammateReviveMs: 1500,
  baseSafeFallHeight: 260, // px; actual = base / mass
  mashReduceMs: 250,       // per mash press (jump/attack/grab edges)
  splitStunMs: 1200,       // landing on a teammate: both briefly stunned
  reviveRange: 56,         // px to a stunned teammate for the revive channel
};

// ---------- Player-vs-player collision (solid top / soft side) ----------
export const PVP = {
  sidePushAccel: 1400,      // px/s^2 separation on side contact (soft push)
  velocityInheritance: 0.8, // carrier velocity kept on jump-off / throw
  topContactEps: 6,         // px tolerance for "was above last step"
};

// ---------- Grab / carry / throw ----------
export const CARRY = {
  grabRange: 48,       // px to a stunned teammate for pickup
  carryOffsetY: -40,   // carried body rides above the carrier's head
  throwVelX: 460,      // px/s along facing
  throwVelY: 360,      // px/s upward
};

// ---------- Clock economy (only movement shortcuts cost time) ----------
export const CLOCK = {
  sessionMs: 12 * 60 * 1000,
  smashDoorMs: 20 * 1000,
  blastRubbleMs: 25 * 1000,
  breakShortcutMs: 15 * 1000,
  kickBridgeMs: 10 * 1000,
  hourglassBonusMs: 30 * 1000,
  ritualBonusMs: 60 * 1000,
  escalation1Ms: 6 * 60 * 1000, // <6 min -> level 1 (lights dim flag)
  escalation2Ms: 3 * 60 * 1000, // <3 min -> level 2 (collapse flag)
  collapseWarnMs: 1500,         // flash-then-despawn window for collapse-marked
                                // platforms (mechanic deferred; flag-only in WP4)
};

// ---------- Noise gauge ----------
export const NOISE = {
  max: 100,
  // Per-weapon swing noise replaces the old flat attack:6 — CLAUDE.md's
  // noise-vs-power axis REQUIRES the weapons to differ in noise.
  daggerSwing: 2,      // a full dagger fight barely tickles the gauge
  daggerHitBonus: 2,   // landed hit total 4
  hammerSwing: 8,      // loudest verb short of a door break
  hammerHitBonus: 4,   // landed hit total 12
  grappleImpact: 5,
  hardLanding: 8,
  sprintPerSec: 3,
  doorSmash: 30,       // large — a smash costs time AND noise
  rubbleSmash: 35,
  shortcutSmash: 25,
  bridgeSmash: 15,
  bagStow: 4,          // WP5: cautious play still feeds the gauge
  bagUnstow: 3,        // CLAUDE.md: stow/unstow BOTH make small noise;
                       // unstow slightly quieter than stow (designer spec A)
  relicThrow: 3,       // clatter of release
  relicLand: 6,        // UNCAUGHT thrown relic on first terrain contact;
                       // a caught relic is silent — rewards the catch
  hourglassPickup: 10, // shrieking sand — the +30 s is never free
  relicDropBurst: 20,  // WP5 hook: stun-drop noise burst
  decayPerSec: 2,
  decayDelayMs: 4000,  // quiet this long before decay starts — without it,
                       // 2/s silently eats ~60 noise over a 30 s fight and
                       // "10 loud actions" becomes 15+; bursts accumulate
                       // honestly, true quiet still drains to 0 in <1 min
  hardLandingFrac: 0.6, // landings with fallDist > safeHeight*frac make noise
  spawnDropFactor: 0.5, // gauge halves after a spawn — post-spawn 50/100
                        // leaves ~5 loud actions of headroom
};

// ---------- Doors / barriers ----------
// smashHp = hammer hits to break (Brute hit weight is MONSTERS config).
// CLAUDE.md rule: smash time-COST ≈ 1.5–2× the quiet alternative's DURATION.
export const DOORS = {
  smashHp: {
    door: 4,            // breaks in ~4 s of real time (approach + swings)
    rubble: 6,          // ~6 s
    shortcut: 3,        // ~3 s
    bridge: 2,          // ~2 s
    crankGate: Infinity, // hammer-immune — the mandatory co-op barrier
  },
  quietMs: {
    door: 12000,     // 'pickDoor'   — vs smash: ~4 s real + 20 s clock + half a spawn
    rubble: 15000,   // 'clearRubble' — CO-OP showcase: up to 2 channelers sum (7.5 s duo)
    shortcut: 9000,  // 'pryShortcut'
    bridge: 6000,    // 'lowerBridge'
    crankGate: 8000, // 'crank' — 2 players channel SIMULTANEOUSLY
  },
  maxQuietChannelers: 2, // co-op picking sums but caps at 2 (feel review):
                         // an uncapped 4-stack quiet-picks the main door in
                         // 3 s — free, silent AND faster than the smash,
                         // deleting the loud-vs-quiet trade entirely
  // Time charged on SMASH break (quiet = free). Brute-broken doors charge
  // NO time cost but emit the full smash noise burst (players didn't choose
  // the shortcut so the clock doesn't fine them; the gauge still spikes).
  timeCostMs: {
    door: CLOCK.smashDoorMs,
    rubble: CLOCK.blastRubbleMs,
    shortcut: CLOCK.breakShortcutMs,
    bridge: CLOCK.kickBridgeMs,
    crankGate: 0,
  },
  // Noise burst on smash break, per type (feel spec §4).
  smashNoise: {
    door: NOISE.doorSmash,
    rubble: NOISE.rubbleSmash,
    shortcut: NOISE.shortcutSmash,
    bridge: NOISE.bridgeSmash,
    crankGate: 0,
  },
  interactRange: 64, // px to a door for pickDoor/crank channels
  brokenAlpha: 0.25, // client visual for broken barriers
};

// ---------- Interact / pickups ----------
export const INTERACT = {
  rackRange: 48,
  rackMs: 400,             // weapon rack quick channel (lobby)
  ritualRange: 70,
  ritualChannelMs: 5000,   // ALL connected players channel simultaneously; +60 s once
  hourglassTouchRadius: 30, // touch pickup (decided: touch, no channel)
  boardRange: 48,          // WP6: stage board prompt/channel radius (lobby)
  boardMs: 500,            // WP6: 'CHANGING STAGE' channel (ux-spec §7.6)
};

// ---------- WP6: ready zone / ping / stages / results ----------
export const READY = {
  holdMs: 3000,            // CLAUDE.md LOCKED "3 s" stand-to-ready, as config
};

export const PING = {
  cooldownMs: 500,         // per-player rate limit, host-validated
  gamepadDist: 200,        // px from player along R-stick dir (ux-spec §7.8)
};

// Stage board cycle order (lobby excluded; one entry today, built for more).
export const STAGES = ['test'];

export const RESULTS = {
  ruinousFfWeight: 2,      // award score = timeCostMs/1000 + weight * ffDealt
};

// ---------- WP6 UI (ux-spec is the source; config is runtime truth) ----------
export const UI = {
  font: 'Courier New, monospace',
  // ux-spec §0.3 palette. String forms for Text, int forms for Graphics.
  colors: {
    bg: 0x10121a, panel: 0x1a1e2c, panelStroke: 0x2a3048,
    text: '#e8eaf2', muted: '#8890a6', dim: '#565d75',
    gold: '#ffd23f', danger: '#ff5d5d', warn: '#ffb347',
    ok: '#7ee787', noise: '#b07eff',
    // int twins (Graphics fills/strokes)
    goldInt: 0xffd23f, dangerInt: 0xff5d5d, warnInt: 0xffb347,
    okInt: 0x7ee787, noiseInt: 0xb07eff, textInt: 0xe8eaf2,
    dimInt: 0x565d75, mutedInt: 0x8890a6,
  },
  scrimAlpha: 0.7,
  panelAlpha: 0.92, panelRadius: 6, panelStrokeW: 2,
  // depths (ux-spec §0.1)
  depth: { panels: 0, hud: 10, banner: 20, toasts: 30, modal: 40, world: 900 },
  // widgets
  buttonHitPad: 8, buttonPressScale: 0.96, buttonPressMs: 80,
  focusRepeatDelayMs: 350, focusRepeatMs: 130,          // §0.6 gamepad repeat
  promptRange: 48,                                       // §7.7
  channelBar: { w: 40, h: 6, aboveHead: 30 },            // §0.4 (world-space)
  // aboveStrip: ring center height above the zone strip top — clears the
  // heads of the players standing in the zone (they were covering the
  // countdown they are all watching).
  readyRing: { r: 40, lineW: 5, resetFlashMs: 200, doneFlashMs: 300, aboveStrip: 56 },
  kickHoldMs: 700, kickRingR: 10,                        // §6.2
  // baseY = playing/results. lobbyBaseY keeps the stack off the ready ring
  // (bottom-center in the lobby map) — join/leave toasts are exactly the
  // traffic that happens while everyone watches the READY n/m readout.
  toast: { lifeMs: 3000, fadeMs: 300, max: 4, baseY: 496, lobbyBaseY: 380, stepY: 20 }, // §9
  focusMarkerGap: 14, // '>' glyph gap left of the focused row (§0.4)
  escConfirmMs: 2500, // window for the confirming 2nd ESC during a run
  clock: { deltaFloatMs: 800, flashMs: 200, finalPopS: 10 }, // urgency tiers
                                // reference CLOCK.escalation1Ms/escalation2Ms
  noiseGauge: { w: 200, h: 14, x: 16, y: 16, warnAt: 80, spikeMs: 250, halveMs: 300 },
  banner: { inMs: 200, holdMs: 1600, outMs: 400, y: 180, bandAlpha: 0.4 },
  ping: { lifeMs: 3000, fadeMs: 500, popMs: 150, edgeInset: 12 }, // §7.8
                                // (cooldown/gamepadDist live in PING — sim truth)
  stunBar: { w: 200, h: 10, y: 436 },                    // §7.4
  crosshair: { size: 8 }, aimLine: { len: 24, alpha: 0.6 },
  hostLagAfterMs: 1000, hostLagRepeatMs: 5000,           // §7.11
  ripple: { ms: 350, loudAmount: 20, shakeMs: 120, shakePx: 4 },  // §10
  connectDotsMs: 300, caretBlinkMs: 500, copiedRevertMs: 1500,
  boardPopupCloseRange: 64,                              // §6.3
  resultsRowStaggerMs: 60, resultsAwardDelayMs: 400, verdictPopMs: 250,
};

// ---------- Weapons (noise-vs-power axis; consumed by CombatSystem) ----------
export const COMBAT = {
  defaultWeapon: 'hammer', // undefined state.weapon means hammer (contract §0.7)
  dagger: {                // a knitting needle, not a threat to friends
    windupMs: 60,          // instant feel; mash-friendly
    activeMs: 80,
    recoveryMs: 120,
    cooldownMs: 280,       // press-to-press, ~3.5 swings/s
    hitboxW: 36,           // short reach = you must commit to Skulker range
    hitboxH: 40,
    damage: 1,             // Skulker in 2, Brute in 10
    knockbackBase: 140,    // applied as base/mass — pops Skulkers (280), ignores Brutes (47)
    moveMult: 1.0,         // no penalty; agility is its identity
    facingLock: false,     // facing may change mid-swing
  },
  hammer: {                // every swing is a decision
    windupMs: 350,         // long enough for a teammate to see it coming and
                           // step out — that IS the FF safety valve
    activeMs: 120,
    recoveryMs: 280,
    cooldownMs: 900,       // heavy cadence; every swing a decision
    hitboxW: 56,           // hits doors + ground Skulkers without pixel aim
    hitboxH: 56,
    damage: 2,             // one-shots Skulker, Brute in 5
    knockbackBase: 420,    // launches Skulkers 840 px/s into hazards; Brute 140 nudge
    moveMult: 0.4,         // 40% speed from windup start through active — committed = vulnerable
    facingLock: true,      // locked at windup start: arc is readable, no twitch-correct into allies
    doorDamage: 1,         // door HP counted in hammer hits
  },
};

// ---------- Friendly fire (players have NO health — FF costs time/position) ----------
// Baseline = the 50% default: interruption values ~half the ffFull values.
export const FF = {
  daggerShoveX: 240,       // shrug-off shove along attacker facing
  daggerShoveY: 120,       // + up
  daggerStaggerMs: 250,    // input-null micro-primitive: NO stun, NO relic
                           // drop, cancels channel — annoying, funny, never run-ending
  hammerShoveX: 520,       // enough to knock a teammate across a gap — allowed comedy
  hammerShoveY: 260,       // + up
  hammerStunMs: 3000,      // via applyStun cause 'ff'; the literal 50% of 6000
  // ffFull lobby toggle values (explicit, from feel spec §2 — the ×2/×1.3
  // rules of thumb round differently; the explicit numbers win):
  full: {
    daggerShoveX: 320,
    daggerStaggerMs: 400,
    hammerShoveX: 680,
    hammerStunMs: 6000,
  },
};

// ---------- Monsters (a loudness tax, not bosses; consumed by MonsterSystem) ----------
export const MONSTERS = {
  skulker: {               // the mosquito
    width: 22,             // body px — smaller than a player (26×34); reads as prey
    height: 20,
    color: 0x9b59d0,       // violet: distinct from every player color + door tint
    chaseSpeed: 300,       // > walk 260, < sprint 377: standing your ground is
                           // losing, sprinting away always works — disengage is real
    accel: 2600,           // px/s^2 steering accel-step: nimble, and a single grappler
                           // (pull 2600/0.5 = 5200 on it) always overwhelms its drive
    wanderSpeed: 90,
    wanderTurnMinMs: 1500, // turn every 1.5–3 s random
    wanderTurnMaxMs: 3000,
    detectRadius: 260,
    windupMs: 400,         // readability floor, QA-audited (telegraph contract)
    activeMs: 150,
    range: 40,
    cooldownMs: 1400,
    hitStunMs: 2000,       // a time fine, not a wipe
    hitShove: 260,         // px/s shove on hit
    hp: 2,                 // 2 dagger / 1 hammer
    flinchMs: 300,         // dagger hit interrupts its windup — dagger is a legit duelist
    hopVelocity: 480,      // blocked-ledge hop; the only pathfinding allowed
    despawnAfterIdleMs: 8000, // the tax expires if you actually go quiet
  },
  brute: {                 // walking terrain
    width: 44,             // visibly corridor-filling next to a 26 px player
    height: 52,
    color: 0x8a3b46,       // dull blood-red slab
    chaseSpeed: 120,
    accel: 1000,           // steering drive; the tug-of-war number: one grappler
                           // pulls the Brute at 2600/3.0 ≈ 867 px/s^2 (< 1000, the
                           // Brute holds and reels YOU in), two sum to ~1733 (> 1000,
                           // the Brute drags) — CLAUDE.md's tug-of-war with no
                           // special case, just accel-vs-accel
    wanderSpeed: 60,
    wanderTurnMinMs: 2000, // lumbering wander: turns less often than the Skulker
    wanderTurnMaxMs: 4000,
    detectRadius: 200,     // short-sighted — walk wide around it
    windupMs: 650,         // huge telegraph, huge consequence
    activeMs: 200,
    range: 56,
    cooldownMs: 2500,
    hitStunMs: 3000,
    hitShove: 420,
    hp: 10,                // 5 hammer / 10 dagger; solo-unkillable-ish is intended
    flinchMs: 0,           // armored: dodge the 650 ms window or don't be there
    doorHitIntervalMs: 1500, // breaks a 4-HP door in 6 s
    doorDamage: 1,
    doorSeekRadius: 300,   // no player target + intact door within this → doorSmash
                           // (0 time cost, full noise burst — bait-demolition is intended)
  },
  deaggroRangeMult: 1.6,   // target beyond detection ×1.6 continuously...
  deaggroHoldMs: 2500,     // ...for this long → back to wander (counter-play IS disengaging)
  spawnMinPlayerDist: 180, // spawn point ≥ this from EVERY non-stunned player
  spawnMaxCentroidDist: 320, // nearest valid on-ground spot within this of noise focus
  spawnStepPx: 80,         // expand the search radius in these steps if nothing qualifies
  spawnEmergeMs: 800,      // 'spawn' emerge: hittable, can't move/attack — never cheap
  bruteEveryN: 3,          // every 3rd noise-gauge spawn is a Brute
  ignoreStunnedPlayers: true, // NEVER target/re-hit a stunned player — no stunlock, ever
  dyingMs: 400,            // 'dying' state window before despawn (death-anim seam, WP7)
  impactStunSpeed: 500,    // px/s player speed that stuns a monster on body contact:
                           // above sprint (377) so running through a Skulker is safe,
                           // reachable by throws (460+inherit) and grapple yanks —
                           // "throw your teammate at it" is intended comedy
  impactStunMs: 1500,      // shorter than any weapon route — impact is setup, not a kill
  dummyRespawnMs: 4000,    // lobby dummy pops back so practice never runs dry
};

// ---------- Grapple (zip-only; constant-force on dynamic bodies) ----------
export const GRAPPLE = {
  maxRange: 420,        // cast length px
  zipSpeed: 900,        // px/s toward infinite-mass anchors (< body maxVelocityY 1200)
  pullForce: 2600,      // per-end accel = pullForce / mass; grapplers on one target SUM
  aimAssistRadius: 48,  // gamepad: max perpendicular ray distance that magnetizes a dynamic target
  minRange: 32,         // ignore intersections closer than this (no attaching to the floor underfoot
                        // or a teammate you're rubbing shoulders with; also assist's near cutoff)
  arriveRadius: 20,     // terrain zip auto-detaches within this distance of the anchor
  breakRangeMult: 1.15, // beam snaps beyond maxRange * this (stretch slack during pulls)
  maxPullAccel: 12000,  // px/s^2 cap on the SUMMED grapple accel per body per tick (anti-explosion).
                        // WP4: raised 8000→12000 executing WP3's inline tuning note — keeps the
                        // locked "+100% per extra grappler" true on sub-1.0 masses (2-grappler
                        // Skulker yank = 10400, was clipping at 8000). WP3 marked 12000
                        // explosion-safe at dt<=50ms.
  maxPullSpeed: 1100,   // px/s speed clamp on bodies receiving grapple force this tick (< 1200 cap)
  fireCooldownMs: 150,  // lockout between attach attempts after a detach (edge-mash guard;
                        // 'refire' retarget bypasses it)
};

// ---------- Relic (the objective; carrier mass rule is MASS.relic) ----------
// All numbers from the WP5 design spec §A (game designer authority).
export const RELIC = {
  width: 22, height: 22,  // reads smaller than a player (26×34)
  color: 0xf5a623,        // amber — distinct from player colors & hourglass diamond
  bounce: 0.35,           // hops visibly, settles in ~2 bounces
  looseDragX: 600,        // loose relic stops sliding in <1 s; grapple pull
                          // (2600) still wins easily (fishing feel check A.3)
  pickupRadius: 44,       // hands pickup + hand-catch + grapple-catch arrival,
                          // center-to-center. 44 < CARRY.grabRange 48 DELIBERATE:
                          // grabbing a teammate who fell ON the relic stays
                          // possible from the teammate's far side
  pickupLockoutMs: 250,   // thrower cannot re-grab own throw (grab-edge
                          // double-fire guard); only blocks the THROWER
  throwSpeed: 760,        // px/s along normalized aim: 412 px flat range @45°,
                          // clears the 280 px pit but NOT a 360 px deck rise —
                          // vertical transfer needs a catcher (the co-op point).
                          // Inheritance = PVP.velocityInheritance (0.8): sprint
                          // throws carry, same skill rule as thrown teammates
  defaultThrowAngleDeg: 45, // aim-neutral gamepad fallback: 45° up along facing
  dropPopVx: 150,         // stun/disconnect drop: horizontal pop away from the
  dropPopVxJitter: 40,    //   stun source (shove sign), else opposite facing;
  dropPopVy: 280,         //   upward pop ~28 px hop — visible, never underfoot
  holdOffsetX: 16, holdOffsetY: -6,  // in-hands: front of carrier (facing-signed)
  bagOffsetX: 12, bagOffsetY: -14,   // bagged: on the back (opposite facing)
  tombstoneOffsetY: -40,  // bagged-at-tombstone pin height
  bagChannelMs: 3000,     // CONFIRMED: ~1.5 Skulker attack cycles — an unhandled
                          // monster denies bagging ("clear the room, THEN secure
                          // it"). Cancels on ANY damage with FULL reset
  unbagChannelMs: 2000,   // CONFIRMED: unbag→throw ≈ 2.5 s — usable, not a panic button
  reclaimChannelMs: 2000, // tombstone bagged-relic → reclaimer's BAG (mirrors unbag)
  reclaimRange: 56,       // px to the tombstone
};

// ---------- Player body ----------
export const PLAYER = {
  width: 26,
  height: 34,
  colors: [0xffd23f, 0x4fd1c5, 0xf47fb0, 0x8ecae6],
};

// ---------- Networking (host-authoritative; see implementation-plan §2) ----------
export const NET = {
  protocolVersion: 1,
  peerIdPrefix: 'pfproto-',   // host peer ID = prefix + 4-letter room code (LOCKED)
  codeLength: 4,
  maxPlayers: 4,
  snapshotHz: 20,             // host -> clients world snapshots (LOCKED)
  inputHz: 30,                // client -> host input frames (edge-OR coalesced)
  interpBufferMs: 100,        // client interpolation buffer (LOCKED: 100 ms)
  joinTimeoutMs: 10000,       // give up connecting after this
  heartbeatMs: 2000,          // ctl ping cadence both directions
  heartbeatTimeoutMs: 8000,   // silence beyond this = peer considered gone
  helloTimeoutMs: 8000,       // host drops a connection that never says hello
  maxNameLen: 16,
};

// Map geometry now lives in src/maps/ (lobbyMap.js, testMap.js).
