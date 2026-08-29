"""TeslaMate 遥测可视化面板后端.

只读访问 TeslaMate 的 PostgreSQL 数据库,提供 JSON API。
所有时间戳在库中按 UTC 存储,查询时转换为 DISPLAY_TZ(默认 Asia/Shanghai)输出。
"""

import base64
import bisect
import json
import os
import re
import secrets
import threading
import time
import urllib.request
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

DATABASE_HOST = os.environ.get("DATABASE_HOST", "database")
DATABASE_PORT = os.environ.get("DATABASE_PORT", "5432")
DATABASE_USER = os.environ.get("DATABASE_USER", "teslamate")
DATABASE_PASS = os.environ.get("DATABASE_PASS", "")
DATABASE_NAME = os.environ.get("DATABASE_NAME", "teslamate")

# 展示时区,来自受信环境变量;校验格式后直接内联进 SQL(避免与位置占位符混用)
DISPLAY_TZ = os.environ.get("DISPLAY_TZ", "Asia/Shanghai")
if not re.fullmatch(r"[A-Za-z_0-9+/.-]{1,64}", DISPLAY_TZ):
    DISPLAY_TZ = "Asia/Shanghai"

# HTTP Basic Auth(账号表为空则不启用)
# 支持多账号:VISUALIZER_USERS="user1:pass1,user2:pass2"(密码可含冒号,取首个冒号分割)
AUTH_USER = os.environ.get("VISUALIZER_USER", "")
AUTH_PASS = os.environ.get("VISUALIZER_PASS", "")
AUTH_USERS: dict[str, str] = {}
for _part in os.environ.get("VISUALIZER_USERS", "").split(","):
    _u, _sep, _p = _part.partition(":")
    if _sep and _u.strip():
        AUTH_USERS[_u.strip()] = _p
if AUTH_USER and AUTH_PASS:
    AUTH_USERS[AUTH_USER] = AUTH_PASS

# 登录失败限速:同一 IP 10 分钟内失败 10 次则锁定 5 分钟
_failures: dict[str, list[float]] = defaultdict(list)
FAIL_WINDOW = 600.0
FAIL_THRESHOLD = 10
LOCKOUT = 300.0

# 每次理想续航(km)对应的可用电量(kWh),用于估算行程能耗;
# 当充电历史足够时按实际数据自动校准。
DEFAULT_KWH_PER_IDEAL_KM = 0.145
# 每 1% 表显电量对应的墙端电量(kWh),用于停放(哨兵/驻车)耗电换算;
# 由「充电量 ÷ 表显电量增幅」自校准,含充电损耗,与电费口径一致。
DEFAULT_KWH_PER_PCT = 0.75

# 用户录入的充电费用(按充电会话 id),存 JSON 文件;挂载卷持久化
COST_FILE = os.environ.get("COST_FILE", "/data/charge_costs.json")
_cost_lock = threading.Lock()

# 「充电详情」模块的用户补充数据:
# charges  → {charge_id: {"total_kwh": 桩端计费总耗电(含损耗),手填}}
# chargers → {位置键 addr_<address_id>/geo_<geofence_id>: {"name", "location"}},
#            同一地点的充电自动带出上次填写的充电桩信息
EXTRAS_FILE = os.environ.get("EXTRAS_FILE", "/data/charge_extras.json")
_extras_lock = threading.Lock()

pool: ConnectionPool | None = None


