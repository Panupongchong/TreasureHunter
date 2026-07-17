# CLAUDE.md — Vaultbreakers (working title)

## What this is

A 4-player co-op online 2D platformer: raid a dungeon, steal the relic, escape
before the calamity. One shared win/lose. Sessions 10–15 minutes.
Tone: Overcooked/Moving Out chaos on a Clank-style push-your-luck raid.
Currently in prototyping phase. Target platform: PC (web now, Steam later).

## Locked decisions — do NOT relitigate

| Area | Decision |
|---|---|
| Engine | **Adopt Phaser 3** (2D physics, input, scenes). Migrate off vanilla canvas |
| Networking | PeerJS (free public broker), star topology, 4-letter room codes |
| Physics authority | **Host-authoritative.** Host simulates all physics; clients send inputs, render interpolated state |
| Grapple traversal | **Zip-only** (reel to point, detach). No rope swing in prototype |
| Grapple aim | Mouse = free aim. Gamepad = **soft aim-assist** (magnetize to players/monsters/relic; raw aim for terrain) |
| Lose condition | **Clock only.** No death, no party-wipe state |
| Prototype weapons | **Hammer + dagger** only (bow, chain-blade later) |
| Prototype monsters | **Skulker + Brute** only (Screecher, Lurker, Snatcher later) |
| Mid-run join | **No.** But disconnected players can REJOIN (tombstone system, below) |
| Stacked weight | Transmits down (carrier on your head slows you) |
| Hoist force | Constant force (tractor-beam), not reel-in |
| Fall stun | Threshold scales with mass: safeHeight = base / mass |
| Relic on stun | Dropped (if in hands) + noise burst; safe if bagged |
| Deployment | GitHub Pages for prototype (HTTPS required by WebRTC) |

## Physics core — the one rule everything composes from

**Mass-based grapple.** Grapple attaches to ANYTHING. It applies equal-and-
opposite constant force to both ends; each body accelerates by force/mass.
No special cases.

- Terrain = infinite mass → grappler zips to it (traversal)
- Multiple grapplers on one target SUM force → team hoisting emerges
  (e.g. 2 players uphill easily haul up a relic carrier)
- Equal masses pull together and meet in the middle

**Mass table (player = 1.0):**
player 1.0 · relic 1.0 · player carrying relic 2.0 · Skulker 0.5 ·
Brute 3.0 · terrain/doors ∞
(Later: Screecher 0.4, Snatcher 0.7, Lurker 0.8)

**Weight affects movement:** speedMult = 1/mass, jumpMult = 1/sqrt(mass).
Relic carrier: 50% speed, ~70% jump. Stacked players transmit weight downward.

**Boost jump = collision, not a mechanic:** players are platforms to each
other (top contact solid, side contact soft-push). Top player inherits ~80% of
carrier velocity; apex-timed successive jumps stack for big height. Pure skill.

## Player kit — 8 verbs

move · jump (hold = higher) · attack · grapple (aim + fire) ·
interact (hold/channel) · grab/carry/throw · sprint/dodge · ping (marker)

**Bindings:** Gamepad: L-stick move, A jump, X attack, R-stick aim,
RT grapple, Y interact, B grab/throw, LB sprint, R3 ping.
KB/M: AD move, Space jump, LMB attack, mouse aim, RMB grapple, E interact,
F grab, Shift sprint, Q ping.
**Route ALL input through an abstraction layer** (input.jump etc.) — enables
gamepad + future local co-op without rewrites. Use the browser Gamepad API.

**Weapons (noise-vs-power axis):**
- Dagger: quiet, weak, fast. Safe near teammates
- Hammer: loud, strong, can smash doors (its gimmick). Hazard to teammates

## Friendly fire & body blocking

- FF on: light hits shove/stagger teammates; heavy hits (hammer) can stun.
  ~50% damage baseline; lobby toggle for full FF
- Players are solid to each other → corridors clog, body-blocking monsters in
  chokepoints is a tactic. Soft-push on side contact avoids stuck states
