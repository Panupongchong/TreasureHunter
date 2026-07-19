// ============================================================
// camera.js — WP7 camera work (art-spec §4.2.9).
//
// Rendering only. The camera never reads or writes sim state; it follows
// the LOCAL VIEW object, which exists in every mode (host/solo: the
// simulated GO; client: the interpolated view). Following the rendered
// view — not a host body the client does not have — is what keeps the
// world-space UI (which is drawn at rendered positions) aligned with the
// camera in all three modes.
//
// Follow engages ONLY when the map exceeds the viewport, preserving the
// WP5 condition byte-for-byte: the lobby (960×540) keeps a static camera,
// so every WP6 world==screen assumption still holds there.
// ============================================================

import { FX, GAME_WIDTH, GAME_HEIGHT } from '../config.js';

/**
 * One-time camera configuration. Bounds are already set by GameScene
 * before this runs (physics + camera share the map rect).
 * @param {Phaser.Scene} scene
 */
export function setupCamera(scene) {
  const cam = scene.cameras.main;
  cam.setRoundPixels(true); // keeps 1 px beam cores / seams crisp when scrolled
  const worldW = scene.map.width, worldH = scene.map.height;
  scene._camFollows = worldW > GAME_WIDTH || worldH > GAME_HEIGHT;
  if (!scene._camFollows) return cam;
  cam.setDeadzone(FX.cam.deadzoneW, FX.cam.deadzoneH);
  return cam;
}

/**
 * (Re)point the camera at the local view. Null-safe: a missing local view
 * (tombstoned local player, roster race) stops the follow and leaves the
 * camera where it is rather than snapping to the origin.
 * @param {Phaser.Scene} scene
 * @param {Phaser.GameObjects.GameObject|null} view
 */
export function followLocal(scene, view) {
  const cam = scene.cameras.main;
  if (!scene._camFollows || !view) { cam.stopFollow(); return; }
  cam.startFollow(view, true, FX.cam.lerp, FX.cam.lerp);
  cam.setDeadzone(FX.cam.deadzoneW, FX.cam.deadzoneH);
}

/**
 * Per-frame horizontal lookahead, lerped so a facing flip does not snap
 * the world sideways. Vertical lookahead is deliberately omitted — it
 * fights jump arcs on a platformer.
 * @param {Phaser.Scene} scene
 * @param {{state:{facing:number}}|null} view
 * @param {{off:number}} store mutable lookahead accumulator (owned by Fx)
 */
export function updateLookahead(scene, view, store) {
  if (!scene._camFollows || !view) return;
  const want = -(view.state?.facing ?? 1) * FX.cam.lookahead;
  store.off += (want - store.off) * FX.cam.lookLerp;
  scene.cameras.main.setFollowOffset(store.off, 0);
}
