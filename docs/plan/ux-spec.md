# Vaultbreakers — UX / UI Specification

> Contract for WP1 (menu/connecting skeleton) and WP6 (full UX screens), with
> HUD hooks used by WP2–WP5. CLAUDE.md is the design authority; if this doc
> conflicts with it, CLAUDE.md wins. Everything below is implementable with
> Phaser rectangles, arcs, triangles, `Phaser.GameObjects.Text`, and
> `Graphics` — **no DOM, no images, no fonts beyond Courier New**.
>
> NOTE ON CANVAS SIZE: the design brief circulated "900x540"; the code's
> source of truth is `src/config.js` → `GAME_WIDTH = 960`, `GAME_HEIGHT =
> 540`. **This spec uses 960x540.** All positions below are in canvas pixels
> unless marked "world" (world = GameScene world coordinates, camera-relative).

---

## 0. Global conventions

### 0.1 Scenes & layering

| Scene | Runs during | Draws |
|---|---|---|
| `MenuScene` | menu, connecting | §2–§5 (menu, join, settings, connecting overlay) |
| `GameScene` | lobby, playing | world + world-space UI (prompts, channel bars, ready ring, ping markers, board popup) |
| `UIScene` (overlay, launched in parallel with GameScene) | lobby, playing, results | HUD (§7), LobbyUI panels (§6), ResultsUI (§8), Toasts (§9) |

Depth order inside UIScene (low→high): panels 0, HUD widgets 10, banner 20,
toasts 30, modal overlays (results) 40. World-space UI in GameScene sits at
depth 900 (above all entities, below nothing else).

All HUD elements use `setScrollFactor(0)` semantics (UIScene has no camera
movement, so this is automatic). World-space UI scrolls with the camera.

### 0.2 Typography

Font family everywhere: `'Courier New, monospace'`. Sizes used (px):
**44** (title), **32/30/28** (clock states), **26** (banners/results verdict),
**22** (menu items), **18** (section headers, room code), **14** (body,
stats rows), **12** (toasts, hints, prompts), **10** (channel-bar labels,
gauge label). No other sizes. Letter spacing 8 on the 44px title only.

### 0.3 Palette (hex, constants go in `config.js` UI section)

| Token | Hex | Use |
|---|---|---|
| `bg` | `#10121a` | scene background |
| `panel` | `#1a1e2c` | panel fill |
| `panelStroke` | `#2a3048` | panel borders, 2px |
| `text` | `#e8eaf2` | primary text |
| `muted` | `#8890a6` | secondary text |
| `dim` | `#565d75` | hints, disabled |
| `gold` | `#ffd23f` | accent, focus, relic, title |
| `danger` | `#ff5d5d` | errors, red clock, kick |
| `warn` | `#ffb347` | amber clock, interrupts |
| `ok` | `#7ee787` | success, revive fill, ready ring |
| `noise` | `#b07eff` | noise gauge fill, ritual |
| overlay scrim | `#000000` alpha 0.7 | connecting/results dim layer |

Player slot colors (from `config.PLAYER.colors`, fixed by slot):
slot 0 `#ffd23f` gold · slot 1 `#4fd1c5` teal · slot 2 `#f47fb0` pink ·
slot 3 `#8ecae6` blue. Used for: player tint, name text, ping markers,
roster rows, results rows.

### 0.4 Widgets (shared styles)

**Button** — text object in brackets, e.g. `[ HOST GAME ]`, 22px, `text`
color. States: idle `#e8eaf2`; hover/focus `#ffd23f` plus a `>` cursor glyph
drawn 14px left of the text (focus marker for keyboard/gamepad); pressed:
scale 0.96 for 80ms; disabled `#565d75`, not interactive. Hit area = text
bounds inflated 8px each side.

**Panel** — `Graphics` rounded rect, radius 6, fill `panel` alpha 0.92,
2px stroke `panelStroke`.

**Channel bar (world-space)** — 40x6px rect centered horizontally on the
owner, bottom edge 10px above the sprite's top (sprite is 26x34 → bar center
at ownerY − 30). Fill: bg `#1a1e2c`, 1px stroke `#2a3048`, inner fill grows
left→right, color per channel type (§7.6). Label above bar: 10px, `text`
color, e.g. `REVIVING`. Bar renders on every peer (progress comes from
snapshot `ch` field / status bits). On interrupt: bar flashes `warn` and the
whole bar shakes ±2px for 200ms, then despawns.

**Hold-to-confirm ring** — arc, radius r, 5px line width, `ok` color,
starting at −90° sweeping clockwise; background full circle same radius,
`panelStroke`. Used by ready zone (r=40) and kick-hold (r=10, in roster row).

**Toast** — see §9.

### 0.5 Prompt glyphs (KB vs gamepad)

