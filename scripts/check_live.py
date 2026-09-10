#!/usr/bin/env python3
"""Check which commit is live on Render + whether GitHub has our latest push."""
import json
import urllib.request

import yaml

with open("C:/Users/devil/.render/cli.yaml") as f:
    cfg = yaml.safe_load(f)
H = {"Authorization": "Bearer " + cfg["api"]["key"]}
SVC = "srv-dahc6qv40ujc73a5q3i0"

req = urllib.request.Request(f"https://api.render.com/v1/services/{SVC}/deploys?limit=5", headers=H)
with urllib.request.urlopen(req) as r:
    deps = json.loads(r.read().decode())
for entry in deps:
    d = entry["deploy"]
    print(d["id"], (d.get("commit") or {}).get("id", "?")[:7], d["status"], d.get("createdAt", ""))

print("\ngit remote:")
import subprocess
print(subprocess.run(["git", "ls-remote", "origin", "main"], capture_output=True, text=True, cwd="C:/Users/devil/Downloads/strngr").stdout)
