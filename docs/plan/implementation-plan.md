# Vaultbreakers — Implementation Plan

> Contract for the six downstream work packages (plus polish). CLAUDE.md is the
> design authority; if this doc and CLAUDE.md ever disagree, CLAUDE.md wins.
> Steps 1–2 of the build order (Phaser port, input abstraction) are DONE.
> This doc covers steps 3–13, grouped into 7 work packages (WP1–WP7).
>
> Stack: Phaser 3 + Vite + PeerJS + @geckos.io/snapshot-interpolation.
> Plain JS ES modules. NO TypeScript. NO new dependencies. All art procedural.

---

## 1. Module layout under `src/`

Every file below is normative — create it where listed, with the stated
responsibility. Existing files marked `(exists)`.

```
src/
  main.js                 (exists) Phaser bootstrap; registers all scenes
  config.js               (exists) ALL tuning constants; grows every WP
  net/
    Transport.js          (exists) abstract transport seam (connect/send/close)
    PeerTransport.js      PeerJS implementation of Transport; owns Peer object,
                          room-code peer IDs (`pfproto-` + 4 letters), the two
                          data connections per peer (reliable + unreliable),
                          reconnect attempts. NOTHING outside net/ imports peerjs.
    protocol.js           Message type constants (MSG.*), message factory
                          functions, protocol version, channel routing table
                          (which MSG goes reliable vs unreliable), InputFrame
                          pack/unpack (full frame <-> compact wire form)
    Session.js            Roster + phase state machine, shared by host & client:
                          slots (0..3), names, per-run tokens, connected flags,
                          tombstones, FF toggle, chosen stage. Host mutates it;
                          clients mirror it from roster/phase messages
    HostNet.js            Host loop: accepts joiners, validates hello, assigns
                          slot+token, handles tombstone rejoin, buffers latest
                          InputFrame per slot, broadcasts snapshots at 20 Hz,
                          broadcasts phase/roster/event messages
    ClientNet.js          Client loop: sends hello + input frames (30 Hz,
                          edge-coalesced), feeds snapshots into Interpolator,
                          surfaces phase/roster/event messages to the scenes
    Interpolator.js       Thin wrapper around @geckos.io/snapshot-interpolation:
                          one SnapshotInterpolation instance, 100 ms buffer,
                          calcInterpolation calls per state group, latest-value
                          reads for non-interpolated fields
  sim/
    Sim.js                Host/solo authoritative simulation orchestrator. Owns
                          entity collections, calls every system in fixed order
                          each tick, produces events, tracks run stats
    snapshot.js           serializeWorld(sim) -> snapshot state object;
                          applySnapshot(scene, interpolated) on the client.
                          The ONLY place that knows the wire shape of entities
    stats.js              RunStats accumulator (doors smashed, time cost caused,
                          noise made, FF dealt, teammates thrown, stuns, etc.)
  systems/                Pure host-side logic, one system per file. Each is
                          `update(sim, dt)` plus event handlers. No rendering.
    MovementSystem.js     applies InputFrames to player bodies: accel/friction,
                          jump buffer/coyote/variable height, sprint, mass
                          speed/jump multipliers, facing
    PvPCollisionSystem.js player-vs-player: solid top contact (players are
                          platforms), soft side push, 80% velocity inheritance,
                          stacked-weight transmission down the stack
    FallStunSystem.js     tracks fall distance per body, safeHeight = base/mass,
                          fall-stun on hard landing, landing-on-teammate split,
                          grapple-cancels-fall-stun hook
    StunSystem.js         stun state timers, mash-to-recover, teammate 1.5 s
                          revive channel, stunned = inert 1.0-mass body,
                          relic drop + noise burst on stun
    GrappleSystem.js      zip-to-terrain, constant-force rule on dynamic
                          bodies (force/mass as ACCELERATION, see §6), multi-
                          grapple force summing, attach/detach, aim assist
                          resolution (gamepad), max range, beam state for wire
    CombatSystem.js       hammer + dagger attacks, hit arcs, damage/shove/stun,
                          friendly fire (50% baseline, lobby full-FF toggle),
                          monster damage, attack noise events
    CarrySystem.js        grab/carry/throw verb: pick up loose relic or stunned
                          teammate, throw arcs, carried-body attachment
    RelicSystem.js        relic state machine (loose/held/bagged/flying),
                          bag/unbag channels, grapple-catch mid-air, carrier
                          mass update, escape objective check (exit zone)
    ClockSystem.js        countdown, time costs (smash/blast/etc.), hourglass
                          +30 s, 4-player ritual +60 s, escalation triggers at
                          <6 min and <3 min, calamity = lose
    NoiseSystem.js        gauge fill/decay, full-gauge -> monster spawn near
                          noise centroid + gauge halves
    DoorSystem.js         doors/barriers: smash HP vs quiet channel progress,
                          2-player crank gate, time-cost + noise on smash,
                          Brute door-smashing entry point
    MonsterSystem.js      Skulker + Brute AI (chase/attack/blocked states),
                          spawner (called by NoiseSystem), monster stun,
                          pit-death for baited Brutes
    InteractSystem.js     generic hold-to-channel resolver (revive, pick door,
                          crank, bag/unbag, tombstone relic reclaim, ritual,
                          lobby stage board); one channel per player at a time
    ReadyZoneSystem.js    lobby only: everyone-in-zone 3 s fill ring -> tells
                          Session to start the run
  entities/               Factories that create Phaser GameObjects + arcade
                          bodies + attach the `.state` blob defined in §4.
                          Same factory used by host (with body) and client
                          (visual-only, body disabled).
    PlayerEntity.js
    RelicEntity.js
    MonsterEntity.js      Skulker + Brute variants (type field)
    DoorEntity.js         all barrier types incl. crank gate
    PickupEntity.js       hourglass, ritual altar
    TombstoneEntity.js
  maps/
    mapTypes.js           map data shape doc + helpers (spawn/exit/zone defs)
    lobbyMap.js           practice arena: dummy monster, smashable door,
                          grapple anchor, boost ledge, ready zone, stage board
    testMap.js            the single tuning map: entrance, relic vault, exit,
                          one of each barrier type, hourglass rooms, ritual,
                          pit for Brute-baiting
  scenes/
    MenuScene.js          (exists) grows: Host / Join(code entry) / Settings
                          (binds view, volume, name, FF toggle) / Exit;
                          connecting overlay with cancel
    GameScene.js          (exists) becomes THE gameplay scene for lobby AND
                          run, in three modes (§3). Wires input->net->sim->
                          render. No game rules live here — systems only
    UIScene.js            HUD overlay scene running parallel to GameScene:
                          delegates to ui/ components
  ui/
    HUD.js                clock, noise gauge, weapon/carry icons, channel
                          bars, ping markers, phase banner
    LobbyUI.js            roster panel, room code display, ready ring
                          rendering, stage board popup, kick buttons (host)
    ResultsUI.js          win/lose + reason, team stats, per-player comedy
                          stats, "Most Ruinous Player", Return-to-lobby / Exit
    Toasts.js             transient messages (join/leave/rejoin, time costs)
  fx/
    textures.js           ALL procedural texture generation (generateTexture
                          from Phaser Graphics) — players, relic, monsters,
                          tiles, particles. One `ensureTextures(scene)` entry
    Fx.js                 juice: particles, screen shake, stun stars, noise
                          ripple, grapple beam rendering, door debris,
                          escalation tinting (lights dim, collapse warnings)
  input/
    InputManager.js       (exists) unchanged interface; WP3 adds aim-assist
                          candidate query hook
```

