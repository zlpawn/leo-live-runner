#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
J-Link RTT 硬件测试流水日志中继与实时上报工具 (J-Link RTT Live Forwarder)
--------------------------------------------------------------------------
适用场景：
  在 LEO 本地开发环境中，当单片机开发板通过 J-Link 调试器连接时，本工具监听 J-Link
  在本地开放的 RTT Telnet 服务 (默认 127.0.0.1:19021)，流式捕获固件业务日志与
  通信报文，并按批次实时上报至后端测试环境数据库。

核心特性：
  1. 零驱动依赖：基于标准 TCP Socket 连接 J-Link 本地 RTT 端口 (127.0.0.1:19021)；
  2. 智能重连与引导：自动轮询等待 J-Link 连接建立，断连自动重试；
  3. 批量缓冲平滑上报：支持按时间 (flush_interval) 与容量 (batch_size) 缓冲聚合 POST；
  4. 协议指令与日志级别解析：自动识别 Zephyr RTOS <inf>/<err>/<dbg> 及 0x8001/0x0004 协议；
  5. 优雅关机闭环：Ctrl+C 中断时自动推送 isFinal=True 状态封板主表运行会话。

用法示例：
  python3 scripts/jlink_forwarder.py --imei 861993083543235
  python3 scripts/jlink_forwarder.py --imei 861993083543235 --url http://127.0.0.1:8080/backdoor/device/log/batch
