// Snake Royale: everyone online in one arena. Plays on the site and inside an X (Twitter) post via a Player Card.
// Run: npm install && npm start   (PORT defaults to 3000)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "board.json");
const KEY = "snake:board";

const W = 64, H = 36;          // arena in cells (16:9)
const TICK = 110;              // ms per step
const ROOM_CAP = 28;           // humans per arena before a new arena opens
const KEYFRAME = 45;           // full resync every N ticks
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up right down left
const today = () => new Date().toISOString().slice(0, 10);
const cell = (x, y) => y * W + x;

/* ---------------- leaderboard storage ---------------- */
let board = { days: {}, all: [] };
let saveTimer = null;
async function load() {
  try {
    if (UPSTASH_URL) {
      const r = await fetch(`${UPSTASH_URL}/get/${KEY}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
      const j = await r.json(); if (j.result) board = JSON.parse(j.result);
      console.log("Leaderboard loaded from Upstash");
    } else if (fs.existsSync(DATA_FILE)) board = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) { console.error("Could not load leaderboard:", e.message); }
  board.days = board.days || {}; board.all = board.all || [];
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = JSON.stringify(board);
    try {
      if (UPSTASH_URL) await fetch(`${UPSTASH_URL}/set/${KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }, body });
      else { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, body); }
    } catch (e) { console.error("Could not save leaderboard:", e.message); }
  }, 2000);
}
function upsert(list, entry, cap) {
  const i = list.findIndex(r => r.nick.toLowerCase() === entry.nick.toLowerCase());
  if (i >= 0) { if (entry.len <= list[i].len) return false; list.splice(i, 1); }
  list.push(entry); list.sort((a, b) => b.len - a.len || a.at - b.at); list.length = Math.min(list.length, cap);
  return true;
}
function submit(nick, len, kills) {
  if (len < 6) return;
  const d = today(); board.days[d] = board.days[d] || [];
  const e = { nick, len, kills, at: Date.now() };
  const a = upsert(board.days[d], { ...e }, 100), b = upsert(board.all, { ...e, day: d }, 100);
  const keys = Object.keys(board.days).sort(); while (keys.length > 14) delete board.days[keys.shift()];
  if (a || b) { scheduleSave(); boardDirty = true; }
}
let boardDirty = true;
const publicBoard = () => ({
  today: (board.days[today()] || []).slice(0, 10).map(({ nick, len, kills }) => ({ nick, len, kills })),
  all: board.all.slice(0, 10).map(({ nick, len, kills }) => ({ nick, len, kills })),
});

/* ---------------- nicknames ---------------- */
const ROOTS = ["nigg", "faggot", "retard", "hitler", "cunt", "fuck", "whore", "rapist",
  "хуй", "хуе", "хуё", "пизд", "бля", "пидор", "пидр", "залуп", "мудак", "гандон", "шлюх", "нигер", "еблан", "уеб", "ёбан", "ебан"];
const WORDS = ["fag", "fags", "nazi", "nazis", "shit", "rape", "negro", "негр", "сука", "суки", "сучка", "еба", "ебал", "ебло", "ебу", "ебать", "ёб"];
const ADJ = ["Swift", "Lucky", "Quiet", "Brave", "Tiny", "Neon", "Lazy", "Wild", "Frosty", "Sunny", "Sly", "Hungry"];
const ANIMAL = ["Otter", "Comet", "Fox", "Owl", "Panda", "Gecko", "Moth", "Koala", "Lynx", "Wren", "Yak", "Crab"];
const randomNick = () => ADJ[Math.random() * ADJ.length | 0] + ANIMAL[Math.random() * ANIMAL.length | 0] + (Math.random() * 90 + 10 | 0);
function cleanNick(raw) {
  const s = String(raw || "").normalize("NFKC").replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 14);
  if (!s) return { nick: randomNick(), blocked: false };
  const low = s.toLowerCase().replace(/[@4]/g, "a").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/0/g, "o");
  const flat = low.replace(/[\s_\-.0-9]/g, ""), tokens = low.split(/[\s_\-.0-9]+/).filter(Boolean);
  const bad = ROOTS.some(w => flat.includes(w)) || tokens.some(t => WORDS.includes(t)) || WORDS.includes(flat);
  return bad ? { nick: randomNick(), blocked: true } : { nick: s, blocked: false };
}

/* ---------------- arena ---------------- */
const BOT_NAMES = ["Noodle", "Slinky", "Wiggles", "Sir Hiss", "Pretzel", "Spaghetto", "Zigzag", "Mr Danger", "Linguine", "Sssteve"];
const COLORS = 10;
let nextId = 1;

