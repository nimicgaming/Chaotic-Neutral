/* eslint-disable no-console */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* Load hero stats (hpMax) from characters.json for future-proof max HP */
const fs = require('fs');
const HERO_STATS = (()=>{
  const fs = require('fs');
  try {
    const candidates = [
      path.join(__dirname, 'characters.json'),
      path.join(__dirname, 'public', 'characters.json')
    ];
    let arr = null, where = null;
    for (const p of candidates) {
      try {
        arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        where = p;
        break;
      } catch (e) { /* try next */ }
    }
    if (!Array.isArray(arr)) {
      console.warn('[HERO_STATS] characters.json not found. Looked in:', candidates.join(' , '));
      return {};
    }
    console.log('[HERO_STATS] loaded', arr.length, 'heroes from', where);
    const m = {};
    for (const h of arr) {
      const hpMax = h.hpMax || h.hp || h.hp_max || null;
      const key1 = h.name, key2 = h.id;
      if (key1 && hpMax) m[key1] = { hpMax };
      if (key2 && hpMax) m[key2] = { hpMax };
    }
    return m;
  } catch (e) {
    console.warn('[HERO_STATS] characters.json load error:', e.message);
    return {};
  }
})();


/* -------------------- Static + Routes -------------------- */
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB, { index: false }));
app.get('/', (_req, res) => res.redirect('/home'));
app.get('/home', (_req, res) => res.sendFile(path.join(PUB, 'home.html')));
app.get('/game', (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

/* =========================================================
   LOBBIES (HOST/JOIN BEFORE ENTERING GAME)
   ========================================================= */
const lobbies = new Map(); // code -> { host:{socketId,name,heroes}, guest:{socketId,name,heroes} | null }

function ensureLobby(code) {
  if (!lobbies.has(code)) lobbies.set(code, { host: null, guest: null });
  return lobbies.get(code);
}

function cleanupLobbyBySocket(socketId) {
  for (const [code, lob] of lobbies) {
    if (lob.host?.socketId === socketId || lob.guest?.socketId === socketId) {
      const other = (lob.host?.socketId === socketId) ? lob.guest : lob.host;
      if (other) io.to(other.socketId).emit('lobby:closed');
      lobbies.delete(code);
      break;
    }
  }
}

/* =========================================================
   QUICK MATCH QUEUE
   ========================================================= */
const quickQueue = []; // [{ socketId, name, heroes }]
function makeRoomCode() {
  const r = Math.random().toString(36).slice(2, 6);
  return `qm-${Date.now().toString(36)}-${r}`;
}
function dequeueBySocket(id) {
  const idx = quickQueue.findIndex(q => q.socketId === id);
  if (idx >= 0) quickQueue.splice(idx, 1);
}

/* =========================================================
   MULTI-ROOM GAME ENGINE (LIGHTWEIGHT)
   ========================================================= */
const rooms = new Map(); // roomId -> state

// Hero catalog (ids from home page) => names + archetype for UI naming
const HEROES = {
  // Tanks
  voodoo:    { id:'voodoo',    name:'Voodoo',        archetype:'Tank' },
  loadstone: { id:'loadstone', name:'Loadstone',     archetype:'Tank' },
  // DPS
  aimbot:    { id:'aimbot',    name:'Aimbot',        archetype:'DPS'  },
  trickster: { id:'trickster', name:'Trickster',     archetype:'DPS'  },
  // Support
  death_blossom: { id:'death_blossom', name:'Death Blossom', archetype:'Support' },
  dungeon_master: { id:'dungeon_master', name:'Dungeon Master', archetype:'DPS' },
  little_bear: { id:'little_bear', name:'Little Bear', archetype:'Tank' },

  don_atore: { id:'don_atore', name:'Don Atore', archetype:'Support' },
};


/* [ENERGY] Card costs + constants + helpers (server) */
const CARD_COST = {
  SkillCheck: 3,
  Cleanse: 3,
  Siphon: 2,
  Fireball: 4,
  Entangle: 2,
  IronSkin: 3,
  Sprint: 2,
  Wall: 1,
  Shatter: 1,
  Swap: 4,
  FMJ: 3,
  VoodooDoll: 3,
  PolarAttraction: 4,
  HealingPetal: 3,
  Transform: 5,
  Replenish: 5,};
const ENERGY_MAX = 10;
const ENERGY_GAIN_PER_TURN = 1;



function energyGainForRound(round){
  if (round == null) round = 1;
  if (round <= 2) return 1;   // Rounds 1–2
  if (round <= 5) return 2;   // Rounds 3–5
  if (round <= 8) return 3;   // Rounds 6–8
  return 4;                   // Round 9+
}

function ensureEnergy(st){
  if (!st.energy) st.energy = { player1:0, player2:0 };
  if (st.energy.player1 == null) st.energy.player1 = 0;
  if (st.energy.player2 == null) st.energy.player2 = 0;
}
function canPay(st, seat, type){
  ensureEnergy(st);
  const cost = CARD_COST[type] || 0;
  return (st.energy[seat] || 0) >= cost;
}
function pay(st, seat, type){
  ensureEnergy(st);
  const cost = CARD_COST[type] || 0;
  if ((st.energy[seat] || 0) < cost) return false;
  st.energy[seat] = Math.max(0, (st.energy[seat] || 0) - cost);
  return true;
}
function initialTurnState() {
  return { cardPlayed:false, usedMovement:false, usedAction:false, moveBuff:{ stepsBonus:0, minSteps:0 }, moved:{}, acted:{} };
}

function createRoomState(roomId) {
  const ENERGY_INIT = { player1:0, player2:0 };
  const hexR = 58, hexH = 2*hexR, vSpace = 0.75 * hexH;
  const state = { mode: 'standard', control: null,

    roomId,
    // seating & meta
    players: [],       // [{socketId, seat:'player1'|'player2'|'spectator', name, heroes:[ids]}]
    seatBySocket: new Map(), // socketId -> 'player1'|'player2'|'spectator'
    locked: false,
    playerNames: { player1:'Player 1', player2:'Player 2' },
    playerHeroes: { player1:[], player2:[] }, // ids
    gameEnded: false,
    currentTurn: 'player1',
    lastDiscard: { player1:null, player2:null },
    /* [ENERGY] per-seat energy */
    energy: { player1:0, player2:0 },

    // board geometry
    centerX: 960, centerY: 540 - 50,
    hexR, vSpace,
    adjacency: null,
    tilePositions: {},

    // tokens/chars/walls
    tokens: new Map(),  // id -> { owner, tile, hasMovedEver, role:'Tank'|'DPS1'|'DPS2'|'Support', name }
    chars: new Map(),   // id -> { owner, role, hp, cds:{special}, dead, name }
    walls: new Map(),   // tile -> ttl
    WALL_TTL: 8,
    blossomWalls: new Map(), // Blossom walls (passable)
    blossomPinkWalls: new Map(), // Blossom ring (pink, passable)
    BLOSSOM_WALL_TTL: 2,

    // class defs
    CHAR_DEFS: {
      Tank:    { maxHP: 18, primary:{ name:'Shield Bash',  type:'damage', dmg:3, range:1 }, special:{ name:'Hammer Slam', type:'damage', dmg:5, range:1, cd:3 } },
      DPS1:    { maxHP: 12, primary:{ name:'Fire Bolt',    type:'damage', dmg:3, range:2 }, special:{ name:'Dragon’s Fury', type:'damage', dmg:4, range:2, cd:4 } },
      DPS2:    { maxHP: 11, primary:{ name:'Dagger Thrust',type:'damage', dmg:3, range:1 }, special:{ name:'Sneak Attack', type:'damage', dmg:5, range:1, cd:3, cond:'movedThisTurn' } },
      Support: { maxHP: 13, primary:{ name:'Mend',         type:'heal',   heal:2, range:2 }, special:{ name:'Healing Bloom', type:'heal', heal:4, range:2, cd:3 } }
    }
,

    turnState: { player1: initialTurnState(), player2: initialTurnState() },
  
    energy: { ...ENERGY_INIT },};

  // build tiles and adjacency
  const rows = [
    { label:'A', count:4 }, { label:'B', count:5 }, { label:'C', count:6 },
    { label:'D', count:7 }, { label:'E', count:8 }, { label:'F', count:7 },
    { label:'G', count:6 }, { label:'H', count:5 }, { label:'I', count:4 }
  ];
  const hexW = Math.sqrt(3) * hexR;
  const centerRow = Math.floor(rows.length/2);
  rows.forEach((row, ri) => {
    const y = state.centerY + (ri - centerRow) * vSpace;
    const half = (row.count - 1) * hexW / 2;
    for (let i = 0; i < row.count; i++) {
      const x = state.centerX - half + i * hexW;
      const id = `${row.label}${i+1}`;
      state.tilePositions[id] = { x, y, id };
    }
  });
  const dHoriz = hexW, dVert = vSpace, dDiag = Math.hypot(hexW/2, vSpace);
  const targets = [dHoriz, dVert, dDiag], tol = 0.18;
  const ids = Object.keys(state.tilePositions);
  const adjacency = {};
  for (const id of ids) {
    const a = state.tilePositions[id], n = [];
    for (const id2 of ids) {
      if (id2 === id) continue;
      const b = state.tilePositions[id2];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      for (const t of targets) { if (Math.abs(dist - t) <= t * tol) { n.push([id2, dist]); break; } }
    }
    n.sort((p, q) => p[1] - q[1]);
    adjacency[id] = n.slice(0, 6).map(p => p[0]);
  }
  state.adjacency = adjacency;

  // default tokens (names get overridden by hero picks)
  function addTok(id, owner, tile, role, name) {
    state.tokens.set(id, { owner, tile, hasMovedEver:false, role, name });
    const def = state.CHAR_DEFS[role];
    state.chars.set(id, { owner, role, hp:def.maxHP, cds:{special:0}, dead:false, name: name || id });
  }
  addTok('P1','player1','I1','Tank','Tank');
  addTok('P2','player1','I2','DPS1','DPS1');
  addTok('P3','player1','I3','DPS2','DPS2');
  addTok('P4','player1','I4','Support','Support');
  addTok('E1','player2','A1','Tank','Tank');
  addTok('E2','player2','A2','DPS1','DPS1');
  addTok('E3','player2','A3','DPS2','DPS2');
  addTok('E4','player2','A4','Support','Support');

  rooms.set(roomId, state);
  function initControlPoints(st){
    try{
      const ids = Object.keys(st.tilePositions||{});
      if (!ids.length) return;
      const eligible = ids.filter(id => (st.adjacency[id]||[]).length >= 3);
      const seedStr = String(st.roomId||'seed');
      let h=0; for (let i=0;i<seedStr.length;i++){ h = (h*31 + seedStr.charCodeAt(i))|0; }
          const pick = (st.tilePositions && st.tilePositions.E1) ? 'E1' : (eligible[0] || ids[0]);
      const nbs = (st.adjacency[pick]||[]).slice();
      nbs.sort((a,b)=>{
        const pa = st.tilePositions[a], pb = st.tilePositions[b];
        const da = Math.hypot(pa.x - st.centerX, pa.y - st.centerY);
        const db = Math.hypot(pb.x - st.centerX, pb.y - st.centerY);
        return da - db;
      });
      st.control = { anchor: pick, tiles: Array.from(new Set(nbs)).slice(0,3), scores:{ player1:0, player2:0 } };
    }catch(e){ st.control = { anchor:null, tiles:[], scores:{player1:0,player2:0} }; }
  }
  function scoreControlRound(st){
  if (!st || st.mode!=='control' || !st.control) return;
  let p1=0, p2=0;
  const tileSet = new Set(st.control.tiles||[]);
  const anchor = st.control.anchor || null;
  for (const [id, tok] of st.tokens){
    if (!tok || !tok.tile) continue;
    if (anchor && tok.tile === anchor){
      if (tok.owner==='player1') p1 += 2;
      else if (tok.owner==='player2') p2 += 2;
    } else if (tileSet.has(tok.tile)){
      if (tok.owner==='player1') p1++;
      else if (tok.owner==='player2') p2++;
    }
  }
  st.control.scores.player1 = (st.control.scores.player1||0) + p1;
  st.control.scores.player2 = (st.control.scores.player2||0) + p2;
  let winner = null;
  if (st.control.scores.player1 >= 10) winner = 'player1';
  if (st.control.scores.player2 >= 10) winner = 'player2';
  if (winner){ st.gameEnded = true; io.to(st.roomId).emit('gameOver', { winner }); }
}

  return state;
}



// Minimal helper: adjust spawn tiles for Control mode only (characters only)
function applyControlModeSpawns(st){
  try{
    if (!st || st.mode !== 'control') return;
    const have = (t)=> st.tilePositions && st.tilePositions[t];
    const set  = (id,t)=>{ if (have(t) && st.tokens && st.tokens.has(id)) st.tokens.get(id).tile = t; };

    // Player 1 — bottom-right corner cluster (facing left)
    set('P1','H4'); // Tank (front)
    set('P2','I4'); // DPS (side)
    set('P3','H5'); // DPS (side)
    set('P4','I3'); // Support (back)

    // Player 2 — top-right corner cluster (facing left)
    set('E1','B4'); // Tank (front)
    set('E2','A4'); // DPS (side)
    set('E3','B5'); // DPS (side)
    set('E4','A3'); // Support (back)
  }catch(_){ /* no-op */ }

    // Record fixed respawn tiles for this mode
    if (!st.respawnAt) st.respawnAt = {};
    st.respawnAt.P1 = 'H4'; st.respawnAt.P2 = 'I4'; st.respawnAt.P3 = 'H5'; st.respawnAt.P4 = 'I3';
    st.respawnAt.E1 = 'B4'; st.respawnAt.E2 = 'A4'; st.respawnAt.E3 = 'B5'; st.respawnAt.E4 = 'A3';
    if (!st.pendingRespawn) st.pendingRespawn = { player1: [], player2: [] };

  }



/* --- Per-hero overrides (server) --- */
function getCharDef(st, ch){
  // Base by role
  const base = (st && st.CHAR_DEFS && ch && ch.role) ? (st.CHAR_DEFS[ch.role] || st.CHAR_DEFS.Tank) : null;
  if (!base) return null;
  const HERO_OVERRIDES = {
    "Little Bear": {
      maxHP: 13,
      primary: { name: 'Paw Swipe', type: 'damage', dmg: 3, range: 1, cd: 0 },
      special: { name: 'Transform', type: 'transform', energyCost: 5, cd: 0 }
    },

    "Dungeon Master": {
      maxHP: 12,
      primary: { name: '1D6', type: 'damage', dmg: 1, range: 2, cd: 0 },
      special: { name: 'Skill Check', type: 'buff', range: 2, energyCost: 3, cd: 0 }
    },
    Trickster: {
      maxHP: 11,
      primary: { name: 'Sleight of Hand', type: 'damage', dmg: 4, range: 1, cd: 0 },
      special: { name: 'Swap', type: 'swap', range: 99, energyCost: 4, cd: 0 }
    },
    Aimbot: {
      maxHP: 12,
      primary: { name: 'True Shot', type: 'damage', dmg: 5, range: 3, cd: 0 },
      special: { name: 'FMJ', type: 'fmj', range: 4, energyCost: 6, dmg: 5, cd: 0 }
    },
    Voodoo: {
      // if maxHP omitted uses Tank base (18)
      primary: { name: 'Pin Cushion', type: 'damage', dmg: 4, range: 1, cd: 0 },
      special: { name: 'Voodoo Doll', type: 'redirect', energyCost: 3, duration: 2, cd: 0 }
    },
    Loadstone: {
      maxHP: 15,
      primary: { name: 'Reverse Polarity', type: 'aoe', dmg: 2, range: 1, cd: 0 },
      special: { name: 'Polar Attraction', type: 'polar', range: 2, energyCost: 4, cd: 0 }
    },
    Aimbot: {
      maxHP: 12,
      primary: { name: 'True Shot', type: 'damage', dmg: 5, range: 3, cd: 0 },
      special: { name: 'FMJ', type: 'fmj', range: 4, energyCost: 6, dmg: 5, cd: 0 }
    }
  
,
"Don Atore": {
  maxHP: 12,
  special: { name: 'Replenish', type: 'selfHeal', heal: 5, energyCost: 5, cd: 0 
,
primary: { name: 'Blood Donation', type: 'tapHeal', range: 1, cd: 0 }

}
}
};
  const ov = (ch && ch.name) ? HERO_OVERRIDES[ch.name] : null;
  if (!ov) return base;
  return {
    ...base,
    maxHP: ov.maxHP ?? base.maxHP,
    primary: { ...(base.primary || {}), ...(ov.primary || {}) },
    special: { ...(base.special || {}), ...(ov.special || {}) }
  };
}



/* -------------------- Helpers bound to room -------------------- */
function neighbors(state, id) { return state.adjacency[id] ?? []; }
function wallsSet(state) { return new Set([...state.walls.keys()]); }
function occMap(state) { const m = new Map(); state.tokens.forEach((st)=> m.set(st.tile, true)); return m; }


// Find an open tile near a preferred spawn tile (BFS up to radius 3)
function findOpenTileNear(state, preferred){
  const occ = occMap(state), walls = wallsSet(state);
  if (preferred && state.tilePositions[preferred] && !occ.has(preferred) && !walls.has(preferred)) return preferred;
  if (!preferred || !state.tilePositions[preferred]) return preferred;
  const seen = new Set([preferred]);
  let frontier = [preferred];
  for (let depth=0; depth<3; depth++){
    const next = [];
    for (const cur of frontier){
      for (const n of neighbors(state, cur)){
        if (seen.has(n)) continue; seen.add(n);
        if (!occ.has(n) && !walls.has(n)) return n;
        next.push(n);
      }
    }
    frontier = next;
  }
  // fallback: even if occupied, return the preferred to avoid undefined
  return preferred;
}
function shortestDistance(state, start, goal, blockedSet) {
  if (start === goal) return 0;
  const seen = new Set([start]); const q = [[start, 0]];
  while (q.length) {
    const [cur, d] = q.shift();
    for (const nxt of neighbors(state, cur)) {
      if (blockedSet && blockedSet.has(nxt)) continue;
      if (seen.has(nxt)) continue;
      if (nxt === goal) return d + 1;
      seen.add(nxt); q.push([nxt, d + 1]);
    }
  }
  return Infinity;
}
function placeWall(state, tile){
  if (!state.tilePositions[tile]) return false;
  if (state.walls.has(tile)) return false;
  if (occMap(state).has(tile)) return false;
  state.walls.set(tile, state.WALL_TTL); return true;
}
function clearWall(state, tile){ if (!state.walls.has(tile)) return false; state.walls.delete(tile); return true; }
function tickWalls(state){
  const toRemove = [];
  state.walls.forEach((ttl, tid)=>{
    const next = ttl - 1;
    if (next <= 0) toRemove.push(tid);
    else state.walls.set(tid, next);
  });
  toRemove.forEach(tid=> state.walls.delete(tid));
}

// === Blossom Walls (passable + TTL 2 turns) ===
function placeBlossomWall(state, tile, owner){
  if (!state.tilePositions[tile]) return false;
  if (state.walls.has(tile)) return false;
  // Passable and layered: allow both players' petals to coexist
  const cur = state.blossomWalls.get(tile) || {};
  const ttl = state.BLOSSOM_WALL_TTL;
  cur[owner] = ttl;
  state.blossomWalls.set(tile, cur);
  return true;
}

function clearBlossomWall(state, tile){
  if (!state.blossomWalls.has(tile)) return false;
  state.blossomWalls.delete(tile); return true;
}
function tickBlossomWalls(state, seat){
  const toRemove = [];
  state.blossomWalls.forEach((v, tile)=>{
    let next = {};
    if (v && typeof v === 'object' && ('player1' in v || 'player2' in v)) {
      // Decrement only the seat that just ended turn
      if (v.player1 && v.player1 > 0) next.player1 = (seat === 'player1') ? v.player1 - 1 : v.player1;
      if (v.player2 && v.player2 > 0) next.player2 = (seat === 'player2') ? v.player2 - 1 : v.player2;
    } else if (v && typeof v === 'object' && 'ttl' in v) {
      // migrate legacy entry into layered form
      if (v.owner) {
        next[v.owner] = Math.max(0, v.ttl - 1);
      }
    }
    if ((next.player1||0) <= 0) delete next.player1;
    if ((next.player2||0) <= 0) delete next.player2;
    if (!next.player1 && !next.player2) toRemove.push(tile);
    else state.blossomWalls.set(tile, next);
  });
  toRemove.forEach(t=> state.blossomWalls.delete(t));
}




function exportBlossomWalls(state){
  const list = [];
  state.blossomWalls.forEach((v, tid)=>{
    if (v && typeof v === 'object' && ('player1' in v || 'player2' in v)) {
      if (v.player1 && v.player1 > 0) list.push({ tile: tid, ttl: v.player1, owner: 'player1' });
      if (v.player2 && v.player2 > 0) list.push({ tile: tid, ttl: v.player2, owner: 'player2' });
    } else if (v && typeof v === 'object' && 'ttl' in v) {
      // legacy single owner
      list.push({ tile: tid, ttl: v.ttl, owner: v.owner || null });
    }
  });
  return list;
}


// === Blossom PINK ring (passable, TTL same as green, heals 1) ===
function placeBlossomPinkRing(state, centerTile, owner){
  const neigh = state.adjacency[centerTile] || [];
  for (const t of neigh){
    if (state.walls.has(t)) continue; // block only by hard walls
    // layered: allow overlap with any existing blossoms (center or ring)
    const cur = state.blossomPinkWalls.get(t) || {};
    cur[owner] = state.BLOSSOM_WALL_TTL;
    state.blossomPinkWalls.set(t, cur);
  }
}

function tickBlossomPinkWalls(state, seat){
  const toRemove = [];
  state.blossomPinkWalls.forEach((v, tid)=>{
    let next = {};
    if (v && typeof v === 'object' && ('player1' in v || 'player2' in v)) {
      if (v.player1 && v.player1 > 0) next.player1 = (seat === 'player1') ? v.player1 - 1 : v.player1;
      if (v.player2 && v.player2 > 0) next.player2 = (seat === 'player2') ? v.player2 - 1 : v.player2;
    } else if (v && typeof v === 'object' && 'ttl' in v) {
      if (v.owner) next[v.owner] = Math.max(0, v.ttl - 1);
    }
    if ((next.player1||0) <= 0) delete next.player1;
    if ((next.player2||0) <= 0) delete next.player2;
    if (!next.player1 && !next.player2) toRemove.push(tid);
    else state.blossomPinkWalls.set(tid, next);
  });
  toRemove.forEach(tid=> state.blossomPinkWalls.delete(tid));
}


function exportBlossomPinkWalls(state){
  const list = [];
  state.blossomPinkWalls.forEach((v, tid)=>{
    if (v && typeof v === 'object' && ('player1' in v || 'player2' in v)) {
      if (v.player1 && v.player1 > 0) list.push({ tile: tid, ttl: v.player1, owner: 'player1' });
      if (v.player2 && v.player2 > 0) list.push({ tile: tid, ttl: v.player2, owner: 'player2' });
    } else if (v && typeof v === 'object' && 'ttl' in v) {
      list.push({ tile: tid, ttl: v.ttl, owner: v.owner || null });
    }
  });
  return list;
}

function exportTokens(state){ const out = {}; state.tokens.forEach((t, id)=>{ out[id] = { ...t }; }); return out; }
function exportWalls(state){ const list = []; state.walls.forEach((ttl, tid)=> list.push({ tile: tid, ttl })); return list; }
function exportChars(state) {
  const out = {};
  state.chars.forEach((c, id) => {
    if (!c) return;
    const def = state.CHAR_DEFS[c.role] || { maxHP: 10 };
    const maxHp = (c.maxHp != null) ? c.maxHp : def.maxHP;
    out[id] = {
      role: c.role,
      owner: c.owner,
      hp: Math.max(0, Math.min(maxHp, c.hp)),
      maxHp,
      cds: { ...(c.cds || { special: 0 }) },
      dead: !!c.dead,
      name: c.name || String(id)
    };
  });
  return out;
}
function exportFx(state){
  const out = {};
  state.chars.forEach((c, id)=>{
    if (!c || !c.fx) return;
    const row = {};
    if (c.fx.fireDot && c.fx.fireDot.remaining > 0) row.fireDot = c.fx.fireDot.remaining;
    if (c.fx.ironSkin && c.fx.ironSkin.remaining > 0) row.ironSkin = c.fx.ironSkin.remaining;
    if (c.fx.entangle && c.fx.entangle.remaining > 0) row.entangle = c.fx.entangle.remaining;
    if (c.fx.redirect && c.fx.redirect.remaining > 0) row.redirect = c.fx.redirect.remaining;
    if (c.fx.bear && c.fx.bear.remaining > 0) row.bear = c.fx.bear.remaining;
    
    if (c.fx.moveBonusThisTurn) row.moveBonus = c.fx.moveBonusThisTurn;
    if (c.fx.skillCheckNext) row.skillCheck = 1;
    if (Object.keys(row).length) out[id] = row;
  });
  return out;
}
function other(role){ return role === 'player1' ? 'player2' : 'player1'; }
function resetPerTurn(st, role){ st.turnState[role] = initialTurnState(); }



    // Per-character status bucket used for DoT / roots / mitigation.
    function getFx(st, id){
      const c = st.chars.get(id); if (!c) return null;
      if (!c.fx) c.fx = {};
      return c.fx;
    }
    

    // Tick down statuses for the side beginning its turn and apply DoT ticks.
    function processStartOfTurn(st, seat){
  // Ensure per-turn flags are fresh for the seat starting its turn
  resetPerTurn(st, seat);

      // Handle Control-mode pending respawns for this seat
      if (st.mode === 'control' && st.pendingRespawn && Array.isArray(st.pendingRespawn[seat]) && st.pendingRespawn[seat].length){
        const toBring = st.pendingRespawn[seat].splice(0);
        for (const id of toBring){
          const ch = st.chars.get(id); if (!ch) continue;
          const base = getCharDef(st, ch) || { maxHP: ch.hp || 10 };
          const pref = (typeof __CN_pickRespawn==='function' ? __CN_pickRespawn(st, id) : ((typeof __cn_getRespawnTileDynamic==='function' ? __cn_getRespawnTileDynamic(st, id) : null) || (st.respawnAt ? st.respawnAt[id] : null)));
          const tile = (typeof __CN_findOpenTileSameRowNear==='function' ? __CN_findOpenTileSameRowNear(st, pref) : findOpenTileNear(st, pref));
          ch.fx = {}; ch.dead = false;
          ch.hp = base.maxHP || ch.hp || 10;
          st.tokens.set(id, { owner: ch.owner, tile, hasMovedEver:false, role: ch.role, name: ch.name });
          io.to(st.roomId).emit('respawn', { id, tile, owner: ch.owner });
        }
      }

      for (const [id, ch] of st.chars){
        const tok = st.tokens.get(id);
        if (!tok || tok.owner !== seat) continue;
        const fx = ch.fx; if (!fx) continue;

        // Promote Dungeon Master Skill Check pending → one-turn bonuses
        if (fx && fx.skillCheckNext){
          fx.attackBonusThisTurn = (fx.attackBonusThisTurn||0) + (fx.skillCheckNext.attack||1);
          fx.moveBonusThisTurn   = (fx.moveBonusThisTurn||0)   + (fx.skillCheckNext.move||1);
          delete fx.skillCheckNext;
        }
        if (fx.fireDot && fx.fireDot.remaining > 0){
          applyDamage(st, id, fx.fireDot.per || 2);
          fx.fireDot.remaining -= 1;
          if (fx.fireDot.remaining <= 0) delete fx.fireDot;
      // --- Healing Blossoms tick ---
      if (st.tileAuras && Array.isArray(st.tileAuras.blossoms)){
        const next = [];
        for (const b of st.tileAuras.blossoms){
          // Heal any unit on affected tiles at the start of BOTH players' turns
          for (const [id, tok] of st.tokens){
            const onTile = b.tiles.includes(tok.tile);
            if (!onTile) continue;
            const healAmt = (tok.tile === b.center ? (b.centerHeal ?? 2) : (b.petalHeal ?? 1));
            applyHeal(st, id, healAmt);
          }
          b.remaining -= 1;
          if (b.remaining > 0) next.push(b);
        }
        st.tileAuras.blossoms = next;}

    }
        if (fx.entangle && fx.entangle.remaining > 0){
          fx.entangle.remaining -= 1;
          if (fx.entangle.remaining <= 0) delete fx.entangle;
        }
        if (fx.ironSkin && fx.ironSkin.remaining > 0){
          fx.ironSkin.remaining -= 1;
          if (fx.ironSkin.remaining <= 0) delete fx.ironSkin;
        }

if (fx.bear && fx.bear.remaining > 0){
  fx.bear.remaining -= 1;
  if (fx.bear.remaining <= 0) delete fx.bear;
}

      
        



// REDIRECT tick
        if (fx.redirect && fx.redirect.remaining > 0){
          fx.redirect.remaining -= 1;
          if (fx.redirect.remaining <= 0) delete fx.redirect;
        }
        
}
    }
    

function healBlossomAtEnd(st, seat){
  try{
    const healed = new Set();
    const doHeal = (map, amount) => {
      if (!map) return;
      map.forEach((v, tile)=>{
        let active = 0;
        if (v && typeof v === 'object' && ('player1' in v || 'player2' in v)) {
          active = v[seat] || 0;
        } else if (v && typeof v === 'object' && 'owner' in v && 'ttl' in v) {
          active = (v.owner === seat) ? v.ttl : 0;
        }
        if (!active) return;
        for (const [id, tok] of st.tokens){
          if (tok.owner !== seat) continue;
          if (tok.tile === tile && !healed.has(id)){
            applyHeal(st, id, amount);
            healed.add(id);
          }
        }
      });
    };
    doHeal(st.blossomWalls, 2);
    doHeal(st.blossomPinkWalls, 1);
  }catch(e){ /* ignore */ }
}


function endTurnTo(st, next){
  if (st.gameEnded) return;
  const prev = st.currentTurn;
  /* [ENERGY] add to the player who just ended their turn */
  ensureEnergy(st);
  const __energGain = energyGainForRound(st.round);
  st.energy[prev] = Math.min(ENERGY_MAX, (st.energy[prev]||0) + __energGain);
tickWalls(st);
  healBlossomAtEnd(st, prev);
  if (st.mode === 'control' && prev === 'player2') { scoreControlRound(st); }

  
  // Advance the round counter after both players have taken a turn
  if (st.round == null) st.round = 1;
  if (prev === 'player2') st.round += 1;
// Healing Petals (tileAuras.blossoms): heal & tick only on OWNER's end turn
  if (st.tileAuras && Array.isArray(st.tileAuras.blossoms)){
    const nextBlossoms = [];
    for (const b of st.tileAuras.blossoms){
      if (b.owner === prev){
        if (st.tokens && typeof st.tokens.forEach === 'function'){
          st.tokens.forEach((tok, id)=>{
            if (!tok || tok.owner !== prev) return; // only heal owner's units
            if (!b.tiles || !b.tiles.includes(tok.tile)) return;
            const healAmt = (tok.tile === b.center ? (b.centerHeal ?? 2) : (b.petalHeal ?? 1));
            applyHeal(st, id, healAmt);
          });
        } else if (st.tokens && Symbol.iterator in Object(st.tokens)){
          for (const [id, tok] of st.tokens){
            if (!tok || tok.owner !== prev) continue;
            if (!b.tiles || !b.tiles.includes(tok.tile)) continue;
            const healAmt = (tok.tile === b.center ? (b.centerHeal ?? 2) : (b.petalHeal ?? 1));
            applyHeal(st, id, healAmt);
          }
        }
        b.remaining = (b.remaining|0) - 1;
      }
      if ((b.remaining|0) > 0) nextBlossoms.push(b);
    }
    st.tileAuras.blossoms = nextBlossoms;
  // Prune expired blossoms immediately so they vanish after 2nd owner end turn
  st.tileAuras.blossoms = st.tileAuras.blossoms.filter(b => (b.remaining|0) > 0);
  }
  tickBlossomWalls(st, prev);
  tickBlossomPinkWalls(st, prev);
  // Don Atore passive — heal +1 at the end of OWNER's turn
  try {
    for (const [id, ch] of st.chars){
      const tok = st.tokens.get(id);
      if (!tok || tok.owner !== prev) continue;
      if ((ch && ch.name) === 'Don Atore' && !ch.dead){
        applyHeal(st, id, 1);
      }
    }
  } catch(_){ /* ignore */ }

  for (const [id, c] of st.chars){
    const tok = st.tokens.get(id);
    if (tok && tok.owner === prev && c.cds.special > 0) c.cds.special -= 1;
  }

  // Clear per-character one-turn bonuses for the player who ended their turn
  for (const [id, ch] of st.chars){
    const tok = st.tokens.get(id);
    if (tok && tok.owner === prev && ch.fx){ delete ch.fx.attackBonusThisTurn; delete ch.fx.moveBonusThisTurn; }
  }
  st.currentTurn = next;
  // Promote beginning-of-turn buffs
  processStartOfTurn(st, next);

  resetPerTurn(st, prev);
  io.to(st.roomId).emit('nextTurn', st.currentTurn);
  sendFullState(st.roomId);
}

function maybeEndTurn(st, role){
  if (st.gameEnded) return;
  const ts = st.turnState[role];
  if (ts.usedMovement && ts.usedAction) endTurnTo(st, other(role));
  else sendFullState(st.roomId);
}

function applyDamage(st, targetId, amount){
  /* REDIRECT to Voodoo */
  try {
    const tok = st.tokens.get(targetId);
    const owner = tok ? tok.owner : null;
    if (owner){
      // find a living ally with redirect active
      for (const [id, ch] of st.chars){
        const t = st.tokens.get(id);
        if (!t || t.owner !== owner) continue;
        if (id === targetId) continue;
        const fx = ch.fx || {};
        if (fx.redirect && fx.redirect.remaining > 0 && !ch.dead){
          targetId = id; // move damage to Voodoo
          break;
        }
      }
    }
  } catch(e){ /* ignore */ }
  // IRON SKIN mitigation
  const c = st.chars.get(targetId); if (!c || c.dead) return;
  let eff = amount;
const hasBear = !!(c.fx && c.fx.bear && c.fx.bear.remaining > 0);
const hasIron = !!(c.fx && c.fx.ironSkin && c.fx.ironSkin.remaining > 0);
// Order: Transform first (50% DR, ceil), then Iron Skin flat reduction
if (hasBear) {
  eff = Math.ceil(eff * 0.5);
}
if (hasIron) {
  const cut = (c.fx.ironSkin.reduce ?? 2);
  eff = Math.max(0, eff - cut);
}
const before = c.hp;                                // <<< add
  c.hp = Math.max(0, c.hp - eff);
  io.to(st.roomId).emit('hpUpdate', {                // <<< add prev + type
    id: targetId,
    hp: c.hp,
    prev: before,
    type: 'dmg'
  });
  console.log('[DMG]', {
    roomId: st.roomId,
    targetId,
    amount,
    eff,
    ironSkinActive: !!(c.fx && c.fx.ironSkin && c.fx.ironSkin.remaining > 0)
  });
  sendFullState(st.roomId);
  
  // Dungeon Master Saving Throw: 1 in 3 chance to revive at 3 HP when reduced to 0
if (c.hp <= 0 && String(c.name||'').toLowerCase() === 'dungeon master'){
  // Roll 1..3. Fail on 1 or 2; succeed on 3.
  const roll = Math.floor(Math.random() * 3) + 1;
  const success = (roll === 3);

  // Inform clients of the roll (for HUD / logs)
  io.to(st.roomId).emit('savingThrow', { id: targetId, roll, success });

  if (success) {
    // Set HP to 3 (capped by maxHP if lower), clear death
    const maxCap = (c.maxHp != null) ? c.maxHp
                 : ((st.CHAR_DEFS && st.CHAR_DEFS[c.role] && st.CHAR_DEFS[c.role].maxHP)
                    ? st.CHAR_DEFS[c.role].maxHP : 3);
    const newHp = Math.min(maxCap, 3);
    c.hp = newHp;
    c.dead = false;

    // Heal blip + sync
    io.to(st.roomId).emit('hpUpdate', { id: targetId, hp: c.hp, prev: 0, type: 'heal' });

    // Push Saving Throw card to DM owner's discard (must include 'who' for the client)
    try {
      const raw = String(c.owner||'');
      let seat = raw;
      const low = raw.toLowerCase();
      if (low === 'p1' || low === 'player1') seat = 'player1';
      else if (low === 'p2' || low === 'player2') seat = 'player2';
      else if (low.includes('1')) seat = 'player1';
      else if (low.includes('2')) seat = 'player2';
      else seat = 'player1'; // safe default

      if (!st.lastDiscard) st.lastDiscard = {};
      st.lastDiscard[seat] = 'Saving Throw';
      io.to(st.roomId).emit('cardRevealed', { who: seat, type: 'Saving Throw' });
      io.to(st.roomId).emit('cardPlayed',   { who: seat, type: 'Saving Throw' });
    } catch(e) { /* ignore */ }

    sendFullState(st.roomId);
    return; // skip death handling
  }
}
  
if (c.hp <= 0){
    c.fx = {}; c.dead = true;
    if (st.tokens.has(targetId)) st.tokens.delete(targetId);
    io.to(st.roomId).emit('unitDied', { id: targetId });
    // Queue respawn at original spawn at the start of owner's next turn (Control mode only)
    try{
      if (st.mode === 'control'){
        if (!st.pendingRespawn) st.pendingRespawn = { player1: [], player2: [] };
        const seat = c.owner || (st.tokens.get(targetId)?.owner);
        if (seat && st.pendingRespawn[seat]){
          // avoid duplicates
          if (!st.pendingRespawn[seat].includes(targetId)) st.pendingRespawn[seat].push(targetId);
        }
      }
    }catch(_){}
    checkGameOver(st);
  }
}

function applyHeal(st, targetId, amount){
  const c = st.chars.get(targetId); if (!c || c.dead) return;
  const def = st.CHAR_DEFS[c.role];
  const before = c.hp;                                // <<< add
  c.hp = Math.min((c.maxHp ?? def.maxHP), c.hp + amount);
  io.to(st.roomId).emit('hpUpdate', {                // <<< add prev + type
    id: targetId,
    hp: c.hp,
    prev: before,
    type: 'heal'
  });
  console.log('[HEAL]', {
    roomId: st.roomId,
    targetId,
    amount,
    newHp: c.hp
  });
  sendFullState(st.roomId);
}

function checkGameOver(st){
  if (st.gameEnded) return;
  let p1Alive = 0, p2Alive = 0;
  st.tokens.forEach(t => { if (t.owner === 'player1') p1Alive++; else if (t.owner === 'player2') p2Alive++; });
  let winner = null;
  if (p1Alive === 0 && p2Alive > 0) winner = 'player2';
  if (p2Alive === 0 && p1Alive > 0) winner = 'player1';
  if (winner){
    st.gameEnded = true;
    io.to(st.roomId).emit('gameOver', { winner });
  }
}

function sendFullState(roomId, toSocket=null){
  const st = rooms.get(roomId); if (!st) return;
  const payload = { mode: st.mode || 'standard', control: st.control ? { anchor: st.control.anchor, tiles:[...(st.control.tiles||[])], scores:{...(st.control.scores||{player1:0,player2:0})}, tally:{...(st.control.tally||{player1:0,player2:0})}, progress:{...(st.control.progress||{player1:0,player2:0})}, round:(typeof st.control.round==='number'?st.control.round:1) } : null, 
    blocked: exportWalls(st),
    blossomBlocked: exportBlossomWalls(st),
    blossomPinkBlocked: exportBlossomPinkWalls(st),
    tokens: exportTokens(st),
    chars:  exportChars(st),
    currentTurn: st.currentTurn,
    playerNames: { ...st.playerNames },
    turn: {
      cardPlayed: st.turnState[st.currentTurn].cardPlayed,
      usedMovement: st.turnState[st.currentTurn].usedMovement,
      usedAction: st.turnState[st.currentTurn].usedAction
    },
    lastDiscard: { ...st.lastDiscard },
    energy: { ...(st.energy||{player1:0,player2:0}) },
    energyMax: ENERGY_MAX,
    fx: exportFx(st)
  };
  if (toSocket) io.to(toSocket).emit('fullState', payload);
  else io.to(roomId).emit('fullState', payload);
}

/* =========================================================
   SOCKET.IO
   ========================================================= */
io.on('connection', (socket) => {
  /* ---------- LOBBY: HOST ---------- */
  socket.on('lobby:host', ({ room, name, heroes })=>{
    const code = (room || '').trim();
    if (!code) { socket.emit('lobby:error', 'Room code required'); return; }
    const lob = ensureLobby(code);

    if (lob.host || lob.guest) {
      if (lob.host && lob.guest) { socket.emit('room:full', { room: code }); return; }
      if (lob.host && lob.host.socketId !== socket.id) {
        socket.emit('lobby:error', 'Room already hosted');
        return;
      }
    }

    lob.host = { socketId: socket.id, name: name?.trim() || 'Player 1', heroes: Array.isArray(heroes) ? heroes : [] };
    socket.join(`lobby-${code}`);
    socket.emit('lobby:waiting', { room: code });
  });

  /* ---------- LOBBY: JOIN ---------- */
  socket.on('lobby:join', ({ room, name, heroes })=>{
    const code = (room || '').trim();
    if (!code || !lobbies.has(code)) { socket.emit('lobby:notfound'); return; }
    const lob = lobbies.get(code);

    if (lob.guest) { socket.emit('room:full', { room: code }); return; }

    lob.guest = { socketId: socket.id, name: name?.trim() || 'Player 2', heroes: Array.isArray(heroes) ? heroes : [] };
    io.to(lob.host.socketId).emit('lobby:start', { room: code, host: lob.host, guest: lob.guest });
    io.to(lob.guest.socketId).emit('lobby:start', { room: code, host: lob.host, guest: lob.guest });
  });

  /* ---------- QUICK MATCH ---------- */
  socket.on('queue:quickmatch', ({ name, heroes })=>{
    const opponent = quickQueue.find(q => q.socketId !== socket.id);
    if (opponent){
      dequeueBySocket(opponent.socketId);
      const room = makeRoomCode();
      io.to(opponent.socketId).emit('match:found', { room });
      io.to(socket.id).emit('match:found', { room });
    }else{
      quickQueue.push({ socketId: socket.id, name, heroes });
      socket.emit('queue:status', 'Searching…');
    }
  });
  socket.on('queue:cancel', ()=>{ dequeueBySocket(socket.id); socket.emit('queue:status', 'Cancelled.'); });

  /* ---------- LIGHT CAPACITY CHECK ---------- */
  socket.on('room:check', ({ room }, ack)=>{
    const st = rooms.get(room);
    const seated = st ? st.players.filter(p=>p.seat==='player1'||p.seat==='player2').length : 0;
    const full = !!(st && st.locked && seated >= 2);
    if (typeof ack === 'function') ack({ full, seated });
  });

  /* ---------- GAME JOIN (index.html) ---------- */
  // payload: { room, name, heroes:[ids] }
  socket.on('game:join', ({ room, name, heroes, mode })=>{
    if (!room) return;

    // Create/fetch room state
    let st = rooms.get(room);
    if (!st) st = createRoomState(room);

    // Join socket.io room
    socket.join(room);

    // Set mode and initialize Control Points if requested
    const chosen = (mode === 'control') ? 'control' : 'standard';
    if (!st.mode || st.mode !== chosen){ st.mode = chosen; if (st.mode === 'control' && !st.control) initControlPoints(st); }
applyControlModeSpawns(st);



    // Upsert provisional player
    const existingIdx = st.players.findIndex(p => p.socketId === socket.id);
    const provisional = { socketId: socket.id, seat:'spectator', name: (name?.trim() || 'Player'), heroes: Array.isArray(heroes) ? heroes : [] };
    if (existingIdx >= 0) st.players[existingIdx] = { ...st.players[existingIdx], ...provisional };
    else st.players.push(provisional);

    // If room not locked and we have >=2 distinct players, assign random seats ONCE
    const activeSockets = st.players.filter(p => p.socketId);
    if (!st.locked && activeSockets.length >= 2) {
      const [a, b] = activeSockets.slice(0,2);
      const flip = Math.random() < 0.5;
      const p1 = flip ? a : b;
      const p2 = flip ? b : a;

      // assign seats
      p1.seat = 'player1';
      p2.seat = 'player2';
      st.seatBySocket.set(p1.socketId, 'player1');
      st.seatBySocket.set(p2.socketId, 'player2');
      st.locked = true;

      // record names
      st.playerNames.player1 = p1.name || 'Player 1';
      st.playerNames.player2 = p2.name || 'Player 2';

      // validate hero picks and store
      function validateAndStore(picks, seat){
        const resolved = (Array.isArray(picks)?picks:[]).map(id => HEROES[id]).filter(Boolean);
        const counts = { Tank:0, DPS:0, Support:0 };
        resolved.forEach(h => { if (h.archetype === 'Tank') counts.Tank++; else if (h.archetype === 'DPS') counts.DPS++; else if (h.archetype === 'Support') counts.Support++; });
        const valid = counts.Tank === 1 && counts.DPS === 2 && counts.Support === 1;
        if (!valid) return false;
        st.playerHeroes[seat] = resolved.map(h => h.id);
        return true;
      }
      const ok1 = validateAndStore(p1.heroes, 'player1');
      const ok2 = validateAndStore(p2.heroes, 'player2');
      if (!ok1) io.to(p1.socketId).emit('heroes:invalid', { reason:'Pick 1 Tank, 2 DPS, 1 Support' });
      if (!ok2) io.to(p2.socketId).emit('heroes:invalid', { reason:'Pick 1 Tank, 2 DPS, 1 Support' });

      // apply hero names to token display names (cards) and set per-hero maxHp
      function applyHeroNamesFor(seat){
        const ids = st.playerHeroes[seat] || [];
        const resolved = ids.map(id=>HEROES[id]).filter(Boolean);
        const byType = {
          Tank: resolved.find(h=>h.archetype==='Tank'),
          DPS:  resolved.filter(h=>h.archetype==='DPS'),
          Support: resolved.find(h=>h.archetype==='Support')
        };
        const mapNames = {};
        if (seat === 'player1'){
          if (byType.Tank)   mapNames.P1 = byType.Tank.name;
          if (byType.DPS[0]) mapNames.P2 = byType.DPS[0].name;
          if (byType.DPS[1]) mapNames.P3 = byType.DPS[1].name;
          if (byType.Support)mapNames.P4 = byType.Support.name;
        } else {
          if (byType.Tank)   mapNames.E1 = byType.Tank.name;
          if (byType.DPS[0]) mapNames.E2 = byType.DPS[0].name;
          if (byType.DPS[1]) mapNames.E3 = byType.DPS[1].name;
          if (byType.Support)mapNames.E4 = byType.Support.name;
        }
        // apply display names
        Object.entries(mapNames).forEach(([tid, nm])=>{
          if (st.tokens.has(tid)){ st.tokens.get(tid).name = nm; }
          if (st.chars.has(tid)){ const c = st.chars.get(tid); c.name = nm; }
        });
        // Also set per-character maxHp from HERO_STATS (fallback to class default)
        const roleIds = seat === 'player1' ? ['P1','P2','P3','P4'] : ['E1','E2','E3','E4'];
        for (const rid of roleIds) {
          const c = st.chars.get(rid);
          if (!c) continue;
          const heroName = mapNames[rid] || c.name;
          const def = st.CHAR_DEFS[c.role] || { maxHP: c.maxHp || c.hp || 10 };
          const stat = HERO_STATS[heroName];
          const newMax = (stat && stat.hpMax) ? stat.hpMax : ((c.maxHp != null) ? c.maxHp : def.maxHP);
          c.maxHp = newMax;
          c.hp = Math.min(c.hp, newMax);
        }
      }
      applyHeroNamesFor('player1');
      applyHeroNamesFor('player2');
      // === Match start: reset all characters to clean state ===
      // Clear any lingering status effects and ensure full HP at the moment the match locks.
      st.chars.forEach((c, id)=>{
        const def = st.CHAR_DEFS[c.role] || { maxHP: 10 };
        const maxHp = (c.maxHp != null) ? c.maxHp : def.maxHP;
        c.maxHp = maxHp;
        c.hp = maxHp;         // start at full health
        c.dead = false;
        c.cds = { special: 0 };
        c.fx = {};            // wipe DoTs/redirect/ironSkin/etc
      });


      // assign roles to sockets
      io.to(p1.socketId).emit('assignRole', 'player1');
      io.to(p2.socketId).emit('assignRole', 'player2');

      // send initial full state to both
      
      // [ENERGY] Give starting energy to the first player only once
      ensureEnergy(st);
      if ((st.energy.player1||0) === 0 && (st.energy.player2||0) === 0) {
        processStartOfTurn(st, st.currentTurn);
      }
sendFullState(st.roomId);
    } else if (st.locked) {
      // seating already done; tell this joining socket its seat (spectator or a seat if reconnected)
      const seat = st.seatBySocket.get(socket.id) || 'spectator';
      io.to(socket.id).emit('assignRole', seat);
      sendFullState(st.roomId, socket.id);
    } else {
      // not yet locked and only one person waiting — mark as spectator until another arrives
      st.seatBySocket.set(socket.id, 'spectator');
      io.to(socket.id).emit('assignRole', 'spectator');
      sendFullState(st.roomId, socket.id);
    }
  });

  /* ---------- MOVEMENT ---------- */
  socket.on('requestMove', ({ id, owner, toTile })=>{
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId);
    if (st.gameEnded) return;

    const mySeat = st.seatBySocket.get(socket.id);
    if (!mySeat || (mySeat !== 'player1' && mySeat !== 'player2')) return;
    if (st.currentTurn !== mySeat) return;

    const tok = st.tokens.get(id);
    if (!tok || tok.owner !== mySeat) return;
    if (!st.tilePositions[toTile]) return;
    // Entangle: rooted units cannot move
    const ch = st.chars.get(id);
    if (ch && ch.fx && ch.fx.entangle && ch.fx.entangle.remaining > 0){
      io.to(socket.id).emit('invalidMove', { id, reason: 'rooted' });
      return;
    
      io.to(socket.id).emit('invalidMove', { id });
      return;
    }

    const blocked = wallsSet(st);
    if (blocked.has(toTile)) { io.to(socket.id).emit('invalidMove', { id }); return; }
    const occ = occMap(st);
    if (occ.has(toTile)) { io.to(socket.id).emit('invalidMove', { id }); return; }

    const ts = st.turnState[mySeat];
    if (ts.moved && ts.moved[id]) { io.to(socket.id).emit('invalidMove', { id }); return; }
    const alreadyMoved = tok.hasMovedEver === true;
    const baseSteps = alreadyMoved ? 1 : 2;
    const charStepBonus = (ch && ch.fx && ch.fx.moveBonusThisTurn) ? ch.fx.moveBonusThisTurn : 0;
    const bearStepBonus = (ch && ch.fx && ch.fx.bear && ch.fx.bear.remaining > 0) ? 1 : 0;
    const bonusOnce = (ts.moveBuff?.stepsBonusNext || 0);
    const bonusPersist = (ts.moveBuff?.stepsBonus || 0);
    const steps = baseSteps + bonusPersist + bonusOnce + charStepBonus + bearStepBonus;
    const minSteps = ts.moveBuff?.minSteps || 0;

    const dist = shortestDistance(st, tok.tile, toTile, blocked);
    if (dist === Infinity || dist > steps || dist < minSteps) { io.to(socket.id).emit('invalidMove', { id }); return; }

    tok.tile = toTile;
    tok.hasMovedEver = true;
    ts.moved = ts.moved || {}; ts.moved[id] = true;
    if (ts.moveBuff && ts.moveBuff.stepsBonusNext) ts.moveBuff.stepsBonusNext = 0;

    io.to(st.roomId).emit('move', { id, owner: mySeat, toTile, capturedId: null });
    maybeEndTurn(st, mySeat);
  });

  /* ---------- ABILITIES ---------- */
  socket.on('usePrimary', ({ sourceId, targetId })=>{
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId);
    if (st.gameEnded) return;
    const seat = st.seatBySocket.get(socket.id);
    if (!seat || seat !== st.currentTurn) return;

    
    // Loadstone AoE primary (instant): Sonic Slam — hits all enemies within 1 tile for 2 dmg
    {
      const defAoe = (getCharDef(st, st.chars.get(sourceId)) || {}).primary;
      if (defAoe && defAoe.type === 'aoe') {
        { const ts = st.turnState[seat] || (st.turnState[seat] = {}); if (ts.acted && ts.acted[sourceId]) return; } const tok = st.tokens.get(sourceId);
        if (!tok) return;
        const ring = neighbors(st, tok.tile) || [];
        const walls = wallsSet(st);
        const hits = [];
        for (const [id, t] of st.tokens.entries()){
          if (!t || t.owner === seat) continue;
          const dist = shortestDistance(st, tok.tile, t.tile, walls);
          if (dist !== Infinity && dist <= (defAoe.range || 1)) {
            const atkB = (st.chars.get(sourceId)?.fx?.attackBonusThisTurn)||0;
            applyDamage(st, id, (defAoe.dmg || 0) + atkB);
            hits.push(id);
          }
        }
        const ts2 = st.turnState[seat] || (st.turnState[seat] = {});
       ts2.acted = ts2.acted || {}; ts2.acted[sourceId] = true;  ts2.acted = ts2.acted || {}; ts2.acted[sourceId] = true;
        io.to(st.roomId).emit('abilityUsed', { kind:'primary', sourceId, targetId: sourceId, name: defAoe.name || 'Reverse Polarity', hits });
        st.lastDiscard[seat] = (defAoe.name || 'Reverse Polarity');
    io.to(st.roomId).emit('cardPlayed', { type: (defAoe.name || 'Reverse Polarity'), who: seat });
    maybeEndTurn(st, seat);
        return;
      }
    }

    const src = st.chars.get(sourceId), tgt = st.chars.get(targetId);
    if (!src || !tgt) return;
    if (st.tokens.get(sourceId)?.owner !== seat) return;

    const def = (getCharDef(st, src) || {}).primary;
    if (!def) return;

    const srcTile = st.tokens.get(sourceId)?.tile;
    const tgtTile = st.tokens.get(targetId)?.tile;
    if (!srcTile || !tgtTile) return;
    const d = shortestDistance(st, srcTile, tgtTile, wallsSet(st));
    const exact = (src.name === 'Aimbot');
    if (d === Infinity) return;
    if (exact ? (d !== (def.range ?? 1)) : (d > (def.range ?? 1))) return;

    const ts = st.turnState[seat]; if (!ts.acted) ts.acted = {};
    let lastPrimaryDmg = null;


    // [ENERGY] helper to validate/deduct energy for a card
    function requirePay(cardType){
      if (!canPay(st, seat, cardType)){
        io.to(socket.id).emit('insufficientEnergy', { card: cardType, have:(st.energy?.[seat]||0), required:(CARD_COST[cardType]||0) });
        return false;
      }
      pay(st, seat, cardType);
      return true;
    }
    if (ts.acted && ts.acted[sourceId]) return;

    

if (def.type === 'damage') {
      let dmgVal = def.dmg || 0;
      const srcChar = st.chars.get(sourceId);
      const srcName = srcChar ? (srcChar.name || '') : '';
      const fxsrc = (srcChar && srcChar.fx) ? srcChar.fx : {};

      // Dungeon Master — 1D6: roll 1..6, then +1 if Skill Check is active (either promoted or pending)
      const defName = String(def.name||'').toLowerCase().replace(/\s+/g,'');
      const isDM = srcName.toLowerCase() === 'dungeon master';
      const isD6 = defName.includes('1d6');

      if (isDM && isD6) {
        const roll = 1 + Math.floor(Math.random()*6);
        const scActive = !!(fxsrc.attackBonusThisTurn || (fxsrc.skillCheckNext && fxsrc.skillCheckNext.attack));
        dmgVal = roll + (scActive ? 1 : 0);
      } else {
        // Generic path: everyone gets attackBonusThisTurn; DM also gets fallback +1 if Skill Check is pending
        let atkB = fxsrc.attackBonusThisTurn || 0;
        if (isDM && !atkB && fxsrc.skillCheckNext && fxsrc.skillCheckNext.attack) atkB += 1;
        dmgVal += atkB;
      }

      // Little Bear transform bonus (unchanged)
      if (src && src.name === 'Little Bear' && src.fx && src.fx.bear && src.fx.bear.remaining > 0) { dmgVal += 2; }

      applyDamage(st, targetId, dmgVal);
      lastPrimaryDmg = dmgVal;
    }
    if (def.type === 'heal')   applyHeal(st, targetId, def.heal || 0);

    ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
    io.to(st.roomId).emit('abilityUsed', { kind:'primary', sourceId, targetId, name:def.name });
    let __type = def.name;
    try{ const _src = st.chars.get(sourceId); if (_src && _src.name === 'Little Bear' && _src.fx && _src.fx.bear && _src.fx.bear.remaining>0){ __type = 'Bear Claw'; } }catch(e){}
try{
      if (src && src.name === 'Dungeon Master' && String(def.name||'').toLowerCase()==='1d6' && typeof lastPrimaryDmg==='number'){
        const atkBNow = (src?.fx?.attackBonusThisTurn)||0;
        const v = lastPrimaryDmg|0;
        if (atkBNow>0){
          const face = Math.max(2, Math.min(7, v));
          __type = `1D6SC-${face}`;
        } else {
          const face = Math.max(1, Math.min(6, v));
          __type = `1D6-${face}`;
        }
      }
    }catch(e){}st.lastDiscard[seat] = __type;
    io.to(st.roomId).emit('cardPlayed', { type: __type, who: seat });
    maybeEndTurn(st, seat);
  });


  /* ---------- SPECIAL: Trickster Swap (no energy, no range) ---------- */
  
  /* ---------- SPECIALS: Swap & FMJ ---------- */
socket.on('useSpecial', ({ sourceId, targetId })=>{
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId); if (!st || st.gameEnded) return;
    const seat = st.seatBySocket.get(socket.id);
    if (!seat || seat !== st.currentTurn) return;

    // Validate source/target
    const src = st.chars.get(sourceId); const tgt = st.chars.get(targetId);
    if (!src || !tgt) return;
    if (st.tokens.get(sourceId)?.owner !== seat) return;
    // Per-character action guard (specials share the same 1/turn gate as primaries)
    { const ts = st.turnState[seat] || (st.turnState[seat] = {}); if (ts.acted && ts.acted[sourceId]) return; }


    // Move/transfer entangle when swapping later
    try {
      const sfx = getFx(st, sourceId);
      const tfx = getFx(st, targetId);
      if (sfx && sfx.entangle && sfx.entangle.remaining > 0){
        tfx.entangle = { ...(tfx.entangle||{}), remaining: sfx.entangle.remaining };
        delete sfx.entangle;
      }
    } catch(e){ /* ignore */ }

    const def = getCharDef(st, src) || {};
    const spec = def.special || {};

// Self-heal specials (e.g., Don Atore — Replenish)
if (spec && spec.type === 'selfHeal') {
  if (!requirePay(spec.name || 'Replenish')) return;
  const amt = (spec.heal ?? spec.amount ?? 5);
  applyHeal(st, sourceId, amt);
  const ts = st.turnState[seat] || (st.turnState[seat] = {});
  if (!ts.acted) ts.acted = {}; ts.acted[sourceId] = true;
  io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId: sourceId, name: spec.name || 'Replenish', extra:{ healed:[sourceId], amount: amt } });
  st.lastDiscard[seat] = spec.name || 'Replenish';
  io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Replenish', who: seat });
  maybeEndTurn(st, seat);
  return;
}


    // Dungeon Master — Skill Check (ally buff next turn)
    if (spec.type === 'buff'){
      const srcTok = st.tokens.get(sourceId); const tgtTok = st.tokens.get(targetId);
      if (!srcTok || !tgtTok) return;
      if (tgtTok.owner !== seat) return; // ally-only
      const d = shortestDistance(st, srcTok.tile, tgtTok.tile, wallsSet(st));
      if (d === Infinity || d > (spec.range || 2)) return;
      if (!requirePay('SkillCheck')) return;
      const tfx = getFx(st, targetId);
      tfx.skillCheckNext = { move: 1, attack: 1, remaining: 1 };
      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true; 
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId, name: spec.name || 'Skill Check', extra:{ attack:+1, move:+1 } });
      st.lastDiscard[seat] = spec.name || 'Skill Check';
      io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Skill Check', who: seat });
      maybeEndTurn(st, seat);
      return;
    }


    // Helper: energy payment using CARD_COST
    function requirePay(label){
      if (!canPay(st, seat, label)){ io.to(socket.id).emit('insufficientEnergy', { card: label, have:(st.energy?.[seat]||0), required:(CARD_COST[label]||0) }); return false; }
      pay(st, seat, label); return true;
    }

    // Helper: tiles on segment between a and b (screen coords)
    function tilesOnSegment(aTile, bTile){
      const A = st.tilePositions[aTile]; const B = st.tilePositions[bTile];
      if (!A || !B) return [];
      const dx = B.x - A.x, dy = B.y - A.y;
      const L2 = dx*dx + dy*dy || 1;
      const out = [];
      for (const [tid, P] of Object.entries(st.tilePositions)){
        // project P onto AB
        const t = ((P.x - A.x)*dx + (P.y - A.y)*dy) / L2;
        if (t < -0.05 || t > 1.05) continue;
        const px = A.x + t*dx, py = A.y + t*dy;
        const dist = Math.hypot(P.x - px, P.y - py);
        if (dist <= 30) out.push({tid, t});
      }
      out.sort((u,v)=>u.t - v.t);
      return out.map(o=>o.tid);
    }

    // Voodoo Doll — redirect ally damage to self
