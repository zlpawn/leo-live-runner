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

from firmware_probe import extract_clues, load_firmware_image
from renode_manager import find_inspector_skill, find_renode_binary
from workspace import (
    ConfigError,
    allocate_run_dir,
    get_config_path,
    read_config,
    resolve_device_params,
    update_config,
    update_device_config,
)

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


def list_available_devices():
    devices_dir = SKILL_DIR / "references" / "devices"
    if not devices_dir.exists():
        return []
    return sorted(p.name for p in devices_dir.iterdir() if p.is_dir() and (p / "device.json").exists())


def load_device_profile(device_name):
    profile_path = SKILL_DIR / "references" / "devices" / device_name / "device.json"
    if not profile_path.exists():
        raise FileNotFoundError(
            f"Unknown device '{device_name}'. Available: {list_available_devices()}"
        )
    return json.loads(profile_path.read_text(encoding="utf-8"))


def suggest_test_hosts_from_firmware(firmware_path):
    """Derive safe test-domain candidates (test.<domain>) from firmware strings without using bare prod domains."""
    if not firmware_path or not Path(firmware_path).exists():
        return []
    try:
        _, _, raw = load_firmware_image(firmware_path)
        clues = extract_clues(raw)
    except Exception:
        return []
    suggestions = []
    for dom in clues.get("domains_and_hosts", []):
        low = dom.lower()
        if re.match(r"^v\d+\.\d+", low):
            continue
        labels = [seg for seg in re.split(r"[.-]", low) if seg]
        if any(m in labels for m in NON_PROD_HOST_MARKERS):
            candidate = low
        else:
            candidate = f"test.{low}"
        if candidate not in suggestions:
            suggestions.append(candidate)
    return suggestions


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


