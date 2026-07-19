// ============================================================
// mapTypes.js — the map data shape + helpers.
//
// A map is plain data; scenes/entities interpret it. Shape:
//
//   {
//     id: string,                 // 'lobby' | 'test' (stageId in protocol)
//     name: string,               // display name
//     width, height: number,      // THE WORLD SIZE in px (WP5: camera +
//                  // physics bounds; may exceed the 960×540 viewport —
//                  // camera-follow kicks in automatically. Lobby stays
//                  // viewport-sized → static camera, no special case)
//     platforms: [[x, y, w, h]],  // static terrain rects (top-left anchored)
//     spawns: [[x, y]],           // per-slot spawn points (index = slot)
//     // ---- WP4 world data (all optional; top-left anchored like platforms) ----
//     doors:    [{id:'d0', type:'door'|'rubble'|'shortcut'|'bridge'|'crankGate',
//                 x, y, w, h}]
//                  // ids MUST start with 'd' (grapple wire contract — never
//                  // 'p'/'m'/'g', and never bare 'relic')
//     pickups:  [{id, type:'hourglass'|'ritual', x, y}]  // ritual id: 'ritual';
//                  // x,y are CENTER points (no body — host distance checks).
//                  // Hourglass placement rule: ≥1 barrier off the golden path
//                  // OR behind a drop deeper than the mass-1.0 safe fall
//                  // height — never on the main corridor.
//     pits:     [[x, y, w, h]]    // zones: monsters inside die (despawn
//                  // reason 'pitDeath' — MonsterSystem checks these)
//     collapseIdx: [n, ...]       // platform indices that collapse at
//                  // escalation 2 (flag-only in WP4; mechanic ships later)
//     weaponRack: {x, y} | undefined // lobby: interact cycles hammer/dagger
//     readyZone: {x, y, w, h}     // WP6: vault-entrance stand-to-ready rect
//                  // (ReadyZoneSystem; lobby only — absent = no ready ring)
//     board: {x, y} | undefined   // WP6: stage board CENTER (lobby). Host-only
//                  // 0.5 s interact channel cycles config.STAGES; maps
//                  // without it never match the 'board' channel
//     labels:   [{x, y, text}]    // cosmetic map annotations
//     monsterSpawns: [{id, type:'skulker'|'brute', x, y, dummy?:true}]
//                  // consumed by MonsterSystem; dummy = never aggros (lobby pen)
//     // ---- WP5 relic & objective data ----
//     relicSpawn: [x, y]          // relic start CENTER (the vault).
//                  // Absent ⇒ no relic, no win check (lobby)
//     exitZone: [x, y, w, h]      // top-left rect (platform convention;
//                  // an {x,y,w,h} object is also accepted). Win = relic
//                  // CARRIER (hands OR bag) center inside it. Absent ⇒
//                  // no win check
//     // ---- declared for the WP5 level build; consumed by later work ----
//     entranceZone: [x, y, w, h]  // spawn-area annotation (testMap). NOT the
//                  // ready trigger — that is `readyZone` (lobby only)
//     noSpawnZones: [[x, y, w, h]] // monster-free rects — MonsterSystem
//                  // spawn search must reject points inside (not yet
//                  // enforced; MonsterSystem is outside WP5 systems scope)
//   }
//
// Keep maps data-only: no Phaser imports here.
// ============================================================

import { lobbyMap } from './lobbyMap.js';
import { testMap } from './testMap.js';

const MAPS = { [lobbyMap.id]: lobbyMap, [testMap.id]: testMap };

/** @returns the map for a stage/map id; throws on unknown ids (typo guard). */
export function getMap(id) {
  const map = MAPS[id];
  if (!map) throw new Error('unknown map id: ' + id);
  return map;
}

/** Spawn point for a slot, wrapping if the map defines fewer than 4. */
export function spawnFor(map, slot) {
  return map.spawns[slot % map.spawns.length];
}
