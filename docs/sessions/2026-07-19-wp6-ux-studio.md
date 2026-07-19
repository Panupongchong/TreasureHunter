# Session log — 2026-07-19 (part 2)

**Topic:** WP6 — UX screens: final menu, lobby arena UI + stand-to-ready, HUD,
results, tombstone-rejoin UX (build steps 11 + 12). Studio workflow, same
shape as WP3–WP5. Ran across two model sessions (Fable 5 → Opus 4.8) after
two usage limits; the workflow resume replayed cached agents.

## How it was built

7-agent workflow. `docs/plan/ux-spec.md` (673 lines, written in an earlier
planning session) was the UI-half authority below CLAUDE.md, so no creative
UX work happened here — only implementation.

1. **Pre-production** (parallel): *Technical UX Designer* turned the ux-spec
   into a build contract (every widget → its data source, plus the missing
   wire bits: hourglass taker slot, ping event, host-side award); *Systems
   Designer* spec'd the sim/net half.
2. **Production** (sequential): *Engineer #1* landed systems/net;
   *Engineer #2* built the UI half on top and smoke-checked it live.
3. **QA** (parallel): *Technical Director* (APPROVE_WITH_FIXES — 3 minors,
   3 nits), *UX Designer review* (SHIPPABLE_AFTER_DELTAS — 8 deltas, judged
   against 17 live screenshots), *QA Automation* (wrote `wp6-accept.mjs`,
   13 sections; hit the session limit mid-run — the producer finished it).

**Limit interruptions:** the first run died after Engineer #1 (4 agents
lost); `Workflow({scriptPath, resumeFromRunId})` replayed the three completed
agents from cache and ran the rest live. The second run lost only the QA
agent, whose partial artifacts (`wp6-accept.mjs`, `wp6-run1.log`,
`wp6-diag-rejoinerr.mjs`) survived on disk and were finished by the producer.

## What landed

- **systems/net:** `ReadyZoneSystem` (all-connected-in-zone 3 s → latched
  `READY_COMPLETE` → host phase broadcast; fill mirrored as world-row
  `rz`/`rzN`/`rzM`), `PingSystem` (aim-point markers, 500 ms rate limit),
  stage-board channel (host-only, between ritual and bag in the
  InteractSystem priority chain), host kick (LOBBY-only hard guard),
  FF plumbing (written once at session init, roster-mirrored),
  `TIME_GAIN.slot` (the WP4 hourglass-taker debt), host-computed
  "Most Ruinous Player" award, `purgeDisconnected` on results→lobby.
- **UI:** `ui/HUD.js` (+ `WorldHUD`), `LobbyUI`, `ResultsUI`, grown
  `Toasts`, `ui/nav.js` (FocusNav: keyboard + gamepad + prompt glyphs),
  UIScene as delegator, final MenuScene (menu tree, code entry, settings,
  connecting overlay + every §4.2 error, Rejoin-last-room, Exit hidden on
  web). All procedural, no asset files.
- P/R/L host debug keys preserved deliberately — the acceptance harnesses
  drive phases with them.

## Producer pass (fixes applied after the studio run)

- **REAL HANG (QA-caught, producer-diagnosed):** a stale-token rejoin
  rejected mid-run destroyed the `[ REJOIN LAST ROOM ]` button while
  FocusNav still listed it; `_applyState('join')` → `setEnabled(false)` →
  `_refresh()` → `setColor` on a destroyed Text threw
  (`TypeError: … 'drawImage'`) **out of the catch block**, so `_setError`
  never ran and the menu sat dead with an empty error line. Reproduced with
  the QA agent's `wp6-diag-rejoinerr.mjs`; fixed in `FocusNav._refresh`
  (drop destroyed items instead of styling them — protects every caller,
  not just this path). Both button-present and button-absent paths now show
  `RUN IN PROGRESS — CAN'T JOIN MID-RUN`, zero page exceptions.
