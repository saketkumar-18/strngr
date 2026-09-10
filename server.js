/**
 * strngr — anonymous stranger chat (video + text)
 *
 * Privacy model (see public/privacy.html):
 *  - No accounts, no cookies, no database, no message logging.
 *  - The server ONLY does matchmaking + relaying, entirely in volatile memory.
 *  - Text messages are relayed to the partner and discarded — never stored, never inspected
 *    (rate limiting counts messages, it does not read them).
 *  - Video/audio NEVER touches this server: WebRTC peer-to-peer with DTLS-SRTP.
 *    Only opaque SDP/ICE signaling blobs pass through, same as every video-calling service.
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// tunables
const RATE_BURST = 10;          // burst allowance for text/typing events
const RATE_REFILL_PER_SEC = 5;  // sustained rate
const MAX_TEXT = 2000;          // chars per message (trimmed server-side)
const MAX_SIGNAL_JSON = 100000;// max relayed signal payload (~100KB)
const REMATCH_AFTER_MS = 8000;  // after this wait, allow matching with the previous partner again
const SWEEP_MS = 2000;          // housekeeping interval
const REPORT_WINDOW_MS = 10 * 60 * 1000;
const CHANNELS = ['text', 'video'];

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()), online: users.size }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 20000,
  pingTimeout: 25000,
});

// ---------------- volatile, in-memory state (never persisted) ----------------
const users = new Map();        // socketId -> {state, partner, channel, interests, since}
const queue = [];               // socketIds currently searching (FIFO)
const lastPartner = new Map();  // socketId -> previous partner socketId
const buckets = new Map();      // socketId -> {tokens, ts} rate-limit buckets
const reports = new Map();      // socketId -> [{from, at}] within REPORT_WINDOW_MS

function normInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= 10) break;
    const t = String(raw).toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function leaveQueue(id) {
  const i = queue.indexOf(id);
  if (i !== -1) queue.splice(i, 1);
}

function broadcastOnline() {
  io.emit('online-count', { online: users.size });
}

// token bucket: returns false when the sender is flooding
function takeToken(id) {
  const now = Date.now();
  let b = buckets.get(id);
  if (!b) { b = { tokens: RATE_BURST, ts: now }; buckets.set(id, b); }
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.ts) / 1000) * RATE_REFILL_PER_SEC);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// find a partner for `id`: same channel, shared interests preferred, previous partner excluded
function scanCandidates(id, channel, interests) {
  const skip = lastPartner.get(id);
  let fallback = null;
  for (const cid of queue) {
    if (cid === id || cid === skip) continue;
    const cu = users.get(cid);
    if (!cu || cu.state !== 'searching' || cu.channel !== channel) continue;
    if (!fallback) fallback = cid;
    if (cu.interests.some((t) => interests.includes(t))) return cid;
  }
  return fallback;
}

function doMatch(aId, bId) {
  const a = users.get(aId);
  const b = users.get(bId);
  if (!a || !b) return false;
  if (a.state !== 'searching' || b.state !== 'searching' || a.partner || b.partner) return false;
  if (a.channel !== b.channel) return false;
  leaveQueue(aId);
  leaveQueue(bId);
  a.state = 'chatting'; a.partner = bId; a.since = null;
  b.state = 'chatting'; b.partner = aId; b.since = null;
  lastPartner.set(aId, bId);
  lastPartner.set(bId, aId);
  const shared = a.interests.filter((t) => b.interests.includes(t));
  io.to(aId).emit('matched', { initiator: true, shared });
  io.to(bId).emit('matched', { initiator: false, shared });
  return true;
}

// break an active pair; `reasonForOther` is delivered to the partner
function breakPair(id, reasonForOther) {
  const u = users.get(id);
  if (!u || u.state !== 'chatting' || !u.partner) return false;
  const pid = u.partner;
  u.state = 'idle'; u.partner = null; u.since = null;
  const p = users.get(pid);
  if (p && p.partner === id) {
    p.state = 'idle'; p.partner = null; p.since = null;
    io.to(pid).emit('partner-left', { reason: reasonForOther });
  }
  return true;
}

io.on('connection', (socket) => {
  users.set(socket.id, { state: 'idle', partner: null, channel: null, interests: [], since: null });
  broadcastOnline();

  socket.on('find-partner', (payload = {}, ack) => {
    const u = users.get(socket.id);
    if (!u) return;
    const channel = CHANNELS.includes(payload.channel) ? payload.channel : null;
    if (!channel) { if (typeof ack === 'function') ack({ ok: false, error: 'bad channel' }); return; }

    // starting a new search while chatting implicitly skips the current partner
    if (u.state === 'chatting') breakPair(socket.id, 'skip');
    leaveQueue(socket.id);

    u.channel = channel;
    u.interests = normInterests(payload.interests);
    u.state = 'searching';
    u.since = Date.now();

    const partnerId = scanCandidates(socket.id, u.channel, u.interests);
    const matched = partnerId ? doMatch(socket.id, partnerId) : false;
    if (!matched) {
      queue.push(socket.id);
      socket.emit('searching', { online: users.size });
    }
    if (typeof ack === 'function') ack({ ok: true, matched });
  });

  socket.on('stop-searching', () => {
    const u = users.get(socket.id);
    if (u && u.state === 'searching') {
      u.state = 'idle'; u.since = null;
      leaveQueue(socket.id);
    }
  });

  socket.on('skip', () => { breakPair(socket.id, 'skip'); });

  socket.on('text-message', (payload = {}, ack) => {
    const u = users.get(socket.id);
    if (!u || u.state !== 'chatting' || !u.partner) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_TEXT) : '';
    if (!text.trim()) { if (typeof ack === 'function') ack({ ok: false }); return; }
    if (!takeToken(socket.id)) { socket.disconnect(true); return; } // flooder is dropped
    io.to(u.partner).emit('text-message', { text });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('typing', (payload = {}) => {
    const u = users.get(socket.id);
    if (!u || u.state !== 'chatting' || !u.partner) return;
    if (!takeToken(socket.id)) { socket.disconnect(true); return; }
    io.to(u.partner).emit('typing', { on: !!payload.on });
  });

  socket.on('signal', (payload = {}) => {
    const u = users.get(socket.id);
    if (!u || u.state !== 'chatting' || !u.partner) return;
    const data = payload.data;
    if (data === null || typeof data !== 'object') return;
    if (JSON.stringify(data).length > MAX_SIGNAL_JSON) return;
    io.to(u.partner).emit('signal', { data });
  });

  socket.on('media-state', (payload = {}) => {
    const u = users.get(socket.id);
    if (!u || u.state !== 'chatting' || !u.partner) return;
    io.to(u.partner).emit('media-state', { video: !!payload.video, audio: !!payload.audio });
  });

  socket.on('report', () => {
    const u = users.get(socket.id);
    if (!u || u.state !== 'chatting' || !u.partner) return;
    const pid = u.partner;
    const list = (reports.get(pid) || []).filter((r) => Date.now() - r.at < REPORT_WINDOW_MS);
    list.push({ from: socket.id, at: Date.now() });
    reports.set(pid, list);
    // the reported user simply sees the reporter leave — reporter stays anonymous
    breakPair(socket.id, 'left');
    // three distinct reporters inside the window => the reported user is disconnected
    const distinct = new Set(list.map((r) => r.from)).size;
    if (distinct >= 3) {
      const target = io.sockets.sockets.get(pid);
      if (target) target.disconnect(true);
    }
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (u && u.state === 'chatting' && u.partner) {
      const p = users.get(u.partner);
      if (p && p.partner === socket.id) {
        p.state = 'idle'; p.partner = null; p.since = null;
        io.to(u.partner).emit('partner-left', { reason: 'left' });
      }
    }
    users.delete(socket.id);
    leaveQueue(socket.id);
    lastPartner.delete(socket.id);
    buckets.delete(socket.id);
    reports.delete(socket.id);
    broadcastOnline();
  });
});

// housekeeping: prune dead queue entries, allow rematch with previous partner after a wait,
// and pair queue-mates who were skipped apart but are both still waiting.
setInterval(() => {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const u = users.get(queue[i]);
    if (!u || u.state !== 'searching') queue.splice(i, 1);
  }
  for (const id of queue) {
    const u = users.get(id);
    if (u && u.since && now - u.since >= REMATCH_AFTER_MS) lastPartner.delete(id);
  }
  for (const id of [...queue]) {
    const u = users.get(id);
    if (!u || u.state !== 'searching' || !queue.includes(id)) continue;
    const pid = scanCandidates(id, u.channel, u.interests);
    if (pid) doMatch(id, pid);
  }
}, SWEEP_MS);

server.listen(PORT, () => {
  console.log(`strngr listening on :${PORT}`);
});