Every interaction prompt is a 12px text like `[E] REVIVE`. When the local
player's last-used device is gamepad (`usingGamepad` bit from InputManager),
swap the bracket token: `[E]`→`(Y)`, `[F]`→`(B)`, `[LMB]`→`(X)`,
`[RMB]`→`(RT)`, `[SPACE]`→`(A)`, `[SHIFT]`→`(LB)`, `[Q]`→`(R3)`,
`[ENTER]`→`(A)`, `[ESC]`→`(B)`. One helper `glyph('interact')` in HUD.js
owns this mapping; never hardcode a bracket string at call sites.

### 0.6 Menu navigation model (all MenuScene screens)

- Mouse: hover = focus, click = activate.
- Keyboard: `W`/`S`/`Up`/`Down` move focus, `Enter` activates, `Esc` goes
  back (never exits the page). Focus wraps.
- Gamepad: D-pad/L-stick up-down moves focus (repeat delay 350ms, repeat
  rate 130ms), `A` activates, `B` goes back.
- Exactly one element is focused at all times; initial focus = first button.
- Focus visual = the `>` marker + gold text (§0.4).

---

## 1. Input reference (LOCKED — display verbatim in Settings)

| Verb | KB/M | Gamepad |
|---|---|---|
| Move | `A / D` | `Left stick` |
| Jump (hold = higher) | `SPACE` | `A` |
| Attack | `LMB` | `X` |
| Aim | `Mouse` | `Right stick` |
| Grapple | `RMB` | `RT` |
| Interact (hold) | `E` | `Y` |
| Grab / Throw | `F` | `B` |
| Sprint / Dodge | `SHIFT` | `LB` |
| Ping | `Q` | `R3` |

Binds are **view-only** in the prototype (no rebinding UI).

---

## 2. Main menu (MenuScene, phase `menu`)

Background `bg`. Layout (all x-centered at 480 unless noted):

| Element | Pos (x,y) | Size/style | Copy |
|---|---|---|---|
| Title | 480, 130 | 44px, `gold`, letterSpacing 8, origin 0.5 | `VAULTBREAKERS` |
| Tagline | 480, 172 | 14px, `muted` | `steal the relic · beat the calamity` |
| Btn 1 | 480, 250 | button 22px | `[ HOST GAME ]` |
| Btn 2 | 480, 292 | button 22px | `[ JOIN GAME ]` |
| Btn 3 | 480, 334 | button 22px | `[ PRACTICE (SOLO) ]` |
| Btn 4 | 480, 376 | button 22px | `[ SETTINGS ]` |
| Rejoin (conditional) | 480, 424 | button 14px, `warn` color idle | `[ REJOIN LAST ROOM ____ ]` (4-letter code inserted) |
| Hint | 480, 505 | 12px, `dim` | `arrows/WS + ENTER · mouse · gamepad` |
| Version | 12, 526 | 10px, `dim`, origin 0,0.5 | `proto` + protocol version, e.g. `proto v1` |

- **No Exit item on web** (locked). A Steam/desktop build appends
  `[ EXIT ]` at y=418 (Btn positions shift are NOT needed now; just note).
- `[ REJOIN LAST ROOM ____ ]` renders only if
  `sessionStorage['vb-token-'+code]` exists for the most recent room code
  (store the code under `sessionStorage['vb-last-room']`). Activating it
  skips code entry and goes straight to §4 connecting with the stored token.
- `[ HOST GAME ]` → connecting overlay in "opening" mode (§4), then lobby.
- `[ JOIN GAME ]` → code entry (§3).
- `[ PRACTICE (SOLO) ]` → starts GameScene `{mode:'solo', mapId:'lobby'}`
  immediately, no network. Ready zone in solo starts a solo run.
- `[ SETTINGS ]` → settings screen (§5).

---

## 3. Join — 4-letter code entry (MenuScene sub-state)

Replaces the button column (title/tagline stay). Centered panel 360x200 at
(480, 300) center.

| Element | Pos | Style | Copy |
|---|---|---|---|
| Header | 480, 232 | 18px `text` | `ENTER ROOM CODE` |
| 4 letter boxes | centers x = 408, 456, 504, 552; y = 290 | each 40x52 rect, `panel` fill, 2px stroke: `panelStroke` idle / `gold` for active box | letter 26px `text`, centered |
| Caret | active box | 2px underline `gold`, blinks 500ms on/off | — |
| Join btn | 480, 366 | button 22px; disabled until 4 letters entered | `[ JOIN ]` |
| Back hint | 480, 400 | 12px `dim` | `[ESC] back` (glyph-swapped) |
| Error line | 480, 430 | 12px `danger`; hidden until an error (§4.2) | reason string |

Input rules:

- Keyboard: letters `A–Z` fill boxes left→right (force uppercase; ignore
  digits/symbols), `Backspace` clears the last filled box, `Enter` = Join
  (only when 4 letters), `Esc` = back to main menu. Paste (`Ctrl+V`) of a
  4-letter string fills all boxes.
