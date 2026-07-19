# Session log — 2026-07-18 (part 2)

**Topic:** WP3 — grapple system, built with a game-studio-structured subagent
workflow (user-requested). Same day as the WP1/WP2 session log.

## How it was built

A 5-agent workflow with studio roles, orchestrated via the Workflow tool
(main session acted as producer):

1. **Pre-production** (parallel): a *Physics Programmer* spec'd
   `GrappleSystem.js` (attach raycast, zip steering, force-as-acceleration
   integration, detach matrix D1–D9, aim assist, config constants) while a
   *Presentation/Netcode Engineer* spec'd everything outside it (snapshot
   `grapples` group, one-path beam rendering, EV registry, interpolation
   edge cases — including statically verifying geckos is safe with
   empty-but-present group arrays).
2. **Production:** a *Senior Gameplay Engineer* implemented from both specs
   (physics spec wins simulation conflicts, presentation spec wins wire/
   render conflicts); all deviations recorded.
3. **QA** (parallel): a *Technical Director* reviewed the diff against the
   locked decisions (verdict: APPROVE, 4 minor findings) while a *QA
   Automation Engineer* wrote and ran `scratchpad/wp3-accept.mjs` — a
   3-browser-instance headless suite over the real PeerJS broker.

## What landed

- `src/systems/GrappleSystem.js` — THE mass rule: terrain zip
  (velocity-steered, gravity off while zipping, restore on every detach
  path), dynamic targets via equal-and-opposite `pullForce/mass` integrated
  as `velocity += (F/m)*dt` through a per-body force-accumulation map
  (multi-grapple summing automatic), caps `maxPullAccel`/`maxPullSpeed`,
  host-side gamepad aim assist (magnetize dynamic targets only), exports
  `canFireGrapple` (WP5 gate), `grapplesOn`, `detachAll`, `detachGrapple`.
- `sim.grapples` beam mirror → snapshot `grapples` group (`g<slot>`,
  x/y/tx/ty; always present, even empty) → client beams drawn purely from
  interpolation in GameScene's one `_drawBeams` path.
- EV: `grappleAttach`, `grappleDetach` (reason set), `noiseBurst`
  (WP4's NoiseSystem consumes it — do NOT also hook the emit site).
- Producer fixes after review: corrected the `maxPullAccel` comment
  (sub-1.0 masses CAN clip — WP4 tuning note inline) and pinned the
  monster-id contract in `dynamicTargets` (Map key IS the wire id).

## Verification

- QA suite (all 6): zip+arrive, fall-stun cancel (with stunning control
  case), equal-mass convergence (symmetric ±185px), force summing measured
  at ratio 1.93≈2× with a 3rd joined client, client beam row + rendering,
  stun→detach propagating to client snapshots.
- WP1 + WP2 suites re-run clean as regression; `npm run build` clean.

## Accepted-as-designed / deferred to WP7 FX

- Beam pop-in/out up to ~100 ms on attach/detach (geckos omits entities
  missing from one bracketing snapshot).
- Retarget within one snapshot interval sweeps the beam tip on clients.
- Beam start can lead the interpolated body by ≤1 snapshot right after
  attach (WP7: override start with interpolated player position).

## WP4 must-dos recorded by the specs
- Extend `_terrainRects()` with intact-door bounds; call
  `detachAll(sim, doorId, 'targetGone')` on door break.
- NoiseSystem consumes `noiseBurst` events (not the grapple emit site).
- Revisit `maxPullAccel` for light monsters (see config comment).

## Follow-ups
- WP4 next: clock, doors, noise, monsters, weapons, FF.
- Nothing committed (user decision pending).