def _load_costs() -> dict[str, float]:
    """读取用户录入的充电费用 {charge_id: 元},文件缺失/损坏时返回空。"""
    try:
        with open(COST_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return {str(k): float(v) for k, v in (data or {}).items()}
    except (OSError, ValueError, TypeError):
        return {}


def _save_cost(charge_id: int, cost: float) -> dict[str, float]:
    """原子写入单条充电费用,返回最新全量表。"""
    with _cost_lock:
        costs = _load_costs()
        costs[str(charge_id)] = round(float(cost), 2)
        tmp = COST_FILE + ".tmp"
        os.makedirs(os.path.dirname(COST_FILE) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(costs, f, ensure_ascii=False)
        os.replace(tmp, COST_FILE)
    return costs


def _load_extras() -> dict:
    """读取充电详情补充数据,文件缺失/损坏时返回空结构。"""
    try:
        with open(EXTRAS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError
        return {
            "charges": {str(k): v for k, v in (data.get("charges") or {}).items()
                        if isinstance(v, dict)},
            "chargers": {str(k): v for k, v in (data.get("chargers") or {}).items()
                         if isinstance(v, dict)},
        }
    except (OSError, ValueError, TypeError, AttributeError):
        return {"charges": {}, "chargers": {}}


def _save_extras(data: dict) -> None:
    """原子写入充电详情补充数据。"""
    with _extras_lock:
        tmp = EXTRAS_FILE + ".tmp"
        os.makedirs(os.path.dirname(EXTRAS_FILE) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, EXTRAS_FILE)


def _loc_key(address_id, geofence_id) -> str | None:
    """充电地点的稳定键:优先地址,其次地理围栏;都没有则无法跨次自动带出。"""
    if address_id is not None:
        return f"addr_{address_id}"
    if geofence_id is not None:
        return f"geo_{geofence_id}"
    return None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = ConnectionPool(
        conninfo=(
            f"host={DATABASE_HOST} port={DATABASE_PORT} dbname={DATABASE_NAME} "
            f"user={DATABASE_USER} password={DATABASE_PASS} "
            "options='-c timezone=UTC'"
        ),
        min_size=1,
        max_size=4,
        kwargs={"row_factory": dict_row},
    )
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    yield
    pool.close()


app = FastAPI(title="TeslaMate Telemetry Visualizer", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def auth_and_headers(request: Request, call_next):
    """HTTP Basic Auth + 基础安全响应头(健康检查与地图瓦片代理除外)。"""
    if AUTH_USERS and request.url.path != "/api/health" \
            and not request.url.path.startswith("/api/tiles/"):
        ip = request.client.host if request.client else "?"
        now = time.time()
        fails = [t for t in _failures[ip] if now - t < FAIL_WINDOW]
        _failures[ip] = fails
        if len(fails) >= FAIL_THRESHOLD and now - fails[-FAIL_THRESHOLD] < LOCKOUT:
            return JSONResponse({"detail": "尝试次数过多,请稍后再试"}, status_code=429)
        header = request.headers.get("Authorization", "")
        user = pw = ""
        if header.startswith("Basic "):
            try:
                user, pw = base64.b64decode(header[6:]).decode("utf-8").split(":", 1)
            except (ValueError, UnicodeDecodeError):
                pass
        expected = AUTH_USERS.get(user)
        if expected is None or not secrets.compare_digest(pw, expected):
            _failures[ip].append(now)
            return JSONResponse(
                {"detail": "需要认证"},
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="TeslaMate Visualizer"'},
            )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response

# 将 UTC 时间戳转为本地墙钟时间 / 绝对毫秒时间戳的 SQL 片段
def local_ts(col: str, alias: str | None = None) -> str:
    """返回两列:本地时间字符串与 epoch 毫秒。

    col 为列表达式(如 d.start_date),alias 为输出列名前缀(默认为列名本身)。
    """
    a = alias or col.split(".")[-1]
    return (
        f"({col} AT TIME ZONE 'UTC' AT TIME ZONE '{DISPLAY_TZ}') AS {a}_local, "
        f"(EXTRACT(EPOCH FROM ({col} AT TIME ZONE 'UTC' AT TIME ZONE '{DISPLAY_TZ}') "
        f"AT TIME ZONE '{DISPLAY_TZ}') * 1000)::bigint AS {a}_ts"
    )


def q(sql: str, params: tuple = ()):
    """执行只读查询(参数按占位符顺序传入)。"""
    assert pool is not None
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def get_car_id(car_id: int | None) -> int:
    cars = q("SELECT id FROM cars ORDER BY id")
    if not cars:
        raise HTTPException(status_code=503, detail="数据库中没有任何车辆")
    if car_id is None:
        return cars[0]["id"]
    if not any(c["id"] == car_id for c in cars):
        raise HTTPException(status_code=404, detail=f"car_id={car_id} 不存在")
    return car_id


def kwh_per_ideal_km(car_id: int) -> float:
    """根据充电历史校准每理想续航公里的可用电量,失败时用默认值。"""
    row = q(
        """
        SELECT sum(charge_energy_added) AS energy,
               sum(end_ideal_range_km - start_ideal_range_km) AS delta
        FROM charging_processes
        WHERE car_id = %s AND charge_energy_added IS NOT NULL
          AND start_ideal_range_km IS NOT NULL
          AND end_ideal_range_km > start_ideal_range_km
        """,
        (car_id,),
    )[0]
    if row["energy"] and row["delta"] and float(row["delta"]) > 0:
        return float(row["energy"]) / float(row["delta"])
    return DEFAULT_KWH_PER_IDEAL_KM


def kwh_per_pct(car_id: int) -> float:
    """根据充电历史校准每 1% 表显电量对应的墙端电量(kWh)。"""
    row = q(
        """
        SELECT sum(charge_energy_added) AS energy,
               sum(end_battery_level - start_battery_level) AS delta
        FROM charging_processes
        WHERE car_id = %s AND charge_energy_added IS NOT NULL
          AND end_battery_level > start_battery_level
        """,
        (car_id,),
    )[0]
    if row["energy"] and row["delta"] and float(row["delta"]) > 0:
        return float(row["energy"]) / float(row["delta"])
    return DEFAULT_KWH_PER_PCT


def charge_rate_timeline(car_id: int) -> list[dict]:
    """全部充电会话按开始时间升序,带有效单价(用户录入优先,其次 TeslaMate 库内 cost)。"""
    costs = _load_costs()
    rows = q(
        f"""
        SELECT cp.id, {local_ts('cp.start_date', 'start_date')},
               cp.charge_energy_added, cp.cost
        FROM charging_processes cp
        WHERE cp.car_id = %s
        ORDER BY cp.start_date
        """,
        (car_id,),
    )
    out = []
    for r in rows:
        energy = float(r["charge_energy_added"]) if r["charge_energy_added"] else None
        entered = costs.get(str(r["id"]))
        cost = entered if entered is not None else (
            float(r["cost"]) if r["cost"] is not None else None)
        rate = cost / energy if (cost is not None and energy and energy > 0) else None
        out.append({
            "id": r["id"], "start_ts": int(r["start_date_ts"]),
            "energy_kwh": round(energy, 2) if energy is not None else None,
            "cost": round(cost, 2) if cost is not None else None,
            "cost_entered": entered is not None,
            "rate_yuan_kwh": round(rate, 4) if rate is not None else None,
        })
    return out


@app.get("/api/health")
def health():
    try:
        q("SELECT 1")
        return {"status": "ok", "database": "connected", "tz": DISPLAY_TZ}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "database": str(exc), "tz": DISPLAY_TZ}


# 地图瓦片同源代理:手机端只需连通本站即可出图(直连 CDN 在国内移动网络下不稳,
# 会一直「连接中」);由本站中转并做磁盘缓存。
# 上游用 OSM 官方瓦片(CARTO 无 key 的 basemaps 已全面加水印「API KEY REQUIRED」),
# 深色主题在前端用 CSS 滤镜反色实现。
TILE_CACHE_DIR = os.environ.get("TILE_CACHE_DIR", "/data/tiles")
TILE_UPSTREAM = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
TILE_HEADERS = {
    "User-Agent": "TeslaMateVisualizer/1.0 (self-hosted personal dashboard, single user)",
    "Accept": "image/png,image/*;q=0.8",
}
_tile_lock = threading.Lock()


@app.get("/api/tiles/{style}/{z}/{x}/{y}")
def map_tile(style: str, z: int, x: int, y: str):
    m = re.fullmatch(r"(\d{1,7})(@2x)?\.png", y)
    if m is None or style not in ("dark", "light") or not (0 <= z <= 19) or not (0 <= x < 2 ** 21):
        raise HTTPException(status_code=404, detail="瓦片不存在")
    yy = m.group(1)
    if not (0 <= int(yy) < 2 ** 21):
        raise HTTPException(status_code=404, detail="瓦片不存在")
    cache_path = os.path.join(TILE_CACHE_DIR, str(z), str(x), f"{yy}.png")
    if os.path.isfile(cache_path):
        return FileResponse(cache_path, headers={"Cache-Control": "public, max-age=2592000"})
    sub = "abc"[(x + int(yy)) % 3]
    url = TILE_UPSTREAM.format(s=sub, z=z, x=x, y=yy)
    try:
        req = urllib.request.Request(url, headers=TILE_HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"上游瓦片获取失败: {exc}") from exc
    if not data.startswith(b"\x89PNG"):
        raise HTTPException(status_code=502, detail="上游返回的不是 PNG")
    with _tile_lock:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cache_path)
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=2592000"},
    )


@app.get("/api/system")
def system_stats():
    """服务器资源:内存读 /proc/meminfo(容器内可见宿主机内存),
    硬盘取根分区(overlay 即宿主机磁盘)。"""
    mem: dict[str, int] = {}
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                key, _, val = line.partition(":")
                mem[key] = int(val.strip().split()[0])  # kB
    except (OSError, ValueError, IndexError):
        mem = {}
    mem_total = mem.get("MemTotal")
    mem_avail = mem.get("MemAvailable", mem.get("MemFree", 0))
    mem_used = mem_total - mem_avail if mem_total else None

    st = os.statvfs("/")
    disk_total = st.f_blocks * st.f_frsize
    disk_used = disk_total - st.f_bavail * st.f_frsize

    return {
        "mem_total_mb": round(mem_total / 1024) if mem_total else None,
        "mem_used_mb": round(mem_used / 1024) if mem_used is not None else None,
        "mem_pct": round(mem_used / mem_total * 100, 1) if mem_total else None,
        "disk_total_gb": round(disk_total / 1e9, 1),
        "disk_used_gb": round(disk_used / 1e9, 1),
        "disk_pct": round(disk_used / disk_total * 100, 1) if disk_total else None,
    }


@app.get("/api/overview")
def overview(car_id: int | None = Query(default=None)):
    cid = get_car_id(car_id)
    cars = q("SELECT id, name, model, trim_badging, efficiency FROM cars ORDER BY id")

    pos = q(
        f"""
        SELECT {local_ts('date')}, battery_level, usable_battery_level,
               rated_battery_range_km, ideal_battery_range_km, est_battery_range_km,
               odometer, outside_temp, inside_temp, latitude, longitude,
               speed, power, elevation
        FROM positions
        WHERE car_id = %s
        ORDER BY date DESC LIMIT 1
        """,
        (cid,),
    )
    latest = pos[0] if pos else None

    state_row = q(
        "SELECT state FROM states WHERE car_id = %s ORDER BY start_date DESC LIMIT 1",
        (cid,),
    )
    driving = q(
        "SELECT EXISTS(SELECT 1 FROM drives WHERE car_id = %s AND end_date IS NULL) AS x",
        (cid,),
    )[0]["x"]
    charging = q(
        "SELECT EXISTS(SELECT 1 FROM charging_processes "
        "WHERE car_id = %s AND end_date IS NULL) AS x",
        (cid,),
    )[0]["x"]
    if driving:
        state = "driving"
    elif charging:
        state = "charging"
    else:
        state = state_row[0]["state"] if state_row else "unknown"

    ver = q(
        "SELECT version FROM updates WHERE car_id = %s "
        "ORDER BY start_date DESC LIMIT 1",
        (cid,),
    )
    version = ver[0]["version"] if ver else None

    ratio = kwh_per_ideal_km(cid)
    # 本月/本年边界按展示时区计算,再换算为 UTC 与库中时间戳比较
    local_now = datetime.now(ZoneInfo(DISPLAY_TZ))
    month_start_utc = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0) \
        .astimezone(timezone.utc).replace(tzinfo=None)
    year_start_utc = local_now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0) \
        .astimezone(timezone.utc).replace(tzinfo=None)
    totals = q(
        """
        SELECT
          count(*) AS drives_total,
          coalesce(sum(distance) FILTER (WHERE start_date >= %s), 0) AS month_km,
          coalesce(sum(distance) FILTER (WHERE start_date >= %s), 0) AS year_km,
          coalesce(sum(start_ideal_range_km - end_ideal_range_km)
            FILTER (WHERE start_date >= %s
                     AND start_ideal_range_km IS NOT NULL
                     AND end_ideal_range_km IS NOT NULL), 0) AS month_ideal_delta_km
        FROM drives WHERE car_id = %s
        """,
        (month_start_utc, year_start_utc, month_start_utc, cid),
    )[0]

    chg = q(
        """
        SELECT count(*) AS sessions,
               coalesce(sum(charge_energy_added), 0) AS energy_kwh,
               coalesce(sum(cost), 0) AS cost,
               coalesce(sum(duration_min), 0) AS duration_min
        FROM charging_processes WHERE car_id = %s
        """,
        (cid,),
    )[0]

    return {
        "cars": [
            {
                "id": c["id"],
                "name": c["name"],
                "model": c["model"],
                "trim_badging": c["trim_badging"],
                "efficiency": float(c["efficiency"]) if c["efficiency"] else None,
            }
            for c in cars
        ],
        "car_id": cid,
        "state": state,
        "software_version": version,
        "latest": latest,
        "kwh_per_ideal_km": ratio,
        "totals": {
            "drives_total": int(totals["drives_total"]),
            "month_km": float(totals["month_km"] or 0),
            "year_km": float(totals["year_km"] or 0),
            "month_energy_kwh": float(totals["month_ideal_delta_km"] or 0) * ratio,
        },
        "charging": {
            "sessions": int(chg["sessions"]),
            "energy_kwh": float(chg["energy_kwh"]),
            "cost": float(chg["cost"] or 0),
            "duration_min": int(chg["duration_min"] or 0),
        },
    }