- Mouse: click a box to make it active; click `[ JOIN ]`.
- Gamepad: active box letter cycles with D-pad/L-stick Up/Down through
  A→Z (wrap; repeat 350/130ms). Left/Right moves active box. Empty boxes
  start at `A` when first touched. `A` button on the 4th box (or when 4
  filled) = Join. `B` = back.
- On Join: transition to connecting overlay (§4) with the entered code.

---

## 4. Connecting states & errors

### 4.1 Connecting overlay

Full-canvas scrim (`#000000` alpha 0.7) over the current MenuScene content,
plus a centered panel 420x140 at (480, 270):

| Element | Pos | Style | Copy |
|---|---|---|---|
| Status line | 480, 245 | 18px `text` | see modes below |
| Animated dots | appended to status | cycle ` `, `.`, `..`, `...` every 300ms | — |
| Sub line | 480, 275 | 12px `muted` | mode-specific |
| Cancel btn | 480, 312 | button 14px | `[ CANCEL ]` |

Modes (status / sub):

- **Opening (host):** `OPENING ROOM` / `registering with the broker`
  While registering the `pfproto-<CODE>` peer ID. If the broker reports the
  ID is taken, silently regenerate a new 4-letter code and retry (max 3,
  then error `NO ROOM AVAILABLE — TRY AGAIN`). On success → lobby.
- **Joining:** `CONNECTING TO ROOM <CODE>` / `waiting for host` — until
  `welcome` or `reject`. On `welcome` → lobby (or playing if rejoin).
- **Rejoining:** `REJOINING ROOM <CODE>` / `reclaiming your slot` — join
  with stored token.

Cancel (`Esc`/`B`/click): destroys the pending Peer/connections, returns to
the previous menu screen. **Timeout: 10s** with no `welcome`/`reject` →
treat as `timeout` error below.

### 4.2 Error states (single source of truth)

All connection errors land back on the screen the user came from (code
entry for join errors; main menu for host/runtime errors) with the error
line set (12px `danger`, §3) — and, for errors that occur while in
lobby/playing, a return to MenuScene plus a toast (§9). Strings verbatim:

| Trigger | String | Where shown |
|---|---|---|
| `reject {reason:'full'}` | `ROOM IS FULL (4/4)` | code entry error line |
| Peer unavailable / `reject {reason:'bad-code'}` | `ROOM NOT FOUND — CHECK THE CODE` | code entry error line |
| 10s timeout | `CONNECTION TIMED OUT — TRY AGAIN` | code entry error line |
| `reject {reason:'in-run'}` (no valid token) | `RUN IN PROGRESS — CAN'T JOIN MID-RUN` | code entry error line |
| `reject {reason:'version'}` | `VERSION MISMATCH — HOST HAS A DIFFERENT BUILD` | code entry error line |
| Host ctl close, phase `lobby` | `HOST DISCONNECTED` | toast on menu after return |
| Host ctl close, phase `playing`/`results` | `HOST DISCONNECTED — RUN ENDED` | toast on menu after return |
| `kick` received | `KICKED BY HOST` | toast on menu after return |
| Host open retries exhausted | `NO ROOM AVAILABLE — TRY AGAIN` | main menu error line at 480, 430 |

Host-side: a joiner disconnect never shows an error — only the roster
change toast (§9).

---

## 5. Settings (MenuScene sub-state)

Centered panel 520x380 at (480, 290) center. Header `SETTINGS` 18px `text`
at (480, 128). Rows are focus-navigable (§0.6); Left/Right (or `A`/`D`,
D-pad left/right) change values on the focused row.

| Row | y | Label (14px `muted`, x=250 left-aligned) | Value (14px `text`, x=710 right-aligned) |
|---|---|---|---|
| Name | 170 | `NAME` | current name, e.g. `PLAYER` + caret when editing |
| Friendly fire | 205 | `FRIENDLY FIRE` | `STANDARD (50%)` or `FULL (100%)` |
| Volume | 240 | `VOLUME` | `◄ 80% ►` grayed `dim` + suffix ` (no audio yet)` |
| Binds header | 280 | `BINDS (view only)` 14px `muted`, x-centered 480 | — |
| Binds list | 300–440 | two columns: verb 12px `muted` left col x=270; KB value 12px `text` x=520 right-aligned; pad value 12px `text` x=700 right-aligned; 9 rows, 16px line height | exact table from §1 |
| Back | 470 | button 22px centered | `[ BACK ]` |

- **Name**: activating the row (Enter/A/click) enters edit mode — capture
  `keydown` for A–Z, a–z, 0–9, space, backspace; max 16 chars; Enter/Esc
  commits. Empty commits revert to `PLAYER`. Gamepad editing: not supported
  in v1 — row shows `(keyboard to edit)` 10px `dim` under the value when
  focused via gamepad. Persist to `localStorage['vb-name']`.
