"""车辆远程控制(可选功能)。

面板不直接持有 Tesla 凭证:指令转发到用户配置的「指令后端」——官方
tesla-http-proxy(自建)或兼容 Fleet API 的托管服务(Teslemetry / MyTeslaMate),
二者同为 `POST {CONTROL_API_URL}/api/1/vehicles/{vin}/command/{cmd}` + Bearer 令牌形态。

配置(.env,见 .env.example 与面板「接入文档」/guide.html):
  CONTROL_API_URL    指令后端地址,如 http://tesla-proxy:8080 或 https://api.teslemetry.com
  CONTROL_API_TOKEN  访问令牌(Fleet API 用户令牌 / 托管服务 API Key)
  CONTROL_VIN        可选,默认取数据库第一辆车的 VIN

公钥托管:自建代理时 Tesla 要求从应用域名拉取公钥,本模块在
/.well-known/appspecific/com.tesla.3p.public-key.pem 直接提供 /data/tesla-public-key.pem
(该路径在中间件白名单中,无需登录)。

独立成模块(与 backup.py / parking.py 同理),减少与 main.py 的并发修改冲突。
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel

router = APIRouter(tags=["control"])

CONTROL_API_URL = os.environ.get("CONTROL_API_URL", "").rstrip("/")
CONTROL_API_TOKEN = os.environ.get("CONTROL_API_TOKEN", "")
CONTROL_VIN = os.environ.get("CONTROL_VIN", "")
PUBLIC_KEY_FILE = os.environ.get("CONTROL_PUBLIC_KEY_FILE", "/data/tesla-public-key.pem")

# 指令节流:同一登录账号 10 分钟最多 30 条(防误触连点/前端异常打爆后端)
_cmd_log: dict[str, list[float]] = defaultdict(list)
CMD_WINDOW = 600.0
CMD_LIMIT = 30

# 指令白名单与参数校验:键=指令名,值=允许的参数范围说明(校验在 _validate_args)
_CMDS = {
    "wake_up": {},
    "door_lock": {},
    "door_unlock": {},
    "honk_horn": {},
    "flash_lights": {},
    "sentry_mode": {"on": bool},
    "set_sentry_mode": {"on": bool},
    "auto_conditioning_start": {},
    "auto_conditioning_stop": {},
    "set_temps": {"driver_temp": (15.0, 30.0)},
    "charge_start": {},
    "charge_stop": {},
    "charge_port_door_open": {},
    "charge_port_door_close": {},
    "set_charge_limit": {"percent": (50, 100)},
    "window_control": {"command": ("vent", "close")},  # lat/lon 由后端自动补车当前位置
    "actuate_trunk": {"which_trunk": ("front", "rear")},
}

# 爆闪:flash_lights 官方指令只闪一次,这里用后台线程循环调用模拟;
# 频率受「面板 → 指令后端 → Tesla 云端 → 车辆蜂窝网络」整条链路往返限制,
# 实测上限约 0.5–1 次/秒,达不到警灯级高频。最长 60 秒,可随时停止。
STROBE_MIN_INTERVAL = 0.9   # 两次闪灯的最小间隔(秒),含往返耗时
STROBE_MAX_SECONDS = 60
_strobe_lock = threading.Lock()
_strobe_stop = threading.Event()
_strobe_stop.set()
_strobe_until = 0.0

# 车辆状态:TeslaMate 只上报空调 / 充电 / 充电线;车锁、哨兵、车窗、充电口盖
# TeslaMate 不上报(Tesla 也不推送),由面板按「最近一次成功指令」乐观推测,
# 持久化到 panel_manual(kind='control_state', key='current'),重启不丢。
_STATE_KIND = "control_state"


def _optimistic() -> dict:
    try:
        return dict(_m()._manual_all(_STATE_KIND).get("current") or {})
    except Exception:  # noqa: BLE001 — 状态读取失败不影响指令主流程
        return {}


def _save_optimistic(patch: dict) -> None:
    state = {**_optimistic(), **patch, "updated_at": int(time.time())}
    _m()._exec(
        """
        INSERT INTO panel_manual (kind, key, payload) VALUES (%s, 'current', %s)
        ON CONFLICT (kind, key) DO UPDATE SET payload = EXCLUDED.payload
        """,
        (_STATE_KIND, Jsonb(state)),
    )


def _state_patch(cmd: str, args: dict) -> dict | None:
    """指令被车辆确认后,需要落盘的乐观状态补丁。"""
    if cmd == "door_lock":
        return {"locked": True}
    if cmd == "door_unlock":
        return {"locked": False}
    if cmd in ("sentry_mode", "set_sentry_mode"):
        return {"sentry": bool(args.get("on"))}
    if cmd == "window_control":
        return {"windows_open": args.get("command") == "vent"}
    if cmd == "auto_conditioning_start":
        return {"climate_on": True}
    if cmd == "auto_conditioning_stop":
        return {"climate_on": False}
    if cmd == "charge_port_door_open":
        return {"charge_port": True}
    if cmd == "charge_port_door_close":
        return {"charge_port": False}
    return None


def _live_states() -> dict:
    """车辆实际上报的状态(空调/充电/充电线),作为乐观推测的底盘,实时项以它为准。"""
    m = _m()
    out: dict = {}
    cid = m.get_car_id(None)
    rows = m.q("SELECT is_climate_on, driver_temp_setting, EXTRACT(EPOCH FROM date AT TIME ZONE 'UTC') * 1000 AS ts FROM positions "
               "WHERE car_id=%s ORDER BY date DESC LIMIT 1", (cid,))
    if rows:
        out["reported_at"] = int(rows[0]["ts"])
        fresh = time.time() * 1000 - out["reported_at"] < 15 * 60 * 1000
        out["climate_on"] = rows[0]["is_climate_on"] if fresh else None
        if fresh and rows[0]["driver_temp_setting"] is not None:
            out["climate_temp"] = float(rows[0]["driver_temp_setting"])
        out["charging"] = bool(m.q("SELECT 1 FROM charging_processes "
                                    "WHERE car_id=%s AND end_date IS NULL LIMIT 1", (cid,))) if fresh else None
    # A historical charge sample cannot establish the current cable connection.
    out["cable"] = None
    return out


_snapshot_lock = threading.Lock()
_snapshot = {}
_snapshot_vin = ""
_snapshot_checked = 0.0
_snapshot_error = ""
CURRENT_FIELDS = ("locked", "sentry", "windows_open", "charge_port", "frunk_open", "trunk_open", "climate_on", "climate_temp", "inside_temp", "charging", "cable", "charge_limit", "camp_mode")


def _fresh(section):
    stamp = section.get("timestamp")
    return isinstance(stamp, (int, float)) and -30 <= time.time() - stamp / 1000 <= 120


def normalize_vehicle(payload):
    """Keep only display fields. Never persist VIN, coordinates, tokens or raw responses."""
    result = {k: None for k in CURRENT_FIELDS}
    stamps = []
    vs, cs, ch = (payload.get(k) or {} for k in ("vehicle_state", "climate_state", "charge_state"))
    boolean = lambda x: x if type(x) is bool else None
    opened = lambda x: x != 0 if type(x) in (int, float) else None
    if _fresh(vs):
        stamps.append(vs["timestamp"])
        result.update(locked=boolean(vs.get("locked")), sentry=boolean(vs.get("sentry_mode")),
                      frunk_open=opened(vs.get("ft")), trunk_open=opened(vs.get("rt")))
        windows = [vs.get(k) for k in ("fd_window", "fp_window", "rd_window", "rp_window")]
        if all(type(v) in (int, float) for v in windows):
            result["windows_open"] = any(v != 0 for v in windows)
    if _fresh(cs):
        stamps.append(cs["timestamp"])
        mode = cs.get("climate_keeper_mode")
        result.update(climate_on=boolean(cs.get("is_climate_on")), climate_temp=cs.get("driver_temp_setting"), inside_temp=cs.get("inside_temp"))
        result["camp_mode"] = (mode == 3 or str(mode).lower() == "camp") if mode in (0, 1, 2, 3, "off", "on", "dog", "camp", "Off", "On", "Dog", "Camp") else None
    if _fresh(ch):
        stamps.append(ch["timestamp"])
        state = ch.get("charging_state")
        result.update(charge_port=boolean(ch.get("charge_port_door_open")), charge_limit=ch.get("charge_limit_soc"))
        if state in ("Charging", "Complete", "Stopped", "Starting", "Disconnected", "NoPower"):
            result["charging"] = state == "Charging"
            result["cable"] = state != "Disconnected"
    result["reported_at"] = min(stamps) if stamps else None
    result["source"] = "fleet" if stamps else "unknown"
    return result


def vehicle_data(vin):
    from . import fleet
    if fleet.configured():
        return fleet.vehicle_data(vin)
    if not (CONTROL_API_URL and CONTROL_API_TOKEN):
        raise HTTPException(409, "请先在个人中心完成控制配置")
    url = CONTROL_API_URL + "/api/1/vehicles/" + urllib.parse.quote(vin, safe="") + "/vehicle_data?endpoints=vehicle_state%3Bclimate_state%3Bcharge_state"
    return fleet.remote(url, token=CONTROL_API_TOKEN).get("response") or {}


def _states():
    with _snapshot_lock:
        state = dict(_snapshot)
    if state.get("reported_at") and time.time() * 1000 - state["reported_at"] <= 120000:
        return state
    out = {k: None for k in CURRENT_FIELDS}
    try:
        live = _live_states()
        # Only recent TeslaMate climate/charge fields can supplement unknown Fleet data.
        if live.get("reported_at") and time.time() * 1000 - live["reported_at"] <= 120000:
            out.update(live)
            out["source"] = "teslamate"
    except Exception:
        pass
    out.setdefault("source", "unknown")
    return out


@router.post("/api/control/refresh")
def refresh_vehicle(request: Request):
    global _snapshot, _snapshot_checked, _snapshot_vin, _snapshot_error
    _m().require_admin(request)
    vin = _vin()
    with _snapshot_lock:
        if vin == _snapshot_vin and time.time() - _snapshot_checked < 10:
            return {"ok": not bool(_snapshot_error), "states": dict(_snapshot), "detail": _snapshot_error}
        _snapshot_checked, _snapshot_vin = time.time(), vin
        try:
            _snapshot = normalize_vehicle(vehicle_data(vin))
            _snapshot_error = "" if _snapshot.get("reported_at") else "车辆未返回新鲜状态，请确认车辆在线后重试"
        except HTTPException as e:
            _snapshot = {k: None for k in CURRENT_FIELDS}
            _snapshot_error = e.detail
        return {"ok": not bool(_snapshot_error), "states": dict(_snapshot), "detail": _snapshot_error}


class CommandIn(BaseModel):
    cmd: str
    args: dict = {}


def _m():
    """延迟引用 main(避免循环导入);请求到来时 main 必然已加载完毕。"""
    from . import main
    return main


def _vin() -> str:
    if CONTROL_VIN:
        return CONTROL_VIN
    rows = _m().q("SELECT vin FROM cars ORDER BY id LIMIT 1")
    if not rows or not rows[0]["vin"]:
        raise HTTPException(status_code=503, detail="数据库中还没有车辆,请先完成 TeslaMate 授权")
    return rows[0]["vin"]


def _validate_args(cmd: str, args: dict) -> dict:
    """按白名单校验参数类型与范围,多余的键直接丢弃(不透传未知参数)。"""
    spec = _CMDS[cmd]
    out: dict = {}
    for k, rule in spec.items():
        v = args.get(k)
        if isinstance(rule, type) and rule is bool:
            if not isinstance(v, bool):
                raise HTTPException(status_code=422, detail=f"参数 {k} 应为布尔值")
            out[k] = v
        elif isinstance(rule, tuple) and rule and isinstance(rule[0], (int, float)):
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail=f"参数 {k} 应为数值")
            lo, hi = rule
            if not (lo <= v <= hi):
                raise HTTPException(status_code=422, detail=f"参数 {k} 需在 {lo}–{hi} 之间")
            out[k] = int(v) if isinstance(lo, int) else v
        elif isinstance(rule, tuple):  # 枚举
            if v not in rule:
                raise HTTPException(status_code=422, detail=f"参数 {k} 仅支持 {'/'.join(map(str, rule))}")
            out[k] = v
    if cmd == "window_control":
        # Tesla REST 形态要求携带车辆当前位置;从 positions 取最新上报点
        rows = _m().q("SELECT latitude, longitude FROM positions ORDER BY date DESC LIMIT 1")
        if rows:
            out["lat"] = float(rows[0]["latitude"])
            out["lon"] = float(rows[0]["longitude"])
    elif cmd == "set_temps":
        out["passenger_temp"] = out["driver_temp"]  # 面板只做单温区
    return out


def _forward(cmd: str, args: dict, vin: str | None = None) -> dict:
    """向指令后端转发一条指令,返回 {ok, reason}。"""
    from . import fleet
    vin = vin or _vin()
    cmd = "set_sentry_mode" if cmd == "sentry_mode" else cmd
    if fleet.configured():
        return fleet.forward(vin, cmd, args)
    suffix = "wake_up" if cmd == "wake_up" else "command/" + cmd
    url = f"{CONTROL_API_URL}/api/1/vehicles/{urllib.parse.quote(vin, safe="")}/{suffix}"
    payload = fleet.remote(url, args, CONTROL_API_TOKEN)
    result = payload.get("response") or {}
    if cmd == "wake_up":
        return {"ok": result.get("state") == "online", "reason": "" if result.get("state") == "online" else "唤醒已请求，请稍后确认"}
    return {"ok": bool(result.get("result")), "reason": str(result.get("reason") or "")[:200]}


def _strobe_loop() -> None:
    """爆闪线程:等上一条返回再发下一条,保证最小间隔;出错不中断(车辆暂时不可达时继续尝试)。"""
    while not _strobe_stop.is_set() and time.time() < _strobe_until:
        t0 = time.time()
        try:
            _forward("flash_lights", {})
        except Exception:  # noqa: BLE001 — 爆闪期间单条失败不终止整段
            pass
        _strobe_stop.wait(max(0.25, STROBE_MIN_INTERVAL - (time.time() - t0)))


def _strobe_active() -> bool:
    return not _strobe_stop.is_set() and time.time() < _strobe_until


def _strobe_start(args: dict) -> dict:
    global _strobe_until
    try:
        seconds = int(args.get("seconds", 10))
    except (TypeError, ValueError):
        seconds = 10
    seconds = max(5, min(seconds, STROBE_MAX_SECONDS))
    with _strobe_lock:
        if _strobe_active():
            raise HTTPException(status_code=409, detail="爆闪进行中,可先停止再重新开始")
        _strobe_stop.clear()
        _strobe_until = time.time() + seconds
        threading.Thread(target=_strobe_loop, daemon=True).start()
    return {"ok": True, "reason": "", "cmd": "flash_strobe", "seconds": seconds}


def _strobe_cancel() -> dict:
    global _strobe_until
    with _strobe_lock:
        _strobe_stop.set()
        _strobe_until = 0.0
    return {"ok": True, "reason": "", "cmd": "flash_strobe_stop"}


@router.get("/api/control/status")
def control_status(request: Request):
    """控制功能是否已配置指令后端(不泄露令牌,只回域名与 VIN 后 6 位)+ 车辆状态。"""
    from . import fleet, nap
    saved = fleet.read()
    base = {"configured": False, "role": request.state.role, "ever_configured": bool(saved.get("client_id") or (CONTROL_API_URL and CONTROL_API_TOKEN)), "strobe_active": _strobe_active(), "states": _states(), "nap": nap.status()}
    from . import fleet
    if not (fleet.configured() or (CONTROL_API_URL and CONTROL_API_TOKEN)):
        return base
    backend_url = fleet.PROXY_URL if fleet.configured() else CONTROL_API_URL
    host = backend_url.split("://", 1)[-1].split("/", 1)[0]
    vin_tail = None
    try:
        vin_tail = _vin()[-6:]
    except Exception:  # noqa: BLE001 — 车辆未入库时仅影响展示
        pass
    return {**base, "configured": True, "backend": host, "vin_tail": vin_tail}


@router.post("/api/control/command")
def send_command(body: CommandIn, request: Request):
    """下发车辆指令:白名单校验 → 节流 → 转发指令后端,返回 Tesla 侧执行结果。"""
    _m().require_admin(request)
    from . import fleet
    if not (fleet.configured() or (CONTROL_API_URL and CONTROL_API_TOKEN)):
        raise HTTPException(status_code=503, detail="请先在个人中心完成车辆控制配置")
    # 爆闪为本地面板功能(循环 flash_lights),不直接转发;计 1 次节流
    if body.cmd in ("flash_strobe", "flash_strobe_stop"):
        pass
    elif body.cmd not in _CMDS:
        raise HTTPException(status_code=422, detail="不支持的指令")
    user = getattr(request.state, "user", "?")
    now = time.time()
    log = [t for t in _cmd_log[user] if now - t < CMD_WINDOW]
    _cmd_log[user] = log
    if len(log) >= CMD_LIMIT:
        raise HTTPException(status_code=429, detail="指令过于频繁,请稍后再试")
    log.append(now)

    if body.cmd == "flash_strobe":
        return _strobe_start(body.args or {})
    if body.cmd == "flash_strobe_stop":
        return _strobe_cancel()

    args = _validate_args(body.cmd, body.args or {})
    result = {"cmd": body.cmd, **_forward(body.cmd, args)}
    patch = _state_patch(body.cmd, args)
    if result.get("ok") and patch:
        try:
            _save_optimistic(patch)
            result["states"] = _states()
        except Exception:  # noqa: BLE001 — 状态落盘失败不视为指令失败
            pass
    return result


@router.get("/.well-known/appspecific/com.tesla.3p.public-key.pem")
def tesla_public_key():
    """Tesla 虚拟钥匙公钥托管(自建 tesla-http-proxy 时,Tesla 从此路径拉取公钥)。

    把公钥放到面板数据目录 /data/tesla-public-key.pem 即可,域名与 HTTPS 复用面板自身。
    """
    if not os.path.exists(PUBLIC_KEY_FILE):
        raise HTTPException(status_code=404, detail="公钥未配置:请将 public-key.pem 放到 data/tesla-public-key.pem")
    return FileResponse(PUBLIC_KEY_FILE, media_type="application/x-pem-file")