- Knocking teammates across gaps with attacks is allowed (noisy, costly, funny)

## Stun system — no death

Stun sources: monster hits / heavy FF, and falls beyond safe height
(scaled by mass). Grappling mid-fall cancels fall stun. Landing on a teammate
splits impact (both briefly stunned).

Stunned player = inert 1.0-mass physics body: can't act, drops hand-held
relic (noise burst), CAN be grappled/hauled/thrown by teammates (rescue = the
existing mass rule, zero new code). Recovery: ~6s self (mash to reduce) or
teammate channels Interact 1.5s.

Stuns never kill — they cost TIME (recovery + rescue detours). Everything
funnels into the one clock.

## Relic handling

Relic mass 1.0; carrier becomes 2.0. Two carry states:

| | In hands | In bag |
|---|---|---|
| Pickup | instant grab | channel ~3s (interruptible by damage) |
| On stun | dropped + noise | secure |
| Throw / grapple-transfer | yes | no (unbag first, ~2s channel) |
| Attack/grapple while holding | no | yes |

Transfers: throw relic + teammate grapple-catches mid-air. Loose relic can be
grapple-fished (1.0 vs 1.0 = both slide). Bag stow/unstow makes small noise so
cautious play still feeds the gauge.

## Two pressure systems

**Clock (strategic).** ~12-min countdown; zero = calamity = loss (only loss).
ONLY movement shortcuts cost time: smash door −20s, blast rubble −25s,
break shortcut −15s, kick bridge −10s. Every barrier has loud/fast/costly vs
quiet/slow/free (often co-op) alternatives. Smash cost ≈ 1.5–2× the quiet
alternative's duration. Time earnable: hourglass pickups +30s in risky rooms,
one 4-player ritual +60s. Dungeon escalates by time REMAINING (<6 min lights
dim, <3 min floors collapse; later: <2 min Warden hunts).

**Noise gauge (tactical).** Fills from: attacks (small), grapple impacts
(small), sprint (tick/s), hard landings, door smashes (large — costs time AND
noise), bag stow (small), fighting (medium). Full gauge → monster spawns near
the noise, gauge halves. Decays slowly when quiet. Monsters are a loudness
tax, not bosses; counter-play is disengaging.

## Monsters (prototype: first two only)

1. **Skulker** (0.5): fast weak melee chaser. Default spawn. Grapple-yank it
   into your hammer
2. **Brute** (3.0): heavy — grappling it pulls YOU in. Blocks corridors,
   smashes doors (ruins quiet routes). Counter: bait into pits, or multiple
   players tug-of-war it
Later: Screecher (screams → dumps noise), Lurker (cuts grapples at anchors),
Snatcher (steals loose relic, drags stunned players).

## Tombstone rejoin

No mid-run join for new players. But a DISCONNECTED player leaves a tombstone
at their position; their hand-held relic drops (bagged relic stays at the
tombstone, reclaimable by teammates via channel). If they reconnect to the
same room during the run, they respawn at their tombstone. Host keeps their
slot reserved.

## UX / journey

menu → connecting → lobby → playing → results → lobby | menu
(host broadcasts phase transitions: {t:"phase", ...}; clients follow)

- **Main menu:** Host / Join / Settings (binds, volume, name, FF toggle) /
  Exit (hidden on web)
- **Lobby = playable practice arena** (dummy monster, smashable door, grapple
  anchor, boost ledge). Same netcode as gameplay — it's just a level.
  Leader picks stage at an interactable board, can kick.
  **Ready = everyone stands in the vault-entrance zone 3s** (visible fill
  ring; stepping out cancels)
- **Gameplay:** spawn at vault entrance, short banner, clock starts, no
  control lockout. Host disconnect mid-run = run ends → menu (no migration)
- **Results:** win/lose + reason; team stats (escape time, treasure, time
  left); per-player comedy stats (doors smashed / time cost caused, noise
  made, FF dealt, teammates thrown). "Most Ruinous Player" award.
  Buttons: Return to lobby (room + code persist) / Exit

## Networking architecture / netcode stack (decided)