@app.get("/api/trend")
def trend(car_id: int | None = Query(default=None),
          days: int = Query(default=7, ge=1, le=90)):
    cid = get_car_id(car_id)
    # 电量数据密集(每分钟多条),按时间取模降采样
    step = 120 if days <= 1 else 300 if days <= 3 else 600 if days <= 7 else 1800
    battery = q(
        f"""
        SELECT {local_ts('date')}, battery_level
        FROM positions
        WHERE car_id = %s AND date >= now() - make_interval(days => %s)
          AND battery_level IS NOT NULL
          AND mod(extract(epoch FROM date)::bigint, %s) = 0
        ORDER BY date
        """,
        (cid, days, step),
    )
    # 续航数据稀疏(仅清醒时段上报),不降采样,全部返回
    range_rows = q(
        f"""
        SELECT {local_ts('date')}, rated_battery_range_km, ideal_battery_range_km
        FROM positions
        WHERE car_id = %s AND date >= now() - make_interval(days => %s)
          AND rated_battery_range_km IS NOT NULL
        ORDER BY date
        """,
        (cid, days),
    )
    # 数据量过大时按间隔抽稀,保证前端渲染流畅
    if len(range_rows) > 3000:
        keep = max(1, len(range_rows) // 3000)
        range_rows = range_rows[::keep]
    return {"days": days, "step_seconds": step, "battery": battery, "range": range_rows}


@app.get("/api/drives/daily")
def drives_daily(car_id: int | None = Query(default=None),
                 days: int = Query(default=30, ge=1, le=90)):
    cid = get_car_id(car_id)
    rows = q(
        f"""
        SELECT (date_trunc('day', start_date AT TIME ZONE 'UTC'
                           AT TIME ZONE '{DISPLAY_TZ}'))::date AS day,
               count(*) AS drives,
               coalesce(sum(distance), 0) AS distance_km,
               coalesce(sum(start_ideal_range_km - end_ideal_range_km)
                 FILTER (WHERE start_ideal_range_km IS NOT NULL
                          AND end_ideal_range_km IS NOT NULL), 0) AS ideal_delta_km
        FROM drives
        WHERE car_id = %s AND start_date >= now() - make_interval(days => %s)
        GROUP BY 1 ORDER BY 1
        """,
        (cid, days),
    )
    return {"days": days, "days_rows": rows}


@app.get("/api/drives/recent")
def drives_recent(car_id: int | None = Query(default=None),
                  limit: int = Query(default=10, ge=1, le=50)):
    cid = get_car_id(car_id)
    ratio = kwh_per_ideal_km(cid)
    rows = q(
        f"""
        SELECT d.id, {local_ts('d.start_date', 'start_date')},
               {local_ts('d.end_date', 'end_date')},
               d.distance, d.duration_min, d.speed_max, d.outside_temp_avg,
               d.start_ideal_range_km, d.end_ideal_range_km,
               a1.name AS start_name, a1.city AS start_city,
               a2.name AS end_name, a2.city AS end_city
        FROM drives d
        LEFT JOIN addresses a1 ON a1.id = d.start_address_id
        LEFT JOIN addresses a2 ON a2.id = d.end_address_id
        WHERE d.car_id = %s
        ORDER BY d.start_date DESC
        LIMIT %s
        """,
        (cid, limit),
    )
    for r in rows:
        r["ideal_delta_km"] = (
            float(r["start_ideal_range_km"] - r["end_ideal_range_km"])
            if r["start_ideal_range_km"] is not None
            and r["end_ideal_range_km"] is not None
            else None
        )
        r["energy_kwh"] = (
            r["ideal_delta_km"] * ratio if r["ideal_delta_km"] is not None else None
        )
        r["efficiency_wh_km"] = (
            r["energy_kwh"] * 1000 / r["distance"]
            if r["energy_kwh"] is not None and r["distance"]
            else None
        )
    return {"kwh_per_ideal_km": ratio, "drives": rows}


@app.get("/api/charging/summary")
def charging_summary(car_id: int | None = Query(default=None),
                     limit: int = Query(default=10, ge=1, le=50)):
    cid = get_car_id(car_id)
    totals = q(
        """
        SELECT count(*) AS sessions,
               coalesce(sum(charge_energy_added), 0) AS energy_kwh,
               coalesce(sum(charge_energy_used), 0) AS energy_used_kwh,
               coalesce(sum(cost), 0) AS cost,
               coalesce(sum(duration_min), 0) AS duration_min
        FROM charging_processes WHERE car_id = %s
        """,
        (cid,),
    )[0]
    rows = q(
        f"""
        SELECT cp.id, {local_ts('cp.start_date', 'start_date')},
               {local_ts('cp.end_date', 'end_date')},
               cp.charge_energy_added, cp.cost, cp.duration_min,
               cp.start_battery_level, cp.end_battery_level,
               cp.start_ideal_range_km, cp.end_ideal_range_km,
               cp.outside_temp_avg,
               a.name AS address_name, a.city AS address_city
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        WHERE cp.car_id = %s
        ORDER BY cp.start_date DESC
        LIMIT %s
        """,
        (cid, limit),
    )
    return {"totals": totals, "sessions": rows}


class ChargeCostIn(BaseModel):
    charge_id: int
    cost: float


@app.get("/api/charging/costs")
def charging_costs(car_id: int | None = Query(default=None),
                   days: int = Query(default=90, ge=1, le=730)):
    """充电费用表:会话明细 + 用户录入费用 + 充电后至下次充电的行驶金额统计。"""
    cid = get_car_id(car_id)
    timeline = charge_rate_timeline(cid)  # 全部会话,升序
    since_ms = _utc_ms(datetime.now(timezone.utc) - timedelta(days=days))
    window = [c for c in timeline if c["start_ts"] >= since_ms]
    if not window:
        return {"kwh_per_pct": round(kwh_per_pct(cid), 3), "charges": []}

    # 会话明细(起止电量/时长/地点)
    details = q(
        f"""
        SELECT cp.id, {local_ts('cp.start_date', 'start_date')},
               {local_ts('cp.end_date', 'end_date')},
               cp.duration_min, cp.start_battery_level, cp.end_battery_level,
               a.name AS address_name
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        WHERE cp.car_id = %s
        ORDER BY cp.start_date DESC
        LIMIT 300
        """,
        (cid,),
    )
    det_by_id = {d["id"]: d for d in details}

    # 全部行程(用于「充电后」统计),升序
    ratio = kwh_per_ideal_km(cid)
    drives = q(
        f"""
        SELECT d.id, {local_ts('d.start_date', 'start_date')},
               d.distance, d.start_ideal_range_km, d.end_ideal_range_km
        FROM drives d
        WHERE d.car_id = %s
        ORDER BY d.start_date
        """,
        (cid,),
    )
    drive_ts = [int(d["start_date_ts"]) for d in drives]
    drive_energy = []
    for d in drives:
        if d["start_ideal_range_km"] is None or d["end_ideal_range_km"] is None:
            drive_energy.append(None)
        else:
            dk = float(d["start_ideal_range_km"] - d["end_ideal_range_km"])
            drive_energy.append(dk * ratio if dk > 0 else None)

    idx_by_id = {c["id"]: i for i, c in enumerate(timeline)}
    out = []
    for c in reversed(window):  # 展示用,新的在前
        row = dict(c)
        d = det_by_id.get(c["id"]) or {}
        row.update({
            "start_date_local": d.get("start_date_local"),
            "end_date_local": d.get("end_date_local"),
            "duration_min": d.get("duration_min"),
            "start_battery_level": d.get("start_battery_level"),
            "end_battery_level": d.get("end_battery_level"),
            "address_name": d.get("address_name"),
        })
        # 充电后至下次充电前:行驶公里与耗电金额
        ti = idx_by_id.get(c["id"], -1)
        nxt = timeline[ti + 1] if 0 <= ti < len(timeline) - 1 else None
        seg_end = nxt["start_ts"] if nxt else int(time.time() * 1000)
        i0 = bisect.bisect_left(drive_ts, c["start_ts"])
        i1 = bisect.bisect_right(drive_ts, seg_end)
        km = cost = 0.0
        for i in range(i0, i1):
            km += float(drives[i]["distance"] or 0)
            e = drive_energy[i]
            if e is not None and row["rate_yuan_kwh"] is not None:
                cost += e * row["rate_yuan_kwh"]
        row["after_km"] = round(km, 1)
        row["after_cost_yuan"] = round(cost, 2) if row["rate_yuan_kwh"] is not None else None
        row["after_per_km_yuan"] = (round(cost / km, 4) if km > 0
                                 and row["rate_yuan_kwh"] is not None else None)
        out.append(row)
    return {"kwh_per_pct": round(kwh_per_pct(cid), 3), "charges": out}


@app.post("/api/charging/costs")
def set_charging_cost(payload: ChargeCostIn):
    """录入某次充电的费用(元)。"""
    row = q("SELECT id FROM charging_processes WHERE id = %s", (payload.charge_id,))
    if not row:
        raise HTTPException(status_code=404, detail="充电会话不存在")
    if payload.cost < 0:
        raise HTTPException(status_code=422, detail="费用不能为负")
    _save_cost(payload.charge_id, payload.cost)
    return {"ok": True, "charge_id": payload.charge_id, "cost": round(payload.cost, 2)}


class ChargeExtraIn(BaseModel):
    charge_id: int
    total_kwh: float | None = None  # 桩端计费总耗电(含损耗);null = 清除手填值


class ChargerIn(BaseModel):
    charge_id: int
    name: str = ""
    location: str = ""
    brand: str | None = None  # None = 不改动已存品牌;空串 = 清除


@app.get("/api/charging/sessions")
def charging_sessions(car_id: int | None = Query(default=None),
                      days: int = Query(default=30, ge=1, le=730)):
    """充电详情卡片:每次充电一张卡,含手填的总耗电 / 充电桩名称 / 费用与派生指标。

    电费单价 = 费用 ÷ 总耗电(手填优先,其次车端 charge_energy_used,
    都没有则退回充电量);充电后每公里费用 = 费用 ÷ 充电后至下次充电的行驶里程。
    """
    cid = get_car_id(car_id)
    since_ms = _utc_ms(datetime.now(timezone.utc) - timedelta(days=days))
    rows = q(
        f"""
        SELECT cp.id, {local_ts('cp.start_date', 'start_date')},
               {local_ts('cp.end_date', 'end_date')},
               cp.duration_min, cp.charge_energy_added, cp.charge_energy_used,
               cp.start_battery_level, cp.end_battery_level,
               cp.address_id, cp.geofence_id, a.name AS address_name
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        WHERE cp.car_id = %s
        ORDER BY cp.start_date
        LIMIT 500
        """,
        (cid,),
    )
    costs = _load_costs()
    extras = _load_extras()

    # 充电后行驶里程:本次充电结束 → 下次充电开始之间的行程距离合计
    drives = q(
        f"""
        SELECT {local_ts('d.start_date', 'start_date')}, d.distance
        FROM drives d
        WHERE d.car_id = %s
        ORDER BY d.start_date
        """,
        (cid,),
    )
    drive_ts = [int(d["start_date_ts"]) for d in drives]

    out = []
    for i, r in enumerate(rows):
        start_ts = int(r["start_date_ts"])
        if start_ts < since_ms:
            continue
        end_ts = int(r["end_date_ts"]) if r["end_date_ts"] is not None else None
        nxt_start = int(rows[i + 1]["start_date_ts"]) if i + 1 < len(rows) else None
        seg_end = nxt_start if nxt_start else int(time.time() * 1000)
        i0 = bisect.bisect_right(drive_ts, end_ts if end_ts is not None else start_ts)
        i1 = bisect.bisect_right(drive_ts, seg_end)
        after_km = round(sum(float(drives[j]["distance"] or 0)
                             for j in range(i0, i1)), 1)

        key = _loc_key(r["address_id"], r["geofence_id"])
        saved_charger = extras["chargers"].get(key) if key else None
        extra = extras["charges"].get(str(r["id"])) or {}
        manual_total = extra.get("total_kwh")
        used = float(r["charge_energy_used"]) if r["charge_energy_used"] else None
        energy = float(r["charge_energy_added"]) if r["charge_energy_added"] else None
        total_kwh = round(float(manual_total), 2) if manual_total is not None else used
        cost = costs.get(str(r["id"]))
        # 单价口径:优先总耗电(桩端计费电量),缺失时退回充电量
        denom = total_kwh if total_kwh and total_kwh > 0 else energy
        rate = round(cost / denom, 4) if cost is not None and denom else None
        per_km = (round(cost / after_km, 4)
                  if cost is not None and after_km > 0 else None)
        out.append({
            "id": r["id"],
            "start_ts": start_ts,
            "end_ts": end_ts,
            "start_local": r["start_date_local"],
            "end_local": r["end_date_local"],
            "duration_min": r["duration_min"],
            "energy_kwh": round(energy, 2) if energy is not None else None,
            "energy_used_kwh": round(used, 2) if used is not None else None,
            "total_kwh": total_kwh,
            "total_kwh_manual": manual_total is not None,
            "start_battery_level": r["start_battery_level"],
            "end_battery_level": r["end_battery_level"],
            "loc_key": key,
            "charger_name": (saved_charger or {}).get("name", ""),
            "charger_location": (saved_charger or {}).get("location",
                                                          r["address_name"] or ""),
            "charger_brand": (saved_charger or {}).get("brand", ""),
            "cost": round(cost, 2) if cost is not None else None,
            "rate_yuan_kwh": rate,
            "after_km": after_km,
            "per_km_yuan": per_km,
        })
    out.reverse()  # 新的在前
    return {"charges": out}


@app.post("/api/charging/extras")
def set_charging_extra(payload: ChargeExtraIn):
    """录入/清除某次充电的桩端计费总耗电(kWh,含充电损耗)。"""
    row = q("SELECT id FROM charging_processes WHERE id = %s", (payload.charge_id,))
    if not row:
        raise HTTPException(status_code=404, detail="充电会话不存在")
    if payload.total_kwh is not None and not (0 <= payload.total_kwh <= 500):
        raise HTTPException(status_code=422, detail="总耗电需在 0–500 kWh 之间")
    extras = _load_extras()
    key = str(payload.charge_id)
    if payload.total_kwh is None:
        extras["charges"].pop(key, None)
    else:
        extras["charges"][key] = {"total_kwh": round(float(payload.total_kwh), 2)}
    _save_extras(extras)
    return {"ok": True, "charge_id": payload.charge_id,
            "total_kwh": extras["charges"].get(key, {}).get("total_kwh")}


@app.post("/api/charging/charger")
def set_charger(payload: ChargerIn):
    """录入充电桩名称/地点/品牌;按充电地点存档,同一地点的后续充电自动带出。

    brand 为 None 时保留已存品牌(「充电详情」卡片只提交名称与地点)。
    """
    row = q("SELECT address_id, geofence_id FROM charging_processes WHERE id = %s",
            (payload.charge_id,))
    if not row:
        raise HTTPException(status_code=404, detail="充电会话不存在")
    key = _loc_key(row[0]["address_id"], row[0]["geofence_id"])
    if key is None:
        raise HTTPException(status_code=422, detail="该次充电没有地点信息,无法存档")
    name = payload.name.strip()[:80]
    location = payload.location.strip()[:120]
    extras = _load_extras()
    entry = dict(extras["chargers"].get(key) or {})
    entry["name"] = name
    entry["location"] = location
    if payload.brand is not None:
        entry["brand"] = payload.brand.strip()[:40]
    if entry.get("name") or entry.get("location") or entry.get("brand"):
        extras["chargers"][key] = entry
    else:
        extras["chargers"].pop(key, None)
    _save_extras(extras)
    return {"ok": True, "loc_key": key, "name": name, "location": location,
            "brand": entry.get("brand", "")}


@app.get("/api/routes")
def routes(car_id: int | None = Query(default=None),
           days: int = Query(default=7, ge=1, le=30)):
    """所选时间范围内全部行程轨迹(每条抽稀到约 220 点以内)。"""
    cid = get_car_id(car_id)
    drives = q(
        f"""
        SELECT d.id, {local_ts('d.start_date', 'start_date')},
               {local_ts('d.end_date', 'end_date')},
               d.distance, d.duration_min, d.speed_max,
               d.start_ideal_range_km, d.end_ideal_range_km,
               a1.name AS start_name, a2.name AS end_name
        FROM drives d
        LEFT JOIN addresses a1 ON a1.id = d.start_address_id
        LEFT JOIN addresses a2 ON a2.id = d.end_address_id
        WHERE d.car_id = %s AND d.start_date >= now() - make_interval(days => %s)
          AND d.distance > 0.1
        ORDER BY d.start_date
        """,
        (cid, days),
    )
    pts = q(
        """
        SELECT drive_id, latitude, longitude
        FROM positions
        WHERE car_id = %s AND drive_id IS NOT NULL AND latitude IS NOT NULL
          AND date >= now() - make_interval(days => %s)
        ORDER BY drive_id, date
        """,
        (cid, days),
    )
    by_id: dict[int, list[list[float]]] = {}
    for p in pts:
        by_id.setdefault(int(p["drive_id"]), []).append(
            [float(p["latitude"]), float(p["longitude"])])
    out = []
    for d in drives:
        points = by_id.get(d["id"], [])
        if len(points) > 220:
            keep = max(1, len(points) // 220)
            points = points[::keep]
        d["points"] = points
        out.append(d)
    return {"routes": out}


# ---------- 活动时间线:电量曲线 + 行驶/充电/哨兵/驻车耗电分段 ----------

# 驻车期间相邻采样间隔超过该值视为车辆进入休眠(样本来自 5 分钟分桶)
AWAKE_GAP_MS = 75 * 60 * 1000
# 驻车清醒持续达到该时长才判定为哨兵开启(短暂唤醒如 App 查看不算)
SENTRY_MIN_DURATION_MS = 30 * 60 * 1000


def _utc_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _battery_samples(cid: int, since_naive: datetime) -> list[tuple[int, int, bool]]:
    """电量采样:5 分钟一桶取首条(哨兵/驻车分段用),驻车时约 30 分钟一条自然保留。"""
    rows = q(
        """
        SELECT DISTINCT ON (b) date, battery_level, is_climate_on
        FROM (
            SELECT date, battery_level, is_climate_on,
                   floor(extract(epoch FROM date) / 300)::bigint AS b
            FROM positions
            WHERE car_id = %s AND date >= %s AND battery_level IS NOT NULL
        ) t
        ORDER BY b, date
        """,
        (cid, since_naive),
    )
    return [
        (_utc_ms(r["date"]), int(r["battery_level"]),
         bool(r["is_climate_on"]) if r["is_climate_on"] is not None else False)
        for r in rows
    ]


def _cut_interval(seg: tuple[int, int], intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """从区间 seg 中挖去 intervals 覆盖的部分,返回剩余片段。"""
    out, cur = [], seg[0]
    for a, b in sorted(intervals):
        if b <= cur:
            continue
        if a >= seg[1]:
            break
        if a > cur:
            out.append((cur, a))
        cur = max(cur, b)
    if cur < seg[1]:
        out.append((cur, seg[1]))
    return out


def _split_segments(samples: list[tuple[int, int, bool]],
                    intervals: list[tuple[int, int]]) -> dict:
    """由电量采样序列切出哨兵与驻车耗电时段。

    samples: (ts_ms, battery_level, is_climate_on),按时间升序。
    intervals: 行驶/充电区间(与采样同一时间基准),用于挖除。
    哨兵判定:驻车清醒 ≥ 30 分钟且非空调预热(特斯拉驻车长时间清醒≈哨兵开启;
    接电时哨兵掉电可能为 0)。驻车耗电:休眠间隙中的电量下降。
    """
    sentry, idle = [], []

    # 1) 清醒连续段(相邻采样间隔 ≤ AWAKE_GAP_MS)
    runs = []
    if samples:
        run_start_ts, run_start_lvl = samples[0][0], samples[0][1]
        prev = samples[0]
        for cur in samples[1:]:
            if cur[0] - prev[0] > AWAKE_GAP_MS:
                runs.append((run_start_ts, prev[0], run_start_lvl, prev[1]))
                run_start_ts, run_start_lvl = cur[0], cur[1]
            prev = cur
        runs.append((run_start_ts, prev[0], run_start_lvl, prev[1]))

    ts_list = [s[0] for s in samples]

    def level_range(a: int, b: int) -> tuple[int, int, list]:
        """区间 [a, b] 内的首末电量与全部样本(供哨兵/空调判定)。"""
        i = bisect.bisect_left(ts_list, a)
        j = bisect.bisect_right(ts_list, b)
        if i >= j:
            return None
        return samples[i][1], samples[j - 1][1], samples[i:j]

    # 2) 清醒段挖去行驶/充电后,剩余驻车清醒片段
    for rs, re, _, _ in runs:
        for ps, pe in _cut_interval((rs, re), intervals):
            if pe - ps < SENTRY_MIN_DURATION_MS:
                continue
            lr = level_range(ps, pe)
            if not lr:
                continue
            l0, l1, inner = lr
            if l1 - l0 >= 1:  # 驻车电量上升:测量噪声,跳过
                continue
            climate = sum(1 for s in inner if s[2]) / len(inner) >= 0.3
            piece = {
                "s": ps, "e": pe, "s_lvl": l0, "e_lvl": l1,
                "delta": l1 - l0, "dur_min": round((pe - ps) / 60000, 0),
            }
            if climate:
                if piece["delta"] <= -1:  # 空调预热耗电归入「非行驶耗电」
                    piece["kind"] = "climate"
                    idle.append(piece)
            else:
                piece["kind"] = "sentry"
                sentry.append(piece)

    # 3) 休眠间隙中的电量下降 → 驻车(非行驶)耗电
    for (t0, l0, _), (t1, l1, _) in zip(samples, samples[1:]):
        if t1 - t0 <= AWAKE_GAP_MS:
            continue
        if any(a < t1 and b > t0 for a, b in intervals):
            continue  # 间隙横跨行驶/充电,无法归因,跳过
        if l1 - l0 <= -1:
            idle.append({
                "s": t0, "e": t1, "s_lvl": l0, "e_lvl": l1,
                "delta": l1 - l0, "dur_min": round((t1 - t0) / 60000, 0),
                "kind": "asleep",
            })

    def merge(pieces: list[dict]) -> list[dict]:
        pieces.sort(key=lambda p: p["s"])
        out = []
        for p in pieces:
            if out and p["s"] - out[-1]["e"] < 30 * 60 * 1000:
                last = out[-1]
                last["e"] = p["e"]
                last["e_lvl"] = p["e_lvl"]
                last["delta"] = last["e_lvl"] - last["s_lvl"]
                last["dur_min"] = round((last["e"] - last["s"]) / 60000, 0)
            else:
                out.append(dict(p))
        return out

    return {"sentry": merge(sentry), "idle": merge(idle)}


@app.get("/api/activity")
def activity(car_id: int | None = Query(default=None),
             days: int = Query(default=7, ge=1, le=30)):
    """电量曲线 + 行驶/充电/哨兵/驻车耗电分段(时间轴标注用)。"""
    cid = get_car_id(car_id)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    since_naive = since.replace(tzinfo=None)

    # 电量采样:5 分钟一桶取首条,驻车时约 30 分钟一条自然保留
    samples = _battery_samples(cid, since_naive)

    # 行驶/充电多取 2 小时:窗口边缘的行程需参与分段挖除,展示时再按窗口过滤
    buffered = since_naive - timedelta(hours=2)
    since_ms = _utc_ms(since)
    drives_all = q(
        f"""
        SELECT d.id, {local_ts('d.start_date', 'start_date')},
               {local_ts('d.end_date', 'end_date')},
               d.distance, d.duration_min,
               d.start_ideal_range_km, d.end_ideal_range_km,
               a1.name AS start_name, a2.name AS end_name
        FROM drives d
        LEFT JOIN addresses a1 ON a1.id = d.start_address_id
        LEFT JOIN addresses a2 ON a2.id = d.end_address_id
        WHERE d.car_id = %s AND d.start_date >= %s
        ORDER BY d.start_date
        """,
        (cid, buffered),
    )
    charges_all = q(
        f"""
        SELECT cp.id, {local_ts('cp.start_date', 'start_date')},
               {local_ts('cp.end_date', 'end_date')},
               cp.charge_energy_added, cp.cost, cp.duration_min,
               cp.start_battery_level, cp.end_battery_level,
               a.name AS address_name
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        WHERE cp.car_id = %s AND cp.start_date >= %s
        ORDER BY cp.start_date
        """,
        (cid, buffered),
    )
    drives = [d for d in drives_all if int(d["start_date_ts"]) >= since_ms]
    charges = [c for c in charges_all if int(c["start_date_ts"]) >= since_ms]

    intervals = [
        (int(d["start_date_ts"]), int(d["end_date_ts"])) for d in drives_all
    ] + [
        (int(c["start_date_ts"]), int(c["end_date_ts"])) for c in charges_all
        if c["end_date_ts"] is not None
    ]

    seg = _split_segments(samples, intervals)

    def with_rate(pieces):
        for p in pieces:
            h = (p["e"] - p["s"]) / 3600000
            p["rate_pct_h"] = round(p["delta"] / h, 2) if h > 0 else None
        return pieces

    # 金额估算:事件发生时最近一次充电的单价 × 事件能耗
    ratio = kwh_per_ideal_km(cid)
    kpp = kwh_per_pct(cid)
    timeline = charge_rate_timeline(cid)
    tl_starts = [c["start_ts"] for c in timeline]
    tl_by_id = {c["id"]: c for c in timeline}

    def rate_at(ts: int):
        i = bisect.bisect_right(tl_starts, ts) - 1
        return timeline[i]["rate_yuan_kwh"] if i >= 0 else None

    def price(ts: int, kwh: float):
        r = rate_at(ts)
        return round(kwh * r, 2) if (r is not None and kwh is not None) else None

    for c in charges:
        t = tl_by_id.get(c["id"])
        if t:
            c["cost"] = t["cost"]
            c["cost_entered"] = t["cost_entered"]
            c["rate_yuan_kwh"] = t["rate_yuan_kwh"]

    for d in drives:
        if d["start_ideal_range_km"] is None or d["end_ideal_range_km"] is None:
            continue
        delta_km = float(d["start_ideal_range_km"] - d["end_ideal_range_km"])
        if delta_km <= 0:
            continue
        kwh = delta_km * ratio
        d["energy_kwh"] = round(kwh, 2)
        d["cost_yuan"] = price(int(d["start_date_ts"]), kwh)
        if d["cost_yuan"] is not None and d["distance"]:
            d["cost_per_km_yuan"] = round(d["cost_yuan"] / float(d["distance"]), 4)

    for p in seg["sentry"] + seg["idle"]:
        kwh = -p["delta"] * kpp
        p["energy_kwh"] = round(kwh, 2)
        p["cost_yuan"] = price(p["s"], kwh)

    return {
        "days": days,
        "battery": [[s[0], s[1]] for s in samples],
        "drives": drives,
        "charges": charges,
        "sentry": with_rate(seg["sentry"]),
        "idle": seg["idle"],
        "kwh_per_pct": round(kpp, 3),
    }


@app.get("/api/efficiency/trend")
def efficiency_trend(car_id: int | None = Query(default=None),
                     days: int = Query(default=30, ge=1, le=90)):
    """每次行程的平均能耗(Wh/km)时间轴,由理想续航差值 × 校准系数估算。"""
    cid = get_car_id(car_id)
    ratio = kwh_per_ideal_km(cid)
    rows = q(
        f"""
        SELECT d.id, {local_ts('d.start_date', 'start_date')},
               d.distance, d.duration_min,
               d.start_ideal_range_km, d.end_ideal_range_km,
               a1.name AS start_name, a2.name AS end_name
        FROM drives d
        LEFT JOIN addresses a1 ON a1.id = d.start_address_id
        LEFT JOIN addresses a2 ON a2.id = d.end_address_id
        WHERE d.car_id = %s AND d.start_date >= now() - make_interval(days => %s)
          AND d.distance > 0.5
        ORDER BY d.start_date
        """,
        (cid, days),
    )
    points = []
    for r in rows:
        if (r["start_ideal_range_km"] is None or r["end_ideal_range_km"] is None
                or not r["distance"]):
            continue
        delta_km = float(r["start_ideal_range_km"] - r["end_ideal_range_km"])
        if delta_km <= 0:
            continue
        points.append({
            "start_ts": int(r["start_date_ts"]),
            "eff_wh_km": round(delta_km * ratio * 1000 / float(r["distance"]), 0),
            "distance": float(r["distance"]),
            "duration_min": int(r["duration_min"] or 0),
            "start_name": r["start_name"], "end_name": r["end_name"],
        })
    return {"kwh_per_ideal_km": ratio, "points": points}


@app.get("/api/battery/health")
def battery_health(car_id: int | None = Query(default=None)):
    """满电容量估算与电池健康度。

    每次充电:满电容量 ≈ 充电量 ÷ 表显电量增幅 × 100(口径含充电损耗,
    只用于相对比较)。基准容量取全部估算的 90 分位(抗离群),当前容量取
    最近 3 次的中位数,健康度 = 当前 ÷ 基准。
    """
    cid = get_car_id(car_id)
    rows = q(
        f"""
        SELECT {local_ts('cp.start_date', 'start_date')},
               cp.charge_energy_added, cp.start_battery_level, cp.end_battery_level
        FROM charging_processes cp
        WHERE cp.car_id = %s AND cp.charge_energy_added IS NOT NULL
          AND cp.end_battery_level > cp.start_battery_level
        ORDER BY cp.start_date
        """,
        (cid,),
    )
    points = []
    for r in rows:
        delta = int(r["end_battery_level"]) - int(r["start_battery_level"])
        if delta < 10:  # 增幅太小,估算误差大
            continue
        cap = float(r["charge_energy_added"]) / delta * 100
        if 30 <= cap <= 150:  # 合理区间过滤离群值
            points.append({"ts": int(r["start_date_ts"]), "kwh": round(cap, 1)})
    if not points:
        return {"points": [], "current_kwh": None, "nominal_kwh": None,
                "health_pct": None}
    caps = sorted(p["kwh"] for p in points)
    nominal = caps[min(len(caps) - 1, int(len(caps) * 0.9))]
    recent = sorted(p["kwh"] for p in points[-3:])
    current = recent[len(recent) // 2]
    return {
        "points": points,
        "current_kwh": round(current, 1),
        "nominal_kwh": round(nominal, 1),
        "health_pct": round(min(100.0, current / nominal * 100), 1),
    }


@app.get("/api/energy/cycles")
def energy_cycles(car_id: int | None = Query(default=None),
                  limit: int = Query(default=6, ge=1, le=20)):
    """按充电周期划分能量去向:每次充电结束 → 下次充电开始(进行中的周期到现在)。

    每段:充至电量 level_after;未充 = 100 - level_after;周期内行驶能耗按
    理想续航差值 × 校准系数折算;哨兵/驻车空调/驻车(休眠)耗电由电量采样分段
    (_split_segments),单位均为电池 %。周期末剩余 = 下次充电起始电量,
    进行中的周期 = 当前可用电量。
    """
    cid = get_car_id(car_id)
    ratio = kwh_per_ideal_km(cid)
    charges = q(
        f"""
        SELECT cp.id, cp.end_date AS end_date_utc,
               {local_ts('cp.start_date', 'start_date')},
               {local_ts('cp.end_date', 'end_date')},
               cp.start_battery_level, cp.end_battery_level, cp.charge_energy_added
        FROM charging_processes cp
        WHERE cp.car_id = %s AND cp.end_date IS NOT NULL
          AND cp.start_battery_level IS NOT NULL AND cp.end_battery_level IS NOT NULL
        ORDER BY cp.start_date DESC
        LIMIT %s
        """,
        (cid, limit + 1),  # 多取一次,用于界定最旧周期的期末剩余
    )
    if not charges:
        return {"cycles": []}
    charges.reverse()  # 升序

    # 每次充电的满电容量估算(供 % → kWh 换算);全局最近几次中位数作回退
    def cap_of(c):
        delta = int(c["end_battery_level"]) - int(c["start_battery_level"])
        if delta >= 10 and c["charge_energy_added"]:
            cap = float(c["charge_energy_added"]) / delta * 100
            if 30 <= cap <= 150:
                return round(cap, 1)
        return None

    valid_caps = [cap for cap in (cap_of(c) for c in charges) if cap is not None]
    recent = valid_caps[-3:]
    current_cap = sorted(recent)[len(recent) // 2] if recent \
        else round(kwh_per_pct(cid) * 100, 1)

    lat = q(
        "SELECT usable_battery_level FROM positions "
        "WHERE car_id = %s AND usable_battery_level IS NOT NULL "
        "ORDER BY date DESC LIMIT 1",
        (cid,),
    )
    usable_now = int(lat[0]["usable_battery_level"]) if lat else None

    oldest_naive = charges[0]["end_date_utc"]
    samples = _battery_samples(cid, oldest_naive)
    drive_rows = q(
        f"""
        SELECT {local_ts('d.start_date', 'start_date')},
               {local_ts('d.end_date', 'end_date')},
               d.start_ideal_range_km, d.end_ideal_range_km
        FROM drives d
        WHERE d.car_id = %s AND d.start_date >= %s
        ORDER BY d.start_date
        """,
        (cid, oldest_naive),
    )
    drives = []
    for d in drive_rows:
        kwh = 0.0
        if (d["start_ideal_range_km"] is not None
                and d["end_ideal_range_km"] is not None):
            delta = float(d["start_ideal_range_km"] - d["end_ideal_range_km"])
            if delta > 0:
                kwh = delta * ratio
        drives.append((int(d["start_date_ts"]), int(d["end_date_ts"]), kwh))

    now_ms = int(time.time() * 1000)
    cycles_all = []
    for i, c in enumerate(charges):
        s = int(c["end_date_ts"])
        nxt = charges[i + 1] if i + 1 < len(charges) else None
        e = int(nxt["start_date_ts"]) if nxt else now_ms
        cyc_samples = [smp for smp in samples if s <= smp[0] <= e]
        cyc_iv = [(a, b) for a, b, _ in drives if a < e and b > s]
        seg = _split_segments(cyc_samples, cyc_iv)
        sentry_pct = max(0.0, -sum(p["delta"] for p in seg["sentry"]))
        climate_pct = max(0.0, -sum(p["delta"] for p in seg["idle"]
                                    if p["kind"] == "climate"))
        idle_pct = max(0.0, -sum(p["delta"] for p in seg["idle"]
                                 if p["kind"] != "climate"))
        drive_kwh = sum(k for a, _, k in drives if s <= a < e)
        cap = cap_of(c) or current_cap
        level_after = int(c["end_battery_level"])
        remaining = int(nxt["start_battery_level"]) if nxt else usable_now
        if remaining is None:  # 无最新电量:用残差兜底
            remaining = max(0.0, level_after - drive_kwh / cap * 100
                            - sentry_pct - climate_pct - idle_pct)
        cycles_all.append({
            "charge_id": c["id"],
            "charge_end_ts": s,
            "charge_end_local": c["end_date_local"],
            "level_after": level_after,
            "uncharged_pct": max(0, 100 - level_after),
            "cap_kwh": cap,
            "drive_pct": round(drive_kwh / cap * 100, 1),
            "sentry_pct": round(sentry_pct, 1),
            "climate_pct": round(climate_pct, 1),
            "idle_pct": round(idle_pct, 1),
            "remaining_pct": round(float(remaining), 1),
            "active": nxt is None,
        })
    return {"cycles": cycles_all[-limit:][::-1]}  # 新的在前


@app.get("/api/tpms/trend")
def tpms_trend(car_id: int | None = Query(default=None),
               days: int = Query(default=7, ge=1, le=30)):
    """四轮胎压(bar)时间轴,按分桶取首条降采样。"""
    cid = get_car_id(car_id)
    step = 120 if days <= 2 else 300 if days <= 7 else 900
    rows = q(
        """
        SELECT DISTINCT ON (b) date, tpms_pressure_fl, tpms_pressure_fr,
               tpms_pressure_rl, tpms_pressure_rr
        FROM (
            SELECT date, tpms_pressure_fl, tpms_pressure_fr,
                   tpms_pressure_rl, tpms_pressure_rr,
                   floor(extract(epoch FROM date) / %s)::bigint AS b
            FROM positions
            WHERE car_id = %s AND date >= now() - make_interval(days => %s)
              AND (tpms_pressure_fl IS NOT NULL OR tpms_pressure_fr IS NOT NULL
                   OR tpms_pressure_rl IS NOT NULL OR tpms_pressure_rr IS NOT NULL)
        ) t
        ORDER BY b, date
        """,
        (step, cid, days),
    )
    wheels = {"fl": [], "fr": [], "rl": [], "rr": []}
    for r in rows:
        ts = _utc_ms(r["date"])
        for key, col in (("fl", "tpms_pressure_fl"), ("fr", "tpms_pressure_fr"),
                         ("rl", "tpms_pressure_rl"), ("rr", "tpms_pressure_rr")):
            if r[col] is not None:
                wheels[key].append([ts, float(r[col])])
    return {"days": days, "step_seconds": step, "wheels": wheels}


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"),
                           html=True), name="static")
