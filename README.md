# strngr

Talk to a random stranger — video or text. Like Omegle, but with a privacy model that's actually real.

**Live:** https://strngr.onrender.com

## Why it's different

| | strngr | typical chat roulette |
|---|---|---|
| Sign-up | none — not even a nickname | usually email/social login |
| Messages | relayed in RAM, dropped in milliseconds | stored, mined, resold |
| Video | peer-to-peer (WebRTC, DTLS-SRTP) — never touches the server | proxied/recorded |
| Logs | none | yes |
| Trackers | zero — no cookies, no third-party scripts | analytics everywhere |
| Database | there isn't one | there is |

## How it works

- Node.js + Express + Socket.IO. Single service, volatile memory only.
- Matchmaking: FIFO queue per channel (text/video). One room per pair; the server only relays signaling (SDP/ICE) and text.
- WebRTC with the [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) pattern; ICE restarts on failure; public STUN only (media never routes through the server).
- Rate limiting (token bucket) on text/typing events — flooders are disconnected.
- Report & skip: counts reports anonymously in memory (10-minute window); users accumulating reports are disconnected. Reporters are never identified to the reported.
- No HTML in messages is ever rendered (textContent only) — no injection, no phishing links rendered clickable.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Test

```bash
npm test           # functional E2E against a live server (set BASE_URL to test prod)
```

Two synthetic clients join, match, exchange text both directions, signal WebRTC offers/answers/candidates, and verify room lifecycle (skip, partner-left, report, cleanup). Exits non-zero on any failure.

## Deployment (Render, free tier)

```bash
render services create ...   # or connect the GitHub repo — render.yaml included
```

Free-tier caveat: the service sleeps after ~15 min idle; first visitor wakes it (~30-60s). State is RAM-only, so a restart cleanly forgets everything — by design.

## Privacy

See [public/privacy.html](public/privacy.html). Short version: we collect nothing, store nothing, share nothing. There is no database to breach.

## License

MIT