class Room {
  constructor(n) {
    this.n = n; this.snakes = new Map(); this.food = new Map(); this.clients = new Set();
    this.k = 0; this.events = []; this.foodAdd = []; this.foodDel = []; this.gone = [];
    this.goldenAt = Date.now() + 15000;
  }
  humans() { let n = 0; for (const s of this.snakes.values()) if (!s.bot) n++; return n; }
  occupied() {
    const occ = new Map();
    for (const s of this.snakes.values()) if (s.alive) for (const c of s.body) occ.set(c, s);
    return occ;
  }
  freeSpot(len) {
    const occ = this.occupied();
    for (let tries = 0; tries < 200; tries++) {
      const x = 6 + (Math.random() * (W - 12) | 0), y = 4 + (Math.random() * (H - 8) | 0);
      let ok = true;
      for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3 && ok; dx++) if (occ.has(cell(x + dx, y + dy))) ok = false;
      if (!ok) continue;
      for (const s of this.snakes.values()) if (s.alive) { const h = s.body[0]; if (Math.abs(h % W - x) + Math.abs((h / W | 0) - y) < 8) ok = false; }
      if (!ok) continue;
      const d = Math.random() * 4 | 0, [ddx, ddy] = DIRS[d];
      const body = []; for (let i = 0; i < len; i++) body.push(cell(x - ddx * i, y - ddy * i));
      if (body.some(c => occ.has(c))) continue;
      return { body, dir: d };
    }
    return null;
  }
  spawn(s) {
    const spot = this.freeSpot(4); if (!spot) return false;
    Object.assign(s, { body: spot.body, dir: spot.dir, queue: [], alive: true, grow: 0, boost: false, boostT: 0, best: 4, kills: 0, spawned: true, add: [], cut: 0, born: Date.now() });
    return true;
  }
  addFood(type) {
    const occ = this.occupied();
    for (let t = 0; t < 60; t++) {
      const c = cell(1 + (Math.random() * (W - 2) | 0), 1 + (Math.random() * (H - 2) | 0));
      if (!occ.has(c) && !this.food.has(c)) { this.food.set(c, type); this.foodAdd.push(c, type); return; }
    }
  }
  dropFood(c, type = 1) { if (!this.food.has(c)) { this.food.set(c, type); this.foodAdd.push(c, type); } }
  eatFood(c) { const t = this.food.get(c); this.food.delete(c); this.foodDel.push(c); return t; }
  ev(text) { this.events.push(text); }
  kill(s, killer, how) {
    s.alive = false; s.deadAt = Date.now();
    s.body.forEach((c, i) => { if (i % 2 === 0) this.dropFood(c, 1); });
    if (killer && killer !== s) { killer.kills++; this.ev(`${killer.nick} ate ${s.nick}`); }
    else this.ev(how === "wall" ? `${s.nick} hit the wall` : how === "self" ? `${s.nick} bit their own tail` : `${s.nick} crashed`);
    if (!s.bot) { submit(s.nick, s.best, s.kills); if (s.ws) send(s.ws, { t: "dead", len: s.best, kills: s.kills, by: killer && killer !== s ? killer.nick : null, how }); }
  }
  botThink(s, occ) {
    const h = s.body[0], hx = h % W, hy = h / W | 0;
    let target = null, td = 1e9;
    for (const [c, t] of this.food) { const d = Math.abs(c % W - hx) + Math.abs((c / W | 0) - hy) - (t === 2 ? 12 : 0); if (d < td) { td = d; target = c; } }
    let best = s.dir, bs = -1e9;
    for (let d = 0; d < 4; d++) {
      if ((d + 2) % 4 === s.dir) continue;
      const nx = hx + DIRS[d][0], ny = hy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || occ.has(cell(nx, ny))) continue;
      let score = 0;
      if (target !== null) score -= Math.abs(target % W - nx) + Math.abs((target / W | 0) - ny);
      // flood fill a little to avoid boxing itself in
      const seen = new Set([cell(nx, ny)]), q = [cell(nx, ny)]; let room = 0;
      while (q.length && room < 40) { const c = q.shift(); room++; const x = c % W, y = c / W | 0;
        for (const [ax, ay] of DIRS) { const X = x + ax, Y = y + ay, C = cell(X, Y); if (X < 0 || Y < 0 || X >= W || Y >= H || seen.has(C) || occ.has(C)) continue; seen.add(C); q.push(C); } }
      if (room < Math.min(40, s.body.length + 4)) score -= 200;
      score += Math.random() * 1.5 + (d === s.dir ? .8 : 0);
      if (score > bs) { bs = score; best = d; }
    }
    if (best !== s.dir) s.queue = [best];
    s.boost = s.body.length > 12 && Math.random() < .02 ? true : (s.boost && Math.random() < .9);
  }
  step() {
    this.k++;
    const now = Date.now();
    // bots: keep the arena lively when few people are around
    const humans = this.humans(), want = Math.max(2, 6 - humans);
    let bots = 0; for (const s of this.snakes.values()) if (s.bot) bots++;
    if (bots < want) { const s = { id: nextId++, nick: BOT_NAMES[Math.random() * BOT_NAMES.length | 0], color: Math.random() * COLORS | 0, bot: true }; if (this.spawn(s)) this.snakes.set(s.id, s); }
    for (const s of this.snakes.values()) {
      if (s.bot && !s.alive && now - s.deadAt > 2500) { if (bots > want) { this.snakes.delete(s.id); this.gone.push(s.id); bots--; } else this.spawn(s); }
    }
    let occ = this.occupied();
    for (const s of this.snakes.values()) if (s.bot && s.alive) this.botThink(s, occ);
    for (const s of this.snakes.values()) { s.add = s.add || []; }
    // two sub-steps: everyone moves once, boosting snakes move twice
    for (let sub = 0; sub < 2; sub++) {
      const movers = [...this.snakes.values()].filter(s => s.alive && (sub === 0 || (s.boost && s.body.length > 5)));
      if (!movers.length) continue;
      occ = this.occupied();
      const heads = new Map();
      for (const s of movers) {
        while (s.queue.length) { const d = s.queue.shift(); if ((d + 2) % 4 !== s.dir && d !== s.dir) { s.dir = d; break; } }
        const h = s.body[0], nx = h % W + DIRS[s.dir][0], ny = (h / W | 0) + DIRS[s.dir][1];
        s.next = (nx < 0 || ny < 0 || nx >= W || ny >= H) ? -1 : cell(nx, ny);
        if (s.grow === 0) { const t = s.body[s.body.length - 1]; if (occ.get(t) === s) occ.delete(t); }
        if (s.next >= 0) heads.set(s.next, (heads.get(s.next) || 0) + 1);
      }
      const dying = [];
      for (const s of movers) {
        if (s.next < 0) { dying.push([s, null, "wall"]); continue; }
        if (heads.get(s.next) > 1) { const other = movers.find(o => o !== s && o.next === s.next); dying.push([s, other, "head"]); continue; }
        const hit = occ.get(s.next);
        if (hit) dying.push([s, hit === s ? null : hit, hit === s ? "self" : "body"]);
      }
      const dead = new Set(dying.map(d => d[0]));
      for (const s of movers) {
        if (dead.has(s)) continue;
        s.body.unshift(s.next); s.add.push(s.next);
        const f = this.food.get(s.next);
        if (f) { this.eatFood(s.next); s.grow += f === 2 ? 5 : 1; if (f === 2) this.ev(`${s.nick} grabbed the golden apple`); }
        if (s.grow > 0) s.grow--; else { s.body.pop(); s.cut++; }
        if (sub === 1) { // boosting costs length
          s.boostT++;
          if (s.boostT % 4 === 0 && s.body.length > 5) { const t = s.body.pop(); s.cut++; this.dropFood(t, 1); }
        }
        s.best = Math.max(s.best, s.body.length);
      }
      for (const [s, killer, how] of dying) if (s.alive) this.kill(s, killer, how);
    }
    // food
    let target = 18 + this.snakes.size * 3, golden = 0;
    for (const t of this.food.values()) if (t === 2) golden++;
    let count = this.food.size;
    while (count < target) { this.addFood(1); count++; }
    if (now > this.goldenAt && golden === 0) { this.addFood(2); this.goldenAt = now + 20000; this.ev("A golden apple appeared"); }
    this.broadcast();
  }
  snakeFull(s) { return { i: s.id, n: s.nick, c: s.color, bot: s.bot ? 1 : 0, a: s.alive ? 1 : 0, b: s.boost ? 1 : 0, k: s.kills, cells: s.alive ? s.body : [] }; }
  broadcast() {
    let msg;
    if (this.k % KEYFRAME === 0) {
      msg = { t: "f", k: this.k, sn: [...this.snakes.values()].filter(s => s.body).map(s => this.snakeFull(s)), food: [...this.food].flat() };
    } else {
      const sn = [];
      for (const s of this.snakes.values()) {
        if (!s.body) continue;
        if (s.spawned) sn.push(this.snakeFull(s));
        else sn.push({ i: s.id, a: s.alive ? 1 : 0, b: s.boost ? 1 : 0, k: s.kills, add: s.alive ? s.add : [], cut: s.alive ? s.cut : 0 });
      }
      for (const id of this.gone) sn.push({ i: id, gone: 1 });
      msg = { t: "s", k: this.k, sn, fa: this.foodAdd, fr: this.foodDel };
    }
    if (this.events.length) msg.ev = this.events;
    msg.on = onlineCount;
    const str = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(str);
    for (const s of this.snakes.values()) { s.spawned = false; s.add = []; s.cut = 0; }
    this.events = []; this.foodAdd = []; this.foodDel = []; this.gone = [];
  }
}
const rooms = [];
function pickRoom() {
  let r = rooms.find(r => r.clients.size < ROOM_CAP);
  if (!r) { r = new Room(rooms.length + 1); rooms.push(r); }
  return r;
}
let onlineCount = 0;
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ---------------- http ---------------- */
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
function render(req, embed) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  const origin = `${proto}://${req.headers.host}`;
  const largeCard = new URL(req.url, "http://x").pathname === "/play";
  const meta = `
<meta name="description" content="Multiplayer snake. Everyone online shares one arena. Eat, grow, cut people off. Plays right inside your timeline.">
<meta property="og:type" content="website">
<meta property="og:title" content="Snake Royale">
<meta property="og:description" content="Multiplayer snake. Everyone online shares one arena. Eat, grow, cut people off.">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/og.png">
<meta name="twitter:title" content="Snake Royale">
<meta name="twitter:description" content="Multiplayer snake. Everyone online shares one arena. Play right here.">
<meta name="twitter:image" content="${origin}/og.png">
${largeCard ? `<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="player">
<meta name="twitter:player" content="${origin}/embed">
<meta name="twitter:player:width" content="640">
<meta name="twitter:player:height" content="360">`}
<script>window.SNAKE_EMBED=${embed ? "true" : "false"};window.SNAKE_ORIGIN=${JSON.stringify(origin)};</script>`;
  return page.replace("<!--META-->", meta);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/" || p === "/play" || p === "/index.html" || p === "/embed") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(render(req, p === "/embed"));
  }
  if (p === "/og.png" || p === "/favicon.ico") {
    return fs.readFile(path.join(__dirname, "og.png"), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" }); res.end(buf);
    });
  }
  if (p === "/api/board") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(publicBoard())); }
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(404); res.end("Not found");
});

