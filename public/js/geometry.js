
/* public/js/geometry.js
 * Hex helpers used by effects (FMJ line shot, ranges, etc.)
 * Exposes Game.board.{toCube,fromCube,hexLineTiles}
 */
(function(){
  window.Game = window.Game || {};
  const G = window.Game;

  G.board = G.board || {};

  // Convert tileId -> cube coords using DOM data attributes, unless user overrides.
  // For robustness, allow override: set Game.board.toCube = (tileId)=>...
  if (typeof G.board.toCube !== "function"){
    G.board.toCube = function toCube(tileId){
      // Expect each tile element to have data-id, data-q, data-r attributes
      const el = document.querySelector(`.tile[data-id="${tileId}"]`);
      if (!el) throw new Error(`[geometry] tile not found: ${tileId}`);
      const q = parseInt(el.getAttribute("data-q"),10);
      const r = parseInt(el.getAttribute("data-r"),10);
      if (Number.isNaN(q) || Number.isNaN(r)){
        throw new Error("[geometry] Tiles must include data-q and data-r attributes, or override Game.board.toCube");
      }
      // axial(q,r) -> cube(x=q, z=r, y=-x-z)
      const x = q, z = r, y = -x - z;
      return {x,y,z};
    };
  }

  if (typeof G.board.fromCube !== "function"){
    G.board.fromCube = function fromCube(c){
      // Default maps back by locating a tile with same axial (q=c.x, r=c.z).
      const q = c.x, r = c.z;
      const el = document.querySelector(`.tile[data-q="${q}"][data-r="${r}"]`);
      if (!el) throw new Error("[geometry] Cannot map cube back to tile; override Game.board.fromCube if needed.");
      return el.getAttribute("data-id");
    };
  }

  function cubeLerp(a, b, t){
    return { x: a.x + (b.x - a.x) * t,
             y: a.y + (b.y - a.y) * t,
             z: a.z + (b.z - a.z) * t };
  }
  function cubeRound(c){
    let rx = Math.round(c.x), ry = Math.round(c.y), rz = Math.round(c.z);
    const x_diff = Math.abs(rx - c.x), y_diff = Math.abs(ry - c.y), z_diff = Math.abs(rz - c.z);
    if (x_diff > y_diff && x_diff > z_diff) rx = -ry - rz;
    else if (y_diff > z_diff)             ry = -rx - rz;
    else                                  rz = -rx - ry;
    return {x:rx,y:ry,z:rz};
  }

  G.board.hexLineTiles = function hexLineTiles(startTileId, endTileId){
    const a = G.board.toCube(startTileId);
    const b = G.board.toCube(endTileId);
    const N = Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.z-b.z));
    const results = [];
    for (let i=0;i<=N;i++){
      const t = N === 0 ? 0 : i / N;
      const c = cubeRound(cubeLerp(a,b,t));
      results.push(G.board.fromCube(c));
    }
    return results;
  };

  console.log("[geometry] Game.board helpers ready.");
})();
