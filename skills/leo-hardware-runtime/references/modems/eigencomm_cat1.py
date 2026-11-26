import binascii
import json
import os
import socket
import time


def _parse_int(val, default_val=0):
    if val is None:
        return default_val
    if isinstance(val, int):
        return val
    return int(str(val), 0)


def _load_runtime_config():
    cfg_path = os.environ.get("LEO_HW_SIM_CONFIG", "")
    if cfg_path and os.path.exists(cfg_path):
        with open(cfg_path, "r") as f:
            return json.load(f), os.path.dirname(os.path.abspath(cfg_path))
    return {}, os.getcwd()


NON_PROD_MARKERS = ("test", "dev", "qa", "uat", "sit", "mock", "sandbox", "staging", "preview", "local")


def _is_safe_test_host(host, allow_test_ip=False):
    h = (host or "").strip().lower()
    if not h:
        return False
    if h in ("localhost", "127.0.0.1", "::1"):
        return True
    parts = h.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        nums = [int(p) for p in parts]
        if nums[0] in (10, 127) or (nums[0] == 192 and nums[1] == 168) or (nums[0] == 172 and 16 <= nums[1] <= 31):
            return True
        return bool(allow_test_ip)
    tokens = []
    for chunk in h.split("."):
        tokens.extend(chunk.split("-"))
    return any(m in tokens for m in NON_PROD_MARKERS)


def init_state():
    cfg, cfg_dir = _load_runtime_config()
    dump_range = cfg.get("sram_dump_range", ["0x20000000", "0x20000"])
    return {
        "regs": {},
        "inten": 0,
        "rx_pos": 0,
        "pending_rx": [],
        "sock": None,
        "imei": str(cfg.get("imei", "")),
        "iccid": str(cfg.get("iccid", "89860012345678901234")),
        "host": str(cfg.get("server_host", "")),
        "port": int(cfg.get("server_port", 8010)),
        "allow_test_ip": bool(cfg.get("allow_test_ip", False)),
        "mock_mode": bool(cfg.get("mock_mode", False)),
        "clock_mode": str(cfg.get("clock_mode", "local")),
        "sram_dump_path": cfg.get("sram_dump_path") or os.path.join(cfg_dir, "sram_dump.bin"),
        "sram_dump_base": _parse_int(dump_range[0], 0x20000000),
        "sram_dump_size": _parse_int(dump_range[1], 0x20000),
    }


def inject_rx(peripheral, state, resp):
    regs = state["regs"]
    rx_ptr = regs.get(0x704, 0)
    if rx_ptr >= 0x20000000:
        bus = peripheral.GetMachine().SystemBus
        for i, b in enumerate(resp):
            bus.WriteByte(rx_ptr + state["rx_pos"] + i, b if isinstance(b, int) else ord(b))
        state["rx_pos"] += len(resp)
        regs[0x70c] = state["rx_pos"]
        regs[0x124] = 1
        regs[0x174] = 1
        regs[0x14c] = 1
        peripheral.Log(LogLevel.Warning, "UART_RX (%dB) -> %s" % (len(resp), repr(resp)))


def _format_cclk(clock_mode):
    if clock_mode.startswith("fixed:"):
        return clock_mode.split(":", 1)[1]
    if clock_mode == "utc":
        return time.strftime("%y%m%d%H%M%S", time.gmtime())
    return time.strftime("%y%m%d%H%M%S", time.localtime())


