// Static contract check: every DOM id app.js references exists in index.html,
// every client-listened event is emitted by the server, every client emit has a handler.
'use strict';
const fs = require('fs');

const js = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

let bad = 0;

// 1) DOM ids (app.js wraps getElementById in a $() helper)
const ids = [...new Set([
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
])].filter((i) => i !== 'toast' || true);
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) { console.log('MISSING DOM ID:', id); bad++; }
}
console.log(`DOM ids referenced: ${ids.length} | missing: ${bad}`);

// 2) client listens -> server emits
const clientEvts = [...new Set([...js.matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1]))];
const BUILTIN = new Set(['connect', 'connect_error', 'disconnect', 'reconnect']); // engine events
let badE = 0;
for (const e of clientEvts) {
  if (BUILTIN.has(e)) continue;
  if (!server.includes(`'${e}'`) && !server.includes(`"${e}"`)) { console.log('CLIENT EVT NOT EMITTED BY SERVER:', e); badE++; }
}
console.log(`client events: ${clientEvts.length} | unhandled: ${badE}`);
bad += badE;

// 3) client emits -> server handlers
const emits = [...new Set([...js.matchAll(/socket\.emit\('([^']+)'/g)].map((m) => m[1]))];
let badS = 0;
for (const e of emits) {
  if (!server.includes(`socket.on('${e}'`)) { console.log('EMIT WITHOUT SERVER HANDLER:', e); badS++; }
}
console.log(`client emits: ${emits.length} | unhandled: ${badS}`);
bad += badS;

if (bad) { console.log('CONTRACT CHECK FAILED'); process.exitCode = 1; }
else console.log('CONTRACT CHECK OK');