// Loadstone special: Polar Attraction — pull enemies within 2 tiles onto open adjacent tiles
if (spec && spec.type === 'polar') {
  if (!requirePay('PolarAttraction')) return;
  const srcTok = st.tokens.get(sourceId);
  if (srcTok){
    const ring1 = neighbors(st, srcTok.tile) || [];
    const occ = occMap(st);
    const open = ring1.filter(t => !occ.has(t) && !st.walls.has(t));
    const walls = wallsSet(st);
    const candidates = [];
    st.tokens.forEach((tok, id)=>{
      if (!tok || tok.owner === seat) return;
      const d = shortestDistance(st, srcTok.tile, tok.tile, walls);
      if (d !== Infinity && d <= (spec.range || 2)) candidates.push(id);
    });
    
// Directional, order-preserving placement using rotational alignment
const posSrc = st.tilePositions[srcTok.tile];
function angleFromSrc(tileId){
  const p = st.tilePositions[tileId];
  return Math.atan2(p.y - posSrc.y, p.x - posSrc.x);
}
function angDiff(a,b){ let d = Math.abs(a-b); if (d > Math.PI) d = 2*Math.PI - d; return d; }

// Open neighbor slots with angles, sorted clockwise
let openSlots = open.map(t => ({ tile:t, ang: angleFromSrc(t) })).sort((a,b)=> a.ang - b.ang);

// Build eligible candidates (not adjacent, not entangled), with angles, sorted clockwise
let eligible = [];
for (const eid of candidates){
  const et = st.tokens.get(eid);
  if (!et) continue;
  const dNow = shortestDistance(st, srcTok.tile, et.tile, walls);
  if (dNow <= 1) continue; // already adjacent
  try { const efx = getFx(st, eid); if (efx && efx.entangle && efx.entangle.remaining > 0) continue; } catch(e) {}
  eligible.push({ id:eid, ang: angleFromSrc(et.tile) });
}
eligible.sort((a,b)=> a.ang - b.ang);

const M = openSlots.length;
const K = Math.min(eligible.length, M);
if (K > 0){
  // Choose rotation r that minimizes total angular difference between eligible[j] and open[(j+r)%M]
  let bestR = 0, bestSum = Infinity;
  for (let r = 0; r < M; r++){
    let sum = 0;
    for (let j = 0; j < K; j++){
      sum += angDiff(eligible[j].ang, openSlots[(j+r)%M].ang);
    }
    if (sum < bestSum){ bestSum = sum; bestR = r; }
  }
  // Apply mapping with preserved order
  for (let j = 0; j < K; j++){
    const eid = eligible[j].id;
    const dest = openSlots[(j+bestR)%M].tile;
    const etok = st.tokens.get(eid);
    if (!etok) continue;
    etok.tile = dest;
    io.to(st.roomId).emit('move', { id:eid, owner: etok.owner, toTile: dest, capturedId: null });
  }
}

const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
    ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
    io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId: sourceId, name: spec.name || 'Polar Attraction' });
    st.lastDiscard[seat] = spec.name || 'Polar Attraction' ;
    io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Polar Attraction' , who: seat });
    maybeEndTurn(st, seat);
    return;
  }
}

    
    // Little Bear — Transform (auto self)
    if (spec.type === 'transform'){
      if (!targetId) targetId = sourceId;
      if (!requirePay('Transform')) return;
      const tfx = getFx(st, targetId);
      tfx.bear = { remaining: 3, reduce: 2 };
      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true; 
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId: sourceId, name: spec.name || 'Transform' });
      st.lastDiscard[seat] = spec.name || 'Transform';
      io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Transform', who: seat });
      sendFullState(st.roomId);
      maybeEndTurn(st, seat);
      return;
    }
