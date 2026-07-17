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
};

// ---------- Noise gauge ----------
export const NOISE = {
  max: 100,
  attack: 6,
  grappleImpact: 5,
  hardLanding: 8,
  sprintPerSec: 3,
  doorSmash: 30,
  bagStow: 4,
  decayPerSec: 2,
  spawnDropFactor: 0.5, // gauge halves after a spawn
};

// ---------- Grapple (zip-only; constant-force on dynamic bodies) ----------
export const GRAPPLE = {
  maxRange: 420,
  zipSpeed: 900,       // px/s toward infinite-mass targets
  pullForce: 2600,     // force split by mass on dynamic targets; grapplers SUM
  aimAssistRadius: 48, // gamepad soft-magnetism toward valid targets
};

// ---------- Player body ----------
export const PLAYER = {
  width: 26,
  height: 34,
  colors: [0xffd23f, 0x4fd1c5, 0xf47fb0, 0x8ecae6],
};

// ---------- Test map: bounded arena. [x, y, w, h] ----------
export const PLATFORMS = [
  [0, 528, 960, 12],            // floor
  [0, 0, 12, 540],              // left wall
  [948, 0, 12, 540],            // right wall
  [0, 0, 960, 12],              // ceiling
  [120, 430, 170, 14],
  [380, 355, 190, 14],
  [680, 430, 170, 14],
  [80, 280, 150, 14],
  [440, 220, 170, 14],
  [740, 280, 150, 14],
  [300, 120, 360, 14],
];

export const SPAWNS = [
  [90, 470], [830, 470], [210, 370], [720, 370],
];
