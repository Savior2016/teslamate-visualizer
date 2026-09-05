"""Durable, single-worker camp-mode timer. Never replay a start after restart."""
import json
import os
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter()
lock = threading.RLock()
ACTIVE = {"starting", "active", "stopping", "retrying"}


class NapTimer:
    def __init__(self, path, fetch, command, clock=time.time):
        self.path, self.fetch, self.command, self.clock = Path(path), fetch, command, clock

    def read(self):
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            raise HTTPException(503, "午休任务文件不可用，请检查服务器并在 Tesla App 确认露营模式") from None

    def write(self, job):
        from .fleet import atomic
        atomic(self.path, json.dumps(job).encode())

    def public(self):
        job = self.read()
        return {k: job[k] for k in ("phase", "ends_at", "minutes", "error", "updated_at", "attempts") if k in job}

    def active(self):
        return self.read().get("phase") in ACTIVE

    def mode(self, vin):
        from .control import _fresh
        cs = self.fetch(vin).get("climate_state") or {}
        if not _fresh(cs):
            raise HTTPException(409, "无法确认当前露营模式，请让车辆在线后重试")
        value = cs.get("climate_keeper_mode")
        modes = {0: "off", 1: "on", 2: "dog", 3: "camp"}
        value = modes.get(value, str(value).lower())
        if value not in ("off", "on", "dog", "camp"):
            raise HTTPException(409, "此车辆暂未返回露营模式状态")
        return value

    def start(self, vin, minutes):
        with lock:
            if self.active():
                raise HTTPException(409, "已有午休任务，请先结束当前午休")
            if self.mode(vin) != "off":
                raise HTTPException(409, "车辆已开启驻车空调、宠物或露营模式，请先在 Tesla App 关闭后再开始午休")
            now = self.clock()
            job = {"phase":"starting", "vin":vin, "minutes":minutes, "ends_at":now+minutes*60,
                   "updated_at":now, "attempts":0, "error":""}
            self.write(job)  # Persist shutdown obligation before any physical command.
            try:
                result = self.command("set_climate_keeper_mode", {"climate_keeper_mode":3}, vin)
            except Exception:
                job.update(phase="retrying", ends_at=self.clock(), error="开启结果未确认，服务器将检查并关闭露营模式；请同时在 Tesla App 确认")
                self.write(job)
                raise HTTPException(502, job["error"]) from None
            if not result.get("ok"):
                job.update(phase="failed", error="车辆未接受露营指令，请检查车辆在线状态、档位和电量")
                self.write(job)
                raise HTTPException(409, job["error"])
            job.update(phase="active", updated_at=self.clock())
            self.write(job)
            return self.public()

    def stop(self):
        with lock:
            job = self.read()
            if job.get("phase") in ACTIVE:
                job.update(phase="stopping", ends_at=self.clock(), next_retry=0)
                self.write(job)
                self.tick()
            return self.public()

    def tick(self):
        with lock:
            job = self.read()
            now = self.clock()
            if job.get("phase") not in ACTIVE or now < job["ends_at"] or now < job.get("next_retry", 0):
                return
            job.update(phase="stopping", updated_at=now)
            self.write(job)
            try:
                # Never disable Dog/Keep Mode that the owner selected during their break.
                mode = self.mode(job["vin"])
                if mode == "camp":
                    result = self.command("set_climate_keeper_mode", {"climate_keeper_mode":0}, job["vin"])
                    if not result.get("ok"):
                        raise RuntimeError("shutdown not acknowledged")
                job.update(phase="completed", error="", updated_at=self.clock())
            except Exception:
                attempts = job.get("attempts", 0) + 1
                job.update(phase="retrying", attempts=attempts, next_retry=now+min(300, 15*2**min(attempts, 4)),
                           error="结束尚未确认，将自动重试；请在 Tesla App 检查露营模式")
            self.write(job)


def _fetch(vin):
    from .control import vehicle_data
    return vehicle_data(vin)


def _command(cmd, args, vin):
    from .control import _forward
    return _forward(cmd, args, vin)


timer = NapTimer(os.environ.get("NAP_FILE", "/data/control-nap.json"), _fetch, _command)
_stop = threading.Event()
_thread = None


def status():
    with lock:
        return timer.public()


def ensure_idle():
    if timer.active():
        raise HTTPException(409, "午休任务尚未结束，请先结束午休再修改控制授权")


def start_worker():
    global _thread
    _stop.clear()
    def run():
        while not _stop.is_set():
            try:
                timer.tick()
            except Exception:
                pass  # Corrupt task is reported by status; never log private task data.
            _stop.wait(2)
    _thread = threading.Thread(target=run, name="nap-shutdown", daemon=True)
    _thread.start()


def stop_worker():
    _stop.set()
    if _thread:
        _thread.join(timeout=55)


class NapRequest(BaseModel):
    minutes: int = Field(ge=5, le=180, strict=True)


@router.post("/api/control/nap/start")
def start(body: NapRequest, request: Request):
    from . import main, control
    main.require_admin(request)
    return timer.start(control._vin(), body.minutes)


@router.post("/api/control/nap/stop")
def stop(request: Request):
    from . import main
    main.require_admin(request)
    return timer.stop()