- **Fabricated results on mid-results join:** welcome carries the phase but
  not the ResultsPayload, so `ResultsUI.show(null)` rendered a hardcoded
  "THE CALAMITY" — facts the host never sent (plan risk 8). Host now
  remembers `lastPhaseData` and replays the phase message after SYNC_DONE
  when phase is results; ResultsUI renders a neutral holding screen when it
  has no payload instead of inventing a verdict.
- **Cancel-then-retry race:** `ClientNet.close()` left the join timer armed
  and the promise unsettled, so an abandoned attempt could fire up to 10 s
  later and stomp a live one. Now settles the pending join on close, and
  MenuScene guards on the per-attempt `_netInFlight` identity rather than
  the shared `cancelled` flag (a new attempt reset that flag).
- **Gamepad softlock:** A on the Settings NAME row entered keyboard-only
  edit mode with no pad exit; now a no-op on pad (ux-spec §5 already says
  "keyboard to edit").
- **ESC during a run now needs a confirming second press** (2.5 s window,
  toast). A single host mis-press ended the run for all four players and
  there is no host migration.
- UX deltas landed: DUMMY nameplate on the lobby pen monster (§6.5 missing
  information), §3 join-screen backing panel, board prompt suppressed once
  its proximity popup is open (was ghosting through the panel), lobby toast
  baseline raised off the ready ring, ready countdown moved above the
  readout (players were covering it) and derived from `READY.holdMs`,
  FF-FULL toast now once per session not once per lobby entry, host-lag
  notice now covers the never-arrived case, focus marker gap 6→14 px.
- Harness fixes (not product): wp6's wp5-regression expected 11 in-script
  PASS rows but wp5's `build` row comes from its runner — corrected to 10;
  stale "bag-channel bug" wording removed from wp5 detail strings (that WP5
  bug was fixed last session; those tests seed the bagged state for setup
  speed).

## Verification

`npm run build` clean. **`scratchpad/wp6-accept.mjs`: all 24 rows PASS**
(`scratchpad/wp6-run2.log`) — 13 WP6 sections over the real PeerJS broker
with up to 4 browser instances, plus the full wp5 suite as a child process:
menu-journey (kb nav + code entry + bad-code error), menu-gamepad-nav
(stubbed pad object — real FocusNav paths), ready-zone-solo, lobby-3peers
(roster/code/furniture identical on all 3), stage-board (host cycles,
non-host locked), ready-zone (fill to 40 %, step-out resets on host AND
client, 3 s → playing on all 3), hud-playing (clock/noise/carry indicator/
ping marker + edge indicator), win-results, return-to-lobby (same code,
second run starts), lose-results, kick (credentials burned, re-join fresh
works), rejoin-ux (token rejoin to tombstone + the negative path),
wp5-regression 10/10, build.

Gamepad note: headless Chrome has no Gamepad hardware, so the pad test
stubs the pad object — FocusNav/`_updatePad` code paths are real, the
browser input layer is not. Real-hardware pad nav remains unverified.

## Open items carried forward

1. The four WP5 design questions are still open (kite-bagging, session
   pacing vs the 8–10 min target, bagged-carrier zip as master key,
   escalation-2 collapse still flag-only). None blocked WP6.
2. UX review deltas deliberately left for WP7: ready-ring `rz` lerp
   smoothing (steps at 20 Hz today).
3. ux-spec doc drift: the stage display name is `THE UNDERVAULT` in code vs
   `THE TEST VAULT` in the spec — doc edit, not a code delta.
4. `STAGES` has one entry, so the board cycle is a same-id wrap by design;
   the UI is built for more.

## Follow-ups
- **WP7 next: art & polish pass** (procedural textures, FX/juice, camera,
  HUD styling). STRICT: no gameplay/tuning/protocol changes.
- Nothing committed (user decision pending — WP1–WP6 all uncommitted).
