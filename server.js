// relay/server.js — run this on an always-on host (Railway, Render, Fly, a VPS). NOT on Vercel.
// Keeps one WebSocket to 24data, remembers each pilot's latest flight plan, and serves live aircraft data.
import http from 'http';
import fs from 'fs';
import WebSocket from 'ws';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const KEY = process.env.RELAY_KEY || '';
const FILE = process.env.DATA_FILE || './plans.json';
const KEEP = 14 * 864e5; // 24data terms: don't keep identifiable data longer than 14 days
let plans = {};
let lb = {};            // pilot -> { 'YYYY-MM-DD': airborne seconds }  (kept 14 days)
const dev = {}, reqs = {}, links = {}, rl = {};
const ids = {}, byName = {}, live = {}, vcs = {}, joinq = [];   // discord id <-> roblox name, live pilot state, aircraft voice channels, pending guild joins   // live devices, co-pilot requests, active links, rate limits
const park = {}, parkSeen = new Set(), tickAt = { main: 0, event: 0 };
const acft = { main: null, event: null };
const cal = {};            // ICAO -> [[x,y], ...] parked positions of pilots who filed a plan from that airport (no names kept)
const calSeen = new Set();
function sample(d) {
  for (const k in d) {
    const c = d[k];
    if (!c || !c.isOnGround || !(c.speed < 2) || !c.position || !c.playerName) continue;
    const p = plans[String(c.playerName).toLowerCase()];
    if (!p || p.server !== 'main' || !p.departing || Date.now() - p.at > 45 * 60e3) continue;
    const id = p.robloxName + p.at;
    if (calSeen.has(id)) continue;
    calSeen.add(id);
    const a = cal[p.departing] || (cal[p.departing] = []);
    a.push([Math.round(c.position.x), Math.round(c.position.y)]);
    if (a.length > 40) a.shift();
  }
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
setInterval(() => {
  calSeen.clear(); parkSeen.clear();
  const n = Date.now(), cut = n - 14 * 864e5;
  for (const p in lb) { for (const d in lb[p]) if (Date.parse(d) < cut - 864e5) delete lb[p][d]; if (!Object.keys(lb[p]).length) delete lb[p]; }
  for (const k in dev) if (n - dev[k].t > 600e3) delete dev[k];
  for (const k in reqs) if (n - reqs[k].at > 600e3) delete reqs[k];
  for (const k in links) if (n - links[k].at > 12 * 36e5) delete links[k];
  for (const k in rl) if (n - rl[k] > 600e3) delete rl[k];
  for (const d in ids) if (n - ids[d].t > 30 * 864e5) { delete byName[ids[d].name.toLowerCase()]; delete ids[d]; }
  for (const k in live) if (n - live[k].t > 300e3) delete live[k];
  save();
}, 3600e3);
setInterval(() => save(), 60e3);
function onData(d, which) {
  const now = Date.now(), dt = Math.min(5, (now - (tickAt[which] || now)) / 1000); tickAt[which] = now;
  const names = new Set(online().map((x) => x.name.toLowerCase()));
  for (const k in d) {
    const c = d[k]; if (!c || !c.position) continue;
    const pn = String(c.playerName || '');
    if (c.isOnGround === false && dt > 0 && names.has(pn.toLowerCase())) { const l = lb[pn] || (lb[pn] = {}), t = day(); l[t] = (l[t] || 0) + dt; }
    if (which === 'main' && c.isOnGround && c.speed < 2) {            // parked aircraft reveal where airports are (and their elevation)
      const cell = Math.round(c.position.x / 700) + ',' + Math.round(c.position.y / 700), id = pn + '|' + cell;
      if (!parkSeen.has(id)) { parkSeen.add(id); const q = park[cell] || (park[cell] = { n: 0, x: 0, y: 0, e: c.altitude });
        q.x = (q.x * q.n + c.position.x) / (q.n + 1); q.y = (q.y * q.n + c.position.y) / (q.n + 1); q.e = (q.e * q.n + c.altitude) / (q.n + 1); q.n = Math.min(q.n + 1, 40); }
    }
  }
}
const RE = /^[A-Za-z0-9_]{3,20}$/;
function cp(b) {
  const name = String(b.name || ''), nl = name.toLowerCase(), now = Date.now(); let extra = {}, st = 200;
  if (!RE.test(name)) return [{ error: 'bad name' }, 400];
  dev[b.dev || nl] = { name, t: now };
  const disc = String(b.disc || '');
  if (/^\d{15,22}$/.test(disc)) { ids[disc] = { name, t: now }; byName[nl] = disc; }
  const cur = b.cur && /^[A-Z0-9_]{3,14}$/.test(String(b.cur.key)) && /^\d{15,22}$/.test(String(b.cur.chan || '')) ? { key: b.cur.key, chan: String(b.cur.chan), freq: String(b.cur.freq || '').slice(0, 8) } : null;
  live[nl] = { phase: String(b.phase || '').slice(0, 20), cur, t: now };
  if (b.act === 'req') {
    const to = String(b.to || '').trim(), tl = to.toLowerCase();
    const k1 = 'i|' + b.ip + '|' + tl, k2 = 'd|' + b.dev + '|' + tl, last = Math.max(rl[k1] || 0, rl[k2] || 0);
    if (!RE.test(to)) { extra = { error: 'Enter a valid Roblox username.' }; st = 400; }
    else if (tl === nl) { extra = { error: 'You cannot co-pilot with yourself.' }; st = 400; }
    else if (now - last < 600e3) { extra = { error: 'Please wait ' + Math.ceil((600e3 - (now - last)) / 60e3) + ' min before asking ' + to + ' again.' }; st = 429; }
    else if (!online().some((d) => d.name.toLowerCase() === tl)) { extra = { error: to + ' is not online on 24instruments.' }; st = 404; }
    else { rl[k1] = rl[k2] = now; const id = crypto.randomBytes(6).toString('hex'); reqs[id] = { id, from: name, fromL: nl, to: tl, toD: to, at: now, st: 'pending' }; extra = { ok: true, id }; }
  } else if (b.act === 'ans') {
    const r = reqs[b.id];
    if (!r || r.to !== nl || r.st !== 'pending' || now - r.at > 120e3) { extra = { error: 'Request expired.' }; st = 404; }
    else { r.st = b.allow ? 'allowed' : 'denied'; if (b.allow) links[r.fromL] = { captain: name, copilot: r.from, at: now }; extra = { ok: true }; }
  } else if (b.act === 'end') {
    if (b.to) { const t = String(b.to).toLowerCase(); if (links[t] && links[t].captain.toLowerCase() === nl) delete links[t]; } else delete links[nl];
  }
  const lk = links[nl], cap = lk && now - lk.at < 12 * 36e5 ? lk.captain : null;
  const mine = vcs[disc], capD = cap && byName[cap.toLowerCase()], capVc = capD ? vcs[capD] : null, vv = mine && mine.joined ? mine : capVc && capVc.joined ? capVc : null;
  let follow = null;
  if (cap) { const L = live[cap.toLowerCase()]; if (L && now - L.t < 25000) follow = L.cur ? { key: L.cur.key, chan: L.cur.chan } : vv ? { key: 'AIRCRAFT', chan: vv.id } : null; }
  const out = Object.values(reqs).filter((r) => r.fromL === nl && now - r.at < 300e3).sort((a, c) => c.at - a.at)[0];
  return [{
    ...extra, online: online().length, vc: vv ? { id: vv.id, name: vv.name } : null, follow,
    incoming: Object.values(reqs).filter((r) => r.to === nl && r.st === 'pending' && now - r.at < 120e3).map((r) => ({ id: r.id, from: r.from })),
    watch: lk && now - lk.at < 12 * 36e5 ? lk.captain : null,
    sharing: Object.values(links).filter((v) => v.captain.toLowerCase() === nl).map((v) => v.copilot),
    outgoing: out ? { id: out.id, to: out.toD, st: out.st === 'pending' && now - out.at > 120e3 ? 'expired' : out.st } : null,
  }, st];
}
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e4) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
try { const r = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (r && r.plans) { plans = r.plans; lb = r.lb || {}; Object.assign(ids, r.ids || {}); Object.assign(vcs, r.vcs || {}); for (const d in ids) byName[ids[d].name.toLowerCase()] = d; } else plans = r || {}; } catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ plans, lb, ids, vcs })); } catch {} };
const day = () => new Date().toISOString().slice(0, 10);
const online = () => { const n = Date.now(); return Object.values(dev).filter((d) => n - d.t < 45000); };
setInterval(() => { const n = Date.now(); for (const k in plans) if (n - plans[k].at > KEEP) delete plans[k]; save(); }, 3600e3);

