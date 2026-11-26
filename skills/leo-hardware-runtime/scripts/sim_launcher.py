#!/usr/bin/env python3
"""Cross-platform parameterized Renode firmware & cloud integration launcher."""

import argparse
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from firmware_probe import load_firmware_image
from renode_manager import find_renode_binary
from workspace import ConfigError, allocate_run_dir, get_config_path, read_config

SKILL_DIR = Path(__file__).resolve().parent.parent

NON_PROD_HOST_MARKERS = (
    "test", "dev", "qa", "uat", "sit", "mock", "sandbox", "staging", "preview", "local"
)


def is_private_or_loopback_ip(host):
    """Check whether host is a loopback or RFC1918 private IPv4 address."""
    parts = host.split(".")
    if len(parts) != 4:
        return host in ("localhost", "::1")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return False
    if any(n < 0 or n > 255 for n in nums):
        return False
    if nums[0] in (10, 127):
        return True
    if nums[0] == 192 and nums[1] == 168:
        return True
    if nums[0] == 172 and 16 <= nums[1] <= 31:
        return True
    return False


def validate_test_host(host, allow_test_ip=False):
    """Hard guard: permit only local/private/mock or explicit test-marked domains."""
    h = (host or "").strip().lower()
    if not h:
        raise ValueError("Missing target host; pass --mock or a test environment --host")
    if h in ("localhost", "127.0.0.1", "::1") or is_private_or_loopback_ip(h):
        return
    is_ipv4 = all(p.isdigit() for p in h.split(".")) and len(h.split(".")) == 4
    if is_ipv4:
        if allow_test_ip:
            return
        raise ValueError(
            f"Refusing raw public IP '{host}' without --confirm-test-ip (test-only guard)"
        )
    labels = [seg for seg in re.split(r"[.-]", h) if seg]
    if any(marker in labels for marker in NON_PROD_HOST_MARKERS):
        return
    raise ValueError(
        f"Refusing non-test domain '{host}': leo-hardware-runtime is strictly restricted to local/test environments"
    )


def load_device_profile(device_name):
    profile_path = SKILL_DIR / "references" / "devices" / device_name / "device.json"
    if not profile_path.exists():
        raise FileNotFoundError(f"Device profile not found: {profile_path}")
    return json.loads(profile_path.read_text(encoding="utf-8"))


def expand_tk_key_to_16b_hex(tk_key):
    """Expand 16-char hex tk_key (8B) to 32-char hex (16B) or validate 32-char hex."""
    cleaned = tk_key.strip().replace(" ", "")
    if len(cleaned) == 16:
        return cleaned + cleaned
    if len(cleaned) == 32:
        return cleaned
    raise ValueError(
        f"Expected 16-char (8B) or 32-char (16B) hex tk_key, got length {len(cleaned)}"
    )


def resolve_vector_entry(firmware_path, profile, explicit_sp=None, explicit_pc=None):
    """Auto-read SP and Reset_Handler PC from firmware vector_table_offset."""
    fw_cfg = profile.get("firmware", {})
    vtor_str = fw_cfg.get("vector_table_offset", "0x0")
    vtor = int(vtor_str, 0)
    sp = explicit_sp or fw_cfg.get("fallback_sp")
    pc = explicit_pc or fw_cfg.get("fallback_pc")

    if not explicit_sp or not explicit_pc:
        _, base, raw = load_firmware_image(firmware_path)
        off = vtor - base
        if 0 <= off and off + 8 <= len(raw):
            read_sp, read_pc = struct.unpack_from("<II", raw, off)
            if 0x20000000 <= read_sp <= 0x20200000 and (read_pc & 1) == 1:
                sp = explicit_sp or hex(read_sp)
                pc = explicit_pc or hex(read_pc)
    return vtor_str, sp, pc


class LocalMockServer:
    """Lightweight fallback TCP server for offline firmware handshake validation."""

    def __init__(self, host="127.0.0.1", port=0):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self._stop = threading.Event()
        self.packets_received = []
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        try:
            self.sock.close()
        except OSError:
            pass

    def _serve(self):
        self.sock.settimeout(0.3)
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(1.0)
                while not self._stop.is_set():
                    try:
                        data = conn.recv(2048)
                    except (socket.timeout, OSError):
                        break
                    if not data:
                        break
                    self.packets_received.append(data.hex())


