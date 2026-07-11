# CLAUDE.md — Peer Platformer

## What this project is

A 4-player multiplayer 2D platformer prototype that runs entirely in the browser.
Built as a single file (`index.html`) with no build step and no backend.
Currently in the prototyping phase — the goal is easy playtesting with friends,
not production infrastructure.

## Architecture decisions (already made — don't relitigate)

- **Networking: PeerJS (WebRTC data channels)** using the free public PeerJS
  cloud broker for signaling. Chosen for zero cost and zero backend during
  prototyping. Raw WebRTC was rejected as too low-level for this phase.
- **Topology: star / host model.** One player hosts and is the relay; up to 3
  joiners connect to the host. Chosen over full mesh for simpler state
  management at 4 players. If the host leaves, the game ends (no host
  migration yet — acceptable for prototype).
- **Rooms: 4-letter invite codes**, registered on the PeerJS broker as peer IDs
  with the prefix `pfproto-` (e.g. room `ABCD` → peer ID `pfproto-ABCD`).
  There is deliberately NO public room list; joining requires knowing the code.
- **State sync:** each client simulates its own player locally (client-side
  physics) and broadcasts position/velocity/facing at 20 Hz (`TICK_MS = 50`).
  The host relays every player's state to everyone else. Remote players are
  smoothed with simple lerp (factor 0.35). No authoritative server, no
  anti-cheat — fine for friends. Disconnect detection is heartbeat-based:
  a remote player is removed after 3s without a state update (`DROP_MS`),
  because WebRTC `close` events are too slow/unreliable to rely on.
- **Deployment: GitHub Pages.** Static hosting is sufficient; it also provides
  the HTTPS that WebRTC requires. The PeerJS public server + Google's default
  STUN handle NAT traversal. No TURN server configured yet.

## Current implementation (index.html)

- Canvas game, 900×540 bounded arena with walls, ceiling, floor, and ~7
  floating platforms (`PLATFORMS` array of [x, y, w, h]).
- Physics: gravity 0.55, jump -11.5, max horizontal speed 5.2, friction 0.82,
  AABB collision resolved per-axis (horizontal then vertical).
- Player: 26×34 rect, 4 spawn points, 4 fixed colors, name label above head,
  eye pixel indicates facing.
- Input: keyboard (arrows / WASD / Space) AND touch. On-screen buttons
  (◀ ▶ ▲) appear automatically on touch devices via
  `matchMedia("(pointer: coarse)")`; they write into the same `keys` object as
  the keyboard. Pinch-zoom and scroll are disabled during play.
- Lobby UI: name input, "Create room (host)" → shows 4-letter code (click to
  copy), or enter code + "Join room". Handles: room full (max 4), room not
  found, host disconnect (reloads page), 8s join timeout.
- Message protocol (`t` field): `hello` (joiner→host), `welcome` (host→joiner,
  includes full roster), `full`, `s` (state update, relayed), `leave`.

## Known limitations / gotchas

- PeerJS public broker is rate-limited and best-effort; if flaky, self-host
  signaling with `npx peerjs --port 9000`.
- ~10–15% of connections can fail NAT hole-punching (symmetric NAT, strict
  firewalls, some mobile carriers). Fix = add a TURN server (e.g. Open Relay
  free tier) to the Peer `config.iceServers`. Deliberately deferred.
- WebRTC requires HTTPS (or localhost) — GitHub Pages satisfies this. The
  game cannot be tested in sandboxed iframes/previews that block WebSockets.
- Mobile browsers throttle background tabs; a backgrounded player freezes.
- No host migration, no reconnect logic, no server-side validation.

## Possible next steps (not yet decided)

- Player-vs-player collision, or a simple objective (tag, coin race)
- In-game chat
- Public room browser (would require a tiny backend, e.g. Firebase Realtime
  Database free tier, to list active room codes — gameplay stays P2P)
- TURN fallback for players behind strict NATs
- Host migration

## Conventions

- Keep everything in a single `index.html` for now (easy GitHub Pages deploys).
- No frameworks, no bundler — vanilla JS + PeerJS from cdnjs.
- Test flow: two tabs on localhost first, then GitHub Pages URL with a phone.
