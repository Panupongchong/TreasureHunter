# Session log — 2026-07-18

**Topic:** WP1 — netcode core + phases (build step 3 + parts of 11/12), then
WP2 — player physics (see addendum at the bottom).
Continued a previous session that had produced `docs/plan/` and the first two
net files; this session completed both work packages.

## Context at start
- `docs/plan/implementation-plan.md` (WP1–WP7 contract) existed, untracked.
- `net/protocol.js` + `net/PeerTransport.js` done; `config.js` NET section and
  `net/Transport.js` interface done. `GameScene` still imported the removed
  `PLATFORMS`/`SPAWNS` exports, so the build was broken mid-refactor.

## What was done
1. **maps/** — `mapTypes.js` (data shape + `getMap`/`spawnFor`), `lobbyMap.js`
   (practice arena geometry), `testMap.js` (old arena copied from git history).
2. **sim/** — `Sim.js` (system list, entity collections, input + event queues),
   `snapshot.js` (players + world groups, status bits, `applySnapshot`),
   `stats.js` (stub RunStats + ResultsPayload), `events.js` (`applyEvent`
   registry — one presentation path for host/client/solo).
3. **net/** — `Session.js` (roster + phase machine + `claimSlot` with token
   takeover: a rejoining token evicts the stale link so refresh beats the 8 s
   heartbeat), `HostNet.js` (hello/welcome/reject, per-slot edge-OR input
   buffers, 20 Hz `setInterval` snapshots, heartbeats, world-replay hook),
   `ClientNet.js` (hello handshake, 30 Hz coalesced input, snapshot feed,
   heartbeat), `Interpolator.js` (geckos wrapper, 100 ms buffer).
4. **Scenes** — `GameScene` refactored to the three-mode contract (host/
   client/solo; movement is interim multi-player code that WP2 extracts into
   MovementSystem); `UIScene` + `ui/Toasts.js` skeleton (room code, roster
   strip, placeholder results overlay); `MenuScene` Host/Join(code entry)/Solo
   with connecting overlay + reject reasons. Placeholder phase keys: host
   P = start run, R = results, L = back to lobby.
5. **Verification** — `npm run build` clean. Wrote a CDP acceptance driver
   (`scratchpad/wp1-accept.mjs`, Node 22 built-ins, headless Chrome) that ran
   the full WP1 acceptance over the real PeerJS broker: host + join by code,
   client sees host movement via interpolated snapshots, lobby→playing→
   results→lobby phase sync on both peers, mid-run tab-refresh token rejoin
   reclaiming the same slot, host-close bouncing the client to menu, solo mode.
   **All checks passed.**

## Gotchas worth remembering
- Headless-Chrome testing needs **one Chrome instance per peer**: a second tab
  occludes the first, rAF stops, and Phaser's scene manager freezes (same
  mechanism as plan risk 7, host tab throttling).
- The 20 Hz snapshot timer outlives scene restarts — `GameScene` must null
  `net.getState` on shutdown or it serializes destroyed bodies.
- `window.game` is now exposed from `main.js` for debugging/acceptance tests.

## Addendum — WP2 (same session)

WP2 (player physics) completed on top of WP1:

1. **`entities/PlayerEntity.js`** — shared factory (host body / client view),
   cosmetics (facing eye, stun stars, over-head channel bar) driven purely
   from `.state` so host and client render through one path.
2. **Six systems** — `MovementSystem` (multi-player, input-buffer driven;
   speed mass = own + carried + riders, jump mass = own + carried; jump-off-
   head inherits 80% carrier velocity — the `vy >= -1` guard is what makes
   boost jumps apex-timed), `PvPCollisionSystem` (solid top / soft side via
   processCallback; ridersMass transmitted down the stack), `FallStunSystem`
   (safeHeight = base/mass, teammate-cushion split stun, `cancelFallStun`
   hook for WP3), `StunSystem` (`applyStun`/`revive` exposed; mash −250 ms
   per press), `InteractSystem` (generic channel resolver, revive 1.5 s,
   `requestChannel` exposed), `CarrySystem` (`grab`/`throwCarried`/
   `dropCarried`; carried body disabled + pinned above head).
3. **Config** — STUN mash/split/reviveRange, new PVP + CARRY sections.
   Snapshot: CARRIED status bit + real channel progress.
4. **Verified** (headless 2-instance acceptance, `wp2-accept.mjs`): side
   soft-push separation, stand-on-head + ridersMass, jump-off-head, 6 s fall
   stun with mash reduction visible on the client, 1.5 s revive channel with
   mirrored progress bar, carry (carrier slowed to exactly 130 px/s = the
   1/mass rule) + throw (inherited vx), teammate-cushion split stun
   (~1.2 s both). WP1 acceptance re-run clean as regression.

Extra gotcha: headless key taps need ≥150 ms hold — at low headless fps a
40 ms down/up fits inside one frame and the edge is never sampled.

## Follow-ups
- WP3 next: grapple system (zip + constant-force mass rule).
- Consider committing WP1+WP2 (user decision; nothing committed this session).
- Re-run `/graphify` to index the new modules.
