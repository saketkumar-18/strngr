#!/usr/bin/env python3
"""Poll the strngr deploy until live, then verify the service URL."""
import json
import sys
import time
import urllib.request

import yaml

with open("C:/Users/devil/.render/cli.yaml") as f:
    cfg = yaml.safe_load(f)
API_KEY = cfg["api"]["key"]

BASE = "https://api.render.com/v1"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
SVC = "srv-dahc6qv40ujc73a5q3i0"
DEP = "dep-dahc6ru7bikc73fat7b0"


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


deadline = time.time() + 420  # 7 min
last = ""
while time.time() < deadline:
    d = get(f"/services/{SVC}/deploys/{DEP}")["deploy"]
    state = d["status"]
    if state != last:
        print(state, flush=True)
        last = state
    if state == "live":
        print("LIVE")
        break
    if state in ("build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"):
        print("FAILED:", state)
        print(json.dumps(d, indent=2)[:3000])
        sys.exit(1)
    time.sleep(10)
else:
    print("timeout waiting for deploy")
    sys.exit(1)

svc = get(f"/services/{SVC}")["service"]
url = svc.get("serviceDetails", {}).get("url") or svc.get("slug") + ".onrender.com"
if not url.startswith("http"):
    url = "https://" + url
print("URL:", url)