---

## 2. Network protocol

### 2.1 Transport channels

`PeerTransport` opens **two PeerJS DataConnections** per host<->joiner pair,
distinguished by label:

| Label | Options | Carries |
|---|---|---|
| `ctl` | `{ label:'ctl', reliable:true, serialization:'json' }` | hello, welcome, roster, phase, event, kick, reject, ping-marker |
| `st` | `{ label:'st', reliable:false, serialization:'json' }` | `input` (client→host), `snap` (host→client) |

The joiner opens both connections to the host peer. Host peer ID =
`pfproto-<CODE>` where CODE is 4 uppercase letters (A–Z, no ambiguous set
needed — letters only). Joiner peer IDs are random (PeerJS default).

Every message is a JSON object with a `t` field (type). `protocol.js` exports
`MSG = { HELLO:'hello', WELCOME:'welcome', ... }` plus `makeX(...)` factories
so shapes exist in exactly one file.

### 2.2 Message catalog

**Client → Host**

| `t` | Channel | Fields | Notes |
|---|---|---|---|
| `hello` | ctl | `v` (protocol version int), `name` (string ≤16), `token` (string or null) | First message after both channels open. `token` null = fresh join; non-null = tombstone rejoin claim |
| `input` | st | `seq` (uint), `f` (packed InputFrame, §2.5) | ~30 Hz. Host keeps highest `seq` only |
| `bye` | ctl | — | polite leave (also inferred from connection close) |

**Host → Client**

| `t` | Channel | Fields | Notes |
|---|---|---|---|
| `welcome` | ctl | `slot` (0–3), `token` (8-hex string), `phase`, `roster`, `ffFull` (bool), `stageId`, `hostTime` (ms) | Accepts the join. Token is the per-run identity (§2.6) |
| `reject` | ctl | `reason` (`'full'`,`'in-run'`,`'version'`,`'bad-code'`) | then host closes the connections |
| `roster` | ctl | `players: [{slot, name, connected, isHost}]`, `ffFull`, `stageId` | Broadcast on any roster/settings change |
| `phase` | ctl | `phase` (`'lobby'`\|`'playing'`\|`'results'`), `data` | §2.4. `data` for playing = `{stageId, clockMs}`; for results = full stats payload |
| `event` | ctl | `kind`, `...payload` | Discrete authoritative facts clients must not miss: `spawn`/`despawn` (any entity: id, etype, x, y, fields), `stun`, `revive`, `relicState`, `doorState`, `monsterSpawn`, `timeCost` {amount, cause, slot}, `timeGain`, `noiseBurst` {x,y,amount}, `pingMarker` {slot,x,y}, `escalation` {level}, `tombstone` {slot,x,y}, `rejoined` {slot} |
| `snap` | st | geckos snapshot (§2.5) | 20 Hz while phase ∈ {lobby, playing} |
| `kick` | ctl | — | then host closes the connections |

Rule: **entity lifecycle is event-driven** (`spawn`/`despawn` on ctl),
**entity motion is snapshot-driven** (st). A client that has a snapshot row
for an unknown id ignores it until the spawn event arrives (ctl is ordered, so
this is a sub-frame race at worst).