- **Friendly fire**: Left/Right/activate toggles. This is the *preference*;
  it only takes effect when the local player hosts (host applies it to the
  Session and it broadcasts via roster). Persist `localStorage['vb-ff']`.
- **Volume**: placeholder — value changes and persists
  (`localStorage['vb-vol']`, 0–100 step 10) but drives nothing yet.
- `Esc`/`B`/`[ BACK ]` → main menu.

---

## 6. Lobby (GameScene `mapId:'lobby'` + UIScene LobbyUI)

The lobby is the playable practice arena (dummy monster, smashable door,
grapple anchor, boost ledge) — full gameplay HUD is **hidden** except the
noise gauge is replaced by nothing and the clock is replaced by the room
code badge. Toasts active.

### 6.1 Room code badge (UIScene, top-center)

Panel 220x36, center (480, 26).

- Text: `ROOM ` 14px `muted` + `KQRZ` (the code) 18px `gold`, vertically
  centered, left-aligned starting x=396.
- Copy button: `[COPY]` 12px button at x=560 right edge, vertically
  centered. Click → `navigator.clipboard.writeText(code)`; on success the
  label becomes `COPIED` (`ok` color) for 1.5s then reverts. No keyboard
  binding (mouse-only convenience).
- Solo lobby: badge instead shows `SOLO PRACTICE` 14px `muted`, no copy.

### 6.2 Roster panel (UIScene, top-left)

Panel 208x124 at (16, 16) top-left. 4 rows, 28px tall, first row top at
panel y+8.

Each row, left→right:

- Color chip: 12x12 rect, slot color, x=28, row-center.
- Name: 14px, slot color, x=46 left-aligned. Host row's name is prefixed
  `★ ` (14px `gold`).
- State (right-aligned x=208): empty slot → `—` 12px `dim` and no chip;
  connected → nothing; disconnected mid-run → `LOST` 12px `danger`;
  in lobby a freed slot just becomes `—`.
- Kick (host only, non-host occupied rows): `[KICK]` 12px `danger` at
  right-aligned x=208 (replaces the state text position). Mouse: click
  starts a 700ms hold-to-confirm — while the pointer stays down the label
  fills a kick ring (r=10, `danger`) at x=196; releasing early cancels.
  Completing sends `kick` to that peer. Keyboard fallback: none in v1
  (kick is host mouse-only; acceptable, note in code).

### 6.3 Stage board (world-space, in the lobby map)

A board object in the arena (drawn by the map). Within 48px, players see
prompt `[E] STAGE BOARD` (12px, 20px above the board). Interacting opens
the board popup (world-space panel 240x100 anchored 12px above the board):

- Line 1: `STAGE` 10px `muted`.
- Line 2: current stage name 14px `text`: `THE TEST VAULT` (testMap).
- Line 3 (host only): `[E] NEXT STAGE` 12px — each 0.5s interact channel
  on the board cycles the stage (one entry now; UI built for more). Change
  broadcasts via roster; all clients' popups update.
- Non-host who interacts sees line 3 as: `ONLY THE HOST PICKS THE STAGE`
  12px `dim`.
- Popup closes when the player walks >64px away.

### 6.4 Ready zone + fill ring (world-space)

The vault-entrance zone is a marked floor region in the lobby map (map
draws a 120x8 strip, `gold` alpha 0.35, plus the label `VAULT ENTRANCE`
10px `dim` 6px under it).

Ring spec (ReadyZoneSystem state, rendered by GameScene on all peers from
host events/snapshot):

- Circle center: zone center, 40px above the floor strip. Radius 40, line
  width 5. Background ring: full circle `panelStroke`. Fill ring: arc from
  −90° clockwise, `ok` color, sweep = progress (0→1 over **3000ms**).
- Center text, 14px `text`: `READY n/m` where n = connected players inside
  the zone, m = connected players total. While filling, the text below the
  count (12px `ok`): countdown `3` → `2` → `1` (ceil of remaining s).
- Fill runs only while **all m connected players** are inside. Any player
  stepping out (or a disconnect changing m) resets progress to 0 instantly
  — the fill arc vanishes, and the ring flashes `warn` for 200ms.
- On completion: ring flashes solid `ok` 300ms, host transitions phase to
  `playing`.
- Solo mode: m=1, same visuals.

### 6.5 Practice furniture affordances

- Dummy monster: nameplate `DUMMY` 10px `dim` above it. Attacking it shows
  hit FX + fills the (hidden-in-lobby) noise logic — no gauge shown.
- Smashable door / grapple anchor / boost ledge: same in-game prompts as
  §7.7 (door shows `[E] PICK LOCK (hold)` and hammer smash works).
- Weapon rack (WP4): prompt `[E] TAKE HAMMER` / `[E] TAKE DAGGER` on the
  respective rack halves; current weapon shows in HUD bottom-left (§7.5).

