# Session log — 2026-07-19 (part 3)

**Topic:** WP7 — art & polish pass (the final work package): procedural
textures, FX/juice, camera, HUD styling. Plus two user-reported bugs found
by playing the deployed build.

## How it was built

Studio workflow, but split across two runs by usage limits:

1. **Run 1** (`wf_44bbf79d-a16`) — pre-production (*Technical Artist*
   texture contract + *FX & Performance Engineer* motion plan) and
   *Engineer #1* (textures) completed. Engineer #2 and all QA died on the
   session limit. Engineer #2's code had ALREADY LANDED on disk before it
   died (fx/Fx.js 37 KB, fx/camera.js) with a green build — only its report
   was lost.
2. **Run 2** (`wf_cf4eee69-b42`) — a QA-only workflow written against the
   working tree (rather than resuming, which would have re-run Engineer #2
   and duplicated landed work): *Technical Director* purity audit, *QA
   Automation* regression + perf + leak, *Art Director* readability review.

## User-reported bugs (fixed before QA ran)

1. **Right-click opened the browser context menu.** RMB is the grapple
   button, so it fired on every grapple. `disableContextMenu: true` in the
   Phaser game config (main.js) — one line, covers every scene.
2. **"Stun have to drop relic."** The drop logic was NOT broken: all four
   stun sources (fall, monster hit, heavy FF, plus the bagged control) were
   verified correct via a new suite, `scratchpad/wp7-stun-drop-check.mjs`.
   The real defect was a WP7 RENDERING regression: WP7 added player-side
   `heldGem`/`bagGem` accessories while RelicSystem still pinned the relic
   ENTITY to the holder, so a carrier drew TWO gold gems (one in front, one
   above the head). `updateRelicCosmetics` now hides the entity + glow +
   glint whenever rs is 'held' or 'bagged' — the carrier's own accessory
   (or the tombstone's gem, for a disconnected carrier) is the single
   renderer; loose/flying still draw from the entity. Verified by
   `scratchpad/wp7-relic-visual-check.mjs`: exactly ONE gem in every state.
   NOTE: bagged-survives-stun is a LOCKED CLAUDE.md decision and was left
   alone; if the report meant "bagged should drop too", that is a design
   change awaiting the user.

## Producer pass (fixes applied after the QA run)

- **MAJOR (tech director):** three effects animate the same `p.art` node —
  landing squash (scale), stun pose (rotation), stagger (x) — and each
  called a blanket `killTweensOf(art)`. Phaser's `stop()` skips
  `onComplete`, so the interrupted effect stranded the node at its
  mid-tween value: **every stun left the player permanently squashed**
  (1.30/0.70) until their next landing, because the rotation killed the
  squash. Each effect now owns a tracked tween slot (`_fxSquash`,
  `_fxPose`, `_fxStagger`) killed independently via `_killSlot`. The same
  change fixed a slow leak — killed tweens were never removed from the
  `_tweens` Set; remaining single-owner sites route through a new
  `_killTweensOf` that untracks.
- **Art must-fix 1 — vignettes at ¼ strength.** `vignette()` divided by
  `steps*4` on the assumption that bands accumulate, but the bands are
  ADJACENT (`yTop = i*bandT`), so each band's value IS its final alpha.
  Escalation-2 and the ≤0:30 urgency vignette were effectively invisible.
  Divisor dropped.
- **Art must-fix 2 — carrier diamond in UI gold.** `UI.colors.goldInt` is
  byte-identical to `PLAYER.colors[0]`, so the over-head carrier marker
  read as "player colour" on slot 0. Now drawn in `COLORS.gold`, and
  enlarged (4→6 px) when bagged — the bagged carrier's only other cue is a
  6×8 gem on the backpack, and the relic fix above made this marker
  load-bearing for the game's most important read.
- **Art must-fix 3 — no name labels over players** (art-spec §4.2.3 is
  normative and it was never implemented). Scene-level label per player
  (never a container child, so it can't inherit squash), text from the
  Session mirror, everyone in the lobby / remotes only in a run, hidden
  while a channel bar occupies the same y.
- **Minor:** FF-heavy and revive white flashes never rendered —
  `updatePlayerCosmetics` runs after the event drain and its unconditional
  `setTint` reset the `tintFill` in the same frame. `_whiteBlink` now
  stamps `_fxFlashUntil` and the cosmetics pass honours the deadline.
- **Minor:** Fx screen overlays sat at depth 90–99, below WorldHUD's 900,
  so the win wipe left the crosshair and prompt text lit on a black
  screen. Transition effects (tint, wipe) moved above 900; the escalation
  dim + vignettes deliberately stay BELOW it so prompts remain readable.
- **Nits:** Brute windup fist-rise never rendered (cosmetics rewrote fist
  positions every frame) — Fx now tweens a render-only `_fistLift` offset
  that cosmetics applies and decays; dead `bagged` branch removed from
  RelicEntity.

**Self-inflicted bug worth recording:** removing that dead `bagged` branch
deleted a variable still referenced five lines below. `npm run build`
PASSED anyway — Vite does not catch an undefined reference — and it would
have thrown every frame on a loose relic. Caught by grepping after the
edit. A green build is not verification; only the suites are.

## Verification

`npm run build` clean. `wp7-stun-drop-check.mjs` 4/4 and
`wp7-relic-visual-check.mjs` 6/6 green after all fixes, zero page
exceptions. **Final post-fix regression: `wp6-accept.mjs` 24/24 PASS,
exit 0** (`scratchpad/wp7-run-final.log`) — all 12 WP6 sections incl.
rejoin-ux, the full WP5 suite as a child, and the build. `wp5-accept.mjs`
also verified 10/10 standalone.

**Performance (QA, `scratchpad/wp7-perf.mjs`):** solo holds avg 60.0 fps /
16.6 ms median at idle, under load, and at escalation 1 AND 2, with zero
frames >33 ms; particles peak 167 against the 250 cap. 3-peer numbers
(29–41 fps) were decomposed rather than accepted: Phaser step+render stayed
FLAT at ~3.2→3.3 ms while the 8.5 ms delta landed entirely outside Phaser —
software rasterization of two full-screen alpha quads under `--disable-gpu`
with three browsers sharing one CPU. Headless numbers are a floor, not a
mid-laptop measurement; a real GPU playtest is still the acceptance gate.

**Leaks:** 4 full lobby→playing→results→lobby cycles with FX load re-applied
each cycle — GameScene children 96→96, UIScene 15→15, tweens 0→0, timers
0→0, texture keys 103→103 on host (102→102 on client). Bit-identical, not
merely stable. fps IMPROVES across cycles (warm-up, not decay).

## Test-infrastructure root cause (cost several failed runs — READ THIS)

Long suite runs kept dying: killed at 11 rows, then 1 row, then aborting
at startup with `timeout waiting for: host: menu ready`. Two wrong
diagnoses (an environment time cap; then a process-tree cleanup bug)
before the actual cause showed up in the vite log:

**The headless-Chrome user-data-dirs were being created INSIDE
`scratchpad/`, which is inside the vite-watched project tree.** Vite was
watching gigabytes of Chrome profile data and firing page reloads as the
browsers wrote to it (`page reload scratchpad/tmp-wp6a/c2/Default/
Extensions/.../viewer.html`). One mistake, three symptoms:

1. Each vite process ballooned to ~800 MB (watching GBs of profile data).
2. Four orphaned ones starved the box to 1.5 GB free of 16 GB, and the
   environment reaped every long run.
3. The game page was reloaded out from under the test before it could
   reach the menu — the final startup abort.

Fixes (scratchpad only — `vite.config.js` is a §7 non-negotiable and was
NOT touched):
- All 16 harnesses now put profiles in `os.tmpdir()`, not `HERE`.
- `scratchpad/tmp-*` deleted: **2.7 GB → 8.7 MB**.
- The runner script's `trap` kills the whole vite process TREE by
  command-line match; `kill $VITE_PID` only reaped the npx wrapper and
  left the real server running.

Lesson for future sessions: never point a browser profile, cache, or any
high-churn artifact at a path inside a dev-server-watched tree.

Also recorded: one wp5 run aborted with
`could not join room ... after 3 attempts (broker)`. That is the
documented public-PeerJS-broker flakiness (CLAUDE.md "best-effort",
~10-15% NAT failures), not a product fault — a straight retry went 10/10.

## Harness changes by QA (scratchpad only, product untouched)

- `wp5-accept.mjs` throw-catch: the in-page auto-catcher's interval
  self-cleared on the THROWER's held state, so it died before the catch
  could happen. Now stops only when the CATCHER holds it. Latent race that
  predated WP7.
- `wp5-accept.mjs` grapple-fish: a phase-dependent endpoint assertion
  (`gap < 60` on the last sample of a fixed window) replaced with a
  convergence assertion, after a diagnostic (`qa-fish-diag.mjs`) measured
  the post-contact damped oscillation (160→82→47→29→19→12→6→4 px,
  reproducible to ~2 px). The behavioural assertions proving the mass rule
  were untouched.

## Deferred (art director, mustFixInWp7 = false)

Escalation-1 per-player glow imperceptible at alpha 0.10 · no gold glow on
the bagged backpack · exit-portal rings never rotate/pulse · ready-zone
floor strip painted in gold · phase banner gold rather than ink · no floor
scuff on broken barriers, door debris from a single point · carried/loose
relic never bobs. Plus (tech director): board popup doesn't use
`toScreen()` (identity today — lobby is viewport-sized — but inconsistent
with the ready ring beside it); lose-screen confetti sits in GameScene so
it renders under the UIScene results panel (needs moving scenes, not a
depth tweak).

## Open items carried forward

1. The four WP5 design questions remain open (kite-bagging, session pacing
   vs the 8–10 min target, bagged-carrier zip as master key, escalation-2
   collapse still flag-only).
2. Escalation-2 platform collapse is still FLAG-ONLY; WP7 marks those
   platforms with a cracked tile and deliberately does not imply physics
   that doesn't exist.
3. Gamepad paths remain stub-verified only (headless Chrome has no Gamepad
   hardware).
4. A real mid-laptop GPU playtest is the outstanding performance gate.

## Follow-ups
- Build order is now COMPLETE (steps 1–13, WP1–WP7). Next is step 13's
  real work: tuning session length on the test map with human playtests —
  which is also what resolves the four open design questions.