if (spec.type === 'redirect'){
      if (!requirePay('VoodooDoll')) return;
      const sfx = getFx(st, sourceId);
      sfx.redirect = { remaining: spec.duration || 2 };
      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId: sourceId, name: 'Voodoo Doll' });
      st.lastDiscard[seat] = 'Voodoo Doll' ;
    io.to(st.roomId).emit('cardPlayed', { type: 'Voodoo Doll' , who: seat });
    maybeEndTurn(st, seat);
      return;
    }

    // FMJ (Aimbot) — line damage
    if (spec.type === 'fmj'){
      const srcTok = st.tokens.get(sourceId); const tgtTok = st.tokens.get(targetId);
      if (!srcTok || !tgtTok) return;
      // Range check ignoring walls (use BFS distance)
      const d = shortestDistance(st, srcTok.tile, tgtTok.tile, null);
      if (d === Infinity || d > (spec.range||4)) return;
      if (!requirePay('FMJ')) return;
      const tiles = tilesOnSegment(srcTok.tile, tgtTok.tile);
      const myTeam = seat;
      const dmg = spec.dmg || 5;
      const hits = [];
      for (const tid of tiles){
        for (const [id, tok] of st.tokens.entries()){
          if (tok.tile === tid && tok.owner !== myTeam){
            applyDamage(st, id, dmg);
            hits.push(id);
          }
        }
      }
      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId, name:'FMJ', tiles, hits });
      st.lastDiscard[seat] = 'FMJ';
    io.to(st.roomId).emit('cardPlayed', { type: 'FMJ', who: seat });
    maybeEndTurn(st, seat);
      return;
    }

    // Default: Trickster Swap
    
    // Healing Blossom (Death Blossom) — tile-targeted aura that heals 2 at center, 1 on petals for 2 turns.
    if (spec.type === 'petal'){
      const centerTile =
        (typeof arguments[0]?.centerTile === 'string' && arguments[0].centerTile) ||
        (st.tokens.get(targetId)?.tile);
      function requirePay(label){
        if (!canPay(st, seat, label)){
          io.to(socket.id).emit('insufficientEnergy', { card: label, have:(st.energy?.[seat]||0), required:(CARD_COST[label]||0) });
          return false;
        }
        pay(st, seat, label); return true;
      }
      if (!requirePay('HealingPetal')) return;
      if (!centerTile || !st.tilePositions[centerTile]) return;
      const tiles = [centerTile, ...neighbors(st, centerTile)];
      if (!st.tileAuras) st.tileAuras = { blossoms: [] };
      st.tileAuras.blossoms.push({ owner: seat, center: centerTile, tiles, remaining: 2, centerHeal: 2, petalHeal: 1 });
      const ts = st.turnState[seat]; ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, name: spec.name || 'Healing Blossom', extra:{ centerTile, tiles } });
      st.lastDiscard[seat] = spec.name || 'Healing Blossom';
    io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Healing Blossom', who: seat });
    maybeEndTurn(st, seat);
      return;
    }
    // Healing Petal (legacy) (Death Blossom): heal allies within radius around target tile
    if (spec.type === 'petal'){
      if (!requirePay('HealingPetal')) return;
      const srcTok = st.tokens.get(sourceId); const tgtTok = st.tokens.get(targetId);
      if (!srcTok || !tgtTok) return;
      const d = shortestDistance(st, srcTok.tile, tgtTok.tile, null);
      if (d === Infinity || d > (spec.range || 99)) return;

      const radius = spec.radius || 1;
      const center = tgtTok.tile;
      const q = [[center,0]]; const seen = new Set([center]); const tiles = new Set([center]);
      while (q.length){
        const [cur, dist] = q.shift();
        if (dist >= radius) continue;
        for (const nb of neighbors(st, cur)){
          if (!seen.has(nb)){
            seen.add(nb); tiles.add(nb);
            q.push([nb, dist+1]);
          }
        }
      }
      const myTeam = seat;
      let healed = [];
      for (const [uid, tok] of st.tokens.entries()){
        if (tiles.has(tok.tile) && tok.owner === myTeam){
          applyHeal(st, uid, spec.heal || 3);
          healed.push(uid);
        }
      }
      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId, name: spec.name || 'Healing Blossom', extra:{healed} });
      st.lastDiscard[seat] = spec.name || 'Healing Blossom';
    io.to(st.roomId).emit('cardPlayed', { type: spec.name || 'Healing Blossom', who: seat });
    maybeEndTurn(st, seat);
      return;
    }
