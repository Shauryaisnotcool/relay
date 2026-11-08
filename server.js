// relay/server.js — run this on an always-on host (Railway, Render, Fly, a VPS). NOT on Vercel.
// Keeps one WebSocket to 24data, remembers each pilot's latest flight plan, and serves live aircraft data.
import http from 'http';
import fs from 'fs';
import WebSocket from 'ws';

const PORT = process.env.PORT || 8080;
const KEY = process.env.RELAY_KEY || '';
const FILE = process.env.DATA_FILE || './plans.json';
const KEEP = 14 * 864e5; // 24data terms: don't keep identifiable data longer than 14 days
let plans = {};
const acft = { main: null, event: null };
try { plans = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(plans)); } catch {} };
setInterval(() => { const n = Date.now(); for (const k in plans) if (n - plans[k].at > KEEP) delete plans[k]; save(); }, 3600e3);

function connect() {
  const ws = new WebSocket('wss://24data.ptfs.app/wss'); // Node's ws sends no Origin header
  ws.on('message', (m) => {
    try {
      const e = JSON.parse(m);
      if (e.t === 'ACFT_DATA') acft.main = { d: e.d, at: Date.now() };
      else if (e.t === 'EVENT_ACFT_DATA') acft.event = { d: e.d, at: Date.now() };
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

http.createServer((req, res) => {
  if (KEY && req.headers['x-relay-key'] !== KEY) { res.writeHead(401); return res.end(); }
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/plan') {
    const names = (u.searchParams.get('names') || '').toLowerCase().split(',').filter(Boolean);
    return res.end(JSON.stringify(names.map((n) => plans[n]).find(Boolean) || null));
  }
  if (u.pathname === '/recent') return res.end(JSON.stringify(Object.values(plans).sort((a, b) => b.at - a.at).slice(0, 8)));
  if (u.pathname === '/acft') {
    const a = acft[u.searchParams.get('server') === 'event' ? 'event' : 'main'];
    if (!a || Date.now() - a.at > 15000) { res.writeHead(503); return res.end('{}'); }
    return res.end(JSON.stringify(a.d));
  }
  res.writeHead(404); res.end('{}');
}).listen(PORT, () => console.log('relay on', PORT));