def build_runtime_config(args, profile, work_dir, server_host, server_port):
    mem_map = profile.get("memory_map", {})
    flash_injections = []
    sram_injections = []

    if args.imei and mem_map.get("imei_flash_addr"):
        flash_injections.append({
            "addr": mem_map["imei_flash_addr"],
            "encoding": "ascii_z",
            "value": args.imei,
        })

    if args.tk_key and mem_map.get("localkey_sram_addr"):
        sram_injections.append({
            "addr": mem_map["localkey_sram_addr"],
            "encoding": "hex",
            "value": expand_tk_key_to_16b_hex(args.tk_key),
        })

    return {
        "device": args.device,
        "imei": args.imei or "",
        "server_host": server_host,
        "server_port": int(server_port),
        "allow_test_ip": bool(args.confirm_test_ip),
        "mock_mode": bool(args.mock),
        "clock_mode": args.clock_mode or profile.get("defaults", {}).get("clock_mode", "local"),
        "rtt_log_path": (work_dir / "rtt_full.log").as_posix(),
        "sram_dump_path": (work_dir / "sram_dump.bin").as_posix(),
        "rtt_scan_range": mem_map.get("rtt_scan_range", ["0x20000000", "0x10000"]),
        "sram_dump_range": mem_map.get("sram_dump_range", ["0x20000000", "0x20000"]),
        "flash_injections": flash_injections,
        "sram_injections": sram_injections,
    }


def render_repl_and_resc(profile, firmware_path, work_dir, vtor, sp, pc, run_for):
    mcu = profile["mcu"]
    modem = profile["modem"]

    repl_tmpl_path = SKILL_DIR / "references" / "mcu" / mcu / "base.repl.tmpl"
    modem_py = SKILL_DIR / "references" / "modems" / f"{modem}.py"
    grtc_py = SKILL_DIR / "references" / "mcu" / mcu / "grtc_rtt.py"

    # Copy peripheral scripts into work_dir with forward slashes for Renode cross-platform paths
    work_modem_py = work_dir / f"{modem}.py"
    work_grtc_py = work_dir / "grtc_rtt.py"
    shutil.copy2(modem_py, work_modem_py)
    shutil.copy2(grtc_py, work_grtc_py)

    repl_content = repl_tmpl_path.read_text(encoding="utf-8")
    repl_content = repl_content.replace("${MODEM_SCRIPT_PATH}", work_modem_py.as_posix())
    repl_content = repl_content.replace("${GRTC_RTT_SCRIPT_PATH}", work_grtc_py.as_posix())

    repl_path = work_dir / f"{mcu}.repl"
    repl_path.write_text(repl_content, encoding="utf-8")

    fw_posix = firmware_path.as_posix()
    ext = firmware_path.suffix.lower()
    if ext == ".hex":
        load_cmd = f"sysbus LoadHEX @{fw_posix}"
    elif ext == ".elf":
        load_cmd = f"sysbus LoadELF @{fw_posix}"
    else:
        load_cmd = f"sysbus LoadBinary @{fw_posix} {vtor}"

    resc_lines = [
        f'mach create "{profile["device"]}"',
        f"machine LoadPlatformDescription @{repl_path.as_posix()}",
        load_cmd,
        f"cpu VectorTableOffset {vtor}",
    ]
    if sp:
        resc_lines.append(f"cpu SP {sp}")
    if pc:
        resc_lines.append(f"cpu PC {pc}")
    resc_lines.extend([
        f'emulation RunFor "{run_for}"',
        "quit",
    ])

    resc_path = work_dir / "boot.resc"
    resc_path.write_text("\n".join(resc_lines) + "\n", encoding="utf-8")
    return repl_path, resc_path


def summarize_logs(renode_log_path, rtt_log_path):
    renode_text = renode_log_path.read_text(encoding="utf-8", errors="ignore") if renode_log_path.exists() else ""
    rtt_text = rtt_log_path.read_text(encoding="utf-8", errors="ignore") if rtt_log_path.exists() else ""

    tcp_events = [line.strip() for line in renode_text.splitlines() if "TCP_BRIDGE" in line]
    rtt_highlights = [
        line.strip()
        for line in rtt_text.splitlines()
        if re.search(r"localkey|imei|SKT|auth|Auth|send type|succ|fail|err", line)
    ]
    return {
        "tcp_events": tcp_events,
        "rtt_highlights": rtt_highlights,
        "auth_passed": any("Auth Pass" in l for l in rtt_highlights),
    }


