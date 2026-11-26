from System import Action
import binascii
import json
import os
import struct


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


def _decode_payload(item):
    enc = item.get("encoding", "ascii_z")
    val = item.get("value", "")
    if enc == "hex":
        raw = binascii.unhexlify(str(val).replace(" ", ""))
        return [b if isinstance(b, int) else ord(b) for b in raw]
    if enc == "ascii_z":
        raw = str(val).encode("ascii") + b"\x00"
        return [b if isinstance(b, int) else ord(b) for b in raw]
    raw = str(val).encode("ascii")
    return [b if isinstance(b, int) else ord(b) for b in raw]


def _write_injections(bus, items, logger=None, tag=""):
    for item in items:
        addr = _parse_int(item.get("addr"))
        data = _decode_payload(item)
        for i, b in enumerate(data):
            bus.WriteByte(addr + i, b)
        if logger is not None and tag:
            logger(LogLevel.Warning, "GRTC %s: injected %dB at 0x%x" % (tag, len(data), addr))


if request.IsInit:
    cfg, cfg_dir = _load_runtime_config()
    rtt_log_path = cfg.get("rtt_log_path") or os.path.join(cfg_dir, "rtt_full.log")
    rtt_range = cfg.get("rtt_scan_range", ["0x20000000", "0x10000"])
    rtt_scan_base = _parse_int(rtt_range[0], 0x20000000)
    rtt_scan_size = _parse_int(rtt_range[1], 0x10000)

    state = {
        "cnt": 0,
        "regs": {},
        "inten0": 0,
        "target": 0xFFFFFFFFFFFFFFFF,
        "rtt_addr": None,
        "rtt_log_path": rtt_log_path,
        "rtt_scan_base": rtt_scan_base,
        "rtt_scan_size": rtt_scan_size,
        "sram_injections": cfg.get("sram_injections", []),
    }

    open(rtt_log_path, "wb").close()
    _write_injections(
        self.GetMachine().SystemBus,
        cfg.get("flash_injections", []),
        self.Log,
        "FLASH",
    )

    def drain_rtt(bus):
        if state["rtt_addr"] is None:
            mem = bytes(bus.ReadBytes(state["rtt_scan_base"], state["rtt_scan_size"]))
            idx = mem.find(b"SEGGER RTT")
            if idx != -1:
                state["rtt_addr"] = state["rtt_scan_base"] + idx
        if state["rtt_addr"] is not None:
            cb = bytes(bus.ReadBytes(state["rtt_addr"], 48))
            _, max_up, max_down, sname, pbuf, sz, wroff, rdoff, flags = struct.unpack("<16sIIIIIiii", cb)
            if 0x20000000 <= pbuf < 0x20080000 and 0 < sz <= 0x8000 and wroff != rdoff:
                if wroff > rdoff:
                    chunk = bytes(bus.ReadBytes(pbuf + rdoff, wroff - rdoff))
                else:
                    chunk = bytes(bus.ReadBytes(pbuf + rdoff, sz - rdoff)) + bytes(bus.ReadBytes(pbuf, wroff))
                with open(state["rtt_log_path"], "ab") as f:
                    f.write(chunk)
                wb = struct.pack("<i", wroff)
                for i, b in enumerate(wb):
                    bus.WriteByte(state["rtt_addr"] + 40 + i, b if isinstance(b, int) else ord(b))

    def on_tick():
        bus = self.GetMachine().SystemBus
        drain_rtt(bus)
        if state["sram_injections"]:
            _write_injections(bus, state["sram_injections"])

        state["cnt"] += 10000
        if state["target"] < 0x100000000 and state["cnt"] < state["target"]:
            state["cnt"] = state["target"] + 100
        if (state["inten0"] & 0x40) and state["cnt"] >= state["target"]:
            state["regs"][0x118] = 1
            nvic = self.GetMachine()["sysbus.nvic"]
            nvic.OnGPIO(226, True)
            nvic.OnGPIO(226, False)

    t = self.GetMachine().ObtainManagedThread(Action(on_tick), 200)
    t.Start()
elif request.IsRead:
    off = request.Offset
    regs = state["regs"]
    if off == 0x720:
        state["cnt"] += 50
        request.Value = state["cnt"] & 0xFFFFFFFF
    elif off == 0x724:
        request.Value = (state["cnt"] >> 32) & 0xFFFFFFFF
    elif off in [0x300, 0x304]:
        request.Value = state["inten0"]
    elif off == 0x30c:
        request.Value = 0x40 if (regs.get(0x118, 0) and (state["inten0"] & 0x40)) else 0
    else:
        request.Value = regs.get(off, 0)
elif request.IsWrite:
    off = request.Offset
    val = request.Value
    regs = state["regs"]
    regs[off] = val
    if off == 0x304:
        state["inten0"] |= val
    elif off == 0x308:
        state["inten0"] &= ~val
    elif off == 0x584 and val == 0:
        ccl = regs.get(0x580, 0)
        if ccl < 0x3900000:
            state["target"] = ccl