def handle_at(peripheral, state, cmd_bytes):
    cmd = cmd_bytes.strip()
    if cmd == b"ATE0":
        return [b"\r\nOK\r\n"]
    elif cmd == b"ATI":
        return [b"\r\nRevision: Eigencomm\r\nOK\r\n"]
    elif cmd.startswith(b"AT+CFUN") or cmd.startswith(b"AT+ECPMUCFG"):
        return [b"\r\nOK\r\n"]
    elif cmd.startswith(b"AT+CGSN"):
        return [('\r\n+CGSN: "%s"\r\nOK\r\n' % state["imei"]).encode("ascii")]
    elif cmd.startswith(b"AT+ECICCID"):
        return [("\r\n+ECICCID: %s\r\nOK\r\n" % state["iccid"]).encode("ascii")]
    elif cmd.startswith(b"AT+CGATT"):
        return [b"\r\n+CGATT: 1\r\nOK\r\n"]
    elif cmd.startswith(b"AT+ZZNGINFO"):
        return [b"\r\n+ZZNGINFOSC: 0,1,2,3,4,85,6,7,8,9,10,11,12,13\r\nOK\r\n"]
    elif cmd.startswith(b"AT+ZZCCLK"):
        now_str = _format_cclk(state["clock_mode"])
        return [("\r\n+ZZCCLK:%s\r\nOK\r\n" % now_str).encode("ascii")]
    elif cmd.startswith(b"AT+SKTCREATE"):
        return [b"\r\n+SKTCREATE: 1\r\nOK\r\n"]
    elif cmd.startswith(b"AT+ECDNS"):
        host = state["host"] or "127.0.0.1"
        try:
            resolved = socket.gethostbyname(host)
        except Exception:
            resolved = host
        return [('\r\n+ECDNS: "%s"\r\nOK\r\n' % resolved).encode("ascii")]
    elif cmd.startswith(b"AT+SKTCONNECT"):
        if state["mock_mode"] and not state["host"]:
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE: Mock mode active (no remote host)")
            return [b"\r\nOK\r\n"]
        if not _is_safe_test_host(state["host"], state.get("allow_test_ip", False)):
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE: BLOCKED non-test host %s" % state["host"])
            return [b"\r\nERROR\r\n"]
        try:
            if state["sock"] is not None:
                state["sock"].close()
            s = socket.create_connection((state["host"], state["port"]), timeout=5.0)
            s.settimeout(2.5)
            state["sock"] = s
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE: Connected to %s:%d!" % (state["host"], state["port"]))
        except Exception as e:
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE connect error: %s" % str(e))
        return [b"\r\nOK\r\n"]
    elif cmd.startswith(b"AT+SKTSEND="):
        parts = cmd.split(b",")
        out_resps = [b"\r\nOK\r\n"]
        if len(parts) >= 3:
            hex_str = parts[2].strip()
            raw_payload = binascii.unhexlify(hex_str)
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE TX to backend (%dB): %s" % (len(raw_payload), hex_str))
            if state["sock"] is not None:
                try:
                    state["sock"].sendall(raw_payload)
                    rx_data = state["sock"].recv(2048)
                    if rx_data:
                        rx_hex = binascii.hexlify(rx_data).upper()
                        peripheral.Log(LogLevel.Warning, "TCP_BRIDGE RX from backend (%dB): %s" % (len(rx_data), rx_hex))
                        urc = '\r\n+SKTRECV: 1,%d,"%s"\r\n' % (len(rx_data), rx_hex)
                        out_resps.append(urc.encode("ascii"))
                    else:
                        peripheral.Log(LogLevel.Warning, "TCP_BRIDGE: Remote server closed connection (0 bytes received)")
                except Exception as e:
                    peripheral.Log(LogLevel.Warning, "TCP_BRIDGE recv timeout/err: %s" % str(e))
        return out_resps
    elif cmd.startswith(b"AT+SKTDELETE"):
        try:
            mem = bytes(peripheral.GetMachine().SystemBus.ReadBytes(state["sram_dump_base"], state["sram_dump_size"]))
            with open(state["sram_dump_path"], "wb") as f:
                f.write(mem)
        except Exception:
            pass
        if state["sock"] is not None:
            try:
                state["sock"].close()
            except Exception:
                pass
            state["sock"] = None
            peripheral.Log(LogLevel.Warning, "TCP_BRIDGE: Socket closed by firmware")
        return [b"\r\nOK\r\n"]
    return [b"\r\nOK\r\n"]


if request.IsInit:
    state = init_state()
elif request.IsRead:
    off = request.Offset
    regs = state["regs"]
    if off in [0x300, 0x304]:
        request.Value = state["inten"]
    else:
        request.Value = regs.get(off, 0)
elif request.IsWrite:
    off = request.Offset
    val = request.Value
    regs = state["regs"]
    regs[off] = val
    nvic = self.GetMachine()["sysbus.nvic"]
    if off == 0x304:
        state["inten"] |= val
    elif off == 0x308:
        state["inten"] &= ~val
    elif off == 0x300:
        state["inten"] = val

    if off == 0x28 and val == 1:
        state["rx_pos"] = 0
        regs[0x70c] = 0
        regs[0x14c] = 0
        regs[0x150] = 1
        if len(state["pending_rx"]) > 0 and (state["inten"] & 0x80200):
            resp = state["pending_rx"].pop(0)
            inject_rx(self, state, resp)
    if off == 0x2c and val == 1:
        regs[0x158] = 1
        regs[0x110] = 1
        state["rx_pos"] = 0
    if off == 0x50 and val == 1:
        ptr = regs.get(0x73c, 0)
        cnt = regs.get(0x740, 0)
        regs[0x744] = cnt
        regs[0x130] = 1
        regs[0x120] = 1
        if ptr >= 0x20000000 and cnt > 0:
            data = bytes(self.GetMachine().SystemBus.ReadBytes(ptr, cnt))
            self.Log(LogLevel.Warning, "UART_TX (%dB): %s" % (cnt, repr(data)))
            resps = handle_at(self, state, data)
            state["pending_rx"].extend(resps)

    if off == 0x308 and (val & 0x1000) and len(state["pending_rx"]) > 0:
        resp = state["pending_rx"].pop(0)
        inject_rx(self, state, resp)

    fire = False
    inten = state["inten"]
    for bit in range(32):
        if (inten & (1 << bit)) and regs.get(0x100 + bit * 4, 0) == 1:
            fire = True
            break
    nvic.OnGPIO(198, fire)