### 2.3 Phase state machine

Phases: `menu → connecting → lobby → playing → results → (lobby | menu)`.

- `menu` and `connecting` are **local-only** phases (no host exists yet /
  no welcome yet). `Session.phase` starts at `menu`.
- `lobby`, `playing`, `results` are **host-owned**. Only `HostNet` may
  transition between them, and every transition is broadcast as
  `{t:'phase', phase, data}` on ctl. Clients set their local phase ONLY when
  this message (or `welcome`) arrives — never speculatively.
- Transitions:
  - `lobby → playing`: ReadyZoneSystem reports all connected players held the
    vault-entrance zone 3 s. Host broadcasts phase `playing`, all peers
    restart GameScene with `stageId` map; clock starts on scene create,
    no control lockout (short banner only).
  - `playing → results`: win (relic through exit zone) or lose (clock zero).
    `data` carries the full ResultsPayload (reason, team stats, per-player
    stats, award) so clients need no other source.
  - `results → lobby`: host presses "Return to lobby"; room + code persist.
  - Host disconnect at any phase: clients detect ctl close → destroy session
    → `menu` with a toast. No host migration.
  - Joiner disconnect during `playing`: tombstone (§2.6). During `lobby`:
    slot freed, roster broadcast.
- Mid-run join: a `hello` with null token while phase is `playing` gets
  `reject {reason:'in-run'}`.

### 2.4 Tick rates & timing

- Host sim: every Phaser update, dt clamped to ≤ 50 ms.
- Snapshots: fixed 50 ms timer (20 Hz), only in lobby/playing.
- Client input send: 30 Hz timer. Between sends the client **coalesces edge
  flags with OR** (a `jump` edge sampled at 60 Hz render must not be lost by
  the 30 Hz sender) and sends the latest analog values.
- Host applies, per slot, the most recent InputFrame every sim tick; edge
  flags are consumed once then cleared on the buffered frame.
- Snapshot `time` = host `performance.now()`; geckos uses it directly. No
  separate clock-sync handshake — snapshot-interpolation is wall-clock-free
  on the client side (it interpolates between received snapshot times).

### 2.5 Wire formats

**Packed InputFrame** (`protocol.js` `packInput` / `unpackInput`):

```js
// f = [moveX, buttons, aimX, aimY]
// moveX: rounded to 2 decimals
// buttons: bitmask — 1 jump(edge) 2 jumpHeld 4 sprint 8 attack(edge)
//          16 grapple(edge) 32 grappleHeld 64 interact 128 grab(edge)
//          256 ping(edge) 512 usingGamepad
// aimX/aimY: mouse = world px (rounded ints); gamepad = unit dir * 1000
```

**Snapshot** (host builds via `sim/snapshot.js`, wraps with
`SI.snapshot.create(state)`):

```js
state = {
  players:  [{ id:'p0', x, y, vx, vy, face, m,        // m = mass*10 int
               st,        // status bits: 1 stunned 2 onGround 4 carryingHands
                          // 8 carryingBag 16 channeling 32 sprinting 64 carried
               ch }],     // channel progress 0..100 (0 when none)
  monsters: [{ id:'m12', x, y, vx, vy, face, hp, ai }], // ai: state enum int
  relic:    [{ id:'relic', x, y, vx, vy, rs }],  // rs: 0 loose 1 held 2 bagged 3 flying
  grapples: [{ id:'g0', x, y, tx, ty }],         // beam start (owner) and tip
  world:    [{ id:'w', clock, noise, esc }],     // ms left, 0..100, escalation lvl
}
```

- Interpolated fields (client `calcInterpolation`): `x y` on `players`,
  `monsters`, `relic`; `x y tx ty` on `grapples`.
- Everything else is read as latest-value from the newest vault snapshot.
- Ids are strings: `p<slot>`, `m<n>`, `g<slot>`, `relic`, `w`. Doors,
  pickups, tombstones are NOT in snapshots — they only change via `event`
  (`doorState`, `spawn`/`despawn`, `tombstone`), which keeps snapshots small.

**Interpolator.js (client)**:

```js
import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation';
const SI = new SnapshotInterpolation(20);      // 20 = server snapshot Hz
SI.interpolationBuffer.value = 100;            // LOCKED: 100 ms buffer
// per snap message:        SI.snapshot.add(snap)
// per render frame:        SI.calcInterpolation('x y', 'players') etc.
// latest non-lerped state: SI.vault.get()?.state
```

### 2.6 Per-run player token & tombstone rejoin

- On accepting a fresh `hello`, host generates `token = 8 random hex chars`
  and includes it in `welcome`. Host stores `slotInfo[slot] = { token, name }`
  for the whole run — the slot stays reserved even after disconnect.
- Client stores the token in memory AND
  `sessionStorage['vb-token-' + roomCode]` (survives an accidental tab
  refresh).
- On joiner disconnect during `playing`: host spawns a tombstone entity at
  the player's position (`event tombstone`), drops hand-held relic (noise
  burst), keeps bagged relic at the tombstone (teammates reclaim via
  channel), marks roster entry `connected:false`.
- Rejoin: same client (new PeerJS peer ID) reconnects to the room and sends
  `hello` with the stored token. Host matches it against reserved slots →
  sends `welcome` with the SAME slot, current phase `playing`, then replays
  the current world as events (spawn events for all live entities, current
  door states) followed by normal snapshots; player respawns at the
  tombstone, tombstone despawns. Wrong/unknown token during `playing` →
  `reject {reason:'in-run'}`.

