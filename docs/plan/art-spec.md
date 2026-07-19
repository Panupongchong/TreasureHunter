# Vaultbreakers — Art Spec (procedural, Phaser-only)

> Visual direction contract, primarily for WP7 (`fx/textures.js`, `fx/Fx.js`)
> but binding on every WP that draws anything. CLAUDE.md is the design
> authority; implementation-plan.md defines the file layout and event names
> this spec keys off. Everything here is implementable with Phaser Graphics,
> `generateTexture`, rectangles, tweens, and particle emitters — zero image or
> audio files, zero new dependencies.
>
> Tone: Overcooked-style chaos inside a dungeon heist. **Readable beats
> pretty.** The placeholder dark-navy look is the base coat — this spec evolves
> it; it never clashes with it. Numbers are normative: implement exactly,
> tune only via `config.js` `FX` section if a value must move.

---

## 1. Palette

### 1.1 Master palette table

All colors are given as CSS hex; in code use `0x`-prefixed ints. Names in
`code` are the suggested keys for a `config.js` `COLORS` export.

**Base / environment**

| Name | Hex | Usage |
|---|---|---|
| `bgDeep` | `#0b0d14` | Game background (LOCKED — already in main.js). Never draw entities in this color |
| `bgFar` | `#131624` | Depth layer L2: far background silhouettes |
| `bgFarDetail` | `#0f1120` | L2 detail (arch silhouettes, distant pillars) |
| `bgMid` | `#1d2236` | Depth layer L1: mid background walls (non-collidable dressing) |
| `bgMidDetail` | `#262c48` | L1 detail (bricks, chains, shelf lines) |
| `surface` | `#39406a` | Depth layer L0: playable platforms/terrain fill (existing) |
| `surfaceTop` | `#4c548a` | L0 top-edge highlight, 3 px (existing) |
| `surfaceShade` | `#2b3152` | L0 bottom/side shade edge, 2 px |
| `surfaceSeam` | `#323858` | L0 brick seam lines, 1 px |
| `outline` | `#12141c` | Universal 2 px entity outline + engraving/crack lines |

**Functional colors (HARD RESERVATIONS — see §1.3)**

| Name | Hex | Usage |
|---|---|---|
| `gold` | `#ffb52e` | Relic core, hourglass sand, treasure UI numbers, bag-channel fill |
| `goldLight` | `#ffdf7e` | Relic top facet, glints, hourglass upper sand |
| `goldDark` | `#d98a12` | Relic bottom facet, gold shadows |
| `danger` | `#ff5d6c` | Hazard/damage: monster family accents, collapse warnings, <3 min clock, lose FX |
| `dangerDeep` | `#c23a4c` | Brute body, damage shading |
| `dangerDark` | `#7d2733` | Brute plates, Skulker legs, deep hazard shade |
| `monster` | `#f2566b` | Skulker body (crimson family, lighter than Brute) |
| `noise` | `#ff8c2e` | Noise gauge fill, noise ripples, time-COST toasts, <6 min clock, smash chevron tags |
| `quiet` | `#6fe3a0` | Quiet/safe/go: quiet-channel fills, ready ring, exit portal, time-GAIN toasts |
| `stun` | `#b39cff` | Stun stars, stun UI, revive channel fill, ritual circle |
| `steel` | `#c8cde8` | Locks, crank wheels, hourglass frame, portcullis highlights |
| `steelDark` | `#9aa2c8` | Portcullis bars |
| `steelDeep` | `#6b7394` | Crossbars, metal shade |
| `wood` | `#7a552f` | Door/bridge planks |
| `woodDark` | `#5c3f22` | Plank seams, wood shade |
| `metalBand` | `#3a4056` | Door metal bands, bolts base |
| `rubbleA` | `#565d75` | Rubble/stone light, dust, pebbles, tombstone fill |
| `rubbleB` | `#4a4f70` | Rubble mid |
| `rubbleC` | `#3a3f5c` | Rubble dark |

**UI**

| Name | Hex | Usage |
|---|---|---|
| `ink` | `#e8eaf2` | Primary UI text (existing — keep) |
| `inkDim` | `#8890a6` | Secondary UI text (existing — keep), dust puffs |
| `inkFaint` | `#565d75` | Debug/hint text (existing — keep) |
| `panel` | `#12141c` | UI panel fill @ alpha 0.92 |
| `panelBorder` | `#2b3152` | UI panel/bar borders, 1 px |
| `white` | `#ffffff` | Eyes, glints, flash frames, spark particles |

