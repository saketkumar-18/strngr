#!/usr/bin/env python3
"""strngr E2E against PRODUCTION using a raw engine.io/socket.io v4 WebSocket client.
Protocol notes: engine.io frames arrive one per WS message (\\x1e only batches multi-packet sends).
socket.io packets: 40=CONNECT, 42[...]=EVENT, 43[aid,...]=ACK from server. Client emits with ack
as 42[aid,[event,...args]]. Events are logged so none are lost between wait_for calls.
Covers: match, bidirectional text relay, SDP/ICE relay, skip, report, rate limit, cleanup."""
import json
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://strngr.onrender.com"
WS = BASE.replace("https://", "wss://").replace("http://", "ws://") + "/socket.io/?EIO=4&transport=websocket"

passed = 0
failed = 0
log = []


def ok(name):
    global passed
    passed += 1
    log.append(f"  ✓ {name}")


def fail(name, err):
    global failed
    failed += 1
    log.append(f"  ✗ {name} — {err}")


def section(s):
    log.append("")
    log.append(s)


class Client:
    def __init__(self):
        self.ws = websocket.create_connection(WS, timeout=15)
        self.ack_counter = 100
        self.ack_results = {}
        self.ack_waiters = {}
        self.handlers = {}
        self.event_log = []  # (event, args) — survives until drained
        self.alive = True
        self.buf = ""
        self._connect()

    # ---- transport ----
    def _recv_raw(self, timeout=10):
        """Receive ONE websocket message; return list of \\x1e-joined packets within it."""
        if "\x1e" in self.buf:
            frames = self.buf.split("\x1e")
            self.buf = frames.pop()
            return frames
        self.ws.settimeout(timeout)
        chunk = self.ws.recv()
        if chunk == "":
            self.alive = False
            raise TimeoutError("socket closed")
        if isinstance(chunk, bytes):
            chunk = chunk.decode(errors="replace")
        if "\x1e" in chunk:
            frames = chunk.split("\x1e")
            self.buf += frames.pop()
            return frames
        return [chunk]

    def send_raw(self, s):
        self.ws.send(s)

    def _connect(self):
        msgs = self._recv_raw()
        assert msgs[0].startswith("0"), f"expected engine open, got {msgs[0][:20]}"
        self.send_raw("40")  # socket.io namespace CONNECT
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                for f in self._recv_raw(2):
                    self._packet(f)
            except (TimeoutError, websocket.WebSocketTimeoutException):
                pass
            if any(e == "__connected" for e, _ in self.event_log):
                self.event_log = [(e, a) for e, a in self.event_log if e != "__connected"]
                return
        raise TimeoutError("no socket.io CONNECT ack")

    # ---- protocol ----
    def _packet(self, frame):
        if not frame:
            return
        code = frame[0]
        if code == "2":  # engine ping
            self.send_raw("3")
            return
        if code != "4":  # only socket.io namespace packets past here
            return
        rest = frame[1:]
        if not rest:
            return
        sub = rest[0]
        if sub == "0":  # socket.io CONNECT ack
            self.event_log.append(("__connected", None))
        elif sub == "1":  # socket.io DISCONNECT packet — server dropped us
            self.alive = False
            self.event_log.append(("__server_disconnected", None))
        elif sub == "2":  # EVENT
            data = json.loads(rest[1:])
            event = data[0]
            args = data[1:]
            self.event_log.append((event, args))
            if event in self.handlers:
                self.handlers[event](*args)
        elif sub == "3":  # ACK (server -> client): "43" + aid + json array
            rest2 = rest[1:]
            idx = rest2.index("[")
            aid = int(rest2[:idx])
            data = json.loads(rest2[idx:])
            result = data[0] if len(data) > 0 else None
            if aid in self.ack_waiters:
                self.ack_waiters.pop(aid)(result)

    def pump(self, duration=0.3):
        """Process packets for a short window."""
        deadline = time.time() + duration
        while time.time() < deadline:
            try:
                for f in self._recv_raw(0.1):
                    self._packet(f)
            except TimeoutError:
                pass
            except websocket.WebSocketTimeoutException:
                pass

    def wait_for(self, event, timeout=10.0):
        """Return args tuple for the next occurrence of event (checks log first)."""
        deadline = time.time() + timeout
        # drain log first
        for i, (e, a) in enumerate(self.event_log):
            if e == event:
                self.event_log = self.event_log[i + 1:]
                return a
        while time.time() < deadline:
            try:
                for f in self._recv_raw(1.0):
                    self._packet(f)
            except (TimeoutError, websocket.WebSocketTimeoutException):
                pass
            for i, (e, a) in enumerate(self.event_log):
                if e == event:
                    self.event_log = self.event_log[i + 1:]
                    return a
        raise TimeoutError(f'timeout waiting for "{event}"')

    def emit(self, event, *args):
        self.send_raw("42" + json.dumps([event, *args]))

    def emit_ack(self, event, *args, timeout=10.0):
        self.ack_counter += 1
        aid = self.ack_counter
        holder = {}
        self.ack_waiters[aid] = lambda r: holder.setdefault("r", r)
        # socket.io v4 client-with-ack: "42" + aid + [event, args...]
        self.send_raw("42" + str(aid) + json.dumps([event, *args]))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.3)
            if "r" in holder:
                return holder["r"]
        raise TimeoutError(f"no ack for {event}")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        self.alive = False