---

## 3. Simulation architecture

### 3.1 One GameScene, three modes

`GameScene` is started with `this.scene.start('Game', { mode, mapId, session,
net })` where `mode` ∈ `'host' | 'client' | 'solo'`.

| Concern | host | client | solo |
|---|---|---|---|
| Sim (systems/) runs | YES | no | YES |
| Arcade bodies | dynamic, enabled | created but `body.enable=false` (visual proxies only) | dynamic, enabled |
| Local input | polled → fed straight into own slot's input buffer | polled → sent via ClientNet at 30 Hz | polled → own slot buffer |
| Remote input | from HostNet buffers | — | — |
| Rendering source | own sim state directly | Interpolator (100 ms behind) | own sim state |
| Snapshots | broadcast 20 Hz | consumed | none |
| Events | emitted by Sim → applied locally AND broadcast | applied on receipt | applied locally |

Key structural rule: **Sim emits events; it never touches rendering or the
network.** `Sim.update()` returns/queues `events[]`. In host mode GameScene
applies each event locally (FX, entity create/destroy) and hands it to
HostNet for broadcast. In solo mode it only applies locally. In client mode
the identical `applyEvent(scene, ev)` function runs on received events —
one code path for presentation on all three modes.

The **lobby is just GameScene** with `mapId:'lobby'` in the current netcode
mode plus `ReadyZoneSystem` active. Solo/practice = `mode:'solo'`,
`mapId:'lobby'`, reachable from the menu without networking.

### 3.2 Host tick order (Sim.update, fixed order — do not reorder)

1. Consume freshest InputFrame per connected slot (stunned/disconnected
   slots get a null frame).
2. `MovementSystem` — desired velocities from inputs (skipped for stunned).
3. `GrappleSystem` — apply grapple accelerations, zip velocities, attach/
   detach, beam updates.
4. `CarrySystem` / `RelicSystem` — grabs, throws, bag channels, catch.
5. `CombatSystem` — attack resolution, FF, monster hits.
6. Phaser arcade step runs (automatic between updates) — colliders:
   players×platforms, players×players (PvPCollisionSystem process callbacks),
   monsters×platforms, relic×platforms, players×monsters (overlap),
   players×doors (doors are static bodies while intact).
7. `FallStunSystem`, `StunSystem` — landings, stun timers, revive channels.
8. `MonsterSystem` — AI decisions, Brute door damage.
9. `DoorSystem`, `InteractSystem`, `ReadyZoneSystem` (lobby) — channels.
10. `ClockSystem`, `NoiseSystem` — pressure, spawns, escalation, win/lose.
11. `stats.js` accumulation from this tick's events.

### 3.3 Serialization

- Every entity's authoritative data lives in a flat `.state` object on its
  Phaser GameObject (never closures/scene fields), so `snapshot.js` can
  serialize mechanically: `serializeWorld(sim)` maps entity collections to
  the §2.5 arrays reading `.state` + `body`.
- Client side, `applySnapshot` writes interpolated x/y to the visual
  GameObjects and latest-value fields into `.state` for the UI (HUD reads
  clock/noise from the `world` row; player badges read status bits).
- `applyEvent` handles the discrete transitions (spawn/despawn/door/stun...)
  identically on host-local and client.

---

## 4. Entity / state model

All masses from `config.MASS`. `effMass(player)` = 1.0 + (1.0 if carrying
relic in hands or bag) + carried-stack weight transmitted down (sum of
players standing on you, applied to speed calc only, not to grapple mass).
Stunned players are ALWAYS treated as inert mass 1.0 bodies regardless of
what they were doing.

**Player.state**
```
slot 0..3            name                 token (host only)
facing -1|1          mass (derived, cached per tick)
onGround bool        lastGroundedAt       jumpBufferedAt
fallStartY           sprinting bool
stunned bool         stunMsLeft           mashReduceMs (per mash press)
carrying: null | {kind:'relic', where:'hands'|'bag'} | {kind:'player', slot}
carriedBy: null | slot        // being carried/stacked-held
channel: null | {type:'revive'|'pickDoor'|'crank'|'bag'|'unbag'|'reclaim'
                 |'ritual'|'board', targetId, msLeft, msTotal}
weapon: 'hammer'|'dagger'     attackCdMs
grapple: null | {targetKind:'terrain'|'entity', targetId, anchorX, anchorY}
connected bool       tombstoneId: null | id
```

**Relic.state** — singleton, id `'relic'`
```
rs: 'loose'|'held'|'bagged'|'flying'    holderSlot: null|0..3
(x,y,vx,vy from body when loose/flying; pinned to holder when held/bagged)
```

**Monster.state**
```
id     type:'skulker'|'brute'    mass (0.5 / 3.0)
hp (skulker 2 dagger-hits, hammer 1; brute hammer 5, dagger 10 — config)
ai: 'spawn'|'idle'|'chase'|'windup'|'attack'|'stunned'|'doorSmash'|'dying'
targetSlot   aiTimerMs   facing
```