if (spec.type === 'swap'){
      if (!requirePay('Swap')) return;
const tokA = st.tokens.get(sourceId);
      const tokB = st.tokens.get(targetId);
      if (!tokA || !tokB) return;
      const a = tokA.tile, b = tokB.tile;
      if (!a || !b) return;

      tokA.tile = b; tokB.tile = a;

      const ts = st.turnState[seat] || (st.turnState[seat] = {});
      if (!ts.acted) ts.acted = {};
      ts.acted = ts.acted || {}; ts.acted[sourceId] = true;ts.moved = ts.moved || {}; ts.moved[sourceId] = true; ts.moved[targetId] = true;
io.to(st.roomId).emit('move', { id: sourceId, owner: seat, toTile: tokA.tile, capturedId: null });
      io.to(st.roomId).emit('move', { id: targetId, owner: tgt.owner, toTile: tokB.tile, capturedId: null });
      io.to(st.roomId).emit('abilityUsed', { kind:'special', sourceId, targetId, name: 'Swap' });
      st.lastDiscard[seat] = 'Swap';
      io.to(st.roomId).emit('cardPlayed', { type: 'Swap', who: seat });
      maybeEndTurn(st, seat);
      return;
    }
  });

/* ---------- PRIMARY: Don Atore — Blood Donation (tap-to-heal) ---------- */
socket.on('don:tapHeal', ({ sourceId, targetId })=>{
  const roomId = [...socket.rooms].find(r => rooms.has(r));
  if (!roomId) return;
  const st = rooms.get(roomId); if (!st || st.gameEnded) return;
  const seat = st.seatBySocket.get(socket.id);
  if (!seat || seat !== st.currentTurn) return;

  const srcTok = st.tokens.get(sourceId); const tgtTok = st.tokens.get(targetId);
  const srcChar = st.chars.get(sourceId);
  if (!srcTok || !tgtTok || !srcChar) return;
  // must own the source; target must be an ally
  if (srcTok.owner !== seat) return;
  if (tgtTok.owner !== seat) return;

  // Per-character action guard (primaries share 1/turn gate)
  {}

  // range check (range 1)
  const d = shortestDistance(st, srcTok.tile, tgtTok.tile, wallsSet(st));
  if (d === Infinity || d > 1) return;

  // Apply: source loses 1, target heals 1
  applyDamage(st, sourceId, 1);
  applyHeal(st, targetId, 1);

  // Mark action used for this unit
  const ts = st.turnState[seat] || (st.turnState[seat] = initialTurnState());
  

  // Broadcast ability usage
  io.to(st.roomId).emit('abilityUsed', { kind:'primary', sourceId, targetId, name:'Blood Donation', extra:{ healed:[targetId], amount:1, selfLoss:1 } });
  });