"""

import sys
import os
import re
import time
import json
import uuid
import socket
import signal
import argparse
import urllib.request
import urllib.error
from datetime import datetime

DEFAULT_TARGET_URL = "http://test.huiju.iot.cloud.ke.com:8080/backdoor/device/log/batch"
DEFAULT_TELNET_HOST = "127.0.0.1"
DEFAULT_TELNET_PORT = 19021

# 匹配 Zephyr RTT 格式: [00:00:02.130,000] <inf> net_interface: content 或 <inf> net_interface: content
RE_ZEPHYR_LOG = re.compile(r"(?:\[([^\]]+)\]\s*)?<([a-z]+)>\s*([^:\s]+):\s*(.*)", re.IGNORECASE)
# 匹配 Hex 协议报文特征: be00... 或 BE00...
RE_HEX_FRAME = re.compile(r"\b(be[0-9a-fA-F]{10,})\b")
# 匹配常见指令码
RE_CMD_TYPE = re.compile(r"\b(0x[0-9a-fA-F]{4})\b")


class JLinkForwarder:
    def __init__(self, imei, target_url=DEFAULT_TARGET_URL, host=DEFAULT_TELNET_HOST,
                 port=DEFAULT_TELNET_PORT, prod_type="", batch_size=50, flush_interval=1.0):
        self.imei = imei.strip()
        self.target_url = target_url
        self.host = host
        self.port = int(port)
        self.prod_type = prod_type
        self.batch_size = batch_size
        self.flush_interval = flush_interval

        now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.run_id = f"run_{self.imei}_{now_str}_{uuid.uuid4().hex[:6]}"
        self.buffer = []
        self.last_flush_time = time.time()
        self.running = True
        self.total_sent = 0
        self.auth_status = 0  # 0-未知, 1-通过, 2-失败

    def parse_log_line(self, line):
        """解析单行 RTT 日志为结构化字段"""
        clean_line = line.strip()
        if not clean_line:
            return None

        level = "INFO"
        module = "rtt"
        content = clean_line
        raw_hex = ""
        cmd_type = ""

        # 1. 尝试匹配 Zephyr RTOS 格式
        m = RE_ZEPHYR_LOG.match(clean_line)
        if m:
            lvl_tag = (m.group(2) or "").lower()
            if lvl_tag in ("err", "error"):
                level = "ERROR"
            elif lvl_tag in ("wrn", "warn"):
                level = "WARN"
            elif lvl_tag in ("dbg", "debug"):
                level = "DEBUG"
            else:
                level = "INFO"
            module = m.group(3) or "zephyr"
            content = m.group(4) or ""
        else:
            if "error" in clean_line.lower() or "fault" in clean_line.lower():
                level = "ERROR"
            elif "warn" in clean_line.lower():
                level = "WARN"

        # 2. 识别鉴权关键事件
        if "auth pass" in clean_line.lower():
            self.auth_status = 1
        elif "auth fail" in clean_line.lower() or "auth error" in clean_line.lower():
            self.auth_status = 2

        # 3. 提取十六进制报文与指令码
        hex_match = RE_HEX_FRAME.search(clean_line)
        if hex_match:
            raw_hex = hex_match.group(1).lower()

        cmd_match = RE_CMD_TYPE.search(clean_line)
        if cmd_match:
            cmd_type = cmd_match.group(1).lower()
        elif raw_hex and len(raw_hex) >= 8 and raw_hex.startswith("be"):
            # 尝试从 BE 头部解出第 3-4 字节作为指令码
            try:
                cmd_type = "0x" + raw_hex[6:10]
            except Exception:
                pass

        return {
            "source": "JLINK",
            "logLevel": level,
            "module": module,
            "content": content,
            "rawHex": raw_hex,
            "cmdType": cmd_type,
            "deviceTimestamp": int(time.time() * 1000)
        }

    def flush_batch(self, is_final=False):
        """将内存缓冲区内的日志上报给后端接口"""
        if not self.buffer and not is_final:
            return

        batch_logs = list(self.buffer)
        self.buffer.clear()
        self.last_flush_time = time.time()

        payload = {
            "runId": self.run_id,
            "imei": self.imei,
            "prodType": self.prod_type,
            "targetHost": f"JLink@{self.host}:{self.port}",
            "authStatus": self.auth_status,
            "isFinal": is_final,
            "logs": batch_logs
        }

        try:
            req_data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                self.target_url,
                data=req_data,
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                res_code = response.getcode()
                if res_code == 200:
                    self.total_sent += len(batch_logs)
                    status_flag = "🟢 [Auth Pass]" if self.auth_status == 1 else ""
                    print(f"\r[J-Link Forwarder] 已同步 {self.total_sent} 条日志到测试环境 {status_flag}", end="", flush=True)
                else:
                    print(f"\n[J-Link Forwarder] ⚠️ 上报接口返回 HTTP {res_code}")
        except Exception as e:
            # 接口异常时将未发送条目回填回缓冲首部，避免丢包
            self.buffer = batch_logs + self.buffer
            print(f"\n[J-Link Forwarder] ⚠️ 日志推送失败: {e} (已缓冲暂存，将在下次重试)")

    def run(self):
        """主循环：建立 Telnet Socket 并流式读取"""
        print("=" * 68)
        print("🚀 J-Link RTT 硬件测试日志实时中继探针启动")
        print(f"  • 设备 IMEI   : {self.imei}")
        print(f"  • 运行批次 ID : {self.run_id}")
        print(f"  • J-Link 目标 : {self.host}:{self.port}")
        print(f"  • 上报接口    : {self.target_url}")
        print("=" * 68)

        sock = None
        while self.running:
            try:
                if sock is None:
                    print(f"\n⏳ 正在连接 J-Link RTT 本地端口 ({self.host}:{self.port})...")
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.settimeout(2.0)
                    sock.connect((self.host, self.port))
                    sock.settimeout(0.5)
                    print("✅ J-Link RTT 已连通，正在实时捕获固件日志并上报后端...\n")

                try:
                    data = sock.recv(4096)
                    if not data:
                        print("\n⚠️ J-Link RTT 连接已断开，准备重连...")
                        sock.close()
                        sock = None
                        time.sleep(1.0)
                        continue

                    text = data.decode("utf-8", errors="replace")
                    for line in text.splitlines():
                        parsed = self.parse_log_line(line)
                        if parsed:
                            self.buffer.append(parsed)

                    # 检查容量或时间触发刷新
                    if len(self.buffer) >= self.batch_size or (time.time() - self.last_flush_time >= self.flush_interval):
                        self.flush_batch()

                except socket.timeout:
                    # 超时心跳刷新
                    if self.buffer and (time.time() - self.last_flush_time >= self.flush_interval):
                        self.flush_batch()

            except (ConnectionRefusedError, socket.error):
                if sock:
                    sock.close()
                    sock = None
                print(f"\r⚠️ 未检测到 127.0.0.1:{self.port}，请确保 J-Link 已连接并启动 JLinkExe/JLinkRTTViewer。重试中...", end="", flush=True)
                time.sleep(2.0)
            except Exception as e:
                print(f"\n⚠️ 运行时异常: {e}")
                time.sleep(1.0)

        # 退出循环后最终清理封板
        print("\n\n🛑 正在执行最终批次同步封板...")
        if sock:
            try:
                sock.close()
            except Exception:
                pass
        self.flush_batch(is_final=True)
        print(f"🎉 运行结束，本次会话 {self.run_id} 共上报 {self.total_sent} 条日志。")


def main():
    parser = argparse.ArgumentParser(description="J-Link RTT 硬件测试日志实时中继探针 (LEO 专享)")
    parser.add_argument("--imei", required=True, help="目标设备 IMEI (如 861993083543235)")
    parser.add_argument("--url", default=DEFAULT_TARGET_URL, help=f"后端日志上报地址，默认: {DEFAULT_TARGET_URL}")
    parser.add_argument("--host", default=DEFAULT_TELNET_HOST, help=f"J-Link RTT Telnet Host，默认: {DEFAULT_TELNET_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_TELNET_PORT, help=f"J-Link RTT Telnet Port，默认: {DEFAULT_TELNET_PORT}")
    parser.add_argument("--model", default="hj07", help="设备产品型号，默认: hj07")
    parser.add_argument("--batch-size", type=int, default=50, help="批量上报容量阈值，默认: 50")
    parser.add_argument("--interval", type=float, default=1.0, help="批量上报时间间隔(秒)，默认: 1.0")

    args = parser.parse_args()

    forwarder = JLinkForwarder(
        imei=args.imei,
        target_url=args.url,
        host=args.host,
        port=args.port,
        prod_type=args.model,
        batch_size=args.batch_size,
        flush_interval=args.interval
    )

    def handle_signal(sig, frame):
        forwarder.running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    forwarder.run()


if __name__ == "__main__":
    main()
