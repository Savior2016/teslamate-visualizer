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
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
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
            out[k] = bool(v)
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


def _forward(cmd: str, args: dict) -> dict:
    """向指令后端转发一条指令,返回 {ok, reason}。"""
    url = f"{CONTROL_API_URL}/api/1/vehicles/{_vin()}/command/{cmd}"
    req = urllib.request.Request(
        url,
        data=json.dumps(args).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {CONTROL_API_TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise HTTPException(status_code=502, detail=f"指令后端返回 HTTP {e.code}:{detail}")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"无法连接指令后端:{e}")
    result = (payload.get("response") or {})
    return {"ok": bool(result.get("result")), "reason": result.get("reason") or ""}


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
def control_status():
    """控制功能是否已配置指令后端(不泄露令牌,只回域名与 VIN 后 6 位)。"""
    if not (CONTROL_API_URL and CONTROL_API_TOKEN):
        return {"configured": False, "strobe_active": _strobe_active()}
    host = CONTROL_API_URL.split("://", 1)[-1].split("/", 1)[0]
    vin_tail = None
    try:
        vin_tail = _vin()[-6:]
    except Exception:  # noqa: BLE001 — 车辆未入库时仅影响展示
        pass
    return {"configured": True, "backend": host, "vin_tail": vin_tail,
            "strobe_active": _strobe_active()}


@router.post("/api/control/command")
def send_command(body: CommandIn, request: Request):
    """下发车辆指令:白名单校验 → 节流 → 转发指令后端,返回 Tesla 侧执行结果。"""
    if not (CONTROL_API_URL and CONTROL_API_TOKEN):
        raise HTTPException(status_code=503, detail="控制功能未配置,请先在 .env 设置 CONTROL_API_URL / CONTROL_API_TOKEN")
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
    return {"cmd": body.cmd, **_forward(body.cmd, args)}


@router.get("/.well-known/appspecific/com.tesla.3p.public-key.pem")
def tesla_public_key():
    """Tesla 虚拟钥匙公钥托管(自建 tesla-http-proxy 时,Tesla 从此路径拉取公钥)。

    把公钥放到面板数据目录 /data/tesla-public-key.pem 即可,域名与 HTTPS 复用面板自身。
    """
    if not os.path.exists(PUBLIC_KEY_FILE):
        raise HTTPException(status_code=404, detail="公钥未配置:请将 public-key.pem 放到 data/tesla-public-key.pem")
    return FileResponse(PUBLIC_KEY_FILE, media_type="application/x-pem-file")