/* ---------- CARDS ---------- */
  socket.on('revealCard', ({ type }) => {
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId);
    if (st.gameEnded) return;
    const seat = st.seatBySocket.get(socket.id);
    if (!seat || seat !== st.currentTurn) return;
    // If you can't afford the card, don't reveal/discard; client will flash a warning
    if (!canPay(st, seat, type)) { io.to(socket.id).emit('insufficientEnergy', { card: type, have:(st.energy?.[seat]||0), required:(CARD_COST[type]||0) }); return; }
    // Do not spend energy here; this is purely to reveal the card UI
    st.lastDiscard[seat] = type;
    io.to(st.roomId).emit('cardRevealed', { who: seat, type });
  });

socket.on('playCard', function(payload){
  const { type, tile, sourceId, toTile, targetId } = payload || {};
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId);
    if (st.gameEnded) return;
    const seat = st.seatBySocket.get(socket.id);
    if (!seat || seat !== st.currentTurn) return;

    const ts = st.turnState[seat];
     // one card per turn (global guard)


    // [ENERGY] helper to validate/deduct energy for a card
    function requirePay(cardType){
      if (!canPay(st, seat, cardType)){
        io.to(socket.id).emit('insufficientEnergy', { card: cardType, have:(st.energy?.[seat]||0), required:(CARD_COST[cardType]||0) });
        return false;
      }
      pay(st, seat, cardType);
      return true;
    }


      // === Status cards (target-only, use targetId after pressing Play) ===

      // Fireball — apply DoT to enemy for 3 turns (2 dmg/turn)
      if (type === 'Fireball'){
if (!targetId) return;
        const tgt = st.chars.get(targetId); if (!tgt) return;
        if (tgt.owner === seat) return; // enemy only
        
        /* [ENERGY] pay cost for Fireball */
        if (!requirePay('Fireball')) return;
const fx = getFx(st, targetId); fx.fireDot = { remaining:3, per:2 };
        io.to(st.roomId).emit('cardPlayed', { type, targetId });
        maybeEndTurn(st, seat);
        return;
      }

      // Entangle — root enemy for 2 turns
      if (type === 'Entangle'){
if (!targetId) return;
        const tgt = st.chars.get(targetId); if (!tgt) return;
        if (tgt.owner === seat) return; // enemy only
        
        /* [ENERGY] pay cost for Entangle */
        if (!requirePay('Entangle')) return;
const fx = getFx(st, targetId); fx.entangle = { remaining: 3 };
        io.to(st.roomId).emit('cardPlayed', { type, targetId });
        maybeEndTurn(st, seat);
        return;
      }

      // Iron Skin — -2 incoming damage for 2 turns (ally/self only)
      if (type === 'Cleanse'){
if (!targetId) return;
        /* [ENERGY] pay cost for Cleanse */
        if (!requirePay('Cleanse')) return;
        const ch = st.chars.get(targetId);
        if (!ch) return;
        // Wipe all status effects on the target (ally or enemy)
        ch.fx = {};
        io.to(st.roomId).emit('cardPlayed', { type, targetId });
        maybeEndTurn(st, seat);
        return;
      }
      if (type === 'IronSkin'){
if (!targetId) return;
        const ally = st.chars.get(targetId); if (!ally) return;
        if (ally.owner !== seat) return; // must be ally
        
        /* [ENERGY] pay cost for IronSkin */
        if (!requirePay('IronSkin')) return;
const fx = getFx(st, targetId); fx.ironSkin = { remaining:2, reduce:2 };
        io.to(st.roomId).emit('cardPlayed', { type, targetId });
        maybeEndTurn(st, seat);
        return;
      }
         // only one card per turn

    function emitCardPlayed(extra={}){
      io.to(st.roomId).emit('cardPlayed', { type, who: seat, ...extra });
      st.lastDiscard[seat] = type;
    }

    // Movement-buff cards: consume card, don't immediately flip usedMovement
    
      // Energy Siphon — Instant: pay 3, gain 2 energy; opponent loses 3
      if (type === 'Siphon'){
        // obey one-card-per-turn rule
        
        /* [ENERGY] pay cost for Energy Siphon */
        if (!canPay(st, seat, 'Siphon')) return;
        ensureEnergy(st);
        const opp = other(seat);
        const gain = 1, steal = 3;
        // apply effects
        st.energy[seat] = Math.min(ENERGY_MAX, (st.energy[seat] || 0) + gain);
        st.energy[opp]  = Math.max(0, (st.energy[opp]  || 0) - steal);
        
        emitCardPlayed({ gain, steal });
        sendFullState(roomId);
        return;
      }
if (type === 'Sprint'){
      if (ts.moved && ts.moved[sourceId]) return; // can't buff after this unit already moved
      
        /* [ENERGY] pay cost for Sprinter */
        if (!requirePay('Sprint')) return;
ts.moveBuff.stepsBonusNext = (ts.moveBuff.stepsBonusNext||0) + 1;
      
      emitCardPlayed({ stepsBonus: ts.moveBuff.stepsBonusNext });
      sendFullState(roomId);
      return;
    }
    if (type === 'Dash'){
      if (ts.moved && ts.moved[sourceId]) return;
      
        /* [ENERGY] pay cost for Dash */
        if (!requirePay('Dash')) return;
ts.moveBuff.stepsBonus = (ts.moveBuff.stepsBonus||0) + 2;
      
      emitCardPlayed({ stepsBonus: ts.moveBuff.stepsBonusNext });
      sendFullState(roomId);
      return;
    }
    if (type === 'Blink'){
      if (ts.moved && ts.moved[sourceId]) return;
      
        /* [ENERGY] pay cost for Blink */
        if (!requirePay('Blink')) return;
ts.moveBuff.minSteps = Math.max(ts.moveBuff.minSteps||0, 2);
      
      emitCardPlayed({ minSteps: ts.moveBuff.minSteps });
      sendFullState(roomId);
      return;
    }

    // Scout = action
    if (type === 'Scout'){
/* [ENERGY] pay cost for Scout */
        if (!requirePay('Scout')) return;
emitCardPlayed();
      maybeEndTurn(st, seat);
      return;
    }

if (type === 'Wall'){
if (!tile) return;
    /* [ENERGY] pay cost for Wall */
  if (!requirePay('Wall')) return;
  if (!placeWall(st, tile)) return;
  
  // counts as action
  emitCardPlayed({ tile });
  // BEFORE: sendFullState(roomId);
  // AFTER:
  maybeEndTurn(st, seat);
  return;
}

if (type === 'BlossomWall') {
  // Heal Blossom: place center + pink ring; costs energy; counts as action for the casting character
  if (!tile) return;
  if (sourceId) {
    const ts = st.turnState[seat] || (st.turnState[seat] = {});
    if (ts.acted && ts.acted[sourceId]) return;
  }
  if (!requirePay('HealingPetal')) return;
  if (!placeBlossomWall(st, tile, seat)) return;
  placeBlossomPinkRing(st, tile, seat);
  if (sourceId) {
    const ts = st.turnState[seat] || (st.turnState[seat] = {});
    ts.acted = ts.acted || {}; ts.acted[sourceId] = true;
  }
  emitCardPlayed({ type:'BlossomWall', tile, owner: seat });
  maybeEndTurn(st, seat);
  return;
}
if (type === 'Shatter'){
if (!tile) return;
            /* [ENERGY] pay cost for Quake */
      if (!requirePay('Shatter')) return;
  if (!clearWall(st, tile)) return;
  
  // counts as action
  emitCardPlayed({ tile });
  // BEFORE: sendFullState(roomId);
  // AFTER:
  maybeEndTurn(st, seat);
  return;
}

    // Teleport = movement action (already moves the piece)
    if (type === 'Teleport'){
      if (ts.moved && ts.moved[sourceId]) return;
      
        
      // Block teleport if rooted (entangled)
      { const rootedChar = st.chars.get(sourceId); if (rootedChar && rootedChar.fx && rootedChar.fx.entangle && rootedChar.fx.entangle.remaining > 0) { io.to(socket.id).emit('invalidMove', { id: sourceId, reason: 'rooted' }); return; } }
/* [ENERGY] pay cost for Teleport */
        if (!requirePay('Teleport')) return;
const tok = st.tokens.get(sourceId);
      if (!tok || tok.owner !== seat) return;
      if (!st.tilePositions[toTile]) return;

      const dist = shortestDistance(st, tok.tile, toTile, null); // ignores walls
      if (dist === Infinity || dist > 3) return;
      if (occMap(st).has(toTile)) return;

      tok.tile = toTile;
      tok.hasMovedEver = true;
      ts.moved = ts.moved || {}; ts.moved[sourceId] = true;
      

      emitCardPlayed({ sourceId, toTile });
      io.to(st.roomId).emit('move', { id: sourceId, owner: seat, toTile, capturedId: null });
      maybeEndTurn(st, seat);
      return;
    }
  });

  /* ---------- TURN ---------- */
  socket.on('endTurn', ()=>{
    const roomId = [...socket.rooms].find(r => rooms.has(r));
    if (!roomId) return;
    const st = rooms.get(roomId);
    if (st.gameEnded) return;
    const seat = st.seatBySocket.get(socket.id);
    if (!seat || seat !== st.currentTurn) return;
    endTurnTo(st, other(seat));
  });

  /* ---------- DISCONNECT ---------- */
  socket.on('disconnect', ()=>{
    cleanupLobbyBySocket(socket.id);
    for (const [roomId, st] of rooms) {
      const idx = st.players.findIndex(p => p.socketId === socket.id);
      if (idx >= 0) {
        const leavingSeat = st.players[idx].seat;
        st.players.splice(idx,1);
        st.seatBySocket.delete(socket.id);
        if (leavingSeat === 'player1' || leavingSeat === 'player2') {
          if (!st.gameEnded) {
            st.gameEnded = true;
            io.to(st.roomId).emit('gameOver', { winner: other(leavingSeat) });
          }
        }
      }
    }
    dequeueBySocket(socket.id);
  });
});

