#!/usr/bin/env python3
"""Create the strngr Render service via the REST API."""
import json
import sys
import urllib.request
import urllib.error

import yaml

with open("C:/Users/devil/.render/cli.yaml") as f:
    cfg = yaml.safe_load(f)
API_KEY = cfg["api"]["key"]

BASE = "https://api.render.com/v1"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=HEADERS,
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


# 1) real ownerId
status, owners = call("GET", "/owners")
if status != 200:
    print("owner lookup failed:", status, owners)
    sys.exit(1)
owner_id = owners[0]["owner"]["id"]
print("ownerId:", owner_id)

# 2) create service from the GitHub repo
payload = {
    "type": "web_service",
    "autoDeploy": "yes",
    "name": "strngr",
    "repo": "https://github.com/saketkumar-18/strngr",
    "branch": "main",
    "ownerId": owner_id,
    "serviceDetails": {
        "runtime": "node",
        "plan": "free",
        "region": "singapore",
        "buildCommand": "npm ci --omit=dev",
        "startCommand": "node server.js",
        "healthCheckPath": "/health",
        "envSpecificDetails": {
            "buildCommand": "npm ci --omit=dev",
            "startCommand": "node server.js",
        },
    },
}

# idempotent: skip if service exists
status, services = call("GET", "/services?limit=50")
existing = None
if status == 200 and services:
    for entry in services:
        s = entry.get("service") or {}
        if s.get("name") == "strngr":
            existing = s
            break

if existing:
    print("service already exists:", existing["id"])
    svc_id = existing["id"]
else:
    status, created = call("POST", "/services", payload)
    print("create:", status)
    if status not in (200, 201):
        print(json.dumps(created, indent=2)[:2000])
        sys.exit(1)
    svc_id = created.get("service", {}).get("id") or created.get("id")
    if not svc_id:
        status, services = call("GET", "/services?limit=50")
        for entry in services or []:
            s = entry.get("service") or {}
            if s.get("name") == "strngr":
                svc_id = s["id"]
                break
    print("serviceId:", svc_id)

# 3) trigger a deploy (also needed when service existed but was never deployed)
status, dep = call("POST", f"/services/{svc_id}/deploys", {})
print("deploy trigger:", status, dep.get("id", "") if isinstance(dep, dict) else "")
print("DEPLOY_ID=" + (dep.get("id") if isinstance(dep, dict) and dep.get("id") else ""))