function connect() {
  const ws = new WebSocket('wss://24data.ptfs.app/wss'); // Node's ws sends no Origin header
  ws.on('message', (m) => {
    try {
      const e = JSON.parse(m);
      if (e.t === 'ACFT_DATA') { acft.main = { d: e.d, at: Date.now() }; sample(e.d); onData(e.d, 'main'); }
      else if (e.t === 'EVENT_ACFT_DATA') { acft.event = { d: e.d, at: Date.now() }; onData(e.d, 'event'); }
      else if ((e.t === 'FLIGHT_PLAN' || e.t === 'EVENT_FLIGHT_PLAN') && e.d && e.d.robloxName) {
        plans[String(e.d.robloxName).toLowerCase()] = { ...e.d, server: e.t === 'FLIGHT_PLAN' ? 'main' : 'event', at: Date.now() };
        save();
      }
    } catch {}
  });
  ws.on('error', () => {});
  ws.on('close', () => setTimeout(connect, 3000));
}
connect();

http.createServer(async (req, res) => {
  if (KEY && req.headers['x-relay-key'] !== KEY) { res.writeHead(401); return res.end(); }
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && u.pathname === '/cp') { const [o, st] = cp(await body(req)); res.statusCode = st; return res.end(JSON.stringify(o)); }
  if (req.method === 'POST' && ['/vcset', '/joinq', '/bot/ack'].includes(u.pathname)) {
    const b = await body(req), now = Date.now();
    if (u.pathname === '/vcset') {
      const d = String(b.disc || ''); if (!/^\d{15,22}$/.test(d)) { res.statusCode = 400; return res.end('{}'); }
      if (!b.id) delete vcs[d]; else vcs[d] = { id: String(b.id), name: String(b.name || '').slice(0, 100), joined: !!b.joined || !!(vcs[d] && vcs[d].id === String(b.id) && vcs[d].joined), at: now };
    } else if (u.pathname === '/joinq') {
      const d = String(b.id || ''); if (/^\d{15,22}$/.test(d) && String(b.token || '').length < 200) { const i = joinq.findIndex((x) => x.id === d); if (i >= 0) joinq.splice(i, 1); joinq.push({ id: d, token: String(b.token), name: String(b.name || ''), at: now }); if (joinq.length > 500) joinq.shift(); }
    } else { const i = joinq.findIndex((x) => x.id === String(b.id)); if (i >= 0) joinq.splice(i, 1); }
    return res.end('{"ok":true}');
  }
  if (u.pathname === '/bot/joins') { const n = Date.now(); for (let i = joinq.length - 1; i >= 0; i--) if (n - joinq[i].at > 600e3) joinq.splice(i, 1); return res.end(JSON.stringify(joinq)); }
  if (u.pathname === '/vcs') return res.end(JSON.stringify(Object.entries(vcs).map(([disc, v]) => ({ disc, ...v }))));
  if (u.pathname === '/who') {
    const i = ids[u.searchParams.get('disc')]; if (!i) return res.end('{}');
    const nl = i.name.toLowerCase(), now = Date.now(), p = plans[nl], L = live[nl], fresh = !!(L && now - L.t < 25000), lk = links[nl];
    const seen = (a) => a && now - a.at < 20000 && Object.values(a.d || {}).some((c) => String(c.playerName || '').toLowerCase() === nl);
    return res.end(JSON.stringify({ name: i.name, online: fresh, seated: !!(seen(acft.main) || seen(acft.event)), phase: fresh ? L.phase : '', cur: fresh ? L.cur : null,
      plan: p ? { callsign: p.callsign || p.realcallsign, departing: p.departing, arriving: p.arriving, flightlevel: p.flightlevel, at: p.at } : null,
      copilots: Object.values(links).filter((v) => v.captain.toLowerCase() === nl).map((v) => byName[v.copilot.toLowerCase()]).filter(Boolean),
      watch: lk && now - lk.at < 12 * 36e5 ? byName[lk.captain.toLowerCase()] || null : null }));
  }
  if (u.pathname === '/lb') {
    const cut = Date.now() - 15 * 864e5;
    const rows = Object.entries(lb).map(([name, days]) => ({ name, secs: Math.round(Object.entries(days).filter(([d]) => Date.parse(d) >= cut).reduce((a, [, v]) => a + v, 0)) })).filter((r) => r.secs > 0).sort((a, c) => c.secs - a.secs).slice(0, 20);
    return res.end(JSON.stringify({ rows, online: online().length }));
  }
  if (u.pathname === '/plan') {
    const names = (u.searchParams.get('names') || '').toLowerCase().split(',').filter(Boolean);
    return res.end(JSON.stringify(names.map((n) => plans[n]).find(Boolean) || null));
  }
  if (u.pathname === '/map') {
    const c = {}, cs = {};
    for (const i in cal) if (cal[i].length) c[i] = { x: med(cal[i].map((p) => p[0])), y: med(cal[i].map((p) => p[1])), n: cal[i].length };
    for (const k in plans) cs[k] = plans[k].callsign || plans[k].realcallsign || '';
    return res.end(JSON.stringify({ cal: c, cs, park: Object.values(park).filter((q) => q.n >= 2).map((q) => [Math.round(q.x), Math.round(q.y), q.n, Math.round(q.e)]) }));
  }
  if (u.pathname === '/recent') return res.end(JSON.stringify(Object.values(plans).sort((a, b) => b.at - a.at).slice(0, 8)));
  if (u.pathname === '/acft') {
    const a = acft[u.searchParams.get('server') === 'event' ? 'event' : 'main'];
    if (!a || Date.now() - a.at > 15000) { res.writeHead(503); return res.end('{}'); }
    return res.end(JSON.stringify(a.d));
  }
  res.writeHead(404); res.end('{}');
}).listen(PORT, () => console.log('relay on', PORT));
