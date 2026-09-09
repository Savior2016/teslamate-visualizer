"""充电提醒:家/公司识别、通勤耗电模型与充电预测的合成数据测试。

合成作息(仿真实数据):13:30 离家→14:10 到公司,23:40 离公司→次日 00:40 到家,
即夜间停家、白天停公司;单程约 29 km,耗 27 km rated 续航。
"""
import pytest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from test_security import client, store, login

TZ = ZoneInfo("Asia/Shanghai")
HOME = {"ids": [8, 20], "lat": 40.0438, "lng": 116.3507, "name": "后屯东路"}
WORK = {"ids": [1, 3, 5], "lat": 39.9282, "lng": 116.2400, "name": "田村路"}


def _ts(dt):
    return dt.timestamp() * 1000


def _drive(did, start, end, frm, to, km=29.0, r0=300.0, r1=273.0):
    return {
        "id": did, "distance": km,
        "start_address_id": frm["ids"][0], "end_address_id": to["ids"][0],
        "start_rated_range_km": r0, "end_rated_range_km": r1,
        "start_ts": _ts(start), "end_ts": _ts(end),
        "s_lat": frm["lat"], "s_lng": frm["lng"], "s_name": frm["name"],
        "e_lat": to["lat"], "e_lng": to["lng"], "e_name": to["name"],
    }


def _commute_days(n, start_day=datetime(2026, 8, 1, 0, 0, tzinfo=TZ)):
    """n 天规律通勤 + 一趟特殊长途(第 3 天下午,不应影响模型)。"""
    drives, did = [], 0
    rng = 460.0
    for i in range(n):
        day = start_day + timedelta(days=i)
        rng -= 6  # 夜间停家掉电
        drives.append(_drive(did := did + 1, day.replace(hour=13, minute=30),
                             day.replace(hour=14, minute=10), HOME, WORK, r0=rng, r1=rng - 27))
        rng -= 27 + 5  # 白天停公司掉电
        drives.append(_drive(did := did + 1, day.replace(hour=23, minute=40),
                             (day + timedelta(days=1)).replace(hour=0, minute=40), WORK, HOME,
                             r0=rng, r1=rng - 27))
        rng -= 27
        if i == 2:  # 特殊行程:去 60km 外某地当天往返
            drives.append(_drive(did := did + 1, day.replace(hour=15, minute=0),
                                 day.replace(hour=16, minute=0), WORK, WORK, km=60, r0=rng, r1=rng - 50))
    return drives


@pytest.fixture
def rem(client, monkeypatch):
    """按 SQL 内容分发合成行的 q 桩;state 可换 drives/charges/latest。"""
    from app import main
    state = {"drives": [], "charges": [], "latest": [{"battery_level": 60, "rated_battery_range_km": 120.0}]}

    def fake_q(sql, params=()):
        if "FROM cars" in sql:
            return [{"id": 1}]
        if "FROM drives" in sql:
            return state["drives"]
        if "FROM charging_processes" in sql:
            return state["charges"]
        if "FROM positions" in sql:
            return state["latest"]
        return []

    monkeypatch.setattr(main, "q", fake_q)
    login(client)
    return client, state


def _get(client):
    r = client.get("/api/charging/reminder")
    assert r.status_code == 200, r.text
    return r.json()


def test_identifies_home_and_work(rem):
    client, state = rem
    state["drives"] = _commute_days(10)
    r = _get(client)
    assert r["home"]["label"] == HOME["name"]    # 夜间 01:00–13:30 停家
    assert r["work"]["label"] == WORK["name"]    # 工作日 14:10–23:40 停公司
    assert r["overridden"] is False
    assert {c["label"] for c in r["candidates"]} >= {HOME["name"], WORK["name"]}


def test_predicts_charge_date_and_place(rem):
    client, state = rem
    state["drives"] = _commute_days(10)
    state["latest"] = [{"battery_level": 40, "rated_battery_range_km": 130.0}]
    r = _get(client)
    assert r["ready"] is True
    # 单程 27 km,阈值 = max(40, 1.5×27) = 40.5;每天约 54+11 km → 130 km 约 1.4 天
    assert 0.5 <= r["days_left"] <= 2.5
    assert r["charge_at"] in ("home", "work")
    assert r["charge_place"].startswith("家" if r["charge_at"] == "home" else "公司")
    assert r["leg_km"]["to_work"] == pytest.approx(27, abs=0.5)
    assert r["leg_km"]["to_home"] == pytest.approx(27, abs=0.5)
    assert r["sample_legs"] == 20


def test_special_trips_do_not_skew_model(rem):
    client, state = rem
    state["drives"] = _commute_days(10)
    base = _get(client)
    extra = _drive(999, datetime(2026, 8, 20, 8, 0, tzinfo=TZ),
                   datetime(2026, 8, 20, 12, 0, tzinfo=TZ), HOME, WORK, km=120, r0=400, r1=300)
    state["drives"] = _commute_days(10) + [extra]
    state["drives"].sort(key=lambda d: d["start_ts"])
    skewed = _get(client)
    assert skewed["leg_km"] == base["leg_km"]


def test_not_ready_with_few_samples(rem):
    client, state = rem
    state["drives"] = _commute_days(2)
    r = _get(client)
    assert r["ready"] is False
    assert "样本不足" in r["reason"]
    assert r["home"]["label"] == HOME["name"]   # 样本不足时仍展示识别结果


def test_no_drives_not_ready(rem):
    client, _ = rem
    r = _get(client)
    assert r["ready"] is False
    assert r["home"] is None


def test_charger_suggestion_near_anchor(rem, monkeypatch):
    client, state = rem
    from app import main
    monkeypatch.setattr(main, "_manual_all", lambda kind: {
        "charger": {"addr_4": {"name": "昆仑网电-快充", "location": "双林南路"}},
        "anchors": {}}.get(kind, {}))
    state["drives"] = _commute_days(10)
    state["charges"] = [{"address_id": 4, "lat": 39.9270, "lng": 116.2410, "name": "双林南路"}] * 3
    state["latest"] = [{"battery_level": 40, "rated_battery_range_km": 130.0}]
    r = _get(client)
    assert r["ready"] is True
    if r["charge_at"] == "work":
        assert r["charger"]["name"] == "昆仑网电-快充"


def test_anchors_override(rem, monkeypatch):
    client, state = rem
    from app import main
    saved = {}

    def fake_manual(kind):
        return {"anchors": {"places": saved}}.get(kind, {}) if saved else {}

    monkeypatch.setattr(main, "_manual_all", fake_manual)
    monkeypatch.setattr(main, "_exec", lambda sql, params=(): None)
    state["drives"] = _commute_days(10)
    r = client.post("/api/charging/anchors",
                    json={"home": WORK["ids"], "work": HOME["ids"]})   # 故意颠倒
    assert r.status_code == 200
    saved.update({"home": WORK["ids"], "work": HOME["ids"]})
    r = _get(client)
    assert r["overridden"] is True
    assert r["home"]["label"] == WORK["name"]
    assert r["work"]["label"] == HOME["name"]


def test_anchors_require_admin(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "q", lambda *a: [{"id": 1}])
    login(client, "guest")   # viewer
    r = client.post("/api/charging/anchors", json={"home": [1], "work": [8]})
    assert r.status_code == 403


def test_anchors_validation(rem):
    client, _ = rem
    r = client.post("/api/charging/anchors", json={"home": [1, 8], "work": [8]})
    assert r.status_code == 422   # 家与公司不能是同一地点