def build_runtime_config(device_name, imei, tk_key, profile, work_dir, server_host, server_port, args):
    mem_map = profile.get("memory_map", {})
    flash_injections = []
    sram_injections = []

    if imei and mem_map.get("imei_flash_addr"):
        flash_injections.append({
            "addr": mem_map["imei_flash_addr"],
            "encoding": "ascii_z",
            "value": imei,
        })

    if tk_key and mem_map.get("localkey_sram_addr"):
        sram_injections.append({
            "addr": mem_map["localkey_sram_addr"],
            "encoding": "hex",
            "value": expand_tk_key_to_16b_hex(tk_key),
        })

    return {
        "device": device_name,
        "imei": imei or "",
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


def run_preflight(args, user_cfg):
    """Evaluate all prerequisites and saved parameters before running Renode."""
    missing = []
    available_devices = list_available_devices()
    profile = None
    try:
        profile = load_device_profile(args.device)
    except FileNotFoundError:
        missing.append({
            "field": "device",
            "reason": f"Device profile '{args.device}' does not exist.",
            "suggestions": [
                f"Use an available profile: {available_devices}",
                "Or probe the new firmware first with firmware_probe.py and add references/devices/<model>/.",
            ],
        })

    default_port = profile.get("protocol", {}).get("default_port", 8010) if profile else 8010
    params = resolve_device_params(
        args.device,
        cli_imei=args.imei,
        cli_tk_key=args.tk_key,
        cli_host=args.host,
        cli_port=args.port,
        default_port=default_port,
    )

    renode_bin = find_renode_binary(args.renode_bin or user_cfg.get("renode_bin") or None)
    if not renode_bin:
        missing.append({
            "field": "renode_cli",
            "reason": "Renode CLI executable was not found.",
            "suggestions": [
                "Ask user to confirm, then run: python3 scripts/renode_manager.py install --confirm",
            ],
        })

    fw_raw = args.firmware or params["last_firmware"]["value"]
    fw_source = "cli" if args.firmware else ("config_device" if params["last_firmware"]["value"] else "missing")
    fw_path = Path(fw_raw).expanduser().resolve() if fw_raw else None
    if not fw_path or not fw_path.exists():
        missing.append({
            "field": "firmware",
            "reason": "Firmware file path is missing or does not exist.",
            "suggestions": ["Ask the user to supply the .hex, .bin, or .elf firmware file path."],
        })

    suggested_hosts = suggest_test_hosts_from_firmware(fw_path) if (fw_path and fw_path.exists()) else []
    mem_map = profile.get("memory_map", {}) if profile else {}

    host_val = str(params["test_host"]["value"] or "").strip()
    port_val = int(params["test_port"]["value"] or default_port)
    imei_val = str(params["imei"]["value"] or "").strip()
    tk_key_val = str(params["tk_key"]["value"] or "").strip()

    if not args.mock:
        if not host_val:
            sugg = [f"Suggested test endpoint from firmware/config: {h}:{port_val}" for h in suggested_hosts]
            sugg.append("Or pass --mock to run with the built-in local offline mock TCP server.")
            missing.append({
                "field": "test_host",
                "reason": "No test-environment host/IP configured (--host and config.json are both empty).",
                "suggested_test_hosts": suggested_hosts,
                "suggestions": sugg,
            })
        else:
            try:
                validate_test_host(host_val, allow_test_ip=args.confirm_test_ip)
            except ValueError as exc:
                missing.append({
                    "field": "test_host",
                    "reason": str(exc),
                    "suggested_test_hosts": suggested_hosts,
                    "suggestions": ["Use a test-marked hostname (e.g. test.*) or --mock."],
                })

        if mem_map.get("imei_flash_addr") and not imei_val:
            missing.append({
                "field": "imei",
                "reason": "Device IMEI is required for test backend authentication.",
                "suggestions": [
                    "Ask the user for IMEI, or query/seed iot_plat.lock_hardware_info via leo-live-inspector.",
                ],
            })
        if mem_map.get("localkey_sram_addr") and not tk_key_val:
            missing.append({
                "field": "tk_key",
                "reason": "Device tk_key (16-char or 32-char hex) is required for AES authentication.",
                "suggestions": [
                    "Ask the user for tk_key, or query/seed iot_plat.lock_hardware_info via leo-live-inspector.",
                ],
            })
        elif tk_key_val:
            try:
                expand_tk_key_to_16b_hex(tk_key_val)
            except ValueError as exc:
                missing.append({
                    "field": "tk_key",
                    "reason": str(exc),
                    "suggestions": ["Provide a valid 16-char or 32-char hex tk_key."],
                })

    inspector_dir = find_inspector_skill()
    backend_dir = args.backend_dir or params["backend_dir"]["value"]
    resolved_summary = {
        "device": {"value": args.device, "source": "profile" if profile else "missing"},
        "firmware": {"value": str(fw_path) if fw_path else "", "source": fw_source},
        "imei": params["imei"],
        "tk_key": params["tk_key"],
        "test_host": {"value": "127.0.0.1 (mock)" if args.mock and not host_val else host_val, "source": "mock" if args.mock and not host_val else params["test_host"]["source"]},
        "test_port": {"value": port_val, "source": params["test_port"]["source"]},
        "output_dir": params["output_dir"],
        "backend_dir": {"value": backend_dir, "source": "cli" if args.backend_dir else params["backend_dir"]["source"]},
        "renode_bin": {"value": str(renode_bin) if renode_bin else "", "source": "detected" if renode_bin else "missing"},
    }

    report = {
        "status": "ready" if not missing else "incomplete",
        "config_path": str(get_config_path()),
        "available_devices": available_devices,
        "resolved": resolved_summary,
        "missing": missing,
        "inspector": {
            "installed": inspector_dir is not None,
            "skill_dir": str(inspector_dir) if inspector_dir else None,
            "backend_dir": backend_dir or None,
        },
        "suggested_test_hosts": suggested_hosts,
    }
    return report, profile, renode_bin, fw_path, imei_val, tk_key_val, host_val, port_val


def main():
    parser = argparse.ArgumentParser(description="Run parameterized Renode hardware-cloud integration")
    parser.add_argument("--device", required=True, help="Device profile name under references/devices/")
    parser.add_argument("--firmware", default="", help="Path to firmware (.hex, .bin, .elf); defaults to config.json last_firmware")
    parser.add_argument("--imei", default="", help="Device IMEI")
    parser.add_argument("--tk-key", default="", help="Device key (16-char or 32-char hex)")
    parser.add_argument("--host", default="", help="Test-environment TCP host/IP")
    parser.add_argument("--port", type=int, default=0, help="Backend TCP port")
    parser.add_argument("--backend-dir", default="", help="Backend repo root for leo-live-inspector (persisted unless --no-persist)")
    parser.add_argument("--run-for", default=None, help="Virtual emulation seconds (e.g. 10)")
    parser.add_argument("--clock-mode", default=None, help="Modem clock mode: local | utc | fixed:<yymmddhhmmss>")
    parser.add_argument("--output-dir", default=None, help="Base output root (persisted to ~/.shrimp/skills/leo-hardware-runtime/config.json unless --no-persist)")
    parser.add_argument("--no-persist", action="store_true", help="Do not persist parameters into config.json")
    parser.add_argument("--work-dir", default=None, help="Exact directory for this single run (overrides --output-dir without persisting)")
    parser.add_argument("--renode-bin", default=None, help="Explicit Renode CLI path")
    parser.add_argument("--sp", default=None, help="Override initial SP")
    parser.add_argument("--pc", default=None, help="Override initial Reset PC")
    parser.add_argument("--mock", action="store_true", help="Run against built-in local mock TCP sink if no host specified")
    parser.add_argument("--confirm-test-ip", action="store_true", help="Allow a raw public IP verified to belong to test environment")
    parser.add_argument("--preflight", action="store_true", help="Check prerequisites & resolved config without running Renode")
    parser.add_argument("--timeout", type=int, default=60, help="Wall-clock subprocess timeout seconds")
    args = parser.parse_args()

    try:
        user_cfg = read_config()
    except ConfigError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 3

    report, profile, renode_bin, fw_path, imei_val, tk_key_val, host_val, port_val = run_preflight(args, user_cfg)

    if args.preflight:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0 if report["status"] == "ready" else 2

    if report["status"] != "ready":
        print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
        return 2

    if args.work_dir:
        work_dir = Path(args.work_dir).expanduser().resolve()
        work_dir.mkdir(parents=True, exist_ok=True)
        output_source = "explicit_work_dir"
    else:
        run_tag = imei_val if imei_val else ("mock" if args.mock else "sim")
        work_dir, out_info = allocate_run_dir(
            args.device,
            tag=run_tag,
            explicit_output_dir=args.output_dir,
            persist=not args.no_persist,
        )
        output_source = out_info["source"]

    if not args.no_persist:
        if args.backend_dir:
            update_config({"backend_dir": str(Path(args.backend_dir).expanduser().resolve())})
        dev_updates = {
            "imei": imei_val or None,
            "tk_key": tk_key_val or None,
            "test_host": host_val or None,
            "test_port": port_val or None,
            "last_firmware": str(fw_path),
        }
        update_device_config(args.device, {k: v for k, v in dev_updates.items() if v is not None})

    mock_server = None
    server_host = host_val
    server_port = port_val
    if args.mock and not server_host:
        mock_server = LocalMockServer()
        mock_server.start()
        server_host = "127.0.0.1"
        server_port = mock_server.port

    try:
        vtor, sp, pc = resolve_vector_entry(fw_path, profile, args.sp, args.pc)
        run_for = str(args.run_for or profile.get("defaults", {}).get("run_for_seconds", 10))
        cfg = build_runtime_config(args.device, imei_val, tk_key_val, profile, work_dir, server_host, server_port, args)

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
        "resolved_params": report["resolved"],
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