---

## 7. In-game HUD (UIScene over GameScene, phase `playing`)

HUD margin: 16px from every canvas edge. All HUD elements are screen-fixed.

### 7.1 Clock (top-center) — the star of the screen

- Position: center (480, 30), origin 0.5. Format `MM:SS` (e.g. `11:42`).
- Normal (>6:00 left): 28px, `text` color.
- **Urgency 1** (<6:00, escalation 1): 30px, `warn`; once per second a
  scale pulse 1.0→1.08→1.0 over 200ms.
- **Urgency 2** (<3:00, escalation 2): 32px, `danger`; alpha blinks
  1.0/0.55 at 2Hz; the pulse continues.
- Final 10s: each second tick also pops scale to 1.25 decaying over 300ms.
- Time cost/gain feedback: floating delta text spawns 24px below the clock,
  20s cost → `-0:20` 18px `danger` (gain → `+0:30` 18px `ok`), drifts down
  16px and fades over 800ms. The clock itself flashes `danger`/`ok` for
  200ms. (Toast also fires, §9.)

### 7.2 Noise gauge (top-left)

- Bar: 200x14 rect at (16, 16) top-left. Bg `panel`, 2px stroke
  `panelStroke`. Fill left→right, `noise` color, width = noise/100 * 196.
- Label: `NOISE` 10px `muted`, at (16, 34) under the bar's left end.
- Fill feedback: every `noiseBurst` event bumps a 2px-taller "spike"
  overlay at the fill edge, `#ffffff` alpha 0.8, fading 250ms — the gauge
  visibly *ticks* on each noisy action. A ripple ring also spawns at the
  world position of the noise (§10).
- ≥80: the stroke turns `warn` and the fill alpha blinks 1.0/0.7 at 2Hz.
- Spawn (gauge full): fill flashes white 150ms, then animates down to the
  halved value over 300ms; toast `SOMETHING HEARD THAT…` (§9); the spawned
  monster gets a one-shot world marker: `!` 18px `danger` above spawn point
  for 1.5s.
- In lobby phase the gauge is hidden.

### 7.3 Relic / carry indicator (top-right)

Anchored right at x=944, y=16 (origin 1,0). A 18x18 diamond icon (rotated
square, `Graphics`) + status text 12px to its left (right-aligned):

| Relic state | Icon | Text (color) |
|---|---|---|
| Loose/unseen | outline only, `dim` | `RELIC LOOSE` (`muted`) — only after first seen; before that ``RELIC IN VAULT`` (`dim`) |
| Held by local player | filled `gold`, pulsing alpha 0.7–1.0 at 1Hz | `RELIC IN HANDS — DON'T GET HIT` (`gold`) |
| Bagged by local player | filled `gold` inside a 22x22 outline square | `RELIC BAGGED — SECURE` (`ok`) |
| Held/bagged by teammate | filled, teammate's slot color | `<NAME> HAS THE RELIC` (slot color) |
| Flying (thrown) | filled `gold`, no pulse | `RELIC IN THE AIR` (`warn`) |
| At tombstone (bagged) | outline `warn` | `RELIC AT TOMBSTONE` (`warn`) |

Carrier also gets a world-space marker: small diamond 8px `gold` floating
12px above the carrier's head (visible to everyone).

### 7.4 Stun indicators + rescue prompt

- Any stunned player (world-space): 3 five-point stars (`Graphics`, 6px)
  orbiting 18px above the head, one revolution / 1.2s, `warn` color; the
  body tints gray (`0x777788`).
- **Local player stunned** (screen-fixed): centered prompt at (480, 400):
  line 1 `STUNNED!` 22px `danger`; line 2 `MASH ANY BUTTON TO RECOVER`
  14px `text` (gamepad: same string — any button/stick edge counts as a
  mash). Below at (480, 436): recovery bar 200x10, fill `warn`, draining
  right→left from full over the remaining stun time; every mash visibly
  chops the fill (mash reduces time — WP2 rule). All action inputs are
  ignored while stunned (host-side); the HUD communicates why.
- **Rescue prompt** (world-space, teammates): when an un-stunned local
  player is within 48px of a stunned teammate: `[E] REVIVE` 12px above the
  body (below the stars). While channeling: the channel bar (§7.6) with
  label `REVIVING`, 1500ms, fill `ok`, progress mirrored on all peers.
  Also `[F] GRAB` shows next to it (stunned bodies can be carried) —
  stacked prompts: `[E] REVIVE` on top, `[F] GRAB` 14px lower.

### 7.5 Weapon indicator (bottom-left)

At (16, 508) origin 0,0.5: 20x20 icon (hammer = T-shape rects; dagger =
thin triangle) + weapon name 14px `text` at x=44: `HAMMER` or `DAGGER`.
Sub-hint 10px `dim` under the name: hammer → `loud · smashes doors`,
dagger → `quiet · quick`.

