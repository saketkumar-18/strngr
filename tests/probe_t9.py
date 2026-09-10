#!/usr/bin/env python3
"""T9 verbose probe: run the three-strikes scenario with full frame logging on the target."""
import sys
import time

sys.path.insert(0, "tests")
import prod_e2e as P

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://strngr.onrender.com"
P.WS = BASE.replace("https://", "wss://").replace("http://", "ws://") + "/socket.io/?EIO=4&transport=websocket"

# monkeypatch _packet to log
orig = P.Client._packet


def verbose_packet(self, frame):
    if frame and frame[0] == "4" and frame[1:2] in ("1", "0"):
        print(f"    [target-frame] {frame[:60]}")
    return orig(self, frame)


P.Client._packet = verbose_packet


def drain(cli):
    try:
        cli.pump(0.3)
    except Exception as e:
        print("    drain exc:", type(e).__name__)


target = P.Client()
print("target connected")
target.emit_ack("find-partner", {"channel": "text"})
print("target searching")

for i in range(3):
    r = P.Client()
    r.emit_ack("find-partner", {"channel": "text"})
    reporters_ack = None
    drain(target); drain(r)
    m = target.wait_for("matched", 8)
    print(f"iter {i}: target matched (initiator={m[0]['initiator']})")
    r.wait_for("matched", 8)
    r.emit("report")
    print(f"iter {i}: report emitted")
    drain(target)
    if i < 2:
        target.emit_ack("find-partner", {"channel": "text"})
        drain(target)
        print(f"iter {i}: target searching again")

# watch target for 10s
print("watching target for disconnect...")
deadline = time.time() + 10
while time.time() < deadline:
    try:
        target.pump(0.5)
    except Exception as e:
        print("pump exc:", type(e).__name__)
        break
    log_events = [e for e, _ in target.event_log]
    if "__server_disconnected" in log_events or not target.alive:
        print("TARGET DISCONNECTED ✓")
        break
else:
    print("TARGET STILL CONNECTED ✗")
    print("event_log tail:", [e for e, _ in target.event_log][-8:])
