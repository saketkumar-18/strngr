#!/usr/bin/env python3
"""Trigger a manual deploy and wait for it to go live."""
import json
import sys
import time
import urllib.request

import yaml

with open("C:/Users/devil/.render/cli.yaml") as f:
    cfg = yaml.safe_load(f)
H = {"Authorization": "Bearer " + cfg["api"]["key"], "Content-Type": "application/json"}
SVC = "srv-dahc6qv40ujc73a5q3i0"
BASE = "https://api.render.com/v1"


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=H,
        method=method,
    )
    with urllib.request.urlopen(req) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else None


dep = call("POST", f"/services/{SVC}/deploys", {})
dep_id = dep["id"]
print("triggered:", dep_id)

last = ""
deadline = time.time() + 420
while time.time() < deadline:
    raw = call("GET", f"/services/{SVC}/deploys/{dep_id}")
    d = raw.get("deploy", raw)
    if d["status"] != last:
        print(d["status"], flush=True)
        last = d["status"]
    if d["status"] == "live":
        print("LIVE on commit", (d.get("commit") or {}).get("id", "")[:7])
        sys.exit(0)
    if d["status"] in ("build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"):
        print("FAILED:", d["status"])
        print(json.dumps(d, indent=2)[:2000])
        sys.exit(1)
    time.sleep(8)
print("timeout")
sys.exit(1)