**Door/Barrier.state**
```
id   type:'door'|'rubble'|'shortcut'|'bridge'|'crankGate'
state:'intact'|'broken'
smashHp          // hammer hits (and Brute hits) reduce; 0 => broken,
                 // ClockSystem charges the type's time cost + big noise
quietProgress 0..1   // pick/crank channel; 1 => broken silently, no cost
crankSlots: []       // crankGate: needs 2 simultaneous channelers
timeCostMs           // from config.CLOCK per type
```
Broken barriers disable their static body and swap texture. Doors are never
un-broken during a run.

**World state**
```
clockMsLeft          clockRunning bool (lobby: false)
noise 0..100         escalationLevel 0|1|2   (1 at <6 min, 2 at <3 min)
phase (Session)      stats (sim/stats.js per-slot counters)
```

**Pickups**: hourglass `{id, taken}`, ritual altar `{id, channelers:[],
used}` — 4 simultaneous channelers required, once per run.

**Tombstone**: `{id, slot, x, y, baggedRelic bool}`.

---

## 5. Work packages

Order is WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7; each may rely on every
earlier package's exposed interfaces. Every WP: keep constants in
`config.js`, run `npm run build` clean before finishing, and keep solo mode
playable at all times (it is the regression baseline).

---

### WP1 — Netcode core + phases (build steps 3, 11-partial)

**Scope.** PeerTransport (host/join by 4-letter code, two channels),
protocol.js, Session, HostNet, ClientNet, Interpolator, snapshot.js for the
`players` + `world` groups, GameScene three-mode refactor (mode param, sim
hook points as no-op system list, event apply pipeline), minimal
MenuScene Host/Join UI (code display + code entry + connecting overlay),
phase machine lobby↔playing↔results with placeholder trigger keys (host
presses P to start run, R for results — replaced in WP5/WP6), tombstone
token plumbing (welcome/hello/token/sessionStorage + reserved slots;
tombstone entity/respawn UX finished in WP6), UIScene + Toasts skeleton.

**Files.** Creates `net/PeerTransport.js`, `net/protocol.js`,
`net/Session.js`, `net/HostNet.js`, `net/ClientNet.js`,
`net/Interpolator.js`, `sim/Sim.js`, `sim/snapshot.js`, `sim/stats.js`
(stub counters), `scenes/UIScene.js`, `ui/Toasts.js`, `maps/mapTypes.js`,
`maps/lobbyMap.js` (geometry only), `maps/testMap.js` (copy current
PLATFORMS). Modifies `main.js`, `config.js` (NET section: rates, buffer,
version), `scenes/MenuScene.js`, `scenes/GameScene.js`,
`net/Transport.js` (finalize interface only if needed).

**Exposes.**
- `Sim` with `registerSystem(sys)`, `update(dt)`, `events` queue,
  `players/monsters/relic/doors` collections — later WPs only add systems
  and entities, never touch net code.
- `HostNet.broadcastEvent(ev)`, `Session` phase/roster API,
  `applyEvent(scene, ev)` dispatcher with a registry later WPs extend.
- `protocol.js` event `kind` registry.
- GameScene mode contract from §3.1.

**Acceptance.** Two browser tabs (host + join via code): both players run
and jump around the lobby map; remote player motion is smooth (100 ms
interpolation, no snapping at 20 Hz); host P/R cycles all three phases on
both tabs and both scenes restart correctly; joiner tab refresh + rejoin
with the same code reclaims the same slot/color via token; host tab close
returns the client to menu with a toast; solo mode works with zero network;
`npm run build` passes.

---

### WP2 — Player physics: PvP collision, boost, mass, fall-stun, stun-rescue (steps 4, 5, 9)

**Scope.** Extract movement from GameScene.update into MovementSystem
(multi-player, input-buffer driven). PvPCollisionSystem: players collide
with players — top contact solid (stand on heads), side contact soft-push
(process callback applies separation impulse instead of hard block), 80%
carrier velocity inheritance for the top player, apex-timed jump stacking,
stacked weight transmitted down (bottom player's speedMult uses
1/(ownMass + riders)). FallStunSystem: fall distance tracking,
safeHeight = base/mass, landing-on-teammate splits impact (both briefly
stunned, shorter duration). StunSystem: 6 s self-recover, mash reduces,
teammate Interact 1.5 s revive channel (via InteractSystem, created here in
minimal form), stunned body inert at mass 1.0, can be grabbed/carried/
thrown — CarrySystem created here for players (relic variant lands in WP5).
Status bits + channel progress into snapshots; stun stars placeholder FX.

**Files.** Creates `systems/MovementSystem.js`,
`systems/PvPCollisionSystem.js`, `systems/FallStunSystem.js`,
`systems/StunSystem.js`, `systems/InteractSystem.js`,
`systems/CarrySystem.js`, `entities/PlayerEntity.js` (factory extracted
from GameScene). Modifies `GameScene.js` (thin), `config.js` (STUN/CARRY
tuning), `sim/snapshot.js` (status bits), `sim/Sim.js` (tick order).

**Exposes.** `StunSystem.applyStun(sim, player, ms, cause)` (WP3/WP4 call
it), `InteractSystem.requestChannel(player, spec)` (WP4/WP5 reuse for
doors/bags/ritual), `CarrySystem.grab/throw`, fall-stun cancel hook
`FallStunSystem.cancelFor(player)` (WP3 grapple calls it).