/* ---------------- websocket ---------------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 });
wss.on("connection", ws => {
  onlineCount++;
  const room = pickRoom();
  room.clients.add(ws);
  const me = { id: nextId++, nick: randomNick(), color: Math.random() * COLORS | 0, bot: false, ws, alive: false, body: null, queue: [] };
  let msgs = 0, alive = true;
  const reset = setInterval(() => { msgs = 0; }, 1000);
  send(ws, { t: "hi", id: me.id, w: W, h: H, tick: TICK, room: room.n, board: publicBoard(),
    sn: [...room.snakes.values()].filter(s => s.body).map(s => room.snakeFull(s)), food: [...room.food].flat() });
  ws.on("pong", () => { alive = true; });
  ws.on("message", data => {
    if (++msgs > 60) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "play") {
      if (me.alive) return;
      const r = cleanNick(m.nick); me.nick = r.nick;
      if (r.blocked || r.nick !== String(m.nick || "").trim()) send(ws, { t: "nick", nick: r.nick, blocked: r.blocked });
      if (Number.isInteger(m.c) && m.c >= 0 && m.c < COLORS) me.color = m.c;
      if (room.spawn(me)) { room.snakes.set(me.id, me); send(ws, { t: "spawned", id: me.id }); }
      else send(ws, { t: "full" });
    } else if (m.t === "d" && me.alive) {
      const d = m.d | 0; if (d >= 0 && d < 4 && me.queue.length < 3) me.queue.push(d);
    } else if (m.t === "b") { me.boost = !!m.on; }
  });
  ws.on("close", () => {
    onlineCount--; clearInterval(reset); room.clients.delete(ws);
    if (me.alive) { submit(me.nick, me.best, me.kills); me.alive = false; me.body.forEach((c, i) => { if (i % 2 === 0) room.dropFood(c, 1); }); }
    if (room.snakes.has(me.id)) { room.snakes.delete(me.id); room.gone.push(me.id); }
  });
  const ping = setInterval(() => { if (!alive) { ws.terminate(); clearInterval(ping); return; } alive = false; try { ws.ping(); } catch {} }, 30000);
  ws.on("close", () => clearInterval(ping));
});

setInterval(() => {
  for (const r of rooms) if (r.clients.size) r.step();
  if (boardDirty) {
    boardDirty = false; const s = JSON.stringify({ t: "board", board: publicBoard() });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
  }
  // close empty extra rooms
  for (let i = rooms.length - 1; i > 0; i--) if (!rooms[i].clients.size) rooms.splice(i, 1);
}, TICK);

load().then(() => server.listen(PORT, () => console.log(`Snake Royale on http://localhost:${PORT}`)));
