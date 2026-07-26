// ============================================================
// terrain.js — the shared static-geometry cache.
//
// Two consumers need the same rects and must never disagree about them:
// GrappleSystem (casts, line-of-sight, anchors) and MovementSystem
// (auto-step probing). Previously the cache lived private inside
// GrappleSystem; a second private copy would drift the moment a door
// broke, so it lives here and both systems read it.
//
// Rects are Phaser.Geom.Rectangle. Door rects carry `.doorId` so a cast
// can report targetKind 'door' + targetId on the wire; broken doors drop
// out on the next rebuild.
//
// Invalidation: DoorSystem still calls sim.grapple.invalidateTerrain(),
// which delegates here. Anything that adds or removes static geometry
// mid-run must do the same.
// ============================================================

/** Platforms + INTACT doors (doors are walls: they occlude and block). */
export function terrainRects(sim) {
  return sim._terrainRects ??= [
    ...sim.scene.platforms.getChildren().map((go) => go.getBounds()),
    ...[...sim.doors.values()]
      .filter((d) => d.state.state === 'intact')
      .map((d) => {
        const r = d.getBounds();
        r.doorId = d.state.id;
        return r;
      }),
  ];
}

/**
 * Attach points for TRAVERSAL.anchorsOnly mode — the level designer's
 * grip on how fast the map can be crossed.
 *
 * Two sources:
 *   - every EXPOSED platform lip (both top corners of a rect, kept only
 *     when the air just above is clear, so floor/wall junctions and
 *     buried corners don't become phantom hooks). The point sits 6 px
 *     OUTSIDE the corner and 6 px above it, in open air — not inset on
 *     the deck. That is not cosmetic: an inset point is occluded by its
 *     own slab for anyone approaching from below, so you could only ever
 *     hook a ledge you were already level with. Hanging the anchor off
 *     the corner is what makes "hook the edge and pull yourself up" work
 *   - map.anchors: [{x, y}] — authored points, including mid-air ones
 *     with no platform at all
 *
 * A platform index listed in map.noAnchorIdx contributes NO lips: that is
 * how you author a smooth, unhookable surface (a ledge only reachable by
 * hooking a teammate, say). Cached alongside the rects.
 */
export function terrainAnchors(sim) {
  if (sim._anchors) return sim._anchors;
  const map = sim.scene.map;
  const rects = terrainRects(sim);
  const smooth = new Set(map.noAnchorIdx ?? []);
  // Strict containment: touching an edge is not "buried inside".
  const covered = (x, y) =>
    rects.some((r) => x > r.x && x < r.right && y > r.y && y < r.bottom);

  const out = [];
  const platforms = sim.scene.platforms.getChildren();
  platforms.forEach((go, i) => {
    if (smooth.has(i)) return;
    const r = go.getBounds();
    if (r.width < 24) return; // too thin to have two distinct lips
    for (const [x, inx] of [[r.x - 6, r.x + 6], [r.right + 6, r.right - 6]]) {
      if (covered(inx, r.y - 8)) continue; // no air above the lip: not a lip
      if (covered(x, r.y - 6)) continue;   // the corner itself is walled in
      out.push({ x, y: r.y - 6, id: null });
    }
  });
  for (const a of map.anchors ?? []) out.push({ x: a.x, y: a.y, id: a.id ?? null });
  return sim._anchors = out;
}

/** Drop both caches (DoorSystem → GrappleSystem.invalidateTerrain). */
export function invalidateTerrain(sim) {
  sim._terrainRects = null;
  sim._anchors = null;
}