**Acceptance.** In a 2-tab session: players can't overlap standing side by
side but slide around each other in corridors; jumping on a head works and
an apex-timed double boost reaches a ledge a single jump cannot; a fall
beyond safe height stuns for ~6 s, mashing shortens it, teammate E-channel
revives in 1.5 s with visible progress in both tabs; landing on a teammate
stuns both briefly; a stunned player can be picked up (F), carried (carrier
slowed by the weight rule), and thrown; all of it renders correctly on the
client tab. Build passes.

---

### WP3 — Grapple system (step 6)

**Scope.** GrappleSystem implementing THE mass rule: raycast/segment test
along aim from player up to `GRAPPLE.maxRange` against terrain, doors,
players, monsters, relic; attach beam. Terrain/intact-door (infinite mass):
grappler zips at `zipSpeed` toward anchor (velocity-steered, auto-detach on
arrival/obstruction/release). Dynamic target: equal-and-opposite constant
force — implemented as per-tick `body.acceleration` contributions
(`force/mass`, see §6), grapplers on the same target SUM. Equal masses meet
in the middle; Brute (3.0) pulls the grappler in — no special cases.
Detach on: release of grappleHeld, range break, line-of-sight break, either
end stunned. Grappling mid-fall calls `FallStunSystem.cancelFor`. Gamepad
soft aim-assist: magnetize to players/monsters/relic within
`aimAssistRadius` of the aim ray; terrain stays raw. Grapple impact noise
event. Beam serialization (`grapples` group) + client beam rendering in
Fx-lite form. Cannot fire grapple while carrying relic in hands (CLAUDE.md
table) — enforce via a capability check that WP5 turns on.

**Files.** Creates `systems/GrappleSystem.js`. Modifies
`input/InputManager.js` (expose aim ray helper for assist),
`sim/snapshot.js` (grapples group), `config.js` (GRAPPLE tuning),
`sim/Sim.js`, `GameScene.js` (beam visuals hook).

**Exposes.** `GrappleSystem.grapplesOn(targetId)` (Brute tug-of-war checks,
stats), `GrappleSystem.detachAll(playerOrTarget)` (stun/door-break call),
attach/detach/impact events in the registry.

**Acceptance.** Solo: zip to terrain point; zip cancels a lethal fall's
stun. 2-tab: grapple a teammate — both slide together and meet in the
middle; two players grappling one target visibly haul it ~2× faster; beams
render on both tabs at interpolated endpoints; gamepad aim magnetizes to a
moving player but not to terrain; grapple auto-detaches when the target is
stunned. No physics explosion when grappling into a wall corner (accel
capped). Build passes.

---

### WP4 — World systems: clock, doors, noise, monsters, weapons, FF (steps 7, 10 + weapons)

**Scope.** ClockSystem: 12-min countdown starts on `playing` entry, banner,
time costs charged via `chargeTime(ms, cause, slot)` (events + stats),
hourglass pickups, 4-player ritual (+60 s, once), escalation levels (<6 min
`escalation 1` = lights dim flag, <3 min `escalation 2` = collapse-floor
flag; the testMap marks which platforms collapse), calamity → lose event
(Sim raises `runOver {result:'lose', reason:'calamity'}`; WP5 owns the win).
DoorSystem + DoorEntity: smashable door (hammer/Brute, −20 s + 30 noise),
rubble (−25 s), shortcut (−15 s), bridge (−10 s), each with a quiet
channel alternative (pick ~2× smash-cost duration, free + silent), and one
2-player crank gate (both channel simultaneously). NoiseSystem: fills from
the config table (attacks, grapple impacts, sprint tick, hard landings,
smashes, bag stow hook for WP5, fighting), slow decay, full → spawn monster
near noise centroid + halve. CombatSystem + weapons: hammer (loud, strong,
slow, smashes doors, heavy FF can stun) and dagger (quiet, weak, fast, safe
near teammates); FF 50% baseline (shove/stagger on light, stun on heavy),
`ffFull` lobby toggle honored; weapon select in lobby via interact on a
weapon rack (lobbyMap gains one). MonsterSystem + MonsterEntity: Skulker
(fast weak chaser, default spawn, yankable into a hammer swing) and Brute
(3.0 mass, blocks corridors, targets doors on quiet routes, dies in pits;
spawns only from level triggers or every 3rd noise spawn — config).
Monster hits stun via WP2's `applyStun`.

**Files.** Creates `systems/ClockSystem.js`, `systems/NoiseSystem.js`,
`systems/DoorSystem.js`, `systems/CombatSystem.js`,
`systems/MonsterSystem.js`, `entities/MonsterEntity.js`,
`entities/DoorEntity.js`, `entities/PickupEntity.js`. Modifies
`maps/lobbyMap.js` (dummy monster, smashable door, weapon rack, anchors),
`maps/testMap.js` (barriers/pit placeholders), `config.js` (COMBAT,
MONSTERS, door HP/durations), `sim/snapshot.js` (monsters group),
`ui/HUD.js`-facing events, `sim/stats.js` (real counters).

**Exposes.** `ClockSystem.chargeTime/grantTime`, `NoiseSystem.addNoise(x,y,
amount, cause)` (WP5 bag-stow calls it), `runOver` event contract (WP5/WP6
consume), door/monster event kinds, `sim.stats` populated for WP6.