### 7.6 Channel progress bars (world-space, all channels)

One spec for every hold/channel (Interact-driven). Bar per §0.4. Labels and
fills (durations from config; defaults listed):

| Channel | Label | Fill color | Duration |
|---|---|---|---|
| Revive teammate | `REVIVING` | `ok` | 1500ms |
| Bag relic | `BAGGING` | `gold` | 3000ms |
| Unbag relic | `UNBAGGING` | `gold` | 2000ms |
| Pick door quietly | `PICKING` | `text` (white) | ~12000ms (config: ≈ smash cost 20s ÷ 1.6) |
| Crank gate (each cranker) | `CRANKING 1/2` or `2/2` | `text` | 8000ms, needs 2 simultaneous |
| Ritual | `RITUAL 3/4` (count channeling) | `noise` | 5000ms, needs 4 simultaneous |
| Reclaim tombstone bag | `RECLAIMING` | `warn` | 3000ms |
| Stage board (lobby) | `CHANGING STAGE` | `text` | 500ms |

Rules: bar appears the frame a channel starts, tracks the owner. Cancel
(release of the interact input, or walking away) → bar just despawns.
Interrupt by damage → flash+shake per §0.4. Multi-person channels (crank,
ritual) additionally show the shared count in the label and each channeler
gets their own bar.

### 7.7 Interact prompts (world-space)

12px `text`, centered 20px above the target, visible when the local player
is within 48px of the interactable and the action is currently legal.
Verbatim strings:

- Door (intact): `[E] PICK LOCK (hold)` — hammer users also learn via
  hint toast the first time they're near a door with hammer equipped:
  `hammer smashes doors — costs time and noise` (once per run).
- Crank gate: `[E] CRANK — NEEDS 2`
- Ritual altar (unused): `[E] RITUAL — NEEDS ALL 4 (+1:00)`
- Hourglass: no prompt (walk-over pickup).
- Loose relic: `[F] GRAB RELIC` and 14px lower `[E] BAG RELIC (hold)`
- While holding relic in hands: `[E] BAG RELIC (hold)` floats over own
  head; `[F] THROW` replaces the grab prompt (throw arc from aim).
- While relic bagged: `[E] UNBAG (hold)`
- Stunned teammate: `[E] REVIVE` / `[F] GRAB` (§7.4).
- Carrying a teammate: `[F] THROW`
- Tombstone with bag: `[E] RECLAIM BAG (hold)`
- Weapon rack (lobby): `[E] TAKE HAMMER` / `[E] TAKE DAGGER`
- Stage board (lobby): `[E] STAGE BOARD` (§6.3).

Only the nearest prompt-pair shows (avoid stacking more than 2 lines).

### 7.8 Ping markers

- Fire: `Q` / `R3`. Marker placed at the aim point: mouse = cursor world
  position; gamepad = 200px from the player along the R-stick direction
  (or facing direction if stick is neutral). Cooldown 500ms per player.
- Marker (world-space, all peers, via ctl event): a 12px downward triangle
  in the pinger's slot color, hovering with a ±3px 1Hz bob, above a 4px dot
  at the exact point. Lifetime 3000ms, fading the last 500ms. Spawn pop:
  scale 1.6→1.0 over 150ms.
- Off-screen: an edge indicator — same-color 10px triangle clamped 12px
  inside the canvas edge toward the marker, pointing at it, same lifetime.
- No text, no sound (prototype).

### 7.9 Phase banner

On entering `playing` (no control lockout — banner only): centered text at
(480, 180), 26px `gold`: `STEAL THE RELIC — GO`. Behind it a full-width
band 960x44 `#000000` alpha 0.4. Slides in from alpha 0 over 200ms, holds
1600ms, fades 400ms. Also used for escalation announcements (§10):
`THE DUNGEON STIRS` (<6:00, 22px `warn`) and `THE FLOORS ARE FALLING`
(<3:00, 22px `danger`), same timing.

### 7.10 Grapple & aim affordances

- Mouse: crosshair at cursor (world-space `Graphics`, two 8px lines).
  `dim` when no valid grapple target along the ray within range (420px);
  `gold` when the shot would attach. Default OS cursor hidden over canvas
  during `playing`.
- Gamepad: 24px aim line from the player edge along R-stick dir, `dim`
  alpha 0.6; when soft aim-assist magnetizes to a target
  (player/monster/relic), draw 4 corner brackets (10px, `gold`) around
  that target while assisted.
- Beam (while attached): 2px line, owner slot color, player→tip, drawn
  from snapshot `grapples` group on every peer. On attach: 6px impact
  flash ring at the anchor, 150ms.

### 7.11 Host-lag notice (clients only)

If no snapshot arrives for >1000ms during lobby/playing: toast
`WAITING FOR HOST…` (repeats at most every 5s while starved; clears
silently on recovery).