- **Stay on PeerJS** (free public broker), star topology; joiners connect to
  host by room code (peer ID prefix `pfproto-` + 4-letter code).
  No server-based framework (Colyseus etc.) for the prototype
- **Host-authoritative:** clients send input frames; host simulates ALL
  physics (players, monsters, relic, grapples, stuns) and broadcasts world
  snapshots ~20 Hz
- **Client rendering: use `@geckos.io/snapshot-interpolation`** (npm) —
  transport-agnostic snapshot buffer + interpolation library; works over
  PeerJS data channels. Clients render interpolated snapshots ~100ms behind
  host time
- **NO client-side prediction in v1** — decided. Inputs go to host, players
  render from snapshots. At friend-scale pings (20–60ms) this is acceptable
  for a co-op platformer. Revisit ONLY if playtests feel mushy; if added
  later, predict local movement only (Gambetta's "Fast-Paced Multiplayer"
  articles are the reference)
- Reconnect/ownership is hand-rolled and intentionally simple: host owns all
  state; tombstone rejoin (see above) is the reconnect model; host keeps a
  reserved slot keyed to a per-run player token so a reconnecting peer (new
  peer ID) can reclaim it
- Keep transport isolated behind a small interface (connect/send/receive) —
  Steam release will swap PeerJS → Steam Networking without touching game
  code. Escape hatch if P2P netcode becomes painful: Colyseus (the
  host-authoritative code maps ~1:1 from player-host to Node room, and it has
  built-in reconnection), at the cost of hosting a small server

## Tuning defaults (v1, all adjustable)

12-min clock · smash −20s · noise gauge ≈ 10 loud actions to spawn ·
stun 6s · hoist = constant force, +100% per extra grappler ·
velocity inheritance on stacks 80% · FF damage 50%

## Build order

1. ~~Phaser 3 project scaffold; port current platformer (movement, platforms)~~ DONE
2. ~~Input abstraction layer (KB/M + Gamepad API)~~ DONE (src/input/InputManager.js)
3. Host-authoritative netcode: input up, snapshots down;
   client interpolation via @geckos.io/snapshot-interpolation (no prediction)
4. Player-vs-player collision (solid top / soft-push side) → boost jump
5. Mass system: speed/jump multipliers, fall-stun threshold
6. Grapple (zip to terrain; force rule for dynamic bodies; multi-grapple sum)
7. Clock + smash/pick doors + one 2-player crank gate
8. Relic: carry, throw, grapple-catch, bag channels, stun-drop
9. Stun + rescue (grapple/carry stunned bodies)
10. Noise gauge + Skulker spawning; then Brute
11. Lobby arena + stand-to-ready + phase state machine
12. Results screen + stats; tombstone rejoin
13. Tune session length on a single test map

## Known limitations / deferred

PeerJS public broker is best-effort (self-host: `npx peerjs --port 9000`) ·
no TURN yet (~10–15% NAT failures; add Open Relay if friends can't connect) ·
WebRTC needs HTTPS (GitHub Pages OK; sandboxed previews won't work) ·
no host migration · monsters 3–5, bow/chain-blade, swing-grapple, room
browser (needs small backend), Steam wrap (Electron/Tauri + Steamworks) all
deferred.

## Tooling

### RTK (Rust Token Killer)
RTK is installed globally (`rtk 0.42.4`, `~/.local/bin/rtk`) and is applied
automatically to dev commands in this project via the Claude Code hook — no
per-project install needed. See `~/.claude/RTK.md` for the command reference.

- `rtk gain` — show token savings analytics
- `rtk discover` — find missed optimization opportunities in Claude Code history
- `rtk proxy <cmd>` — run a raw command without filtering (debugging)

### graphify
Turn this codebase into a queryable knowledge graph. Run `/graphify` to
(re)index; results are written to `graphify-out/` and can be queried,
path-traced, and explained. Treat codebase/architecture questions as graphify
queries when `graphify-out/` exists.

## Session history
Human-readable logs of notable Claude Code sessions live in `docs/sessions/`.