**Acceptance.** 2-tab on testMap: clock ticks identically on both;
hammering a door breaks it, charges −20 s (toast + stats) and spikes
noise; the quiet pick channel opens the same door free and silent; crank
gate needs both players; ~10 loud actions spawn a Skulker near the noise
and the gauge halves; Skulker chases and its hit stuns; a Brute in a
corridor cannot be pulled by one grappler (grappler slides in) but two
players win the tug-of-war; hammer FF stuns a teammate, dagger FF only
staggers, full-FF toggle changes damage; clock zero ends the run with a
lose phase on both tabs. Build passes.

---

### WP5 — Relic, objective, test map (steps 8, 13-groundwork)

**Scope.** RelicEntity + RelicSystem: loose relic (1.0 body, grapple-
fishable — WP3 rule gives the both-slide behavior free), instant hand
pickup (grab), carrier mass 2.0 (50% speed, ~70% jump via existing rule),
bag channel ~3 s interruptible by damage, unbag ~2 s, bag stow noise, throw
(grab button while holding: arc from aim), grapple-catch mid-air
(grapple attaches to flying relic → force rule reels it), stun-drop +
noise burst (hooks WP2 StunSystem), capability gating (no attack/grapple
with relic in hands; all allowed when bagged). Objective: relic starts in
the vault room; win = any player carries it (hands or bag) into the exit
zone → `runOver {result:'win'}` with escape-time stat. Tombstone relic
rules from §2.6 (bagged relic stays at tombstone, reclaim channel). Build
the REAL `testMap.js`: entrance/spawn, vault (relic + hourglass risk
rooms), exit, at least one of each barrier type, crank gate on the quiet
route, ritual altar, Brute pit, collapse-marked floors — sized so a clean
run ≈ 8–10 min of the 12-min clock.

**Files.** Creates `entities/RelicEntity.js`, `systems/RelicSystem.js`,
`entities/TombstoneEntity.js`. Modifies `systems/CarrySystem.js` (relic
branch), `systems/StunSystem.js` (drop hook), `systems/GrappleSystem.js`
(catch + capability gate), `maps/testMap.js` (full layout), `config.js`
(RELIC channels/throw), `sim/snapshot.js` (relic group), `sim/stats.js`.

**Exposes.** Relic state events (`relicState`), `runOver` win path,
finalized ResultsPayload shape `{result, reason, teamStats:{escapeMs,
timeLeftMs, treasure}, perPlayer:[{slot, name, doorsSmashed, timeCostMs,
noiseMade, ffDealt, throws, stuns}], award:{slot, title}}` (WP6 renders it).

**Acceptance.** Full 2-tab loop on testMap: grab relic (carrier visibly
slower/lower jumps), bag it over 3 s (interrupted by a hit), stunned
hand-carrier drops it with a noise burst while a bagged carrier keeps it,
throw + teammate grapple-catch works, loose relic grapple-fishing slides
both, carrying it into the exit ends the run as a win with correct phase
broadcast; disconnecting the carrier leaves a tombstone whose bagged relic
a teammate reclaims; a full honest playthrough is possible and loseable by
clock. Build passes.

---

### WP6 — UX screens: menu, lobby arena, HUD, results, tombstone rejoin (steps 11, 12)

