"""充电提醒:识别家/公司,按通勤+停放耗电推算还能用几天、在哪充电。

纯只读分析(不下发任何车辆指令)。家/公司判定:
  家   = 夜间(01:00–05:00 本地)停放最多的地点聚类
  公司 = 白天(12:00–16:00 本地工作日)停放最多的其他聚类
端点按经纬度聚类(半径 500m),解决同一地点多条 addresses 记录的问题。
用户可通过 POST /api/charging/anchors 纠正,覆盖存 panel_manual kind='anchors'。

预测:通勤腿耗电取家⇄公司行程的 rated 续航差中位数(剔除距离异常的特殊行程),
停放掉电取相邻行程间 (前序结束续航 − 后续起始续航)/停放小时 的中位数(分地点),
按学到的出发时刻逐事件向后推演,首次抵达 anchor 时续航低于阈值即建议在该处充电。
"""
import statistics
from datetime import datetime, timedelta
from math import asin, cos, radians, sin, sqrt
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel

router = APIRouter(prefix="/api/charging", tags=["charging"])

_CLUSTER_M = 500          # 端点聚类半径
_CHARGER_NEAR_M = 1500    # 推荐充电桩与 anchor 的最大距离
_MIN_LEGS = 6             # 做出预测所需的最少通勤腿数(双向合计)
_MIN_LEG_DIR = 2          # 每个方向最少腿数
_HORIZON_DAYS = 30
_NIGHT = (1, 5)           # 夜间停留判定窗口(本地小时)
_DAY = (12, 16)           # 白天停留判定窗口
_MIN_RANGE_FLOOR_KM = 40  # 提醒阈值下限


def _m():
    """延迟引用 main(避免循环导入);请求到来时 main 必然已加载完毕。"""
    from . import main
    return main


def _tz():
    return ZoneInfo(_m().DISPLAY_TZ)


def _local(ms):
    return datetime.fromtimestamp(ms / 1000, _tz())