**Player colors (LOCKED, existing `PLAYER.colors`)**

| Slot | Hex | Name |
|---|---|---|
| 0 | `#ffd23f` | Gold-yellow |
| 1 | `#4fd1c5` | Teal |
| 2 | `#f47fb0` | Pink |
| 3 | `#8ecae6` | Sky |

Derived per-slot "dark" variant (bags, accents): multiply each RGB channel by
0.55 → slot 0 `#8c7423`, slot 1 `#2b736c`, slot 2 `#864661`, slot 3 `#4e6f7e`.
Compute at runtime (`darken(color, 0.55)` helper in `fx/textures.js`), do not
hand-tune.

### 1.2 Dungeon surface depth layers

Three parallax-free layers (world is only a few screens; no parallax needed,
"depth" is purely tonal):

- **L2 far** (`bgFar` on `bgDeep`): large silhouettes — arches 120 px wide,
  pillars 24 px wide — drawn with `bgFarDetail` insets. Pure dressing.
- **L1 mid** (`bgMid`): wall panels behind the play space; brick pattern =
  horizontal `bgMidDetail` lines every 24 px, vertical seams every 48 px
  offset half per row, 1 px.
- **L0 playable** (`surface`): every collidable platform. Render recipe per
  platform rect `[x,y,w,h]`: fill `surface`; 3 px top strip `surfaceTop`;
  2 px bottom strip `surfaceShade`; if `h ≥ 14`, add `surfaceSeam` vertical
  1 px seams every 32 px starting at x+16 (deterministic, no RNG per frame).

Contrast ladder is fixed: L2 < L1 < L0 < entities. Nothing behind L0 may use
a color lighter than `bgMidDetail`.

### 1.3 Color reservation rules (hard)

1. **Gold family** (`gold*`) = relic, hourglass, treasure UI only. Never
   walls, never generic UI accents. Player 0's `#ffd23f` is *lighter and on a
   26x34 rounded body*; the relic is *deeper amber, gem-shaped, glowing* —
   they never read the same (see §2.4).
2. **Red family** (`danger*`, `monster`) = threat only: monsters, damage,
   collapse, calamity, lose screen.
3. **Orange** (`noise`) = the noise/time-cost economy only: gauge, ripples,
   `-20s` toasts, smash chevron tags, <6 min clock.
4. **Green** (`quiet`) = safe/quiet/go only: quiet channels, ready ring, exit
   portal, `+30s` toasts.
5. **Violet** (`stun`) = stun and ritual mysticism only.
6. **Player bodies are never tinted** for status (carry, channel, sprint…) —
   status is shown by accessories/overlays (§2.2). The ONLY body tint is the
   stun desaturation (§2.3). This keeps "who is who" absolute in chaos.
7. UI chrome (panels, borders, hover states) stays in the navy family
   (`panel`, `panelBorder`, `surfaceTop`); functional colors appear in UI
   only with their reserved meaning.

### 1.4 Escalation stage tints

Escalation levels arrive as `event {kind:'escalation', level}` (plan §2.2).
All overlays are screen-space (`setScrollFactor(0)`) at the depths in §4.

- **Level 1 — lights dim (<6 min):**
  - Full-screen rect `#05070d`, alpha tweened 0 → **0.45** over 2000 ms
    (Quad.inOut), depth 90. Stays for the rest of the run.
  - Each player gains an additive glow: circle radius 44 px in slot color,
    alpha 0.10, `BlendModes.ADD`, attached to the player container (§2.2).
  - Relic glow radius ×1.5 (26 → 39 px) and alpha 0.18 → 0.26.
  - Banner "THE LIGHTS FADE" (§5 banner style), 1500 ms.
- **Level 2 — collapse (<3 min):**
  - Level 1 overlay stays. Add edge vignette: 4 gradient strips (top/bottom
    64 px, left/right 48 px) `#2a0b10`, alpha 0.35 at the edge fading to 0
    inward (build once as a generated texture), depth 91.
  - Collapse-marked platforms run the crumble sequence in §3.10.
  - Banner "THE VAULT IS COLLAPSING", 1500 ms, `danger` text.

---

## 2. Shape language per entity