/* =========================================================
   START SERVER
   ========================================================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chaotic Neutral listening on http://localhost:${PORT}`);
});
// [Patch] AoE1 primary handled in usePrimary above.

/* Control Points helpers (top-level) */
function initControlPoints(st){
  try{
    const ids = Object.keys(st.tilePositions||{});
    if (!ids.length) return;
    const eligible = ids.filter(id => (st.adjacency && (st.adjacency[id]||[]).length >= 3));
    const seedStr = String(st.roomId||'seed');
    let h=0; for (let i=0;i<seedStr.length;i++){ h = (h*31 + seedStr.charCodeAt(i))|0; }
        const pick = (st.tilePositions && st.tilePositions.E1) ? 'E1' : (eligible[0] || ids[0]);
    const nbs = (st.adjacency && st.adjacency[pick] ? st.adjacency[pick].slice() : []);
    nbs.sort((a,b)=>{
      const pa = st.tilePositions[a], pb = st.tilePositions[b];
      const da = Math.hypot(pa.x - st.centerX, pa.y - st.centerY);
      const db = Math.hypot(pb.x - st.centerX, pb.y - st.centerY);
      return da - db;
    });
    st.control = { anchor: pick, tiles: Array.from(new Set(nbs)).slice(0,3), scores:{ player1:0, player2:0 } };
  }catch(e){ st.control = { anchor:null, tiles:[], scores:{player1:0,player2:0} }; }
}

