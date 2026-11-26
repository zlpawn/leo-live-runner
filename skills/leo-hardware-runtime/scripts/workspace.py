#!/usr/bin/env python3
"""Cross-platform workspace and configuration manager for leo-hardware-runtime.

Manages persistent user configuration at:
  ~/.shrimp/skills/leo-hardware-runtime/config.json

Provides 3-tier cascade resolution for output_dir and per-device runtime params:
1. User explicitly specified CLI argument (persisted to config.json unless persist=False)
2. Saved settings in ~/.shrimp/skills/leo-hardware-runtime/config.json
3. Default fallback (e.g. ~/.shrimp/skills/leo-hardware-runtime/output)
"""

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path


class ConfigError(Exception):
    """Raised when config.json exists but is corrupt or unreadable."""


def get_skill_home():
    """Return ~/.shrimp/skills/leo-hardware-runtime (overridable via env)."""
    env_home = os.environ.get("LEO_HARDWARE_RUNTIME_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return Path.home() / ".shrimp" / "skills" / "leo-hardware-runtime"


def get_config_path():
    """Return config.json path (overridable via LEO_HARDWARE_CONFIG_PATH)."""
    env_cfg = os.environ.get("LEO_HARDWARE_CONFIG_PATH")
    if env_cfg:
        return Path(env_cfg).expanduser().resolve()
    return get_skill_home() / "config.json"


def get_default_output_dir():
    """Return default output directory under ~/.shrimp/skills/leo-hardware-runtime/output."""
    return get_skill_home() / "output"


def read_config():
    """Read config.json; return defaults if absent; raise ConfigError if corrupt."""
    cfg_path = get_config_path()
    defaults = {
        "output_dir": "",
        "backend_dir": "",
        "renode_bin": "",
        "default_test_host": "test.huiju.iot.cloud.ke.com",
        "default_test_port": 0,
        "devices": {},
        "updated_at": None,
    }
    if not cfg_path.exists():
        return defaults
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise ConfigError(f"{cfg_path} is corrupt or unreadable ({exc}); fix or remove it") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{cfg_path} is corrupt (expected JSON object); fix or remove it")
    merged = {**defaults, **data}
    if not isinstance(merged.get("devices"), dict):
        merged["devices"] = {}
    return merged


def write_config(config):
    """Write config.json atomically with restrictive permissions on POSIX."""
    cfg_path = get_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        **config,
        "updated_at": datetime.datetime.now().astimezone().isoformat(),
    }
    tmp_path = cfg_path.parent / f".config-{os.getpid()}.tmp"
    try:
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if os.name != "nt":
            try:
                tmp_path.chmod(0o600)
            except OSError:
                pass
        tmp_path.replace(cfg_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return payload


def update_config(partial):
    """Merge partial keys into config.json and persist."""
    current = read_config()
    current.update(partial)
    return write_config(current)


def update_device_config(device_name, updates):
    """Merge per-device settings into config.json['devices'][device_name]."""
    current = read_config()
    devices = dict(current.get("devices") or {})
    dev_entry = dict(devices.get(device_name) or {})
    for key, val in updates.items():
        if val is not None:
            dev_entry[key] = val
    devices[device_name] = dev_entry
    current["devices"] = devices
    return write_config(current)


def resolve_device_params(device_name, cli_imei="", cli_tk_key="", cli_host="", cli_port=0, default_port=8010):
    """Resolve runtime parameters with provenance (cli > config_device > config_global > device_default)."""
    cfg = read_config()
    dev_cfg = (cfg.get("devices") or {}).get(device_name, {})

    def pick(cli_val, dev_key, global_key=None, fallback=None):
        if cli_val is not None and str(cli_val).strip() and str(cli_val) != "0":
            return {"value": cli_val, "source": "cli"}
        dv = dev_cfg.get(dev_key)
        if dv is not None and str(dv).strip() and str(dv) != "0":
            return {"value": dv, "source": "config_device"}
        if global_key:
            gv = cfg.get(global_key)
            if gv is not None and str(gv).strip() and str(gv) != "0":
                return {"value": gv, "source": "config_global"}
        if fallback is not None and str(fallback).strip():
            return {"value": fallback, "source": "device_default"}
        return {"value": "", "source": "missing"}

    return {
        "imei": pick(cli_imei, "imei"),
        "tk_key": pick(cli_tk_key, "tk_key"),
        "test_host": pick(cli_host, "test_host", "default_test_host"),
        "test_port": pick(cli_port if cli_port else None, "test_port", "default_test_port", default_port),
        "last_firmware": pick("", "last_firmware"),
        "backend_dir": {"value": cfg.get("backend_dir", ""), "source": "config" if cfg.get("backend_dir") else "missing"},
        "output_dir": {
            "value": cfg.get("output_dir") or str(get_default_output_dir().resolve()),
            "source": "config" if cfg.get("output_dir") else "default",
        },
    }


def resolve_output_dir(explicit_output_dir=None, persist=True):
    """Resolve effective output root using 3-tier cascade."""
    if explicit_output_dir and str(explicit_output_dir).strip():
        resolved = Path(str(explicit_output_dir).strip()).expanduser().resolve()
        if persist:
            update_config({"output_dir": str(resolved)})
        return {"dir": resolved, "source": "user_specified", "persisted": bool(persist)}

    cfg = read_config()
    cfg_dir = cfg.get("output_dir")
    if cfg_dir and isinstance(cfg_dir, str) and cfg_dir.strip():
        return {"dir": Path(cfg_dir).expanduser().resolve(), "source": "config", "persisted": False}

    return {"dir": get_default_output_dir().resolve(), "source": "default", "persisted": False}


def allocate_run_dir(device_name, tag="", explicit_output_dir=None, persist=True):
    """Allocate a dated run directory under the resolved output root."""
    info = resolve_output_dir(explicit_output_dir=explicit_output_dir, persist=persist)
    now = datetime.datetime.now()
    safe_dev = re.sub(r"[^a-zA-Z0-9_-]+", "_", device_name or "device").strip("_") or "device"
    safe_tag = re.sub(r"[^a-zA-Z0-9_-]+", "_", tag).strip("_") if tag else ""
    leaf = f"{safe_dev}_{now.strftime('%H%M%S')}" + (f"_{safe_tag}" if safe_tag else "")
    run_dir = info["dir"] / now.strftime("%Y-%m-%d") / leaf
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir, info


def main():
    parser = argparse.ArgumentParser(description="Manage ~/.shrimp/skills/leo-hardware-runtime/config.json")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Show config.json and effective directories")
    p_status.add_argument("--device", default=None, help="Also resolve parameters for a device model")

    p_set_out = sub.add_parser("set-output", help="Persist default output_dir in config.json")
    p_set_out.add_argument("dir", help="Target output directory path")

    p_set = sub.add_parser("set", help="Set global config fields")
    p_set.add_argument("--output-dir", default=None)
    p_set.add_argument("--backend-dir", default=None)
    p_set.add_argument("--renode-bin", default=None)
    p_set.add_argument("--test-host", default=None)
    p_set.add_argument("--test-port", type=int, default=None)

    p_dev = sub.add_parser("set-device", help="Persist per-device debugging parameters in config.json")
    p_dev.add_argument("device", help="Device model name (e.g. hj07)")
    p_dev.add_argument("--imei", default=None)
    p_dev.add_argument("--tk-key", default=None)
    p_dev.add_argument("--test-host", default=None)
    p_dev.add_argument("--test-port", type=int, default=None)
    p_dev.add_argument("--firmware", default=None)

    p_clr = sub.add_parser("clear-device", help="Remove saved device entry from config.json")
    p_clr.add_argument("device")

    p_res = sub.add_parser("resolve", help="Resolve effective output_dir")
    p_res.add_argument("--output-dir", default=None)
    p_res.add_argument("--no-persist", action="store_true")

    args = parser.parse_args()
    try:
        if args.command == "status":
            cfg = read_config()
            eff = resolve_output_dir()
            out = {
                "config_path": str(get_config_path()),
                "config_exists": get_config_path().exists(),
                "effective_output_dir": str(eff["dir"]),
                "output_source": eff["source"],
                "config": cfg,
            }
            if args.device:
                out["resolved_device_params"] = resolve_device_params(args.device)
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 0

        if args.command == "set-output":
            target = Path(args.dir).expanduser().resolve()
            saved = update_config({"output_dir": str(target)})
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "set":
            updates = {}
            if args.output_dir is not None:
                updates["output_dir"] = str(Path(args.output_dir).expanduser().resolve()) if args.output_dir else ""
            if args.backend_dir is not None:
                updates["backend_dir"] = str(Path(args.backend_dir).expanduser().resolve()) if args.backend_dir else ""
            if args.renode_bin is not None:
                updates["renode_bin"] = str(Path(args.renode_bin).expanduser().resolve()) if args.renode_bin else ""
            if args.test_host is not None:
                updates["default_test_host"] = args.test_host.strip()
            if args.test_port is not None:
                updates["default_test_port"] = int(args.test_port)
            saved = update_config(updates)
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "set-device":
            updates = {}
            if args.imei is not None:
                updates["imei"] = args.imei.strip()
            if args.tk_key is not None:
                updates["tk_key"] = args.tk_key.strip()
            if args.test_host is not None:
                updates["test_host"] = args.test_host.strip()
            if args.test_port is not None:
                updates["test_port"] = int(args.test_port)
            if args.firmware is not None:
                updates["last_firmware"] = str(Path(args.firmware).expanduser().resolve()) if args.firmware else ""
            saved = update_device_config(args.device, updates)
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "clear-device":
            cfg = read_config()
            devices = dict(cfg.get("devices") or {})
            devices.pop(args.device, None)
            cfg["devices"] = devices
            saved = write_config(cfg)
            print(json.dumps({"config_path": str(get_config_path()), "config": saved}, indent=2, ensure_ascii=False))
            return 0

        if args.command == "resolve":
            eff = resolve_output_dir(args.output_dir, persist=not args.no_persist)
            print(json.dumps({
                "config_path": str(get_config_path()),
                "output_dir": str(eff["dir"]),
                "source": eff["source"],
                "persisted": eff["persisted"],
            }, indent=2, ensure_ascii=False))
            return 0
    except ConfigError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 3
    return 1


if __name__ == "__main__":
    sys.exit(main())
