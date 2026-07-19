# Session log — 2026-07-18 (part 3)

**Topic:** WP4 — clock, doors, noise, monsters, weapons, friendly fire.
Built with the studio subagent workflow, extended per user request with a
**Game Designer** role for game feel (spec up front, feel review at the end).

## How it was built

8-agent workflow (one restart after a session-limit hit; design specs
resumed from cache):

1. **Pre-production** (parallel): *Game Designer* (feel spec: full weapon
   frame data, FF stagger-vs-stun semantics, monster telegraphs, noise
   economy calibration, machine-checkable feel assertions), *Systems
   Designer* (world half), *Combat/AI Designer* (combat half).
2. **Production** (sequential): *Engineer #1* landed the world half
   (Clock/Door/Noise/pickups/maps/replay + seams), *Engineer #2* built the
   combat half (Combat/Monster/MonsterEntity/wire) on top.
3. **QA** (parallel): *Technical Director* (full-diff review: 2 majors,
   4 minors), *QA Automation* (9-test suite over the real broker, 3 browser
   instances — all passed), *Game Designer feel review* (recomputed feel
   predictions from landed constants; verdict: shippable after deltas).

## What landed (high points)

- ClockSystem (countdown, chargeTime/grantTime, hourglass +30s, ritual
  +60s, escalation 1/2 flags, calamity → runOver → results phase).
- DoorSystem: door/rubble/shortcut/bridge/crankGate; smash (time + noise)
  vs quiet channel (free + silent); crank needs 2 simultaneous channelers
  with a no-deadlock hold rule; Brute demolition charges no time.
- NoiseSystem: addNoise is the single gauge sink AND the only noiseBurst
  emitter (WP3 grapple emit site refactored in); full gauge → spawn near
  noise centroid (≥180 px from players) + gauge halves; 4 s decay delay.
- CombatSystem: windup/active/recovery FSM; hammer (facing-locked, 0.4
  move mult, smashes doors, FF stun) vs dagger (fast, FF = 250 ms stagger
  micro-primitive — input-null, no relic-drop semantics); ffFull explicit
  config values.
- MonsterSystem: Skulker (chase/telegraph/swipe, flinches, fade-despawns)
  and Brute (blocks, demolishes doors, zero flinch, pit death); steering
  is accel-only so grapple tug-of-war math holds (1 grappler loses at 867
  vs 1000, two win at 1733); every hit preceded by a telegraph event.
- Wire: monsters snapshot group + spawn/despawn events; doors/pickups
  event-only; rejoin replay via buildReplay/getReplay.

## Producer pass (fixes applied after the studio run)

- **MAJOR (tech director):** rejoin replay burst arrived before the
  client GameScene existed → ClientNet now buffers `net:event` until the
  scene attaches (`attachScene()` drains in order, `detachScene()` on
  shutdown covers phase restarts). Replay now also goes to EVERY joiner
  (fresh lobby joiners previously saw smashed doors as intact).
- **MAJOR:** fast token-takeover rejoin kept the old input seq high-water
  mark → rejoined player's inputs dropped for minutes. HostNet now resets
  inputSeq/inputBuffers on every accepted claim.
- Minor: Brute parked forever under vertically-unreachable doors →
  `_nearestDoorId` filters by vertical reach.
- Feel: attack cooldown now charged at swing START (true press-to-press —
  dagger 280 ms, hammer 900 ms as designed; door smash 6.1 s → 3.7 s).
- Feel: FF cannot stunlock (shove still lands on a stunned teammate, but
  no stun refresh / stagger / ffDealt inflation — the monster rule).
- Feel: `DOORS.maxQuietChannelers = 2` — an uncapped 4-stack quiet-picked
  the main door faster than the smash, deleting the loud/quiet trade.

## Verification

`npm run build` clean; **all four suites green**: wp1 (9), wp2 (7),
wp3 (6, incl. force-summing after the maxPullAccel 12000 change), wp4 (9:
clock sync ±0 ms, door smash −20 s + noise 62, quiet pick free/silent,
crank 2-player, noise spawn 51 px from focus, skulker chase+stun, Brute
tug-of-war direction flip + pit death, FF semantics incl. ffFull, calamity
→ results on all three peers).

## Open design questions for the user (accepted for now)

1. **Ritual** = "all CONNECTED players channel" (not literally 4; solo=1;
   a stunned teammate blocks until revived). Confirm or change.
2. **Escalation-2 platform collapse is flag-only** (map data + constants
   exist, nothing consumes them). Designer insists it lands before
   session-length tuning (build step 13) — currently deferred.
3. **Brute demolition is time-free** (bait-demolition is an intended
   exploit); revisit at half-cost if playtests show clock trivialization.

## Follow-ups
- WP5 next: relic, objective, real test map.
- Small recorded debts: spawnMaxCentroidDist is dead config; spawn scoring
  can place a Skulker one platform above its target (no drop-down AI);
  hourglass DESPAWN lacks the taker's slot (WP6 toast wants it).
- Nothing committed (user decision pending).