function scoreControlRound(st){
  if (!st || st.mode!=='control' || !st.control) return;
  let p1=0, p2=0;
  const tileSet = new Set(st.control.tiles||[]);
  const anchor = st.control.anchor || null;

  if (st.tokens && typeof st.tokens.forEach === 'function'){
    st.tokens.forEach((tok)=>{
      if (!tok || !tok.tile) return;
      if (anchor && tok.tile === anchor){
        if (tok.owner==='player1') p1 += 2;
        else if (tok.owner==='player2') p2 += 2;
      } else if (tileSet.has(tok.tile)){
        if (tok.owner==='player1') p1++;
        else if (tok.owner==='player2') p2++;
      }
    });
  } else if (st.tokens && Symbol.iterator in Object(st.tokens)){
    for (const [, tok] of st.tokens){
      if (!tok || !tok.tile) continue;
      if (anchor && tok.tile === anchor){
        if (tok.owner==='player1') p1 += 2;
        else if (tok.owner==='player2') p2 += 2;
      } else if (tileSet.has(tok.tile)){
        if (tok.owner==='player1') p1++;
        else if (tok.owner==='player2') p2++;
      }
    }
  }

  st.control.scores = st.control.scores || { player1:0, player2:0 };
  st.control.scores.player1 += p1;
  st.control.scores.player2 += p2;

  if (st.control.scores.player1 >= 10 || st.control.scores.player2 >= 10){
    const winner = (st.control.scores.player1 >= 10) ? 'player1' : 'player2';
    try { st.gameEnded = true; io.to(st.roomId).emit('gameOver', { winner }); } catch(_){}
  }
}


/* =====================================================================
   Control Mode: Best-of-5 rounds with progress-to-10 and mirroring
   ---------------------------------------------------------------------
   This block overrides scoreControlRound(st) without touching the rest.
   It lazily creates st.control.progress {p1,p2} and st.control.round.
   On round win (>=10), it increments series score, mirrors control
   anchor/tiles and respawn points, resets progress, and checks first-to-3.
   ===================================================================== */

function __cn_mirrorTile(st, tileId){
  try{
    if (!st || !st.tilePositions || !st.tilePositions[tileId]) return tileId;
    const pos = st.tilePositions[tileId];
    const targetX = 2*st.centerX - pos.x;
    const targetY = 2*st.centerY - pos.y;
    let bestId = tileId, bestD = Infinity;
    for (const [id, p] of Object.entries(st.tilePositions)){
      const dx = p.x - targetX, dy = p.y - targetY;
      const d = dx*dx + dy*dy;
      if (d < bestD){ bestD = d; bestId = id; }
    }
    return bestId;
  }catch(_){ return tileId; }
}

function __cn_mirrorRespawnPoints(st){
  try{
    if (!st || !st.respawnAt) return;
    const next = {};
    for (const k of Object.keys(st.respawnAt)){
      next[k] = __cn_mirrorTile(st, st.respawnAt[k]);
    }
    st.respawnAt = next;
  }catch(_){ /* noop */ }
}

function __cn_mirrorControl(st){
  try{
    if (!st || !st.control) return;
    const anc = st.control.anchor;
    const tiles = st.control.tiles || [];
    st.control.anchor = anc ? __cn_mirrorTile(st, anc) : anc;
    st.control.tiles  = tiles.map(t => __cn_mirrorTile(st, t));
  }catch(_){ /* noop */ }
}