def drain(cli):
    cli.pump(0.2)


def main():
    print(f"strngr prod E2E against {BASE}\n")

    # ---- T1: health ----
    section("T1 · /health")
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=15) as r:
            j = json.loads(r.read().decode())
        if j.get("status") == "ok":
            ok(f"health ok (uptime {j.get('uptimeSec')}s, online {j.get('online')})")
        else:
            fail("health", str(j))
    except Exception as e:
        fail("health", repr(e))

    # ---- T2: text match + relay both ways ----
    section("T2 · text match + relay")
    a = None
    b = None
    try:
        a = Client(); b = Client()
        ra = a.emit_ack("find-partner", {"channel": "text"})
        rb = b.emit_ack("find-partner", {"channel": "text"})
        drain(a); drain(b)
        ma = a.wait_for("matched")
        mb = b.wait_for("matched")
        if ma[0]["initiator"] != mb[0]["initiator"]:
            ok("matched, initiator roles complementary")
        else:
            fail("roles", f'{ma[0]["initiator"]}/{mb[0]["initiator"]}')

        ack = a.emit_ack("text-message", {"text": "hello from A"})
        mbm = b.wait_for("text-message")
        if mbm[0]["text"] == "hello from A" and ack and ack.get("ok"):
            ok("A→B relay + ack")
        else:
            fail("A→B relay", f"got={mbm} ack={ack}")

        ack2 = b.emit_ack("text-message", {"text": "hi from B"})
        mam = a.wait_for("text-message")
        if mam[0]["text"] == "hi from B":
            ok("B→A relay")
        else:
            fail("B→A relay", str(mam))
    except Exception as e:
        fail("text flow", repr(e))
    finally:
        for c in (a, b):
            if c:
                c.close()

    # ---- T3: SDP/ICE relay ----
    section("T3 · WebRTC signal relay")
    a = None
    b = None
    try:
        a = Client(); b = Client()
        a.emit_ack("find-partner", {"channel": "video"})
        b.emit_ack("find-partner", {"channel": "video"})
        drain(a); drain(b)
        a.wait_for("matched"); b.wait_for("matched")
        offer = {"description": {"type": "offer", "sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n"}}
        a.emit("signal", {"data": offer})
        got = b.wait_for("signal")[0]["data"]
        if got["description"]["type"] == "offer":
            ok("SDP offer relayed")
        else:
            fail("offer relay", str(got))
        answer = {"description": {"type": "answer", "sdp": "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\n"}}
        b.emit("signal", {"data": answer})
        got2 = a.wait_for("signal")[0]["data"]
        if got2["description"]["type"] == "answer":
            ok("SDP answer relayed")
        else:
            fail("answer relay", str(got2))
        cand = {"candidate": {"candidate": "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host", "sdpMid": "0", "sdpMLineIndex": 0}}
        a.emit("signal", {"data": cand})
        got3 = b.wait_for("signal")[0]["data"]
        if got3["candidate"]["sdpMid"] == "0":
            ok("ICE candidate relayed")
        else:
            fail("ice relay", str(got3))
        a.emit("media-state", {"video": False, "audio": True})
        ms = b.wait_for("media-state")[0]
        if ms["video"] is False and ms["audio"] is True:
            ok("media-state relayed")
        else:
            fail("media-state", str(ms))
    except Exception as e:
        fail("signal relay", repr(e))
    finally:
        for c in (a, b):
            if c:
                c.close()

    # ---- T4: skip ----
    section("T4 · skip")
    a = None
    b = None
    try:
        a = Client(); b = Client()
        a.emit_ack("find-partner", {"channel": "text"})
        b.emit_ack("find-partner", {"channel": "text"})
        drain(a); drain(b)
        a.wait_for("matched"); b.wait_for("matched")
        a.emit("skip")
        left = b.wait_for("partner-left")
        if left[0]["reason"] == "skip":
            ok("skip delivered reason=skip")
        else:
            fail("skip", str(left))
    except Exception as e:
        fail("skip", repr(e))
    finally:
        for c in (a, b):
            if c:
                c.close()

    # ---- T5: report ----
    section("T5 · report")
    a = None
    b = None
    try:
        a = Client(); b = Client()
        a.emit_ack("find-partner", {"channel": "text"})
        b.emit_ack("find-partner", {"channel": "text"})
        drain(a); drain(b)
        a.wait_for("matched"); b.wait_for("matched")
        a.emit("report")
        left = b.wait_for("partner-left")
        if left[0]["reason"] == "left":
            ok("report anonymous, reported user sees 'left'")
        else:
            fail("report", str(left))
    except Exception as e:
        fail("report", repr(e))
    finally:
        for c in (a, b):
            if c:
                c.close()

    # ---- T6: rate limit drops flooder ----
    section("T6 · rate limit")
    a = None
    b = None
    try:
        a = Client(); b = Client()
        a.emit_ack("find-partner", {"channel": "text"})
        b.emit_ack("find-partner", {"channel": "text"})
        drain(a); drain(b)
        a.wait_for("matched"); b.wait_for("matched")
        for i in range(40):
            a.send_raw('42["text-message",{"text":"spam %d"}]' % i)
        dead = False
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                a.pump(0.5)
                if any(e == "__server_disconnected" for e, _ in a.event_log):
                    dead = True
                    break
                if not a.alive:
                    dead = True
                    break
            except Exception:
                dead = True
                break
        if dead:
            ok("flooder dropped by rate limiter")
        else:
            fail("rate limit", "flooder still connected after 40 rapid messages")
    except Exception as e:
        fail("rate limit", repr(e))
    finally:
        for c in (a, b):
            if c:
                c.close()

    # ---- T7: cleanup / next-match isolation ----
    section("T7 · cleanup & isolation")
    a = None
    b = None
    c = None
    try:
        a = Client(); b = Client(); c = Client()
        a.emit_ack("find-partner", {"channel": "text"})
        b.emit_ack("find-partner", {"channel": "text"})
        drain(a); drain(b)
        a.wait_for("matched"); b.wait_for("matched")
        a.close()  # abrupt disconnect
        left = b.wait_for("partner-left")
        if left[0]["reason"] in ("left", "skip"):
            ok("partner-left on abrupt disconnect")
        b.emit_ack("find-partner", {"channel": "text"})
        drain(b)
        time.sleep(0.3)
        c.emit_ack("find-partner", {"channel": "text"})
        drain(c)
        b.wait_for("matched", 12)
        c.wait_for("matched", 12)
        ok("fresh sockets pair cleanly (no ghost partner)")
    except Exception as e:
        fail("cleanup", repr(e))
    finally:
        for cl in (a, b, c):
            if cl:
                cl.close()

    # ---- T9: three-strikes report system ----
    section("T9 · three-strikes")
    target = None
    reporters = []

    def safe_drain(cli):
        try:
            cli.pump(0.3)
        except Exception:
            pass

    try:
        target = Client()  # the user who will be reported 3 times
        target.emit_ack("find-partner", {"channel": "text"})
        for i in range(3):
            r = Client()
            r.emit_ack("find-partner", {"channel": "text"})
            reporters.append(r)
            safe_drain(target); safe_drain(r)
            target.wait_for("matched", 6)
            r.wait_for("matched", 6)
            r.emit("report")  # reporter leaves; target keeps searching below
            safe_drain(target)  # socket may be force-closed on the 3rd report — expected
            # target is now idle; search again for the next reporter
            if i < 2:
                target.emit_ack("find-partner", {"channel": "text"})
                safe_drain(target)
        # target should now be force-disconnected (3 distinct reporters)
        dead = False
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                target.pump(0.5)
                if any(e == "__server_disconnected" for e, _ in target.event_log) or not target.alive:
                    dead = True
                    break
            except Exception:
                dead = True
                break
        if dead:
            ok("three-strikes: reported user force-disconnected")
        else:
            fail("three-strikes", "target still connected after 3 reports")
    except TimeoutError as e:
        fail("three-strikes", f"match flow broke: {e!r}")
    except Exception as e:
        fail("three-strikes", repr(e))
    finally:
        if target:
            target.close()
        for r in reporters:
            r.close()

    # ---- T8: static pages ----
    section("T8 · pages")
    for path, marker in [("/", "videoCard"), ("/privacy.html", "No accounts"), ("/terms.html", "Terms of Service")]:
        try:
            with urllib.request.urlopen(BASE + path, timeout=15) as r:
                body = r.read().decode(errors="replace")
            if r.status == 200 and marker in body:
                ok(f"{path} serves {marker!r}")
            else:
                fail(path, f"status={r.status}")
        except Exception as e:
            fail(path, repr(e))

    print("\n".join(log))
    print("\n" + "=" * 50)
    print(f"PASSED {passed} / {passed + failed}")
    if failed:
        sys.exit(1)
    print("PROD E2E OK")


if __name__ == "__main__":
    main()
