#!/usr/bin/env python3
"""Kill whatever listens on local port 3000 (old dev server)."""
import subprocess
import re

out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
pids = set()
for line in out.splitlines():
    if ":3000" in line and "LISTEN" in line.upper():
        pids.add(line.split()[-1])
for pid in pids:
    subprocess.run(["powershell", "-Command", f"Stop-Process -Id {pid} -Force"], capture_output=True)
    print("killed", pid)
print("done")