General rules: every dynamic entity texture is generated ONCE in
`fx/textures.js` `ensureTextures(scene)` via Graphics + `generateTexture`,
with a baked **2 px `outline` (#12141c) outline** (Brute: 3 px). Corner
radius 4 px on all rounded rects unless stated. Sizes are display sizes in px
at scale 1.0; physics body sizes stay whatever the systems define.

### 2.1 Players (26 x 34, LOCKED base size)

- **Body:** 26 x 34 rounded rect (r4), fill = slot color, 2 px `outline`.
  Inner bottom shade: 26 x 6 strip at the bottom, slot-dark (×0.55), alpha
  0.35.
- **Eye (single big eye — the face):** white `#f4f6ff` 8 x 7 rounded rect
  (r3) centered at (facing × 5, −7) from body center; pupil 3 x 4 `outline`
  offset a further (facing × 2, 0). Replaces the current 5 x 5 dark square.
  Eye is a separate child object so it can swap to X-eyes when stunned.
- **Structure:** build each player as a `Phaser.GameObjects.Container`
  (body sprite + eye + accessories + glow). Physics body attaches to the
  container. All accessories below are container children so depth and
  squash-stretch inherit automatically.
- **Carry — relic in hands:** relic gem (§2.4, at 0.8 scale = 18 x 22) drawn
  at (0, −28) above the head, bobbing ±2 px, 1.2 s sine. No arm art.
- **Carry — bag:** back-pack 14 x 16 rounded rect (r4), slot-dark fill, 2 px
  `outline`, positioned at (−facing × 10, −2); strap = 2 px slot-dark line
  across the torso diagonal. When the relic is bagged: 6 x 8 mini-gem
  (`gold`) on the flap + additive glow circle r10, `gold`, alpha 0.15.
- **Carrying a player (stunned teammate):** the carried player's container is
  positioned at (0, −30) above the carrier (systems own the attachment; art
  just renders both normally — weight readability comes from the carrier's
  slower movement).
- **Stun pose:** rotate container to 90° (sign = last horizontal velocity,
  default +90°), tint body sprite `0x9aa0b8`, alpha 0.9. Eye swaps to
  X-eyes: two crossed 2 px `outline` lines, 8 px long. Stun stars orbit
  above (§3.7). Mash prompt (§5) floats at (0, −34).
- **Sprint:** 2-particle-per-100 ms dust trail at the feet (§3.8 puff at 0.6
  scale). No body change.
- **Facing:** flip eye offset only; body is symmetric.

### 2.2 Monsters (crimson family, white eyes, angular vs players' rounded)

**Skulker (mass 0.5 — small, skittery):**
- Body: 22 x 14 horizontal capsule (rounded rect r7), fill `monster`
  (#f2566b), 2 px `outline`.
- Legs: 4 stubs 2 x 4 `dangerDark`, at x = −8, −3, +3, +8 below the body;
  animate alternating pairs ±2 px vertical every 90 ms while moving
  (skitter).
- Eyes: two 3 x 3 `white` squares at the front (facing side), 4 px apart.
- Chase jitter: body x-wobble ±1 px at 12 Hz while `ai='chase'` (render
  offset only, never the physics body).
- Windup: scales to (1.15, 0.85) for 200 ms before its swipe.

**Brute (mass 3.0 — big slab):**
- Body: 56 x 64 rect, r2 corners (near-square = slab), fill `dangerDeep`
  (#c23a4c), **3 px** `outline`.
- Plates: three horizontal bands 56 x 4 `dangerDark` at y = 14, 32, 50 from
  the top edge.
- Eyes: two 5 x 4 `white` rects at y = 10, 16 px apart, set toward facing.
- Fists: 14 x 12 rounded rects (r3) `dangerDark`, one per side at y = 36;
  windup = both rise 8 px over 400 ms; slam = drop back in 80 ms + medium
  shake (§3.6) + dust burst.
- Walk: container rocks ±2° at 2 Hz; a §3.8 dust puff at each footfall
  (every 500 ms while moving).
- Door smashing (`ai='doorSmash'`): fist slam cycle against the door every
  900 ms, each hit triggers the door's damage FX (§3.4 at half count).

**Spawn (both):** monsters appear via the telegraph in §3.9, then scale
0 → 1 over 150 ms, Back.out.

### 2.3 Tombstone

- 24 x 30 slab, top corners r12 (rounded top), fill `rubbleA` (#565d75),
  2 px `outline`.
- Engraving: 8 x 8 rounded (r2) marker in the disconnected player's slot
  color at (0, −6); two 8 x 2 `metalBand` line marks below it.
- Idle: one 2 px slot-color particle wisp rises 20 px and fades every 2 s.
- If it holds a bagged relic: 6 x 8 mini-gem `gold` at the base + glow r12,
  alpha 0.15. Reclaim channel shows the standard channel bar (§5) above it.
- Rejoin: tombstone flashes `white` alpha 0.6 for 120 ms, ring burst
  (r10 → 36, 2 px slot-color stroke, 250 ms), then despawns; player fades in
  alpha 0 → 1 over 200 ms at its position.

### 2.4 Relic (the unmistakable gold gem)

- Shape: **rhombus (diamond)**, 22 wide x 28 tall — the only diamond
  silhouette in the game.
- Facets: top quarter `goldLight`, middle half `gold`, bottom quarter
  `goldDark`; 1 px facet lines `#a86a0c` from the left/right points to the
  top and bottom points; 2 px `outline`.
- Glint: 4 x 4 `white` square at (−4, −8), alpha pulsing 0.6 → 1.0, 0.8 Hz.
- Glow: additive circle r26, `gold`, alpha 0.18 ± 0.06 pulse at 0.8 Hz
  (r39/0.26 at escalation ≥ 1, §1.4).
- Loose: bobs ±2 px, 1.4 s sine, resting 4 px above the floor contact point.
- Flying (`rs=3`): shimmer trail — 1 gold 2 px particle per 30 ms, life
  250 ms, fading, no gravity.
- Distinction from player 0 (both "gold"): relic is deeper amber
  (`#ffb52e` vs `#ffd23f`), diamond vs rounded rect, glowing, and never has
  an eye. Never render the relic as a rect.

### 2.5 Doors & barriers

Barrier affordance tags (baked into each intact texture):
- **Smash chevron tag** (has a loud/costly option): 14 x 8 tag at the top
  right of the barrier, three 45° stripes alternating `noise` / `outline`.
- **Quiet tag** (has a quiet/free option): 8 x 10 `steel` keyhole (6 px
  circle + 3 x 5 slot) at mid-height on the approach side.
  Most barriers carry both tags (loud vs quiet routes, CLAUDE.md).

**Smashable/pickable door** (`type:'door'`, −20 s smash / pick channel):
- 20 x 64 vertical door: fill `wood`, 3 vertical 1 px plank seams
  `woodDark` at x = 5, 10, 15; two metal bands 20 x 5 `metalBand` at
  y = 12 and 47, each with two 2 x 2 `inkDim` bolts. 2 px `outline`.
- Damage states (swap texture at HP thresholds): ≤ 66 % HP → one 1 px
  `outline` crack (jagged 3-segment line from top-left third); ≤ 33 % → a
  second crack from bottom-right + 2–3 splinter notches on the edges.
- Broken: static body disabled; texture swaps to two jamb strips 4 x 64
  `woodDark` (left/right edges only); debris burst (§3.4).

**Rubble** (`type:'rubble'`, −25 s blast / dig channel):
- 64 x 36 pile of 7 overlapping circles, radii 7–13, colors cycling
  `rubbleA/B/C`, 2 px `outline` on the silhouette only; 4 random 2 px
  `inkDim` fleck dots. Deterministic layout (seed by entity id).
- Broken: pile despawns; 16-particle blast (§3.4 rubble variant); leave a
  6 px `rubbleC` floor scuff strip for the rest of the run.

**Shortcut wall** (`type:'shortcut'`, −15 s break / pry channel):
- 24 x 48 block in platform colors (`surface` fill + `surfaceTop` top strip)
  but pre-cracked: two 1 px `outline` cracks + chevron tag → reads
  "breakable wall" vs normal terrain.
- Broken: despawn + debris in surface colors.

**Bridge** (`type:'bridge'`, −10 s kick):
- 80 x 10 plank: `wood` fill, 4 slat lines 1 px `woodDark` every 16 px,
  4 x 4 `metalBand` support pins at both ends. Chevron tag at one end.
- Kicked: tween rotation to 24° over 200 ms, then gravity-fall 500 ms while
  fading to alpha 0, then despawn + 4 dust puffs.

**Crank gate** (`type:'crankGate'`, 2-player quiet channel, no smash):
- Portcullis 24 x 64: four vertical 3 px bars `steelDark` at x = 3, 9, 15,
  21; three horizontal 2 px crossbars `steelDeep` at y = 12, 32, 52; bottom
  of each bar ends in a 4 px triangle spike. NO chevron tag (cannot smash).
- Crank wheels: 16 x 16 circle `steel` with four 2 px `inkFaint` spokes,
  mounted at both sides (the two channel stations). While channeling: wheel
  rotates 180°/s; each wheel shows a radial fill arc (r10, 3 px stroke) in
  its channeler's slot color.
- Gate rises with combined progress: y offset = −56 × `quietProgress`.
  Releases mid-channel: gate slides back down over 600 ms.

### 2.6 Hourglass pickup

- 18 x 24: frame = top/bottom caps 14 x 3 `steel` + two 2 px `steel` side
  struts; glass = two triangles meeting at the 2 px waist; upper sand
  `goldLight`, lower sand `gold`.
- Bob ±3 px, 1.2 s sine; one 2 px `goldLight` sparkle particle every 800 ms.
- Pickup: `white` flash 80 ms, ring burst r8 → 28 (`quiet`, 2 px, 250 ms),
  "+30s" toast in `quiet` (§5), despawn.

### 2.7 Ritual circle (4-player altar)

- Floor decal (depth 11), radius 46: outer circle 3 px `stun` stroke alpha
  0.6; inner circle r38, 1 px, alpha 0.4; four 6 x 6 `stun` squares rotated
  45° at N/E/S/W on the outer ring.
- Each active channeler lights a 90° arc (r42, 4 px stroke) in their slot
  color — 4 arcs = 4 quadrants (N/E/S/W assigned by slot order joining).
- Complete: `white` radial flash (circle r46, alpha 0.5 → 0, 200 ms), 12
  `stun` 3 px particles burst outward (speed 150–250, life 400 ms), "+60s"
  toast in `quiet`, then the decal desaturates to `rubbleA` (used, once per
  run).

### 2.8 Exit portal

- Arch 48 x 76: jamb = 8 px stone blocks `surfaceTop` with 2 px `outline`
  gaps (5 blocks per side + 3-block lintel).
- Inner void 32 x 64: fill `bgDeep`; three nested ellipses (28x56, 20x40,
  12x24) stroked 2 px `quiet` at alphas 0.5/0.3/0.2, rotating together at
  0.5 rev/s.
- Particles: 2 px `quiet` motes rising inside, rate 6/s, life 800 ms,
  vy −40.
- When the relic (carrier or loose) is within 120 px: ellipse alphas ×1.3,
  pulsing at 1.5 Hz — "bring it here".

### 2.9 Ready zone (lobby vault entrance)

- Floor area: 2 px dashed `quiet` border rect (8 px dash / 6 px gap), fill
  `quiet` alpha 0.06.
- Fill ring (all players inside): circle r30 at zone center, 4 px `quiet`
  arc sweeping 0 → 360° over the 3 s hold; stepping out drains the arc at 3×
  speed. On completion: `white` flash 120 ms + banner.

---

## 3. Motion & juice spec

All FX live in `fx/Fx.js`, keyed off existing events (plan §2.2); FX never
touch simulation state. Particle textures: `px2` (2 x 2), `px3` (3 x 3),
`px4` (4 x 4) white squares and `puff8` (8 px soft circle: 3 concentric
alphas 0.5/0.3/0.15), generated once; all colors via `tint`. Global cap:
**250 live particles**; every emitter sets explicit quantity and lifespans
below; when the cap is hit, skip cosmetic emits (dust first).

### 3.1 Grapple line + hook

- Beam: drawn per frame on one shared Graphics object (depth 40) from the
  owner's hand point (center + facing × 10, −2) to the tip: 3 px line in
  owner slot color, alpha 0.95, overlaid by a 1 px `ink` core line, alpha
  0.6. Straight line (zip-only, no sag).
- Hook tip: 7 x 7 diamond in slot color with 2 px `outline`, rotated to the
  beam angle.
- Fire: tip extends visually at 3000 px/s toward the target (cosmetic; host
  events decide attachment).
- Attach: 6 × `px2` `ink` sparks, speed 120–220, life 200 ms, no gravity;
  attach-to-terrain adds no shake (grapple is quiet-ish; its noise event
  still ripples, §3.5).
- Detach/release: beam alpha → 0 over 100 ms, then cleared.

### 3.2 Zip trail

While a player is zipping (grapple to infinite mass, moving > 400 px/s):
- Afterimages: every 50 ms spawn a ghost copy of the player body texture at
  the current position, slot color, alpha 0.22, no outline/eye, fading to 0
  over 240 ms. Max 5 live ghosts per player.
- Streaks: 2 px slot-color particles, rate 20/s, life 150 ms, emitted
  opposite to velocity at 40–80 px/s.

### 3.3 Impact particles (hits)

| Event | Count | Tex | Colors | Speed px/s | Life ms | Gravity |
|---|---|---|---|---|---|---|
| Dagger hit | 4 | px2 | `ink` | 80–160 | 150 | none |
| Hammer hit | 8 | px3 | 5 × `ink`, 3 × `noise` | 140–260 | 250 | 600 |
| Monster hits player | 8 | px3 | `danger` | 120–240 | 250 | 600 |
| Grapple impact | 6 | px2 | `ink` | 120–220 | 200 | none |
| FF heavy (hammer on teammate) | as hammer hit + victim `white` flash 60 ms | | | | | |

Emission cone: away from the hit normal, 100° spread. Weapon swing arcs:
hammer = 90° arc r30, 4 px stroke `ink` alpha 0.5 fading 120 ms; dagger =
50° arc r20, 2 px stroke, fading 80 ms.

### 3.4 Door-smash debris

On `doorState` → broken (or per Brute/hammer hit at HALF counts):
- Debris: 12 rects, random 3–6 px, colors sampled from the barrier's palette
  (door: `wood`/`woodDark`/`metalBand`; rubble: `rubbleA/B/C`; shortcut:
  `surface`/`surfaceShade`), initial speed 150–350 in an up-biased 120°
  cone, world gravity (1400), spin ±720°/s, life 700 ms, fade over the last
  200 ms.
- Dust: 6 × `puff8` `inkDim`, alpha 0.3, rise 30 px, life 500 ms, scale
  1 → 1.6.
- Rubble blast uses 16 debris instead of 12.
- Plus medium shake (§3.6) and the noise ripple (§3.5) fired by the same
  event's noise amount.

### 3.5 Noise-burst ripple (the gauge feed, visualized)

Every `noiseBurst {x, y, amount}` event draws expanding rings at (x, y),
depth 50, `noise` color — **ring size is proportional to gauge fill added**:

- Ring 1: stroke 2 px, radius 6 → (6 + amount × 3) px (clamp 90), over
  350 ms, Quad.out, alpha 0.85 → 0.
- amount ≥ 15: Ring 2, same target radius, 120 ms delayed, 3 px stroke.
- amount ≥ 30 (door smash): Ring 3 at +240 ms + medium shake.

So sprint ticks whisper (r ≈ 15), hammer hits shout (r ≈ 24), door smashes
scream (r = 90, triple ring). The HUD gauge (§5) blips +amount at the same
moment — players learn the economy by eye.

### 3.6 Screen shake (Phaser `camera.shake(duration, intensity)`)

| Tier | Duration | Intensity | Triggers |
|---|---|---|---|
| Small | 80 ms | 0.002 | hammer hit lands, hard landing (no stun), Brute footfall within 200 px of camera center |
| Medium | 150 ms | 0.004 | door/shortcut smash, monster spawn, Brute slam, LOCAL player stunned |
| Large | 250 ms | 0.008 | rubble blast, floor collapse |
| Calamity | 600 ms | 0.010 | clock hits zero (lose) |

Rule: shakes never stack — a new request only restarts the shake if its tier
≥ the running one.

### 3.7 Stun stars

- 3 four-point stars (8 px, `stun` fill, 1 px `outline`), orbiting an
  ellipse rx 14 / ry 5 centered 24 px above the stunned head; period 900 ms,
  120° phase offsets, each spinning 180°/s, alpha 0.9, depth 60.
- Recovery: stars fade out 150 ms; body does a `white` tint flash 80 ms and
  the container tweens rotation back to 0 over 120 ms.

### 3.8 Landing dust & squash-stretch

Dust (at the feet, `puff8` `inkDim` alpha 0.35, vx ±40–90 outward, vy −20,
life 400 ms, scale → 0):

| Landing (impact |vy|) | Puffs | Extra |
|---|---|---|
| Soft 300–700 px/s | 4 | — |
| Hard > 700 px/s | 8 | small shake, hard-land noise ripple |
| Stun landing | 10 | medium shake handled by stun event |

Squash & stretch (tween the container scale; physics body untouched):
- Jump takeoff: (0.82, 1.18) → (1, 1) over 140 ms, Quad.out.
- Land soft: (1.22, 0.78) → (1, 1) over 160 ms, Back.out.
- Land hard/stun: (1.30, 0.70) → (1, 1) over 200 ms, Back.out.
- Throw (carrier): (1.10, 0.90) → (1, 1) over 100 ms.
- Boost jump off a head: BOTH players squash — bottom (1.2, 0.8), top gets
  the takeoff stretch.

### 3.9 Monster spawn telegraph

Starting 700 ms before the spawn point activates (NoiseSystem announces via
`monsterSpawn` event; FX plays telegraph then spawn):
- Pulsing circle r28 fill `danger`, alpha 0 → 0.35 → 0, three 233 ms pulses.
- 8 × `px2` `danger` particles converging from r48 to r8 over the 700 ms.
- Spawn moment: ring burst r10 → 40 (2 px `danger` stroke, 150 ms), medium
  shake, monster scales in (§2.2), HUD noise gauge flashes `white` 2 frames.

### 3.10 Clock urgency & collapse

Clock text (HUD, §5):
- \> 6:00 — `ink`, static.
- ≤ 6:00 — `noise` color; scale pulse 1.00 → 1.05 → 1.00 over 200 ms at
  every whole minute.
- ≤ 3:00 — `danger`; per-second pulse 1.00 → 1.08 over 120 ms.
- ≤ 0:30 — additionally: urgency vignette (depth 95): edge gradient
  `danger` alpha 0.10 ± 0.05 pulsing at 1 Hz; clock flashes `white` each
  second tick.

Collapse-marked platform sequence (escalation 2, per platform, host decides
timing; FX renders): warn 1200 ms — tint flash to `danger` 150 ms every
400 ms (3 flashes) + pebble drip (2 px `rubbleA` particles, rate 8/s) →
crumble: platform splits into 8 rects (w/4 × h/2 each), which fall under
gravity with spin ±360°/s, fading over 600 ms; large shake if on-screen.

Time toasts (§5): every `timeCost` event floats "−20s" in `noise` (16 px)
from the cause position, rising 30 px over 900 ms, fading after 600 ms;
`timeGain` same in `quiet` ("+30s"/"+60s").

### 3.11 Win / lose full-screen moments

- Win: vault-door slam — full-screen `bgDeep` rect wipes down over 250 ms,
  Quad.in, then results; 40 confetti rects (3 x 6 px, the four slot colors +
  `gold`), falling with gravity 300, spin, life 2500 ms on the results
  screen.
- Lose (calamity): calamity shake (§3.6); screen tints `danger` alpha
  0 → 0.35 over 600 ms while 20 debris rects fall across the screen; then
  desaturate overlay (`bgDeep` alpha 0.5) under the results panel.

---

## 4. Depth & readability rules

### 4.1 setDepth plan (normative table)

| Depth | Content |
|---|---|
| 0 | L2 far background |
| 5 | L1 mid background |
| 10 | L0 terrain platforms |
| 11 | Floor decals: ritual circle, ready zone, collapse warnings, rubble scuffs |
| 12 | Doors, rubble, shortcut walls, bridges, crank gates (+ wheels) |
| 14 | Exit portal, tombstones, hourglass pickups |
| 18 | Relic (loose / flying) |
| 20 | Brute |
| 21 | Skulker (small must not hide behind big) |
| 30 | Remote players (containers) |
| 31 | Local player (always wins player-vs-player overlap on your own screen) |
| 40 | Grapple beams + hooks |
| 50 | Gameplay particles, ripples, debris, swing arcs |
| 60 | Overhead world UI: name labels, channel bars, stun stars, mash prompt |
| 70 | Ping markers + off-screen indicators |
| 90 | Escalation dim overlay (91 collapse vignette) — scrollFactor 0 |
| 95 | Urgency vignette (≤ 0:30) — scrollFactor 0 |
| 100+ | HUD — lives in UIScene, which renders above GameScene entirely |

Carried relic/bag/eye/glow are container children of their player, so they
inherit the player's depth — never set depth on accessories.

### 4.2 Readability rules (4 players + monsters in chaos)

1. **Baked outlines:** every dynamic entity has a 2 px `outline` (#12141c)
   outline in its texture (Brute 3 px). Backgrounds may never use colors
   within the entity families (§1.3), so silhouettes always separate.
2. **Shape = faction:** players are rounded rects with ONE big white eye;
   monsters are crimson, angular/organic with TWO small white eyes; the
   relic is the only diamond; barriers are the only wood/steel objects.
   Color-blind safety comes from shape + outline, not hue alone.
3. **Name labels:** 10 px `'Courier New', monospace`, text in slot color,
   stroke `#0b0d14` thickness 3, at (0, −30) over each head, alpha 0.75.
   Lobby: shown for everyone. In-run: hidden for the local player, shown
   for remotes. Label hides while its channel bar (below) is visible.
4. **Channel bars:** 26 x 5 bar at (0, −30): bg `panel` alpha 0.8, 1 px
   `panelBorder` border, fill color by channel type — quiet door/crank/dig
   `quiet`; revive `stun`; bag/unbag/reclaim `gold`; ritual `stun`. Same
   style at 32 x 5 over doors for their quiet progress.
5. **Ping markers:** 10 px inverted triangle in pinger's slot color +
   double ring pulse r8 → 20 (2 px stroke, 2 pulses), lives 4 s, depth 70.
   Off-screen: clamp to screen edge, 12 px inset, as an 8 px triangle
   pointing outward, alpha 0.8.
6. **Off-screen teammates:** same edge-triangle treatment (slot color,
   alpha 0.6) whenever a living teammate is outside the camera view;
   stunned teammates' triangles blink at 2 Hz with a mini stun star.
7. **Status is overlay, not tint** (§1.3 rule 6): carrying = visible
   gem/bag; channeling = bar; sprinting = dust; stunned = the ONLY tint.
8. **FX budget:** no per-frame texture generation; one shared Graphics for
   all beams, one for ripples; particle cap 250 (§3); tween-based flashes
   reuse `setTintFill`/alpha (no new objects). Target: 60 fps with 4
   players + 3 monsters + a door smash on a mid laptop.
9. **Camera:** smooth-follow local player, lerp 0.12/0.12, lookahead
   40 px in facing direction, deadzone 120 x 80. `roundPixels: true` to
   keep 1 px lines crisp.

---

## 5. HUD & UI styling (for ui/ files)

Font everywhere: `'Courier New', monospace` (system font — no asset).
Panels: `panel` fill alpha 0.92, 1 px `panelBorder` border, 8 px padding,
corner radius 4 (Graphics-drawn).

- **Clock:** top center, 22 px `ink`, colors/pulses per §3.10. Format
  `M:SS`.
- **Noise gauge:** top right, 180 x 12 bar: bg `panel` alpha 0.8, 1 px
  `panelBorder`, fill `noise`, tick marks at 25/50/75 % (1 px
  `panelBorder`). On each `noiseBurst`: the newly-added segment flashes
  `white` for 2 frames. At ≥ 80 %: whole fill blinks alpha 1 → 0.6 at 2 Hz.
  On spawn (gauge halves): bar flashes `danger` 150 ms then snaps to half.
- **Weapon/carry icons:** bottom left, 24 x 24 slots: hammer/dagger glyphs
  drawn in `ink` 2 px strokes; carry slot shows mini relic gem or bag icon.
- **Toasts:** bottom center stack, 12 px `ink` on `panel`; time toasts use
  `noise`/`quiet` per §3.10; join/leave/rejoin use `inkDim`.
- **Phase banner:** center, 26 px `ink`, letter-spacing 2 px, on a
  full-width `panel` alpha 0.7 strip 48 px tall; slides in from top 150 ms,
  holds 1200 ms, fades 300 ms. ("STEAL THE RELIC — GO", escalation
  banners per §1.4.)
- **Mash prompt (stunned, local):** "MASH ⟷" 12 px `stun` at (0, −34)
  over the player, scale-pulsing 1.0 → 1.1 at 4 Hz, plus a 20 x 4 recovery
  bar (`stun` fill) that fills as stun time burns down.
- **Menu/lobby buttons:** text `inkDim`, hover/selected `ink` + 2 px
  `surfaceTop` underline; disabled `inkFaint`. Room code display: 28 px
  `ink`, letter-spaced 6 px, on a panel. Roster rows: 12 px name in slot
  color + connection dot (`quiet` = connected, `danger` = tombstoned).
- **Results:** panel per §5 base; "WIN"/"LOSE" 32 px in `quiet`/`danger`;
  stats rows 12 px `ink` / labels `inkDim`; "Most Ruinous Player" row
  highlighted with a 1 px `noise` border and the winner's slot color name.

---

## 6. Texture key registry (fx/textures.js)

Generate once in `ensureTextures(scene)`; keys are normative so entities and
FX agree: `player0..player3` (body), `playerEye`, `playerEyeX`,
`playerBag0..3`, `relic`, `skulker`, `brute`, `bruteFist`, `doorIntact`,
`doorCrack1`, `doorCrack2`, `doorBroken`, `rubblePile`, `shortcutWall`,
`bridge`, `crankGate`, `crankWheel`, `tombstone0..3`, `hourglass`,
`portalArch`, `px2`, `px3`, `px4`, `puff8`, `star8` (stun star),
`vignetteCollapse`, `vignetteDanger`. Decals (ritual circle, ready zone,
beams, ripples, arcs) are drawn with shared Graphics objects, not textures.
