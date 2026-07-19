// ============================================================
// GameScene — THE gameplay scene for lobby AND run, in three modes
// (plan §3.1): 'host' | 'client' | 'solo'.
//
//   host:   runs the Sim, applies remote input buffers, serves snapshots
//   client: sends input frames, renders interpolated snapshots (~100 ms
//           behind host) — NO local gameplay logic (locked: no prediction)
//   solo:   host without a transport
//
// No game rules live here long-term — systems only (WP2 extracts
// movement into MovementSystem; until then _applyMovement is the interim
// multi-player port of the step-1 movement code).
// ============================================================

import {
  CLOCK, PLAYER, STAGES, READY, UI, COLORS, FX,
} from '../config.js';
import { ensureTextures } from '../fx/textures.js';
import { Fx } from '../fx/Fx.js';
import { setupCamera } from '../fx/camera.js';
import { WorldHUD } from '../ui/HUD.js';
import { InputManager } from '../input/InputManager.js';
import { getMap, spawnFor } from '../maps/mapTypes.js';
import { Sim } from '../sim/Sim.js';
import {
  serializeWorld, applySnapshot, applyMonsterSnapshot, applyRelicSnapshot,
  decodeGrappleRows, buildReplay,
} from '../sim/snapshot.js';
import { applyEvent } from '../sim/events.js';
import { PHASE } from '../net/Session.js';
import { EV } from '../net/protocol.js';
import { createPlayer, updatePlayerCosmetics, destroyPlayer } from '../entities/PlayerEntity.js';
import { createRelic, updateRelicCosmetics } from '../entities/RelicEntity.js';
import { createDoor } from '../entities/DoorEntity.js';
import { createPickup } from '../entities/PickupEntity.js';
import { createMonster, updateMonsterCosmetics } from '../entities/MonsterEntity.js';
import { PvPCollisionSystem } from '../systems/PvPCollisionSystem.js';
import { MovementSystem } from '../systems/MovementSystem.js';
import { GrappleSystem } from '../systems/GrappleSystem.js';
import { CarrySystem } from '../systems/CarrySystem.js';
import { RelicSystem } from '../systems/RelicSystem.js';
import { FallStunSystem } from '../systems/FallStunSystem.js';
import { StunSystem } from '../systems/StunSystem.js';
import { InteractSystem } from '../systems/InteractSystem.js';
import { DoorSystem } from '../systems/DoorSystem.js';
import { ClockSystem } from '../systems/ClockSystem.js';
import { NoiseSystem } from '../systems/NoiseSystem.js';
import { CombatSystem } from '../systems/CombatSystem.js';
import { MonsterSystem } from '../systems/MonsterSystem.js';
import { ReadyZoneSystem } from '../systems/ReadyZoneSystem.js';
import { PingSystem } from '../systems/PingSystem.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  /** @param {{mode:'host'|'client'|'solo', mapId:string, session, net}} data */
  init(data) {
    this.mode = data.mode || 'solo';
    this.mapId = data.mapId || 'lobby';
    this.session = data.session;
    this.net = data.net || null;
  }

  create() {
    // WP7: generate-once, idempotent, ~0 ms after the first call. Placed
    // at the TOP of create() because GameScene is the only scene that
    // draws world art AND the scene that restarts — every entry path
    // (menu→lobby, lobby→playing, playing→lobby, client join, rejoin
    // replay) is covered by construction, with no ordering hazard.
    // Textures live on Phaser.Game.textures, so scene.restart() never
    // touches them: no regeneration, no leak, no key collision.
    ensureTextures(this);
    this.map = getMap(this.mapId);
    this.inputManager = new InputManager(this);

    // ----- world + camera bounds (WP5, ALL modes) -----
    // map.width/height ARE the world size (may exceed the 960×540
    // viewport from WP5 on; the lobby stays viewport-sized → static cam).
    const worldW = this.map.width;
    const worldH = this.map.height;
    this.physics.world.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    // ----- backgrounds (two GameObjects for the ENTIRE world) -----
    // TileSprite on WebGL is one quad with a repeating sampler, so world
    // size costs nothing beyond what is on screen. Contrast ladder
    // L2 < L1 < L0 < entities is fixed (art-spec §1.2).
    this.add.tileSprite(worldW / 2, worldH / 2, worldW, worldH, 'tileFar')
      .setDepth(FX.depth.bgFar);
    this.add.tileSprite(worldW / 2, worldH / 2, worldW, worldH, 'tileMid')
      .setDepth(FX.depth.bgMid).setAlpha(0.85);

    // ----- static level -----
    // TileSprite (not Image): its width/height ARE the logical size, so
    // getBounds() stays exact for GrappleSystem._terrainRects (the raycast
    // source of truth) and the static body derives exactly as the old
    // add.rectangle did. setTilePosition aligns every platform to ONE
    // world brick grid, so adjacent platforms line up and no two show the
    // same crop — variation for zero per-frame cost, deterministic on
    // host and client alike.
    this.platforms = this.physics.add.staticGroup();
    // Edge lighting collapses ~35 highlight GameObjects into ONE Graphics
    // with ~70 baked fillRects, drawn at create and never again — a net
    // reduction in scene objects versus WP6.
    this.terrainGfx = this.add.graphics().setDepth(FX.depth.terrain + 0.5);
    const collapse = new Set(this.map.collapseIdx ?? []);
    this.map.platforms.forEach(([x, y, w, h], i) => {
      // Escalation-2 collapse platforms are MARKED from frame one
      // (cracked tile). The crumble mechanic itself needs a host-side
      // scheduler + a per-platform event = a gameplay change; deferred.
      const key = collapse.has(i) ? 'tileWallCracked' : 'tileWall';
      const ts = this.add.tileSprite(x + w / 2, y + h / 2, w, h, key)
        .setDepth(FX.depth.terrain);
      ts.setTilePosition(x % FX.tile.size, y % FX.tile.size);
      this.platforms.add(ts);
      this.terrainGfx.fillStyle(COLORS.surfaceTop, 1).fillRect(x, y, w, 3);
      this.terrainGfx.fillStyle(COLORS.surfaceShade, 1).fillRect(x, y + h - 2, w, 2);
    });

    // ----- world furniture: doors + pickups + labels (ALL modes) -----
    // Both host and client build these from map data; only state changes
    // ride events (doorState / despawn / pickupState) — plan §2.5.
    this.doors = new Map();   // id -> door GO
    this.pickups = new Map(); // id -> pickup GO
    const withBody = this.mode !== 'client';
    if (withBody) this.doorsGroup = this.physics.add.staticGroup();
    for (const def of this.map.doors ?? []) {
      const d = createDoor(this, def, withBody);
      this.doors.set(def.id, d);
      if (withBody) this.doorsGroup.add(d);
    }
    for (const def of this.map.pickups ?? []) {
      this.pickups.set(def.id, createPickup(this, def));
    }
    // Tombstones (WP5, ALL modes): id 't<slot>' -> tombstone GO. Created
    // by RelicSystem (host) / the TOMBSTONE event (clients + replay).
    this.tombstones = new Map();
    // Relic from map data (WP5, ALL modes — level furniture like doors;
    // no spawn event). Absent relicSpawn (lobby) ⇒ no relic.
    this.relic = null;
    if (this.map.relicSpawn) {
      const [rx, ry] = this.map.relicSpawn;
      this.relic = createRelic(this, rx, ry, withBody);
      if (withBody) {
        // NO relic×player collider (pickup is grab-range, not contact).
        this.physics.add.collider(this.relic, this.platforms);
        this.physics.add.collider(this.relic, this.doorsGroup);
      }
    }
    // Exit portal (art-spec §2.8): pure dressing, derived from EXISTING
    // map data (exitZone bottom-center). NO body, NO interaction —
    // RelicSystem's win check stays the rect test it already is.
    if (this.map.exitZone) {
      const [ex, ey, ew, eh] = this.map.exitZone;
      const px = ex + ew / 2, py = ey + eh - 38;
      this.add.image(px, py, 'portalArch').setDepth(FX.depth.furniture);
      this.portalRings = this.add.image(px, py, 'portalRings')
        .setDepth(FX.depth.furniture + 1);
    }
    for (const l of this.map.labels ?? []) {
      this.add.text(l.x, l.y, l.text, {
        fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#565d75',
      }).setOrigin(0.5).setDepth(FX.depth.decal);
    }
    // WP6 (contract W14): ready-zone gold floor strip + label, drawn from
    // map data on ALL modes (the ring itself is LobbyUI's).
    if (this.map.readyZone) {
      const z = this.map.readyZone;
      this.add.rectangle(z.x + z.w / 2, z.y + z.h - 4, z.w, 8, 0xffd23f, 0.35)
        .setDepth(FX.depth.decal);
      this.add.text(z.x + z.w / 2, z.y + z.h + 6, 'VAULT ENTRANCE', {
        fontFamily: 'Courier New, monospace', fontSize: '10px', color: '#565d75',
      }).setOrigin(0.5).setDepth(FX.depth.decal);
    }

    // ----- grapple beams (one Graphics, redrawn every frame, all modes) -----
    this.beamGfx = this.add.graphics().setDepth(FX.depth.beam);
    this._beamRows = []; // last-drawn rows (debug overlay)

    // ----- monsters map (ALL modes; host shares the sim GOs, client holds
    // views — mirrors this.players). Map-declared monsters (lobby dummy)
    // are level furniture: the CLIENT builds views from map data here;
    // host/solo MonsterSystem.init creates the simulated ones.
    this.monsters = new Map();
    if (this.mode === 'client') {
      for (const def of this.map.monsterSpawns ?? []) {
        this.monsters.set(def.id, createMonster(this, def.id, def.type, def.x, def.y, false,
          { dummy: !!def.dummy })); // dummy flag drives the DUMMY nameplate
      }
    }

    // ----- players + sim -----
    /** slot -> player GameObject (host/solo: simulated; client: view) */
    this.players = new Map();
    if (this.mode === 'client') {
      for (const p of this.session.allPlayers()) this._addPlayer(p.slot);
    } else {
      this.playersGroup = this.add.group();
      this.monstersGroup = this.add.group(); // before MonsterSystem.init (colliders)
      this.sim = new Sim(this, this.session);
      // Host/solo: copy world-furniture refs into the sim collections.
      for (const [id, d] of this.doors) this.sim.doors.set(id, d);
      for (const [id, pk] of this.pickups) this.sim.pickups.set(id, pk);
      this.sim.relic = this.relic; // null on relic-less maps (lobby)
      // Tick order per plan §3.2 / WP4 contract §0.8 (PvP bookkeeping
      // first: it converts the previous physics step's contacts into
      // rider/stack state):
      // PvP, Movement, Grapple, Carry, Combat, FallStun, Stun, Monster,
      // Door, Interact, ReadyZone (lobby, self-gated), Clock, Noise,
      // Ping (last — order-insensitive, reads inputs only).
      this.sim.registerSystem(new PvPCollisionSystem());
      this.sim.registerSystem(new MovementSystem());
      this.sim.registerSystem(new GrappleSystem());
      this.sim.registerSystem(new CarrySystem());
      this.sim.registerSystem(new RelicSystem()); // plan §3.2 pos 4 (with
      //    Carry): pin-after-carry ordering + the per-tick mass seam
      this.sim.registerSystem(new CombatSystem());
      this.sim.registerSystem(new FallStunSystem());
      this.sim.registerSystem(new StunSystem());
      this.sim.registerSystem(new MonsterSystem()); // init adds the
      //    monsters×doorsGroup collider (contract §0.5) + map monsters
      this.sim.registerSystem(new DoorSystem());
      this.sim.registerSystem(new InteractSystem());
      this.sim.registerSystem(new ReadyZoneSystem()); // plan §3.2 group 9
      this.sim.registerSystem(new ClockSystem());
      this.sim.registerSystem(new NoiseSystem());
      this.sim.registerSystem(new PingSystem());
      for (const p of this.session.allPlayers()) this._addPlayer(p.slot);
      if (this.net) {
        this.net.getState = () => serializeWorld(this.sim);
        this.net.getReplay = () => buildReplay(this.sim);
      }
    }
    this.worldRow = null; // latest snapshot world row (client HUD)

    // ----- camera (WP7: roundPixels + deadzone + lerped lookahead) -----
    // setupCamera keeps the WP5 engage condition byte-for-byte (follow only
    // when the map exceeds the viewport), so the lobby camera stays static
    // and every WP6 world==screen assumption still holds there.
    setupCamera(this);

    // ----- world-space UI (WP6): prompts, pings, ripples, aim, labels -----
    // Created BEFORE the net-handler registration + client backlog drain
    // (replayed events reach its hooks). Scene-owned; destroy() on
    // shutdown only restores the OS cursor.
    this.lastInputFrame = null; // poll() consumes edges — cached once per frame
    this.worldUI = new WorldHUD(this);
    // FX AFTER worldUI (so the NOISE_BURST handler's fx-wins branch has a
    // live Fx to hit) and BEFORE the client backlog drain (replayed events
    // must reach it, gated by net._replayDone). Never throws; safe in
    // every mode, including a headless harness scene.
    this.fx = new Fx(this);
    this.fx.attachLocal(this.players.get(this.session.localSlot));

    // ----- UI overlay -----
    this.scene.launch('UI', { session: this.session, mode: this.mode });

    // ----- net events (single transition code path for all modes) -----
    this._netHandlers = {
      'net:phase': (p) => this._onPhase(p),
      'net:join': (p) => this._onJoin(p),
      'net:leave': (p) => this._onLeave(p),
      'net:roster': () => this._onRoster(),
      // Every applied event is also relayed as 'ui:event' (WP6 contract
      // §3.5) — the single seam the UIScene toast catalog/HUD hang off.
      'net:event': (ev) => {
        applyEvent(this, ev);
        this.game.events.emit('ui:event', ev);
      },
      'net:closed': (p) => this._onClosed(p),
      // WP6 UI→scene seam: widgets emit game.events 'ui:action'
      // {action, ...args} and stay net-free (see _onUiAction).
      'ui:action': (a) => this._onUiAction(a),
    };
    for (const [name, fn] of Object.entries(this._netHandlers)) {
      this.game.events.on(name, fn);
    }
    if (this.mode === 'client') {
      // Drain world events buffered while no scene listened — the join/
      // rejoin replay burst (doorState, monster spawns, escalation) and
      // anything that raced a phase restart. Order preserved (ctl).
      for (const msg of this.net.attachScene()) {
        applyEvent(this, msg);
        this.game.events.emit('ui:event', msg); // replay reaches the HUD too
      }
    }
    this.events.once('shutdown', () => {
      for (const [name, fn] of Object.entries(this._netHandlers)) {
        this.game.events.off(name, fn);
      }
      // The 20 Hz snapshot timer keeps running across scene restarts —
      // never let it serialize a torn-down sim's destroyed bodies. Same
      // for the rejoin-replay builder.
      if (this.net) {
        this.net.getState = null;
        this.net.getReplay = null;
      }
      if (this.mode === 'client') this.net.detachScene();
      this.worldUI.destroy(); // restores the OS cursor; GOs die with the scene
      // Phase restarts cycle this scene constantly; an un-killed tween or
      // timer here decays fps ACROSS rounds, which is the hardest kind of
      // leak to notice. destroy() kills both and nulls this.fx.
      this.fx?.destroy();
      this.scene.stop('UI');
    });

    // ----- host debug phase keys (KEPT — the acceptance harnesses drive
    // phases with these; WP6 added the PLAYER-facing triggers: the ready
    // zone starts the run, the results button returns to the lobby.
    // L routes through the same _returnToLobby path as the button so the
    // debug shortcut and the player path stay behaviorally identical.)
    if (this.mode !== 'client') {
      this.input.keyboard.on('keydown-P', () => {
        if (this.session.phase === PHASE.LOBBY) {
          this._setPhase(PHASE.PLAYING, {
            stageId: this.session.stageId, clockMs: CLOCK.sessionMs,
          });
        }
      });
      this.input.keyboard.on('keydown-R', () => {
        if (this.session.phase === PHASE.PLAYING) {
          this._setPhase(PHASE.RESULTS, this.sim.stats.toResultsPayload(
            'win', 'debug', this.session, this.sim.world.clockMsLeft,
          ));
        }
      });
      this.input.keyboard.on('keydown-L', () => this._returnToLobby());
    }

    // ----- debug overlay + leave -----
    this.debugText = this.add.text(8, 8, '', {
      fontFamily: 'Courier New, monospace', fontSize: '11px', color: '#565d75',
    }).setDepth(100).setScrollFactor(0).setVisible(false);
    this.showDebug = false;
    this.input.keyboard.on('keydown-F3', () => {
      this.showDebug = !this.showDebug;
      this.debugText.setVisible(this.showDebug);
    });
    // ESC leaves. During a RUN it needs a confirming second press: on the
    // host a single mis-press ends the run for all four players (there is
    // no host migration), which is too much to hang on one key.
    this._escArmedUntil = 0;
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.session.phase !== PHASE.PLAYING) return this._leave(null);
      const now = this.time.now;
      if (now < this._escArmedUntil) return this._leave(null);
      this._escArmedUntil = now + UI.escConfirmMs;
      this.game.events.emit('ui:toast:dim', this.mode === 'client'
        ? 'PRESS ESC AGAIN TO LEAVE THE RUN'
        : 'PRESS ESC AGAIN TO END THE RUN FOR EVERYONE');
    });
  }

  // ---------------- players ----------------

  /** @param {[number, number]|null} at WP5: spawn override (tombstone rejoin) */
  _addPlayer(slot, at = null) {
    if (this.players.has(slot)) return this.players.get(slot);
    const [sx, sy] = at || spawnFor(this.map, slot);
    const p = createPlayer(this, slot, sx, sy, this.mode !== 'client');
    // art-spec §4.1: the local player always wins player-vs-player overlap
    // on your own screen. Accessories are container children and inherit.
    p.setDepth(slot === this.session.localSlot ? FX.depth.local : FX.depth.remote);
    if (this.mode !== 'client') {
      this.physics.add.collider(p, this.platforms);
      this.physics.add.collider(p, this.doorsGroup); // intact doors are walls
      this.playersGroup.add(p);
      this.sim.players.set(slot, p);
    }
    this.players.set(slot, p);
    // The camera follows a GameObject reference, and rejoin DESTROYS the
    // old view — re-point it or the camera keeps chasing a dead object.
    if (slot === this.session.localSlot) this.fx?.attachLocal(p);
    return p;
  }

  _removePlayer(slot) {
    const p = this.players.get(slot);
    if (!p) return;
    if (slot === this.session.localSlot) this.fx?.attachLocal(null);
    destroyPlayer(p);
    this.players.delete(slot);
    this.sim?.players.delete(slot);
    this.sim?.setInput(slot, null);
  }

  // ---------------- net event handlers ----------------

  _setPhase(phase, data) {
    if (this.net) {
      this.net.setPhase(phase, data); // broadcasts + re-emits 'net:phase'
    } else {
      this.session.phase = phase;
      this.game.events.emit('net:phase', { phase, data });
    }
  }

  /**
   * WP6 UI→scene action seam. UI widgets (Engineer #2) emit
   * game.events 'ui:action' and never touch net/sim directly:
   *   {action:'returnLobby'}     host/solo, RESULTS only — results button
   *   {action:'exitSession'}     any mode — results [ EXIT ] / leave
   *   {action:'kick', slot}      host, LOBBY only — roster kick-hold
   */
  _onUiAction({ action, slot }) {
    switch (action) {
      case 'returnLobby':
        return this._returnToLobby();
      case 'exitSession':
        return this._leave(null);
      case 'kick':
        if (this.mode === 'host' && this.session.phase === PHASE.LOBBY) {
          this.net.kick(slot);
        }
        return;
    }
  }

  /**
   * results → lobby (host/solo authority; the debug L key and the
   * results button share this path). Purges disconnected slots first —
   * tombstone reservation is a MID-RUN contract; returning to lobby ends
   * the run, so reservations expire (ghost rows would block fresh joins
   * forever). Roster broadcast BEFORE the phase message (same ordered
   * ctl): clients rebuild the lobby scene from a clean roster.
   */
  _returnToLobby() {
    if (this.mode === 'client') return;
    if (this.session.phase !== PHASE.RESULTS) return;
    this.session.purgeDisconnected();
    if (this.net) this.net.broadcastRoster();
    else this.game.events.emit('net:roster', {});
    this._setPhase(PHASE.LOBBY, null);
  }

  /**
   * WP6 stage board: the sim's STAGE_CYCLE (intercepted in the drain,
   * never broadcast) lands here. session.stageId mutates host-side only;
   * the roster message is the single wire truth — clients mirror it via
   * applyRoster and the UI half derives the "STAGE: <NAME>" toast from
   * the 'net:roster' diff.
   */
  _cycleStage() {
    const i = STAGES.indexOf(this.session.stageId);
    this.session.stageId = STAGES[(i + 1) % STAGES.length];
    if (this.net) this.net.broadcastRoster();
    else this.game.events.emit('net:roster', {}); // solo: same UI code path
  }

  _onPhase({ phase, data }) {
    if (phase === PHASE.PLAYING) {
      const stageId = data?.stageId || this.session.stageId;
      this.net?.resetInterpolation?.();
      this.scene.restart({ mode: this.mode, mapId: stageId, session: this.session, net: this.net });
    } else if (phase === PHASE.LOBBY && this.mapId !== 'lobby') {
      this.net?.resetInterpolation?.();
      this.scene.restart({ mode: this.mode, mapId: 'lobby', session: this.session, net: this.net });
    } else if (phase === PHASE.RESULTS) {
      // No restart — the world idles behind the modal. Release the camera
      // here rather than only on RUN_OVER so the debug R key and a real
      // run end behave identically: a camera drifting behind a results
      // panel is noise, and following a body nobody is driving is worse.
      this.fx?.attachLocal(null);
    }
  }

  _onJoin({ slot, name, rejoined }) {
    if (this.mode === 'host') {
      // Tombstone rejoin (WP5): respawn AT the stone, restore a bagged
      // relic to the rejoiner's bag, despawn the stone.
      const at = rejoined ? this.sim.relicSys?.tombstoneSpawn(this.sim, slot) : null;
      const p = this._addPlayer(slot, at);
      if (rejoined) this.sim.relicSys?.consumeTombstone(this.sim, slot, p);
      // WP6: joined/left toasts now derive from the roster diff on every
      // peer (UIScene) — the WP1 host-pushed TOAST broadcasts are gone.
      // HostNet only broadcasts REJOINED (never applies it locally), so
      // the host's own "<NAME> IS BACK" rides the ui:event seam here.
      if (rejoined) this.game.events.emit('ui:event', { kind: EV.REJOINED, slot });
    }
  }

  _onLeave({ slot, phase }) {
    if (this.mode !== 'host') return;
    if (phase === PHASE.LOBBY) {
      this._removePlayer(slot);
    } else if (phase === PHASE.PLAYING) {
      // WP5 tombstone rules replace the WP4 inert placeholder. The
      // PLAYING gate matters: a RESULTS-phase disconnect must not drain
      // tombstone events into a frozen run.
      this.sim.relicSys?.playerDisconnected(this.sim, slot);
    } else {
      // RESULTS: keep the old behavior (slot reserved, body idles).
      this.sim.setInput(slot, null);
    }
    // WP6: no host-pushed toast — lobby leaves toast via the roster diff
    // ("<NAME> LEFT", UIScene) and mid-run disconnects via the TOMBSTONE
    // event ("<NAME> DISCONNECTED — TOMBSTONE PLACED").
  }

  _onRoster() {
    // Reconcile local player objects with the authoritative roster.
    const present = new Set(this.session.allPlayers().map((p) => p.slot));
    for (const slot of [...this.players.keys()]) {
      if (!present.has(slot)) this._removePlayer(slot);
    }
    for (const p of this.session.allPlayers()) {
      // Resurrection guard (WP5): a tombstoned player is REMOVED, not
      // absent — without this, any roster broadcast re-creates the body/
      // view on host and client alike (ghost players). Keyed on stone
      // existence alone (NOT p.connected): on rejoin the roster lands
      // BEFORE net:join/REJOINED with connected already true — the stone
      // is still standing, and the join path owns the re-add (with the
      // tombstone spawn override) plus the stone despawn.
      if (this.tombstones.has('t' + p.slot)) continue;
      this._addPlayer(p.slot);
    }
  }

  _onClosed({ reason }) {
    // ux-spec §4.2 notice strings — the phase must be read BEFORE _leave
    // resets the session.
    let notice;
    if (reason === 'kicked') notice = 'KICKED BY HOST';
    else if (this.session.phase === PHASE.LOBBY) notice = 'HOST DISCONNECTED';
    else notice = 'HOST DISCONNECTED — RUN ENDED';
    this._leave(notice);
  }

  /** Tear down the session and return to the menu. */
  _leave(notice) {
    this.net?.close();
    if (this.net) this.net.getState = null;
    this.session.reset();
    this.scene.start('Menu', notice ? { notice } : {});
  }

  // ---------------- update ----------------

  update(time, delta) {
    if (this.mode === 'client') return this._clientUpdate(Math.min(delta, 50) / 1000);

    const dt = Math.min(delta, 50) / 1000; // clamp (plan §2.4 / risk 7)
    // poll() consumes edges — ONE poll per frame, cached for the WorldHUD
    // (crosshair/aim read the same frame, never a second poll).
    this.lastInputFrame = this.inputManager.poll();
    this.sim.setInput(this.session.localSlot, this.lastInputFrame);
    if (this.mode === 'host') {
      for (const p of this.session.connectedPlayers()) {
        if (p.slot === this.session.localSlot) continue;
        const frame = this.net.consumeInput(p.slot);
        if (frame) this.sim.setInput(p.slot, frame);
      }
    }

    // Phase-change seams (one pattern): Sim only EMITS; after the drain,
    // host/solo maps sim intents to phase/session changes (the
    // authoritative transition rides the existing phase/roster messages —
    // clients just follow). RUN_OVER → results (WP5); READY_COMPLETE →
    // playing (WP6); STAGE_CYCLE → stageId + roster (WP6, sim-internal:
    // `continue` skips applyEvent AND broadcast — roster is the wire
    // truth for the stage). Everything else broadcasts like any event.
    let runOver = null;
    let readyDone = false;
    let stageCycled = false;
    for (const ev of this.sim.update(dt)) {
      if (ev.kind === EV.STAGE_CYCLE) { stageCycled = true; continue; }
      applyEvent(this, ev);
      this.game.events.emit('ui:event', ev); // WP6 relay (contract §3.5)
      if (this.mode === 'host') this.net.broadcastEvent(ev);
      if (ev.kind === EV.RUN_OVER) runOver = ev;
      if (ev.kind === EV.READY_COMPLETE) readyDone = true;
    }
    if (stageCycled) this._cycleStage();
    if (readyDone && this.session.phase === PHASE.LOBBY) {
      this._setPhase(PHASE.PLAYING, {
        stageId: this.session.stageId, clockMs: CLOCK.sessionMs,
      });
    }
    if (runOver && this.session.phase === PHASE.PLAYING) {
      this._setPhase(PHASE.RESULTS, this.sim.stats.toResultsPayload(
        runOver.result, runOver.reason, this.session, this.sim.world.clockMsLeft));
    }

    this._drawBeams([...this.sim.grapples].map(
      ([slot, g]) => ({ slot, x: g.x, y: g.y, tx: g.tx, ty: g.ty })));
    this._cosmetics();
    this.worldUI.update();
    this.fx?.update(dt);
    this._debug();
  }

  /** @param {number} dt seconds, clamped — Fx derives kinematics from it */
  _clientUpdate(dt) {
    this.lastInputFrame = this.inputManager.poll();
    this.net.pushFrame(this.lastInputFrame);
    const interp = this.net.interpolator.interp('x y', 'players');
    const latest = this.net.interpolator.latest();
    this.worldRow = applySnapshot(this.players, interp, latest) || this.worldRow;
    applyMonsterSnapshot(this.monsters,
      this.net.interpolator.interp('x y', 'monsters'), latest);
    applyRelicSnapshot(this.relic,
      this.net.interpolator.interp('x y', 'relic'), latest, this.players);
    this._drawBeams(decodeGrappleRows(
      this.net.interpolator.interp('x y tx ty', 'grapples')));
    this._cosmetics();
    this.worldUI.update();
    this.fx?.update(dt);
    this._debug();
  }

  /**
   * World point → UIScene screen point. An IDENTITY transform whenever
   * the camera is static (every lobby today), so it cannot regress the
   * shipped WP6 widgets — it just makes any UIScene widget anchored to
   * world coordinates unconditionally correct once a stage larger than
   * the viewport gets one.
   */
  toScreen(x, y) {
    const v = this.cameras.main.worldView;
    return { x: x - v.x, y: y - v.y };
  }

  /**
   * WP6 contract §0.2: the ONE world-row normalizer. Host/solo read the
   * sim; clients read the latest snapshot world row. UIScene widgets
   * call only this — no mode branches in UI code.
   * @returns {{clock, noise, esc, rz, rzN, rzM}}
   */
  getWorldRow() {
    if (this.sim) {
      const w = this.sim.world;
      return {
        clock: w.clockMsLeft, noise: w.noise, esc: w.escalationLevel,
        rz: Math.round(100 * Math.min(1, (w.readyMs || 0) / READY.holdMs)),
        rzN: w.readyN || 0, rzM: w.readyM || 0,
      };
    }
    return this.worldRow || { clock: 0, noise: 0, esc: 0, rz: 0, rzN: 0, rzM: 0 };
  }

  /** EV.PING_MARKER → world marker + edge indicator (events.js hook). */
  spawnPingMarker(ev) {
    this.worldUI?.addPing(ev.slot, ev.x, ev.y);
  }

  /** EV.REJOINED at a standing stone → respawn flash (events.js hook). */
  spawnRejoinFlash(x, y, slot) {
    this.worldUI?.rejoinFlash(x, y, slot);
  }

  /** @param {Array<{slot,x,y,tx,ty}>} rows — empty array = no beams drawn */
  _drawBeams(rows) {
    this._beamRows = rows;
    // WP7 owns beam styling (art-spec §3.1: 3 px body + 1 px ink core +
    // rotated diamond tip). The WP1 line below is the Fx-less fallback.
    if (this.fx) return this.fx.drawBeams(rows);
    this.beamGfx.clear();
    for (const b of rows) {
      const color = PLAYER.colors[b.slot % 4];
      this.beamGfx.lineStyle(2, color, 0.85);
      this.beamGfx.lineBetween(b.x, b.y, b.tx, b.ty);
      this.beamGfx.fillStyle(color, 1);
      this.beamGfx.fillRect(b.tx - 3, b.ty - 3, 6, 6); // tip square
    }
  }

  _cosmetics() {
    for (const p of this.players.values()) updatePlayerCosmetics(p);
    for (const m of this.monsters.values()) updateMonsterCosmetics(m);
    if (this.relic) updateRelicCosmetics(this.relic);
  }

  _debug() {
    if (!this.showDebug) return;
    const local = this.players.get(this.session.localSlot);
    const lines = [
      `mode ${this.mode}  map ${this.mapId}  phase ${this.session.phase}`,
      `slot ${this.session.localSlot}  players ${this.players.size}` +
        (this.session.roomCode ? `  room ${this.session.roomCode}` : ''),
      `fps ${this.game.loop.actualFps.toFixed(0)}` +
        (this.fx ? `  fxP ${this.fx._liveCached}/${FX.particleCap}` +
          `  fxT ${this.fx._tweens.size}  fxDrop ${this.fx.drops}` : ''),
    ];
    if (local) {
      lines.splice(2, 0,
        `pos ${local.x.toFixed(0)},${local.y.toFixed(0)}  mass ${local.state.mass}` +
        `  wpn ${local.state.weapon ?? '?'}`);
    }
    if (this.monsters.size) {
      lines.push('monsters ' + [...this.monsters.values()]
        .map((m) => `${m.state.type[0]}${m.state.hp}:${m.state.ai}`).join(' '));
    }
    if (this.relic) {
      lines.push(`relic ${this.relic.state.rs}@${this.relic.state.holderSlot ?? '-'}` +
        (this.tombstones.size ? `  stones ${this.tombstones.size}` : ''));
    }
    if (this.mode === 'client' && this.worldRow) {
      lines.push(`clock ${(this.worldRow.clock / 1000).toFixed(0)}s  noise ${this.worldRow.noise}`);
    }
    // Grapple tuning lines: per-beam on host/solo, rendered count on the
    // client (clients have no sim and must not derive more).
    if (this.sim) {
      for (const [slot, g] of this.sim.grapples) {
        lines.push(
          `g${slot}→${g.targetId ?? g.targetKind}` +
          ` len ${Math.hypot(g.tx - g.x, g.ty - g.y).toFixed(0)}` +
          ` a ${(g.dbgAccel ?? 0).toFixed(0)}` + (g.assist ? ' [assist]' : ''));
      }
    } else {
      lines.push(`beams ${this._beamRows.length}`);
    }
    this.debugText.setText(lines);
  }
}
