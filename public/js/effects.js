
/* public/js/effects.js
 * First-class Effects resolver for abilities.
 * Exposes Game.effects.resolve(attacker, target, effect)
 * Requires the host game to supply:
 *   - Game.units.getUnitAt(tileId) -> unit or null
 *   - Game.units.teamOf(unitId) -> 'p1' | 'p2' (or similar)
 *   - Game.combat.dealDamage(unitId, amount, meta)
 *   - Game.combat.healUnit(unitId, amount, meta)
 *   - Game.movement.swapPositions(unitA, unitB) (for Trickster)
 */
(function(){
  window.Game = window.Game || {};
  const G = window.Game;

  G.effects = G.effects || {};

  function need(path, name){
    if (!path) { console.warn(`[effects] Missing ${name}`); return false; }
    return true;
  }

  // Core resolve
  G.effects.resolve = function resolve(attacker, target, effect){
    if (!effect || !effect.type){ console.warn("[effects] invalid effect", effect); return; }

    switch(effect.type){

      case "damage": {
        if (!need(G.combat && G.combat.dealDamage, "combat.dealDamage")) return;
        const amount = effect.amount ?? effect.value ?? 0;
        const victim = target.unit ?? target; // target may be a unit or a tile; prefer unit
        if (!victim || !victim.id){ console.warn("[effects] damage target missing unit"); return; }
        G.combat.dealDamage(victim.id, amount, { source: attacker.id, tag: "primary" });
        break;
      }

      case "heal": {
        if (!need(G.combat && G.combat.healUnit, "combat.healUnit")) return;
        const amount = effect.amount ?? effect.value ?? 0;
        const ally = target.unit ?? target;
        if (!ally || !ally.id){ console.warn("[effects] heal target missing unit"); return; }
        G.combat.healUnit(ally.id, amount, { source: attacker.id, tag: "heal" });
        break;
      }

      case "swap_positions": {
        if (!need(G.movement && G.movement.swapPositions, "movement.swapPositions")) return;
        const defender = target.unit ?? target;
        if (!defender || !defender.id){ console.warn("[effects] swap target missing unit"); return; }
        G.movement.swapPositions(attacker, defender);
        break;
      }

      case "aoe": {
        // Generic AoE wrapper: expects nested effects and a range shape.
        // Example (Blossom): apply heal 2 to allies in radius 1 around a chosen tile.
        const nested = effect.effects || [];
        const tiles = (function(){
          if (effect.range && effect.range.type === "area" && typeof G.board.getAreaTiles === "function"){
            return G.board.getAreaTiles(target.tileId, effect.range.radius || 1);
          }
          // Fallback: apply only on the tile itself
          return [target.tileId || (target.tile && target.tile.id)];
        })();
        if (!tiles || !tiles.length) return;
        for (const tid of tiles){
          const u = G.units.getUnitAt ? G.units.getUnitAt(tid) : null;
          if (!u) continue;
          for (const inner of nested){
            // Recurse with same attacker, per-target as needed
            G.effects.resolve(attacker, { unit:u, tileId: tid }, inner);
          }
        }
        break;
      }

      case "line_attack": {
        if (!need(G.units && G.units.getUnitAt, "units.getUnitAt")) return;
        if (!need(G.units && G.units.teamOf, "units.teamOf")) return;
        if (!need(G.combat && G.combat.dealDamage, "combat.dealDamage")) return;
        if (!need(G.board && G.board.hexLineTiles, "board.hexLineTiles")) return;
        const path = G.board.hexLineTiles(attacker.tileId, target.tileId) || [];
        const myTeam = G.units.teamOf(attacker.id);
        const dmg = effect.damage ?? effect.amount ?? 0;

        // Skip the attacker's own tile; limit to 4 tiles forward (FMJ spec)
        // If a future ability needs a different length, extend effect.length override.
        const maxLen = effect.length ?? 4;
        const trimmed = path.slice(1, 1 + maxLen);

        for (const tid of trimmed){
          const u = G.units.getUnitAt(tid);
          if (!u) continue;
          // Only damage enemies; friendly fire off by default.
          if (G.units.teamOf(u.id) === myTeam) continue;
          G.combat.dealDamage(u.id, dmg, { source: attacker.id, tag: "FMJ" });
        }
        break;
      }

      default:
        console.warn("[effects] Unhandled effect type:", effect.type);
    }
  };

  console.log("[effects] Resolver ready (damage, heal, swap_positions, aoe, line_attack).");
})();