def main():
    parser = argparse.ArgumentParser(description="Run parameterized Renode hardware-cloud integration")
    parser.add_argument("--device", required=True, help="Device profile name under references/devices/")
    parser.add_argument("--firmware", required=True, help="Path to firmware (.hex, .bin, .elf)")
    parser.add_argument("--imei", default="", help="Device IMEI")
    parser.add_argument("--tk-key", default="", help="Device key (16-char or 32-char hex)")
    parser.add_argument("--host", default="", help="Backend TCP host/IP")
    parser.add_argument("--port", type=int, default=0, help="Backend TCP port")
    parser.add_argument("--run-for", default=None, help="Virtual emulation seconds (e.g. 10)")
    parser.add_argument("--clock-mode", default=None, help="Modem clock mode: local | utc | fixed:<yymmddhhmmss>")
    parser.add_argument("--output-dir", default=None, help="Base output root (persisted to ~/.shrimp/skills/leo-hardware-runtime/config.json unless --no-persist)")
    parser.add_argument("--no-persist", action="store_true", help="Do not persist --output-dir into config.json")
    parser.add_argument("--work-dir", default=None, help="Exact directory for this single run (overrides --output-dir without persisting)")
    parser.add_argument("--renode-bin", default=None, help="Explicit Renode CLI path")
    parser.add_argument("--sp", default=None, help="Override initial SP")
    parser.add_argument("--pc", default=None, help="Override initial Reset PC")
    parser.add_argument("--mock", action="store_true", help="Run against built-in local mock TCP sink if no host specified")
    parser.add_argument("--confirm-test-ip", action="store_true", help="Allow a raw public IP verified to belong to test environment")
    parser.add_argument("--timeout", type=int, default=60, help="Wall-clock subprocess timeout seconds")
    args = parser.parse_args()

    try:
        user_cfg = read_config()
    except ConfigError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 3

    renode_bin = find_renode_binary(args.renode_bin or user_cfg.get("renode_bin") or None)
    if not renode_bin:
        print(json.dumps({"error": "Renode CLI not found. Run renode_manager.py doctor/install first."}), file=sys.stderr)
        return 1

    fw_path = Path(args.firmware).expanduser().resolve()
    if not fw_path.exists():
        print(json.dumps({"error": f"Firmware not found: {fw_path}"}), file=sys.stderr)
        return 1

    profile = load_device_profile(args.device)
    if args.work_dir:
        work_dir = Path(args.work_dir).expanduser().resolve()
        work_dir.mkdir(parents=True, exist_ok=True)
        output_source = "explicit_work_dir"
    else:
        run_tag = args.imei if args.imei else ("mock" if args.mock else "sim")
        work_dir, out_info = allocate_run_dir(
            args.device,
            tag=run_tag,
            explicit_output_dir=args.output_dir,
            persist=not args.no_persist,
        )
        output_source = out_info["source"]

    mock_server = None
    server_host = args.host.strip()
    server_port = args.port or profile.get("protocol", {}).get("default_port", 8010)
    if args.mock and not server_host:
        mock_server = LocalMockServer()
        mock_server.start()
        server_host = "127.0.0.1"
        server_port = mock_server.port
    else:
        try:
            validate_test_host(server_host, allow_test_ip=args.confirm_test_ip)
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}), file=sys.stderr)
            return 2

    try:
        vtor, sp, pc = resolve_vector_entry(fw_path, profile, args.sp, args.pc)
        run_for = str(args.run_for or profile.get("defaults", {}).get("run_for_seconds", 10))
        cfg = build_runtime_config(args, profile, work_dir, server_host, server_port)

        cfg_path = work_dir / "runtime_config.json"
        cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

        _, resc_path = render_repl_and_resc(profile, fw_path, work_dir, vtor, sp, pc, run_for)

        env = os.environ.copy()
        env["LEO_HW_SIM_CONFIG"] = str(cfg_path)

        renode_log_path = work_dir / "renode.log"
        proc = subprocess.run(
            [str(renode_bin), "--plain", str(resc_path)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            env=env,
            timeout=args.timeout,
        )
        renode_log_path.write_text((proc.stdout or "") + "\n" + (proc.stderr or ""), encoding="utf-8")
    finally:
        if mock_server is not None:
            mock_server.stop()

    rtt_log_path = work_dir / "rtt_full.log"
    summary = summarize_logs(renode_log_path, rtt_log_path)
    result = {
        "exit_code": proc.returncode,
        "renode_bin": str(renode_bin),
        "config_path": str(get_config_path()),
        "output_source": output_source,
        "work_dir": str(work_dir),
        "artifacts": {
            "renode_log": str(renode_log_path),
            "rtt_log": str(rtt_log_path),
            "sram_dump": str(work_dir / "sram_dump.bin"),
            "runtime_config": str(cfg_path),
        },
        "entry": {"vector_table": vtor, "sp": sp, "pc": pc},
        "summary": summary,
    }
    if mock_server is not None:
        result["mock_packets_hex"] = mock_server.packets_received

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if proc.returncode == 0 else proc.returncode


if __name__ == "__main__":
    sys.exit(main())