def _dist_m(lat1, lng1, lat2, lng2):
    """haversine 球面距离(米)。"""
    r = 6371000
    p1, p2 = radians(lat1), radians(lat2)
    dp, dl = p2 - p1, radians(lng2 - lng1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * r * asin(sqrt(a))


def _median(values):
    return statistics.median(values) if values else None


def _covers(interval_start_ms, interval_end_ms, win_start_h, win_end_h, weekday_only=False):
    """停放区间是否与本地时间窗口 [win_start_h, win_end_h) 相交(任一本地日)。"""
    start, end = _local(interval_start_ms), _local(interval_end_ms)
    day = start.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= end:
        if not weekday_only or day.weekday() < 5:
            lo = day.replace(hour=win_start_h)
            hi = day.replace(hour=win_end_h)
            if start < hi and end > lo:
                return True
        day += timedelta(days=1)
    return False


class _Cluster:
    __slots__ = ("lat", "lng", "n", "address_ids", "names", "visits", "nights", "days")

    def __init__(self, lat, lng):
        self.lat, self.lng, self.n = lat, lng, 0
        self.address_ids, self.names = set(), {}
        self.visits = self.nights = self.days = 0

    def add(self, lat, lng, address_id, name):
        self.n += 1
        self.lat += (lat - self.lat) / self.n   # 滚动质心
        self.lng += (lng - self.lng) / self.n
        if address_id is not None:
            self.address_ids.add(address_id)
        if name:
            self.names[name] = self.names.get(name, 0) + 1

    @property
    def label(self):
        return max(self.names, key=self.names.get) if self.names else "未知地点"


def _cluster_endpoints(drives):
    """按行程顺序贪心聚类全部端点,返回 (clusters, {drive_id: (start_idx, end_idx)})。"""
    clusters, of = [], {}

    def assign(lat, lng, address_id, name):
        for i, c in enumerate(clusters):
            if _dist_m(c.lat, c.lng, lat, lng) <= _CLUSTER_M:
                c.add(lat, lng, address_id, name)
                return i
        c = _Cluster(lat, lng)
        c.add(lat, lng, address_id, name)
        clusters.append(c)
        return len(clusters) - 1

    for d in drives:
        s = e = None
        if d["s_lat"] is not None:
            s = assign(float(d["s_lat"]), float(d["s_lng"]), d["start_address_id"], d["s_name"])
        if d["e_lat"] is not None:
            e = assign(float(d["e_lat"]), float(d["e_lng"]), d["end_address_id"], d["e_name"])
        of[d["id"]] = (s, e)
    return clusters, of


def _anchors(clusters, of, drives, override):
    """判定家/公司 cluster 下标;override = {"home": [addr_ids], "work": [addr_ids]}。"""
    for i in range(len(drives) - 1):
        _, e = of[drives[i]["id"]]
        s2, _ = of[drives[i + 1]["id"]]
        if e is None or e != s2:
            continue
        end_ms, start_ms = drives[i]["end_ts"], drives[i + 1]["start_ts"]
        if _covers(end_ms, start_ms, *_NIGHT):
            clusters[e].nights += 1
        if _covers(end_ms, start_ms, *_DAY, weekday_only=True):
            clusters[e].days += 1
    for s, e in of.values():
        if s is not None:
            clusters[s].visits += 1
        if e is not None:
            clusters[e].visits += 1

    def by_ids(ids):
        for i, c in enumerate(clusters):
            if c.address_ids & set(ids or []):
                return i
        return None

    def auto():
        if not clusters:
            return None, None
        h = max(range(len(clusters)), key=lambda i: (clusters[i].nights, clusters[i].visits))
        rest = [i for i in range(len(clusters)) if i != h]
        w = max(rest, key=lambda i: (clusters[i].days, clusters[i].visits)) if rest else None
        return h, w

    # 单边可空:该侧回退自动识别;纠正结果与自动撞车时保留自动的另一侧
    auto_home, auto_work = auto()
    overridden = bool(override.get("home") or override.get("work"))
    home = by_ids(override.get("home")) if override.get("home") else auto_home
    work = by_ids(override.get("work")) if override.get("work") else auto_work
    if home is not None and home == work:
        work = auto_work if auto_work != home else None
    return home, work, overridden


def _commute_model(drives, of, home, work):
    """通勤腿耗电/出发时刻(分方向)与家/公司停放掉电(km/h),全部取中位数。"""
    if home is None:
        return None
    legs = {"to_work": [], "to_home": []}
    departs = {"to_work": [], "to_home": []}
    pairs = {"to_work": (home, work), "to_home": (work, home)}
    candidates = []
    for d in drives:
        s, e = of[d["id"]]
        for direction, (a, b) in pairs.items():
            if b is not None and s == a and e == b and d["distance"]:
                candidates.append((direction, d))
    if not candidates:
        return None
    typical_km = _median([float(d["distance"]) for _, d in candidates])
    for direction, d in candidates:
        used = d["start_rated"] - d["end_rated"]
        # 排除特殊行程:距离偏离典型通勤太远,或续航差异常(顺路充过电等)
        if not (0.4 * typical_km <= float(d["distance"]) <= 2.5 * typical_km and 0 < used < typical_km * 2):
            continue
        legs[direction].append(used)
        departs[direction].append(_local(d["start_ts"]).hour * 60 + _local(d["start_ts"]).minute)

    drain = {"home": [], "work": []}
    anchor_of = {home: "home", work: "work"}
    for i in range(len(drives) - 1):
        _, e = of[drives[i]["id"]]
        s2, _ = of[drives[i + 1]["id"]]
        if e is None or e != s2 or e not in anchor_of:
            continue
        hours = (drives[i + 1]["start_ts"] - drives[i]["end_ts"]) / 3600000
        lost = drives[i]["end_rated"] - drives[i + 1]["start_rated"]
        if hours >= 1 and 0 < lost <= 2 * hours:   # 负值=中间充过电;>2km/h 视为异常
            drain[anchor_of[e]].append(lost / hours)

    return {
        "leg_km": {k: _median(v) for k, v in legs.items()},
        "depart_min": {k: _median(v) for k, v in departs.items()},
        "drain_km_h": {k: (_median(v) if v else 0.3) for k, v in drain.items()},
        "samples": sum(len(v) for v in legs.values()),
    }


def _simulate(now_ms, start_range, start_loc, model, home, work):
    """从当前续航逐事件推演,返回 (charge_by_ms, charge_at) 或 None(超出推演窗口)。"""
    anchors = {"home": home, "work": work}
    if model["leg_km"]["to_work"] is None or model["leg_km"]["to_home"] is None \
            or model["depart_min"]["to_work"] is None or model["depart_min"]["to_home"] is None \
            or work is None:
        # 只有一个锚点:没有通勤腿,仅按停放掉电线性推演
        daily = model["drain_km_h"]["home"] * 24
        if daily <= 0:
            return None
        days = (start_range - _threshold(model)) / daily
        return (now_ms + max(0, days) * 86400000, "home") if days <= _HORIZON_DAYS else None

    threshold = _threshold(model)
    if start_range <= threshold:
        return now_ms, start_loc
    loc, rng, t = start_loc, start_range, now_ms
    legs = {"home": ("to_work", "work"), "work": ("to_home", "home")}
    end = now_ms + _HORIZON_DAYS * 86400000
    for _ in range(_HORIZON_DAYS * 2 + 2):
        direction, dest = legs[loc]
        dep = model["depart_min"][direction]
        day = _local(t).replace(hour=0, minute=0, second=0, microsecond=0)
        leave = day + timedelta(minutes=dep)
        if leave.timestamp() * 1000 <= t:
            leave += timedelta(days=1)
        leave_ms = leave.timestamp() * 1000
        rng -= model["drain_km_h"][loc] * (leave_ms - t) / 3600000   # 停放掉电
        rng -= model["leg_km"][direction]                            # 通勤腿
        arrive_ms = leave_ms + 3600000                               # 行程约 1 小时
        if rng <= threshold:
            return arrive_ms, dest
        loc, t = dest, arrive_ms
        if t >= end:
            break
    return None


def _threshold(model):
    legs = [v for v in (model["leg_km"]["to_work"], model["leg_km"]["to_home"]) if v]
    return max(_MIN_RANGE_FLOOR_KM, 1.5 * max(legs)) if legs else _MIN_RANGE_FLOOR_KM


def _cluster_view(i, clusters):
    if i is None:
        return None
    c = clusters[i]
    return {"label": c.label, "address_ids": sorted(c.address_ids),
            "visits": c.visits, "nights": c.nights, "days": c.days}


def _charger_near(cluster, charges, chargers):
    """anchor 附近历史充电最多的地点;没有则回退到全局最常充的桩。
    名称优先取充电桩档案(panel_manual kind='charger')。"""
    if not charges:
        return None
    counts = {}
    for ch in charges:
        if ch["address_id"] is not None:
            counts[ch["address_id"]] = counts.get(ch["address_id"], 0) + 1
    if not counts:
        return None
    main = _m()

    def view(address_id, near):
        ch = next(c for c in charges if c["address_id"] == address_id)
        saved = chargers.get(main._loc_key(address_id, None)) or {}
        return {"name": saved.get("name") or ch["name"] or "该地点充电桩",
                "location": saved.get("location") or "", "times": counts[address_id],
                "near_anchor": near}

    if cluster is not None:
        near = [(aid, n) for (aid, n) in counts.items()
                if any(c["address_id"] == aid and c["lat"] is not None and
                       _dist_m(cluster.lat, cluster.lng, float(c["lat"]), float(c["lng"])) <= _CHARGER_NEAR_M
                       for c in charges)]
        if near:
            return view(max(near, key=lambda x: x[1])[0], True)
    return view(max(counts, key=counts.get), False)


@router.get("/reminder")
def reminder(car_id: int | None = None):
    main = _m()
    cid = main.get_car_id(car_id)
    drives = [
        {**r, "distance": float(r["distance"] or 0),
         "start_rated": float(r["start_rated_range_km"] or 0),
         "end_rated": float(r["end_rated_range_km"] or 0),
         "start_ts": float(r["start_ts"]), "end_ts": float(r["end_ts"])}
        for r in main.q(
            """
            SELECT d.id, d.distance, d.start_address_id, d.end_address_id,
                   d.start_rated_range_km, d.end_rated_range_km,
                   EXTRACT(EPOCH FROM d.start_date) * 1000 AS start_ts,
                   EXTRACT(EPOCH FROM d.end_date) * 1000 AS end_ts,
                   sa.latitude AS s_lat, sa.longitude AS s_lng,
                   COALESCE(sa.name, sa.display_name) AS s_name,
                   ea.latitude AS e_lat, ea.longitude AS e_lng,
                   COALESCE(ea.name, ea.display_name) AS e_name
            FROM drives d
            LEFT JOIN addresses sa ON sa.id = d.start_address_id
            LEFT JOIN addresses ea ON ea.id = d.end_address_id
            WHERE d.car_id = %s AND d.end_date IS NOT NULL
              AND d.start_date > now() - interval '90 days'
            ORDER BY d.start_date
            """,
            (cid,),
        )
    ]
    charges = main.q(
        """
        SELECT cp.address_id, a.latitude AS lat, a.longitude AS lng,
               COALESCE(a.name, a.display_name) AS name
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        WHERE cp.car_id = %s AND cp.start_date > now() - interval '180 days'
        """,
        (cid,),
    )
    latest = main.q(
        """
        SELECT battery_level, rated_battery_range_km
        FROM positions WHERE car_id = %s AND rated_battery_range_km IS NOT NULL
        ORDER BY date DESC LIMIT 1
        """,
        (cid,),
    )

    override = main._manual_all("anchors").get("places") or {}
    clusters, of = _cluster_endpoints(drives)
    home, work, overridden = _anchors(clusters, of, drives, override)
    candidates = sorted(
        ({"key": i, **_cluster_view(i, clusters)} for i in range(len(clusters))),
        key=lambda c: -c["visits"])
    result = {"ready": False, "overridden": overridden,
              "home": _cluster_view(home, clusters), "work": _cluster_view(work, clusters),
              "candidates": candidates}
    if home is None:
        result["reason"] = "暂无足够行程数据识别常用地点"
        return result

    model = _commute_model(drives, of, home, work)
    if model is None or model["samples"] < _MIN_LEGS \
            or len([1 for v in model["leg_km"].values() if v]) < 2 \
            or work is None or home == work:
        result["reason"] = (f"家⇄公司通勤样本不足(需 ≥{_MIN_LEGS} 趟,"
                            f"当前 {model['samples'] if model else 0} 趟),继续积累行程数据"
                            if work is not None else "只识别到一个常用地点,暂无法推算通勤")
        return result

    if latest and latest[0]["rated_battery_range_km"] is not None:
        current_range = float(latest[0]["rated_battery_range_km"])
    elif latest and latest[0]["battery_level"] is not None:
        # 缺少 rated 续航时按校准系数由表显电量折算
        current_range = float(latest[0]["battery_level"]) * main.kwh_per_pct(cid) / main.kwh_per_ideal_km(cid)
    else:
        result["reason"] = "无法读取当前续航,请等待车辆数据同步"
        return result

    last_loc = of[drives[-1]["id"]][1] if drives else None
    start_loc = "home" if last_loc in (None, home) else ("work" if last_loc == work else "home")
    now_ms = datetime.now(_tz()).timestamp() * 1000
    outcome = _simulate(now_ms, current_range, start_loc, model, home, work)
    if outcome is None:
        result.update(ready=True, days_left=None,
                      reason=f"当前续航约 {round(current_range)} km,未来 {_HORIZON_DAYS} 天内无需充电")
        return result

    charge_by_ms, charge_at = outcome
    anchor_cluster = clusters[home if charge_at == "home" else work]
    charger = _charger_near(anchor_cluster, charges, main._manual_all("charger"))
    result.update(
        ready=True,
        current_range_km=round(current_range, 1),
        threshold_km=round(_threshold(model), 1),
        days_left=round(max(0, (charge_by_ms - now_ms) / 86400000), 1),
        charge_by_ts=int(charge_by_ms),
        charge_at=charge_at,
        charge_place=("家" if charge_at == "home" else "公司") + " · " + anchor_cluster.label,
        charger=charger,
        leg_km={k: round(v, 1) for k, v in model["leg_km"].items()},
        drain_km_day={k: round(v * 24, 1) for k, v in model["drain_km_h"].items()},
        sample_legs=model["samples"],
        reason="",
    )
    return result


class AnchorsIn(BaseModel):
    home: list[int] = []   # 家聚类包含的 address_id;空 = 恢复自动识别
    work: list[int] = []


@router.post("/anchors")
def set_anchors(body: AnchorsIn, request: Request):
    main = _m()
    main.require_admin(request)
    if len(body.home) > 50 or len(body.work) > 50 or \
            any(not isinstance(i, int) or i < 0 for i in body.home + body.work):
        raise HTTPException(status_code=422, detail="地点参数无效")
    if set(body.home) & set(body.work):
        raise HTTPException(status_code=422, detail="家和公司不能是同一地点")
    main._exec(
        """
        INSERT INTO panel_manual (kind, key, payload) VALUES ('anchors', 'places', %s)
        ON CONFLICT (kind, key) DO UPDATE
          SET payload = EXCLUDED.payload, updated_at = now()
        """,
        (Jsonb({"home": sorted(set(body.home)), "work": sorted(set(body.work))}),),
    )
    return {"ok": True}
