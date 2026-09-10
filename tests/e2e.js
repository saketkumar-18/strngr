/**
 * strngr functional E2E — two synthetic clients against a LIVE server.
 * Pattern: every waitFor listener is attached BEFORE the action that triggers
 * the event (socket.io drops events that arrive with no listener attached).
 * Exits non-zero on ANY failure. Usage: node tests/e2e.js [BASE_URL]
 */
'use strict';

const { io } = require('socket.io-client');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
let passed = 0, failed = 0;
const results = [];

function ok(name) { passed++; results.push(`  ✓ ${name}`); }
function fail(name, err) { failed++; results.push(`  ✗ ${name} — ${err && err.message ? err.message : err}`); }
function section(s) { results.push(`\n${s}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return io(BASE, { transports: ['websocket'] });
}

// wait for an event once, with timeout (ATTACH BEFORE TRIGGERING)
function waitFor(sock, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(event, handler); reject(new Error(`timeout waiting for "${event}"`)); }, ms);
    const handler = (data) => { clearTimeout(t); sock.off(event, handler); resolve(data); };
    sock.on(event, handler);
  });
}

async function until(pred, ms = 5000, every = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(every);
  }
  return false;
}

const handshake = (sock, channel) => new Promise((resolve, reject) => {
  sock.timeout(5000).emit('find-partner', { channel }, (err, r) => err ? reject(err) : resolve(r));
});

async function main() {
  console.log(`strngr E2E against ${BASE}\n`);

  section('T1 · health & online count');
  {
    const a = connect();
    const cntP = waitFor(a, 'online-count', 3000);
    await waitFor(a, 'connect');
    const cnt = await cntP;
    if (cnt && Number.isInteger(cnt.online) && cnt.online >= 1) ok(`online-count received (${cnt.online})`);
    else fail('online-count', 'bad payload');
    a.disconnect();
  }

  section('T2 · text matchmaking + bidirectional relay');
  {
    const a = connect(), b = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect');

    // attach match waiters BEFORE any find-partner
    const matchP = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    const [ma, mb] = await matchP;
    if (ma.initiator === !mb.initiator) ok(`matched (initiator roles complementary: ${ma.initiator}/${mb.initiator})`);
    else fail('match roles', `initiators: ${ma.initiator}/${mb.initiator}`);

    // a -> b
    const gotP = waitFor(b, 'text-message');
    let ackRes = null;
    a.emit('text-message', { text: 'hello from A' }, (r) => { ackRes = r; });
    const got = await gotP;
    await until(() => ackRes !== null, 2000, 20); // ack follows the relay by a tick
    if (got.text === 'hello from A' && ackRes && ackRes.ok) ok('A→B relay + ack');
    else fail('A→B relay', `got=${JSON.stringify(got)} ack=${JSON.stringify(ackRes)}`);

    // typing
    const typingP = waitFor(a, 'typing');
    b.emit('typing', { on: true });
    const typing = await typingP;
    if (typing.on === true) ok('typing indicator relayed');
    else fail('typing relay', JSON.stringify(typing));

    // b -> a
    const got2P = waitFor(a, 'text-message');
    b.emit('text-message', { text: 'hi from B' });
    const got2 = await got2P;
    if (got2.text === 'hi from B') ok('B→A relay');
    else fail('B→A relay', JSON.stringify(got2));

    // no echo back to sender
    let echoed = false;
    const echoCheck = () => { echoed = true; };
    a.on('text-message', echoCheck);
    a.emit('text-message', { text: 'should not echo' }, () => {});
    await sleep(400);
    a.off('text-message', echoCheck);
    if (!echoed) ok('no echo back to sender');
    else fail('echo leak', 'sender received own message');

    // disconnect → partner-left
    const leftP = waitFor(b, 'partner-left');
    a.disconnect();
    const left = await leftP;
    if (left && typeof left.reason === 'string') ok(`partner-left on disconnect (reason=${left.reason})`);
    else fail('partner-left', JSON.stringify(left));
    b.disconnect();
  }

  section('T3 · WebRTC signal relay (video channel)');
  {
    const a = connect(), b = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect');
    const matchP = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'video');
    await handshake(b, 'video');
    await matchP;
    ok('video-channel match');

    const fakeOffer = { description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' } };
    const offerP = waitFor(b, 'signal');
    a.emit('signal', { data: fakeOffer });
    const gotOffer = await offerP;
    if (gotOffer.data && gotOffer.data.description && gotOffer.data.description.type === 'offer') ok('SDP offer relayed A→B');
    else fail('SDP offer relay', JSON.stringify(gotOffer));

    const fakeAnswer = { description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\n' } };
    const answerP = waitFor(a, 'signal');
    b.emit('signal', { data: fakeAnswer });
    const gotAnswer = await answerP;
    if (gotAnswer.data && gotAnswer.data.description && gotAnswer.data.description.type === 'answer') ok('SDP answer relayed B→A');
    else fail('SDP answer relay', JSON.stringify(gotAnswer));

    const fakeCand = { candidate: { candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    const candP = waitFor(b, 'signal');
    a.emit('signal', { data: fakeCand });
    const gotCand = await candP;
    if (gotCand.data.candidate && gotCand.data.candidate.sdpMid === '0') ok('ICE candidate relayed A→B');
    else fail('ICE relay', JSON.stringify(gotCand));

    const msP = waitFor(b, 'media-state');
    a.emit('media-state', { video: false, audio: true });
    const ms = await msP;
    if (ms.video === false && ms.audio === true) ok('media-state relayed');
    else fail('media-state', JSON.stringify(ms));

    // oversized signal must NOT be relayed
    let oversizeSeen = false;
    b.on('signal', () => { oversizeSeen = true; });
    a.emit('signal', { data: { description: { type: 'offer', sdp: 'x'.repeat(200000) } } });
    await sleep(500);
    if (!oversizeSeen) ok('oversized signal dropped');
    else fail('oversize guard', '200KB signal was relayed');
    a.disconnect(); b.disconnect();
  }

  section('T4 · skip & rematch flow');
  {
    const a = connect(), b = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect');
    const matchP1 = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    await matchP1;

    const leftP = waitFor(b, 'partner-left');
    a.emit('skip');
    const left = await leftP;
    if (left.reason === 'skip') ok('skip → partner gets reason "skip"');
    else fail('skip reason', JSON.stringify(left));

    // both search again → should rematch (allow previous partner after fresh search; server
    // clears lastPartner after 8s OR matches fresh — with no one else waiting they pair again)
    const matchP2 = Promise.all([waitFor(a, 'matched', 12000), waitFor(b, 'matched', 12000)]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    const re = await matchP2;
    if (re && re[0] && re[1]) ok('rematch works');
    else fail('rematch', 'no match after re-search');
    a.disconnect(); b.disconnect();
  }

  section('T5 · report flow');
  {
    const a = connect(), b = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect');
    const matchP = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    await matchP;

    const leftP = waitFor(b, 'partner-left');
    a.emit('report');
    const left = await leftP;
    if (left.reason === 'left') ok('report ends chat; reported user sees "left" (reporter anonymous)');
    else fail('report flow', JSON.stringify(left));

    if (a.connected) ok('reporter connection stays open');
    else fail('reporter conn', 'disconnected after reporting');
    a.disconnect(); b.disconnect();
  }

  section('T6 · rate limiting (flooder gets dropped)');
  {
    const a = connect(), b = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect');
    const matchP = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    await matchP;

    let aDisconnected = false;
    a.on('disconnect', () => { aDisconnected = true; });
    for (let i = 0; i < 40; i++) a.emit('text-message', { text: `spam ${i}` });
    const dropped = await until(() => aDisconnected, 5000, 50);
    if (dropped) ok('flooder disconnected by rate limiter');
    else fail('rate limit', 'flooder still connected after 40 rapid messages');
    a.disconnect(); b.disconnect();
  }

  section('T7 · cleanup & next-match isolation');
  {
    const a = connect(), b = connect(), c = connect();
    await waitFor(a, 'connect'); await waitFor(b, 'connect'); await waitFor(c, 'connect');
    const matchP = Promise.all([waitFor(a, 'matched'), waitFor(b, 'matched')]);
    await handshake(a, 'text');
    await handshake(b, 'text');
    await matchP;

    const leftP = waitFor(b, 'partner-left');
    a.disconnect();
    await leftP;

    // b searches again, then c; b must match c (not the dead socket)
    const matchP2 = Promise.all([waitFor(b, 'matched', 8000), waitFor(c, 'matched', 8000)]);
    await handshake(b, 'text');
    await sleep(300);
    await handshake(c, 'text');
    const re = await matchP2;
    if (re && re[0] && re[1]) ok('next match cleanly pairs fresh sockets (no ghost partner)');
    else fail('cleanup isolation', 'b did not match c');
    b.disconnect(); c.disconnect();
  }

  section('T8 · REST surface');
  {
    const res = await fetch(`${BASE}/health`);
    const j = await res.json();
    if (res.status === 200 && j.status === 'ok' && Number.isInteger(j.uptimeSec)) ok('/health ok');
    else fail('/health', `status=${res.status}`);
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    if (home.status === 200 && html.includes('strngr') && html.includes('videoCard')) ok('/ serves landing');
    else fail('landing', `status=${home.status}`);
    const priv = await fetch(`${BASE}/privacy.html`);
    if (priv.status === 200 && (await priv.text()).includes('No accounts')) ok('/privacy.html served');
    else fail('privacy page', `status=${priv.status}`);
    const terms = await fetch(`${BASE}/terms.html`);
    if (terms.status === 200 && (await terms.text()).includes('Terms of Service')) ok('/terms.html served');
    else fail('terms page', `status=${terms.status}`);
  }

  console.log(results.join('\n'));
  console.log(`\n${'='.repeat(50)}`);
  console.log(`PASSED ${passed} / ${passed + failed}`);
  if (failed > 0) { console.log('E2E FAILED'); process.exitCode = 1; return; }
  console.log('E2E OK');
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exitCode = 1;
});
