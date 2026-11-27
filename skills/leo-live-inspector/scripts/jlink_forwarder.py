#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
J-Link RTT 日志中继器已全面升级为原生 Node.js 实现 (scripts/jlink_forwarder.js)。
本文件保留作为兼容入口，自动转发参数至 node scripts/jlink_forwarder.js。
"""
import sys
import subprocess
from pathlib import Path

def main():
    script_dir = Path(__file__).resolve().parent
    node_script = script_dir / "jlink_forwarder.js"
    cmd = ["node", str(node_script)] + sys.argv[1:]
    try:
        proc = subprocess.run(cmd)
        sys.exit(proc.returncode)
    except KeyboardInterrupt:
        sys.exit(0)

if __name__ == "__main__":
    main()
