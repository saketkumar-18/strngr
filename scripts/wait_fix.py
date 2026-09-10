#!/usr/bin/env python3
"""Wait for the auto-deploy of the fix commit, then re-run the prod E2E against it."""
import json
import sys
import time
import urllib.request

import yaml

with open("C:/Users/devil/.render/cli.yaml") as f:
    cfg = yaml.safe_load(f)
H = {"Authorization": "Bearer " + cfg["api"]["key"]}
SVC = "srv-dahc6qv40ujc73a5q3i0"


def get(path):
    req = urllib.request.Request("https://api.render.com/v1" + path, headers=H)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


want = "202541a"
print("waiting for deploy of", want)
for i in range(30):
    deps = get(f"/services/{SVC}/deploys?limit=3")
    for entry in deps:
        d = entry["deploy"]
        cid = (d.get("commit") or {}).get("id", "")[:7]
        if cid == want:
            print(cid, d["status"])
            if d["status"] == "live":
                print("FIX IS LIVE")
                sys.exit(0)
            if d["status"] in ("build_failed", "update_failed", "canceled", "deactivated"):
                print("FAILED:", d["status"])
                sys.exit(1)
    latest = deps[0]["deploy"]
    print("latest:", (latest.get("commit") or {}).get("id", "")[:7], latest["status"])
    time.sleep(10)
print("timeout")
sys.exit(1)