---

## 8. Results screen (UIScene ResultsUI, phase `results`)

Full-canvas scrim `#000000` alpha 0.7 over the frozen final game frame.
All content centered on x=480. Rendered entirely from the ResultsPayload in
the `phase` message (clients need no other data).

| Element | y | Style | Copy |
|---|---|---|---|
| Verdict | 64 | 32px; win `gold`, lose `danger` | `VAULT BROKEN` (win) / `THE CALAMITY` (lose) |
| Reason | 100 | 14px `muted` | win: `the relic escaped the dungeon` · lose: `the clock hit zero — everyone is very stylishly doomed` |
| Team stats | 138 | 14px `text`, one line, ` · ` separators | `ESCAPE TIME 07:42 · TIME LEFT 04:18 · TREASURE: RELIC` — on lose: `ESCAPE TIME — · TIME LEFT 00:00 · TREASURE: NONE` |
| Table header | 176 | 12px `dim` | columns below |
| Player rows | 200, 232, 264, 296 | 14px; name in slot color, numbers `text` | one row per rostered slot (incl. disconnected: name suffixed ` (lost)` in `dim`) |
| Award | 348 | 18px `gold`, one line | `MOST RUINOUS PLAYER: <NAME>` |
| Award detail | 372 | 12px `muted` | `caused 1:05 of time costs and 37 friendly damage` (numbers from stats) |
| Buttons | 440 | 22px buttons, centered, 40px gap | host: `[ RETURN TO LOBBY ]`  `[ EXIT ]` · clients: `waiting for host…` 14px `muted` + `[ EXIT ]` |

Stats table columns (x = left edge of each column; header text verbatim):

| x | Header | Cell format |
|---|---|---|
| 150 | `PLAYER` | name (≤16 chars) |
| 330 | `DOORS` | int (doorsSmashed) |
| 410 | `TIME COST` | `M:SS` (timeCostMs) |
| 530 | `NOISE` | int (noiseMade) |
| 620 | `FF DEALT` | int (ffDealt) |
| 720 | `ALLIES THROWN` | int (throws) |
| 870 | `STUNS` | int (stuns, right edge ≤ 944) |

- **Most Ruinous Player**: score = `timeCostMs/1000 + 2*ffDealt` (the WP6
  composite: time cost + FF dealt; the factor 2 lives in config). Highest
  score wins; ties → lowest slot. If every score is 0: award line reads
  `MOST RUINOUS PLAYER: NOBODY` with detail
  `a suspiciously professional crew`.
- `[ RETURN TO LOBBY ]` (host only): broadcasts phase `lobby`; room + code
  persist; everyone's GameScene restarts on the lobby map.
