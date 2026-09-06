"""定时哨兵:按用户设置的多个每日时段自动开/关哨兵模式。

时段存 panel_manual(kind='sentry_schedule', key='slots'),随数据库备份;
调度线程每 20 秒评估一次当前时刻是否落在任一启用时段内,目标状态与
「上次已下发状态」不一致时下发 set_sentry_mode 并写入控制审计(user=定时哨兵)。
支持跨夜时段(如 22:00–07:00);时段按 SENTRY_SCHED_TZ(默认 Asia/Shanghai)解释。

方向不对称(与 nap.py「重启后不重放开启」同哲学,但哨兵是保护性操作):
服务重启且没有历史下发记录时,落在时段内会补发「开启」;不在时段内则只
记录基线不主动下发「关闭」,避免重启意外关掉用户手动开启的哨兵。
"""
import os
import re
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel

router = APIRouter(tags=["control"])

TZ = ZoneInfo(os.environ.get("SENTRY_SCHED_TZ", "Asia/Shanghai"))
MAX_SLOTS = 10
TICK_SECONDS = 20
RETRY_SECONDS = 120  # 下发失败(车辆离线/休眠唤不醒)后的重试间隔
_KIND = "sentry_schedule"
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

_lock = threading.RLock()
_stop = threading.Event()
_thread = None


def _read() -> dict:
    from . import main
    try:
        data = main._manual_all(_KIND).get("slots") or {}
    except Exception:  # noqa: BLE001 — 读取失败视为无时段,本轮不动作
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict) -> None:
    from . import main
    main._exec(
        """
        INSERT INTO panel_manual (kind, key, payload) VALUES (%s, 'slots', %s)
        ON CONFLICT (kind, key) DO UPDATE SET payload = EXCLUDED.payload
        """,
        (_KIND, Jsonb(data)),
    )


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def desired(now: datetime | None = None) -> bool:
    """当前时刻是否落在任一启用时段内(跨夜时段如 22:00–07:00 也算)。"""
    now = now or datetime.now(TZ)
    cur = now.hour * 60 + now.minute
    for s in _read().get("slots") or []:
        if not isinstance(s, dict) or not s.get("enabled", True):
            continue
        start, end = str(s.get("start", "")), str(s.get("end", ""))
        if not (_HHMM.match(start) and _HHMM.match(end)):
            continue
        a, b = _minutes(start), _minutes(end)
        if a == b:
            continue  # 起止相同视为无效时段
        if a < b and a <= cur < b or b < a and (cur >= a or cur < b):
            return True
    return False


def tick() -> None:
    """目标状态与已下发状态不一致时下发一次;结果写控制审计,失败隔 120 秒重试。"""
    from . import control, fleet
    if not (fleet.configured() or (control.CONTROL_API_URL and control.CONTROL_API_TOKEN)):
        return
    want = desired()
    with _lock:
        data = _read()
        if time.time() < data.get("retry_at", 0):
            return
        applied = data.get("applied")
        if applied is want:
            return
        if applied is None and not want:
            # 首次运行且不在时段内:只记录基线,不主动下发「关闭」
            _write({**data, "applied": False, "applied_at": int(time.time())})
            return
        _write({**data, "pending": want})  # 占位,防并发重复下发
    try:
        vin = control._vin()
        control._ensure_awake(vin)
        result = control._forward_with_wake("set_sentry_mode", {"on": want}, vin)
    except HTTPException as exc:
        result = {"ok": False, "reason": str(exc.detail)}
    except Exception:  # noqa: BLE001 — 兜底,保证下轮重试
        result = {"ok": False, "reason": "下发失败,将自动重试"}
    control._audit("定时哨兵", "set_sentry_mode", {"on": want}, result)
    with _lock:
        data = _read()
        data.pop("pending", None)
        if result.get("ok"):
            data.update(applied=want, applied_at=int(time.time()), error="", retry_at=0)
            try:
                control._save_optimistic({"sentry": want})  # 面板乐观状态同步
            except Exception:  # noqa: BLE001 — 状态落盘失败不视为任务失败
                pass
        else:
            data.update(error=result["reason"], retry_at=time.time() + RETRY_SECONDS)
        _write(data)


def status() -> dict:
    data = _read()
    return {"slots": data.get("slots") or [], "active": desired(),
            "applied": data.get("applied"), "error": data.get("error") or ""}


def start_worker() -> None:
    global _thread
    _stop.clear()

    def run():
        while not _stop.is_set():
            try:
                tick()
            except Exception:  # noqa: BLE001 — 单轮异常不终止调度线程
                pass
            _stop.wait(TICK_SECONDS)

    _thread = threading.Thread(target=run, name="sentry-schedule", daemon=True)
    _thread.start()


def stop_worker() -> None:
    _stop.set()
    if _thread:
        _thread.join(timeout=50)


class SlotIn(BaseModel):
    start: str
    end: str
    enabled: bool = True


class ScheduleIn(BaseModel):
    slots: list[SlotIn]


@router.get("/api/control/sentry-schedule")
def get_schedule(request: Request):
    """查看定时哨兵时段(登录即可看,含只读账号)。"""
    return status()


@router.post("/api/control/sentry-schedule")
def save_schedule(body: ScheduleIn, request: Request):
    """整体替换时段列表(添加/删除/启停都由前端整表提交)。"""
    from . import main
    main.require_admin(request)
    if len(body.slots) > MAX_SLOTS:
        raise HTTPException(status_code=422, detail=f"最多 {MAX_SLOTS} 个时段")
    slots = []
    seen = set()
    for i, s in enumerate(body.slots):
        if not (_HHMM.match(s.start) and _HHMM.match(s.end)):
            raise HTTPException(status_code=422, detail="时间格式应为 HH:MM")
        if s.start == s.end:
            raise HTTPException(status_code=422, detail="开始与结束时间不能相同")
        if (s.start, s.end) in seen:
            raise HTTPException(status_code=422, detail="存在重复时段")
        seen.add((s.start, s.end))
        slots.append({"id": f"s{int(time.time() * 1000) % 10**9}{i}",
                      "start": s.start, "end": s.end, "enabled": s.enabled})
    with _lock:
        _write({**_read(), "slots": slots})
    tick()  # 时段变化立即评估一次,不用等下个 20 秒
    return status()