// Override
function scoreControlRound(st){
  if (!st || st.mode!=='control' || !st.control) return;

  // Lazy init
  if (!st.control.scores) st.control.scores = { player1:0, player2:0 };
  if (!st.control.progress) st.control.progress = { player1:0, player2:0 };
  if (typeof st.control.round !== 'number') st.control.round = 1;

  // Tally this tick
  let p1=0, p2=0;
  const tset = new Set(st.control.tiles || []);
  const anc  = st.control.anchor || null;
  for (const [id, tok] of st.tokens){
    if (!tok || !tok.tile) continue;
    if (anc && tok.tile === anc){
      if (tok.owner==='player1') p1 += 2;
      else if (tok.owner==='player2') p2 += 2;
    } else if (tset.has(tok.tile)){
      if (tok.owner==='player1') p1 += 1;
      else if (tok.owner==='player2') p2 += 1;
    }
  }
  st.control.progress.player1 += p1;
  st.control.progress.player2 += p2;

  // Round completion
  let roundWinner = null;
  if (st.control.progress.player1 >= 10) roundWinner = 'player1';
  if (st.control.progress.player2 >= 10) roundWinner = 'player2';

  if (roundWinner){
    st.control.scores[roundWinner] += 1;
    st.control.tally.player1 += p1;
      st.control.tally.player2 += p2;
      st.control.round += 1;

    // Reset progress for next round
    st.control.progress = { player1:0, player2:0 };

    // Mirror for the next round
    __cn_mirrorControl(st);
    __cn_mirrorRespawnPoints(st);

    // Notify
    try{ io.to(st.roomId).emit('roundWon', { winner: roundWinner, scores: { ...st.control.scores }, round: st.control.round }); }catch(_){}

    // Best of 5 => first to 3 ends
    if (st.control.scores.player1 >= 3 || st.control.scores.player2 >= 3){
      const matchWinner = (st.control.scores.player1 >= 3) ? 'player1' : 'player2';
      st.gameEnded = true;
      try{ io.to(st.roomId).emit('gameOver', { winner: matchWinner }); }catch(_){}
    }
  }
}


/* =====================================================================
   RESPawn Flip: Same-half only (left <-> right) explicit pairs
   - Keeps Player1 spawns on rows H/I (bottom half) and swaps side
   - Keeps Player2 spawns on rows A/B (top half) and swaps side
   - Safe to call multiple times
   ===================================================================== */
(function(){
  const SAME_HALF_MAP = {
    // Top half
    A1:'A4', A2:'A3', A3:'A2', A4:'A1',
    B1:'B5', B2:'B4', B4:'B2', B5:'B1',
    // Bottom half
    H1:'H5', H2:'H4', H4:'H2', H5:'H1',
    I1:'I4', I2:'I3', I3:'I2', I4:'I1'
  };
  function sameHalfMirror(tile){
    return SAME_HALF_MAP[tile] || tile;
  }
  // Provide a dedicated function (can be called by round logic)
  globalThis.flipRespawnsSameHalf = function flipRespawnsSameHalf(st){
    try{
      if (!st || !st.respawnAt) return;
      const next = {};
      for (const [id, tile] of Object.entries(st.respawnAt)){
        next[id] = sameHalfMirror(tile);
      }
      st.respawnAt = next;
    }catch(_){}
  };

  // If older override functions exist, rewire them to this behavior
  globalThis.__cn_mirrorRespawnPoints = function __cn_mirrorRespawnPoints(st){
    return globalThis.flipRespawnsSameHalf ? globalThis.flipRespawnsSameHalf(st) : void 0;
  };
})();


/* =====================================================================
   CONTROL MODE RESPAWNS — stay on same half, swap left<->right
   - RIGHT cluster comes from st.respawnAt (whatever your current spawns are).
   - LEFT cluster is computed by mirroring RIGHT horizontally (same row).
   - This keeps top spawns in rows A/B and bottom spawns in H/I.
   ===================================================================== */
(function(){
  // Horizontal mirror map within same rows (A/B top half, H/I bottom half)
  const SAME_HALF_MAP = {
    // Top half
    A1:'A4', A2:'A3', A3:'A2', A4:'A1',
    B1:'B5', B2:'B4', B3:'B3', B4:'B2', B5:'B1',
    // Bottom half
    H1:'H5', H2:'H4', H3:'H3', H4:'H2', H5:'H1',
    I1:'I4', I2:'I3', I3:'I2', I4:'I1'
  };
  function sameHalfMirror(tile){ return SAME_HALF_MAP[tile] || tile; }

  // Compute a dynamic respawn tile given the character id and control side
  globalThis.__cn_getRespawnTileDynamic = function __cn_getRespawnTileDynamic(st, id){
    try{
      if (!st || st.mode !== 'control') return null;
      // Determine which side the control anchor is on
      let anchorOnRight = true;
      if (st.control && st.control.anchor && st.tilePositions && st.tilePositions[st.control.anchor]){
        anchorOnRight = st.tilePositions[st.control.anchor].x >= st.centerX;
      }
      // Use current st.respawnAt as "RIGHT" canonical set; fallback to defaults if absent
      const RIGHT = (st.respawnAt && typeof st.respawnAt === 'object') ? { ...st.respawnAt } : {
        P1:'H4', P2:'I4', P3:'H5', P4:'I3',
        E1:'B4', E2:'A4', E3:'B5', E4:'A3'
      };
      // Build LEFT by mirroring RIGHT within same rows
      const LEFT = Object.fromEntries(Object.entries(RIGHT).map(([k,v])=>[k, sameHalfMirror(v)]));
      const table = anchorOnRight ? RIGHT : LEFT;
      return table[id] || null;
    }catch(_){ return null; }
  };
})();


/* =====================================================================
   CONTROL: Strict same-row respawns + horizontal flips + best-of-5
   - Respawns always stay on original ROW (H↔H, I↔I, A↔A, B↔B), swapping left↔right.
   - At 10 PROGRESS: end ROUND, flip flag/control+respawns horizontally (same row), NEVER end match here.
   - Match ends ONLY at 3 round wins.
   ===================================================================== */
(function(){
  // Exact same-row left<->right pairs
  const SAME_ROW = {
    // Top half rows
    A1:'A4', A2:'A3', A3:'A2', A4:'A1',
    B1:'B5', B2:'B4', B3:'B3', B4:'B2', B5:'B1',
    // Bottom half rows
    H1:'H5', H2:'H4', H3:'H3', H4:'H2', H5:'H1',
    I1:'I4', I2:'I3', I3:'I2', I4:'I1'
  };
  function __CN_sameRowSwap(t){ return SAME_ROW[t] || t; }
  function __CN_rowOf(t){ return (t && typeof t === 'string') ? t[0] : null; }

  // Strict same-row open-tile finder for respawns (radius 3, same-row only)
  globalThis.__CN_findOpenTileSameRowNear = function __CN_findOpenTileSameRowNear(st, preferred){
    try{
      if (!preferred || !st || !st.tilePositions) return preferred;
      const row = __CN_rowOf(preferred);
      const occ = new Set(); st.tokens.forEach((v)=>{ if (v && v.tile) occ.add(v.tile); });
      const walls = new Set(st.walls.keys());
      // If preferred itself is open, take it
      if (st.tilePositions[preferred] && !occ.has(preferred) && !walls.has(preferred)) return preferred;

      // BFS but only along the SAME row
      const seen = new Set([preferred]);
      let frontier = [preferred];
      for (let depth=0; depth<3; depth++){
        const next = [];
        for (const cur of frontier){
          const nbs = st.adjacency[cur] || [];
          for (const n of nbs){
            if (seen.has(n)) continue;
            seen.add(n);
            if (__CN_rowOf(n) !== row) continue; // hard constraint: same row only
            if (!occ.has(n) && !walls.has(n)) return n;
            next.push(n);
          }
        }
        frontier = next;
      }
      // Nothing found; return preferred as a last resort (engine will handle placement)
      return preferred;
    }catch(_){ return preferred; }
  };

  // Mirror a single tile horizontally (flip X, penalize Y drift to keep same row)
  function __CN_mirrorX_sameRow(st, tileId){
    try{
      if (!st || !st.tilePositions || !st.tilePositions[tileId]) return tileId;
      const p = st.tilePositions[tileId];
      const targetX = 2*st.centerX - p.x;
      const targetY = p.y; // keep same Y ideal
      let best = tileId, bestScore = Infinity;
      for (const [id, tp] of Object.entries(st.tilePositions)){
        const dx = tp.x - targetX, dy = tp.y - targetY;
        const score = dx*dx + (dy*dy)*1000; // huge penalty for changing rows
        if (score < bestScore){ bestScore = score; best = id; }
      }
      return best;
    }catch(_){ return tileId; }
  }

  // Flip respawns strictly within same row
  function __CN_flipRespawnsSameRow(st){
    try{
      if (!st || !st.respawnAt) return;
      const next = {};
      for (const [id, t] of Object.entries(st.respawnAt)){
        next[id] = __CN_sameRowSwap(t);
      }
      st.respawnAt = next;
    }catch(_){ /* noop */ }
  }
  // Flip control anchor + tiles horizontally (prefer staying on same row visually)
  function __CN_flipControlHorizontal(st){
    try{
      if (!st || !st.control) return;
      if (st.control.anchor) st.control.anchor = __CN_mirrorX_sameRow(st, st.control.anchor);
      st.control.tiles = (st.control.tiles||[]).map(t => __CN_mirrorX_sameRow(st, t));
    }catch(_){ /* noop */ }
  }

  // Authoritative respawn picker (prefers st.respawnAt; can be customized per id later)
  globalThis.__CN_pickRespawn = function __CN_pickRespawn(st, id){
    try{
      if (!st) return null;
      const t = (st.respawnAt && st.respawnAt[id]) || null;
      return t;
    }catch(_){ return null; }
  };

  // Rounds scoring override: 10 -> round win; flip; best-of-5
  function scoreControlRoundOverride(st){
    if (!st || st.mode!=='control' || !st.control) return;
    // Tally this tick (anchor +2, neighbors +1)
    let p1=0, p2=0;
    const tiles = new Set(st.control.tiles || []);
    const anc = st.control.anchor || null;
    for (const [id, tok] of st.tokens){
      if (!tok || !tok.tile) continue;
      if (anc && tok.tile === anc){
        if (tok.owner==='player1') p1 += 2; else if (tok.owner==='player2') p2 += 2;
      } else if (tiles.has(tok.tile)){
        if (tok.owner==='player1') p1 += 1; else if (tok.owner==='player2') p2 += 1;
      }
    }
    st.control.progress = st.control.progress || { player1:0, player2:0 };
    st.control.scores   = st.control.scores   || { player1:0, player2:0 };
    st.control.tally = st.control.tally || { player1:0, player2:0 };
    st.control.round    = (typeof st.control.round==='number') ? st.control.round : 1;

    st.control.progress.player1 += p1;
    st.control.progress.player2 += p2;

    let roundWinner = null;
    if (st.control.progress.player1 >= 10) roundWinner = 'player1';
    if (st.control.progress.player2 >= 10) roundWinner = 'player2';

    if (roundWinner){
      st.control.scores[roundWinner] += 1;
      st.control.round += 1;
      st.control.progress = { player1:0, player2:0 };

      __CN_flipControlHorizontal(st);
      __CN_flipRespawnsSameRow(st);

      try { io.to(st.roomId).emit('roundWon', { winner: roundWinner, scores: { ...st.control.scores }, round: st.control.round }); } catch(_){}
      try { sendFullState(st.roomId); } catch(_){}

      if (st.control.scores.player1 >= 3 || st.control.scores.player2 >= 3){
        const matchWinner = (st.control.scores.player1 >= 3) ? 'player1' : 'player2';
        st.gameEnded = true;
        try { io.to(st.roomId).emit('gameOver', { winner: matchWinner }); } catch(_){}
      } else {
        st.gameEnded = false; // NEVER end at 10
      }
    }
  }

  // Install override
  try { scoreControlRound = scoreControlRoundOverride; } catch(_){ globalThis.scoreControlRound = scoreControlRoundOverride; }
  // Force older helpers to our behavior
  globalThis.__cn_mirrorRespawnPoints = __CN_flipRespawnsSameRow;
  globalThis.flipRespawnsSameHalf     = __CN_flipRespawnsSameRow;
  globalThis.mirrorRespawnPoints      = __CN_flipRespawnsSameRow;
  globalThis.__cn_getRespawnTileDynamic = undefined; // disable drifting dynamic chooser
})();
