# Session log — 2026-07-19

**Topic:** WP5 — relic, objective, real test map (build steps 8 + 13-groundwork).
Production had already landed in a previous session that was cut short before
QA; this session ("continue the workflow") ran the QA phase of the studio
workflow, applied the producer pass, and verified everything green.

## How it was built

Production (RelicSystem/RelicEntity/TombstoneEntity, Carry/Stun/Grapple relic
branches, real testMap, RELIC config, relic snapshot group + replay) was
found complete and wired in the working tree. This session ran a 3-agent QA
workflow (main session as producer):

1. **Technical Director** — full WP5 diff review against plan §WP5/§2/§3/§4/
   §6-risk-8/§7 and the CLAUDE.md relic/tombstone tables. Verdict:
   APPROVE_WITH_FIXES (1 major, 2 minor, 2 nits).
2. **QA Automation Engineer** — recreated the headless-CDP harness (the old
   `scratchpad/` suites were lost with the previous sessions' temp dirs) and
   wrote `scratchpad/wp5-accept.mjs`: 11 tests, 3 Chrome instances over the
   real PeerJS broker. New harness trick: gameplay verbs driven via an
   InputManager.poll patch (`__hold` merge + one-shot `__edges`) for exact
   edge/aim semantics at headless fps; real CDP keys kept for smoke tests.
3. **Game Designer (feel review)** — recomputed feel from landed constants.
   Verdict: SHIPPABLE_AFTER_DELTAS (delta 1 = the same major; delta 2 =
   pacing, see open questions).

All three converged independently on the same major.

## Producer pass (fixes applied after the studio run)

- **MAJOR (found by all three agents):** the bag/unbag channel start block
  had been dropped from `InteractSystem._findChannel` — the numbered blocks
  literally jumped 1, 2, 4, 5, 6. `_channelValid`/`_complete` and the RELIC
  config constants were all correct-but-dead: the relic could never reach
  'bagged', so secure-on-stun, tombstone bagged-relic reclaim, and the
  while-bagged capability gates were unreachable. Restored the branch
  (self-targeted, ranked below every world-targeted channel so a carrier can
  still pick doors / crank / join the ritual). Damage-interrupt then works
  for free (applyStun/applyStagger null the channel = full reset).
- **Minor:** `serializeWorld` now sets ST.CARRYING_HANDS / ST.CARRYING_BAG
  (plan §2.5) and `applySnapshot` decodes them into client view state —
  WP6's HUD carry icons are specced against these bits.
- **Minor (design decision per CLAUDE.md "a stunned player CAN be hauled"):**
  `CarrySystem.grab` now accepts a stunned teammate carrying a BAGGED relic
  (previously the F-grab rescue whiffed on exactly the objective carrier).
  MovementSystem's carriedLoad now uses the carried player's EFFECTIVE mass,
  so hauling a bagged carrier costs 2.0, not a flat 1.0. Thrown-into-exit
  while stunned-but-bagged still wins (intended comedy, unchanged).
- Nit: grapple-catch now honors the thrower's own pickup lockout (no
  instant self-re-catch of your own throw).
- Nit: testMap 'EXIT' label moved inside the actual exitZone (x 200 → 80;
  it sat in the entranceZone, ~60 px from where the win fires).
- Suite fix (not product): the damage-interrupt assertion expected the
  channel to STAY null after the stagger — correct only pre-fix. Post-fix a
  fresh channel legitimately restarts under a still-held E; the test now
  detects the reset (progress 24% → 0% → restart) instead.

## Verification

`npm run build` clean; **wp5-accept.mjs all 11 green** (final run):
build, smoke-solo (161 px walk @60 fps), smoke-netsync (interp view within
0.2 px of host), carry-weight (walk exactly 50.0%, jump-v 70.7% = 1/sqrt 2),
bag-channel (start → client-mirrored 98% → rs='bagged'; interrupt = full
reset then restart), stun-drop (hands: loose + relicDrop burst 20 on host AND
client; bagged: secure), capability-gate (hands blocks grapple+attack, bagged
allows both), throw-catch (grapple-attach to flying relic, reel to 8 px, hand
catch 'caught'), grapple-fish (1.0 vs 1.0 both slide; meet biased by ground
drag vs friction — design-documented), win-path (runOver win + full
ResultsPayload phase-broadcast to both clients), tombstone-relic (disconnect
7.5 s → stone with baggedRelic → reclaim channel mirrored 96% → BONUS token
rejoin respawning at the stone). WP1–WP4 suites no longer exist (lost temp
dirs) — the smoke tests cover basic regression; rebuild the suites from the
session-log descriptions if deeper regression is ever needed.

## Open design questions for the user (accepted for now)

1. **Kite-bagging:** the bag channel has no grounded/stationary requirement —
   a carrier can sprint away while the 3 s channel runs (damage still hard-
   resets). Intended (channel = attention cost), or require near-stationary?
2. **Pacing (designer delta 2):** paper-walk puts a coordinated quiet run at
   ~2:30–3:00 optimal / ~4:30–6:30 realistic — short of the "clean run ≈
   8–10 min of the 12-min clock" sizing target, which also deadens the
   hourglass/ritual economy. Designer reco: hold 12 min for first playtests,
   then at build step 13 drop CLOCK.sessionMs to 8–9 min rather than growing
   the map. Depends on whether the 8–10 target meant coordinated or
   first-session chaotic play.
3. **Bagged-carrier zip is a master key:** zip is velocity-steered and
   mass-blind, and grapple-while-bagged is allowed (CLAUDE.md table), so a
   bagged carrier solo-bypasses every forced-teamwork jump after one 3 s
   toll. Confirm the haul-shaft co-op hoist is deliberately the
   hand-carry/emergency venue rather than a mandatory beat.
4. **Escalation-2 collapse is still flag-only** (WP4 accepted debt; three of
   four collapse venues punish the carrier's return route). Designer insists
   it lands before step-13 session-length tuning.

## Follow-ups
- WP6 next: UX screens (menu final, lobby arena + ready zone, HUD, results,
  tombstone rejoin UX). Client carry state for HUD icons now on the wire.
- Recorded debts carried forward: WP4's spawnMaxCentroidDist dead config,
  Skulker one-platform-above spawn scoring, hourglass DESPAWN missing the
  taker's slot (WP6 toast wants it).
- Nothing committed (user decision pending — WP1–WP5 all uncommitted).