- `[ EXIT ]`: leaves the session (client: close connections; host: closes
  the room — clients get host-disconnect handling §4.2) and returns to the
  main menu. (This is CLAUDE.md's results "Exit" — on web it exits the
  *session*, since the app can't close the tab.)
- Navigation: §0.6 (focus between the available buttons).
- Entrance juice: verdict scales 1.4→1.0 over 250ms; rows fade in
  top-to-bottom 60ms apart; award pops in last (+400ms).

---

## 9. Toasts (UIScene, all phases with UIScene active)

Stack anchored bottom-center: first toast baseline y=496, each older toast
pushed 20px up; max 4 visible (oldest evicted). Each toast: 12px text on a
pill panel (padding 8x4), lifetime 3000ms, fade-out 300ms.

Catalog (verbatim; `<NAME>` = player name in their slot color, rest
`text` unless noted):

| Event | Toast |
|---|---|
| Player joined lobby | `<NAME> JOINED` |
| Player left / disconnected (lobby) | `<NAME> LEFT` |
| Player disconnected (run) | `<NAME> DISCONNECTED — TOMBSTONE PLACED` (`warn`) |
| Player rejoined (run) | `<NAME> IS BACK` (`ok`) |
| Kicked (on kicked client, after menu return) | `KICKED BY HOST` (`danger`) |
| Host gone (after menu return) | `HOST DISCONNECTED` / `HOST DISCONNECTED — RUN ENDED` (`danger`) |
| Door smashed | `-0:20 DOOR SMASHED (<NAME>)` (`danger` amount) |
| Rubble blasted | `-0:25 RUBBLE BLASTED (<NAME>)` |
| Shortcut broken | `-0:15 SHORTCUT BROKEN (<NAME>)` |
| Bridge kicked | `-0:10 BRIDGE KICKED (<NAME>)` |
| Hourglass | `+0:30 HOURGLASS (<NAME>)` (`ok` amount) |
| Ritual done | `+1:00 RITUAL COMPLETE` (`ok`) |
| Monster spawn | `SOMETHING HEARD THAT…` (`warn`) |
| Brute spawn | `SOMETHING BIG HEARD THAT…` (`danger`) |
| Relic first picked up | `<NAME> HAS THE RELIC` |
| Relic dropped by stun | `<NAME> DROPPED THE RELIC!` (`warn`) |
| Relic reclaimed from tombstone | `<NAME> RECLAIMED THE RELIC BAG` |
| FF full toggled (lobby) | `FRIENDLY FIRE: FULL` / `FRIENDLY FIRE: STANDARD` |
| Stage changed (lobby) | `STAGE: THE TEST VAULT` |
| Host starved (client) | `WAITING FOR HOST…` (`warn`) |
| First hammer-near-door hint | `hammer smashes doors — costs time and noise` (`dim`) |

Time-cost toasts fire alongside the clock delta float (§7.1) — toast tells
*who*, clock tells *how much*.

## 10. Feedback for every noisy action (noise → visible consequence)

Every `noiseBurst {x,y,amount}` event produces, on all peers:

1. Gauge spike tick (§7.2).
2. World ripple: a circle outline at (x,y), radius animating 6→(18 +
   amount*1.2)px, line 2px `noise` color, alpha 0.8→0, over 350ms. Loud
   events (amount ≥ 20, e.g. door smash) get 2 concentric ripples 100ms
   apart plus a 120ms screen shake (4px) — shake host and clients alike
   (WP7 may restyle; the ripple itself ships with the noise system so the
   gauge is never "magic").

Amount sources (from `config.NOISE`): attack 6 · grapple impact 5 · hard
landing 8 · sprint 3/s (ripple-less — gauge tick only, no world ripple for
sprint) · door smash 30 · bag stow 4 · fighting/monster hits 6.

Escalation visual states (host event `escalation {level}`):

- Level 1 (<6:00): banner `THE DUNGEON STIRS` (§7.9); clock urgency 1.
  (WP7 dims world lighting; not a UX blocker.)
- Level 2 (<3:00): banner `THE FLOORS ARE FALLING`; clock urgency 2;
  collapse-marked platforms blink alpha 1.0/0.5 at 1Hz for 2s before each
  crumble.

---

## 11. Copy master list (strings not already quoted above)

- Title: `VAULTBREAKERS` · tagline `steal the relic · beat the calamity`
- Menu hint: `arrows/WS + ENTER · mouse · gamepad`
- Code entry header: `ENTER ROOM CODE`; join `[ JOIN ]`; back `[ESC] back`
- Connecting: `OPENING ROOM`, `CONNECTING TO ROOM <CODE>`,
  `REJOINING ROOM <CODE>`, subs `registering with the broker`,
  `waiting for host`, `reclaiming your slot`, `[ CANCEL ]`
- Settings labels: `SETTINGS`, `NAME`, `FRIENDLY FIRE`, `STANDARD (50%)`,
  `FULL (100%)`, `VOLUME`, ` (no audio yet)`, `BINDS (view only)`,
  `(keyboard to edit)`, `[ BACK ]`
- Lobby: `ROOM`, `[COPY]`, `COPIED`, `SOLO PRACTICE`, `[KICK]`, `LOST`,
  `—`, `★ ` host marker, `VAULT ENTRANCE`, `READY n/m`, `STAGE`,
  `THE TEST VAULT`, `[E] NEXT STAGE`, `ONLY THE HOST PICKS THE STAGE`,
  `DUMMY`
- HUD: `NOISE`, `STUNNED!`, `MASH ANY BUTTON TO RECOVER`, weapon names
  `HAMMER` / `DAGGER`, hints `loud · smashes doors` / `quiet · quick`,
  relic strings per §7.3, prompts per §7.7, banner
  `STEAL THE RELIC — GO`, `THE DUNGEON STIRS`, `THE FLOORS ARE FALLING`
- Results: per §8 table headers and verdict/reason strings.

Style rules: UI chrome and verbs are UPPERCASE; flavor sublines are
lowercase; player names render as entered (≤16 chars). `—` is em dash,
`·` is middle dot — both render fine in Courier New.

---

## 12. Implementation notes for programmers

- HUD reads world state ONLY from the snapshot `world` row
  (clock/noise/escalation) and player status bits/`ch` — never from local
  simulation guesses on clients (locked: no prediction).
- All durations/sizes/colors in this doc land in `config.js` under a `UI`
  section (WP6) — this doc gives defaults, config is runtime truth.
- Text objects are cheap but don't churn them: cache and `setText` only on
  change (clock updates at most 1x/frame; stats rows are static).
- `Graphics`-drawn widgets (gauge, rings, bars) should be cleared+redrawn
  only when their value changes, or use pre-generated textures + crop for
  fills.
- Every string in §11 should live in one `ui/strings.js`-style object or
  at the top of the owning ui/ file — no inline literals scattered in
  logic (copy edits must be one-line diffs).
- Prompt visibility radius (48px), toast lifetime (3000ms), ring radius
  (40px), etc. are all config constants, not magic numbers.