**Scope.** MenuScene final: Host / Join (code entry w/ validation +
connecting overlay + error reasons from `reject`) / Settings (name,
volume placeholder, FF toggle [host-applied in lobby], binds VIEW-only
list) / Exit hidden on web. LobbyUI: roster panel with names/colors/
connection state, room code display, host kick buttons, stage board
interactable (host channels to cycle stage — testMap only for now, UI
built for more), ready = everyone in vault-entrance zone 3 s with visible
fill ring (ReadyZoneSystem created here; stepping out cancels; solo lobby
starts solo run). HUD: clock (turns urgent under escalation), noise gauge,
carry/weapon icons, channel progress bars over heads, ping markers (ping
verb → ctl event → world marker + edge indicator), phase banner ("STEAL
THE RELIC — GO"), stun mash prompt, rejoin toasts. ResultsUI: full
ResultsPayload rendering, "Most Ruinous Player" award (highest
timeCostMs + ffDealt composite), Return to lobby (host) / waiting text
(clients) / Exit. Tombstone rejoin UX end-to-end: menu "Rejoin last room"
shortcut when a sessionStorage token exists, tombstone visuals, respawn
flash.

**Files.** Creates `systems/ReadyZoneSystem.js`, `ui/HUD.js`,
`ui/LobbyUI.js`, `ui/ResultsUI.js`. Modifies `scenes/MenuScene.js`,
`scenes/UIScene.js`, `ui/Toasts.js`, `maps/lobbyMap.js` (board/zone
polish), `net/Session.js` (kick, stage select, FF toggle already plumbed),
`config.js` (UI section).

**Exposes.** Nothing new downstream — this closes the loop. WP7 may
restyle any ui/ file.

**Acceptance.** Complete journey with 3 tabs: menu → host → 2 joins →
practice in lobby (dummy monster, door, anchor, ledge all functional) →
host picks stage at board → all stand in zone 3 s (ring fills, stepping
out cancels) → run plays with full HUD on all tabs → win AND lose paths
show correct results + stats + award → return to lobby keeps room/code →
one client hard-refreshes mid-run and rejoins via token to its tombstone →
host kick returns that client to menu with reason. Keyboard-only and
gamepad-only navigation both work in menus. Build passes.

---

### WP7 — Art & polish pass

**Scope.** Procedural-only visual pass: `fx/textures.js` generates all
textures once (players with simple face/limb frames or squash-stretch
rects, relic glow, Skulker/Brute silhouettes, door/rubble/bridge tiles,
dungeon wall/floor tiling with variation, particle dots) replacing flat
rectangles; `fx/Fx.js` — squash & stretch on jump/land, dust particles,
grapple beam styling + impact sparks, hammer/dagger swing arcs, stun
stars, noise-ripple rings scaled to noise amount, door debris bursts,
screen shake on smashes/heavy hits, relic shimmer trail when flying,
escalation: global light dim at level 1 (dark overlay + player glow),
collapse-floor crumble + fall at level 2, calamity screen effect on lose,
confetti/vault-door slam on win. Camera: smooth-follow local player with
lookahead, world larger than viewport supported. HUD styling pass.
Optional (time-permitting): tiny WebAudio synth blips (no asset files).
STRICT RULE: no gameplay/tuning changes, no protocol changes; rendering
and juice only. Everything keyed off existing events.

**Files.** Creates `fx/textures.js`, `fx/Fx.js`. Modifies entities/
(texture hookup), `GameScene.js` (camera, applyEvent FX hooks), ui/ files
(styling), `config.js` (FX section).

**Acceptance.** Game reads clearly in motion: every event listed above has
a visible response on host AND client tabs; 60 fps maintained with 4
players + 3 monsters + particles on a mid laptop (no per-frame texture
generation, particle counts capped); zero new deps; zero external asset
files; build passes and `dist/` runs via `npm run preview`.

---

## 6. Risks & mitigations

1. **Arcade physics vs the grapple force rule.** Arcade has no constraints;
   naively setting velocities fights the collider and causes jitter/tunnel.
   DECIDED: dynamic-target grapples apply **acceleration, not velocity** —
   each tick GrappleSystem sums grapple forces per body and calls
   `body.setAcceleration(sum/mass)` (plus gravity comp is NOT added — the
   force fights gravity naturally, which is the design). Cap resulting
   speed (`body.setMaxVelocity`) and cap total accel per body to prevent
   explosion; zip-to-terrain is the one velocity-steered case and it
   auto-detaches on `blocked.*`. Never disable colliders for grappled
   bodies.
2. **Soft side-push between solid players.** Full solid player-player
   colliders cause stuck/climbing states. DECIDED: the player×player
   collider uses a `processCallback` — return true (solid) only when the
   contact is clearly top/bottom (relative y + falling); side contacts
   return false and apply a manual separation acceleration (soft push).
3. **Snapshot correctness for discrete state.** Interpolating booleans/
   enums glitches. Mitigated by the split in §2.2: lifecycle + rare state
   via reliable ordered `event`s; only continuous x/y (+ beam endpoints)
   interpolated; other snapshot fields read latest-value only.
4. **Lost input edges.** 30 Hz send vs 60 Hz sampling would eat jump
   presses. Mitigated: edge-OR coalescing in ClientNet (§2.4) and
   consume-once on the host buffer.
5. **PeerJS unreliable channel quirks.** Some platforms silently fall back
   to reliable. Harmless for correctness (snapshots are idempotent; host
   keeps max `seq` input), but HostNet must tolerate out-of-order `input`
   (drop stale seq) and clients must tolerate out-of-order `snap` (geckos
   vault already sorts by time; drop snaps older than newest). Two
   DataConnections per peer is well within browser channel limits (~64k).
6. **Public PeerJS broker flakiness / NAT failures (~10–15%).** Accepted
   for prototype (CLAUDE.md). Surface clear error toasts (`bad-code`,
   timeout after 10 s) rather than hanging; document `npx peerjs --port
   9000` self-host fallback in the README section of the map… (deferred:
   TURN).
7. **Host tab throttling.** Backgrounded tabs clamp timers/rAF → sim
   stalls for everyone. Mitigation: dt clamp (≤50 ms) prevents physics
   blowups; HostNet also runs the snapshot timer via `setInterval` (less
   throttled than rAF); show a "host paused" toast on clients when no snap
   arrives for >1 s. Accepted residual risk for a friends prototype.
8. **Desync of derived visuals.** Clients must NEVER run gameplay logic
   locally (no client-side prediction — locked). Guard: systems/ files are
   only ever registered in host/solo mode; client GameScene registers
   none. Any state a client needs must come from snapshot or event — code
   review rule for every WP.
9. **Event/snapshot races on rejoin.** A rejoiner needs full world state.
   DECIDED: host replays `spawn`/`doorState`/`relicState` events on the
   ordered ctl channel immediately after `welcome`, before the client
   processes any `snap` (client buffers `st` messages until the replay's
   terminating `event {kind:'syncDone'}`).
10. **Scope creep in WP4/WP5.** The two heaviest packages. Guard: monsters
    are a "loudness tax, not bosses" — Skulker AI is chase-and-swipe, Brute
    is walk-block-smash; no pathfinding beyond horizontal steering + jump
    probes. Test map is ONE map; no editor, no generator.

---

## 7. Non-negotiables checklist (every WP)

- CLAUDE.md locked decisions untouched (no prediction, zip-only grapple,
  clock-only loss, host-authoritative, PeerJS, tuning defaults live in
  `config.js`).
- No new dependencies; no edits to `package.json` / `vite.config.js` /
  `.github/`.
- No TypeScript, no external assets.
- `npm run build` passes (Node 22.7.0 warning is expected noise).
- Never `git commit` / `git push`.
- Solo mode stays playable after every package.
