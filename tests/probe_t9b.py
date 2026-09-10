#!/usr/bin/env python3
"""T9 with server-state inspection: after each report, GET /debug/state and print
exactly what the server recorded for the target's report count."""
import json
import sys
import time
import urllib.request

sys.path.insert(0, "tests")
import prod_e2e as P

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
P.WS = BASE.replace("https://", "wss://").replace("http://", "ws://") + "/socket.io/?EIO=4&transport=websocket"


def state():
    with urllib.request.urlopen(BASE + "/debug/state", timeout=10) as r:
        return json.loads(r.read().decode())


def drain(cli):
    try:
        cli.pump(0.3)
    except Exception:
        pass


target = P.Client()
target.emit_ack("find-partner", {"channel": "text"})

for i in range(3):
    r = P.Client()
    r.emit_ack("find-partner", {"channel": "text"})
    drain(target); drain(r)
    m = target.wait_for("matched", 8)
    r.wait_for("matched", 8)
    r.emit("report")
    drain(target)
    time.sleep(0.5)
    st = state()
    print(f"iter {i}: reports map = {json.dumps(st['reports'])} | target users entry: "
          f"{[u for u in st['users'] if u['state'] != 'idle'][:2]}")
    if i < 2:
        target.emit_ack("find-partner", {"channel": "text"})
        drain(target)

deadline = time.time() + 8
dead = False
while time.time() < deadline:
    try:
        target.pump(0.5)
        if any(e == "__server_disconnected" for e, _ in target.event_log) or not target.alive:
            dead = True
            break
    except Exception:
        dead = True
        break
print("TARGET DISCONNECTED ✓" if dead else "TARGET STILL CONNECTED ✗")
