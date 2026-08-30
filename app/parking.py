"""停车费记录(车辆总览旁的费用小模块)。

存 panel_manual 表 kind='parking':key = 日期+随机后缀,payload =
{date, days, cost, note};days=费用覆盖天数(1=仅当天),随数据库备份走。
独立成模块减少与 main.py 的并发修改冲突。
"""
import re
import secrets
from datetime import date as _date, datetime

from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

router = APIRouter(prefix="/api/parking", tags=["parking"])

_KIND = "parking"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class ParkingFeeIn(BaseModel):
    date: str            # 计费起始日 YYYY-MM-DD(前端默认填当天)
    cost: float
    days: int = 1        # 费用覆盖天数:1 = 仅当天,N = 当天起接下来 N 天
    note: str = ""


def _m():
    """延迟引用 main(避免循环导入);请求到来时 main 必然已加载完毕。"""
    from . import main
    return main


@router.get("/fees")
def list_fees():
    """全部停车费记录(新→旧)+ 本月合计与累计。"""
    main = _m()
    fees = []
    for k, v in main._manual_all(_KIND).items():
        try:
            fees.append({
                "key": k,
                "date": str(v["date"]),
                "days": max(1, int(v.get("days", 1))),
                "cost": round(float(v["cost"]), 2),
                "note": str(v.get("note", "")),
            })
        except (KeyError, TypeError, ValueError):
            continue
    fees.sort(key=lambda f: (f["date"], f["key"]), reverse=True)
    prefix = _date.today().strftime("%Y-%m")
    return {
        "fees": fees[:200],
        "month_total": round(sum(f["cost"] for f in fees
                                 if f["date"].startswith(prefix)), 2),
        "total": round(sum(f["cost"] for f in fees), 2),
    }


@router.post("/fees")
def add_fee(payload: ParkingFeeIn):
    """记录一笔停车费;date 默认当天(前端),days 表示覆盖当天起 N 天。"""
    if not _DATE_RE.fullmatch(payload.date):
        raise HTTPException(status_code=422, detail="日期格式应为 YYYY-MM-DD")
    try:
        datetime.strptime(payload.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="日期无效")
    if not (0 < payload.cost <= 100000):
        raise HTTPException(status_code=422, detail="金额需在 0–100000 之间")
    if not (1 <= payload.days <= 366):
        raise HTTPException(status_code=422, detail="覆盖天数需在 1–366 之间")
    entry = {
        "date": payload.date,
        "days": payload.days,
        "cost": round(float(payload.cost), 2),
        "note": payload.note.strip()[:80],
    }
    key = f"{payload.date}-{secrets.token_hex(3)}"
    main = _m()
    main._exec(
        """
        INSERT INTO panel_manual (kind, key, payload) VALUES (%s, %s, %s)
        ON CONFLICT (kind, key) DO NOTHING
        """,
        (_KIND, key, Jsonb(entry)),
    )
    return {"ok": True, "key": key, **entry}


@router.delete("/fees/{key}")
def del_fee(key: str):
    """删除一笔停车费记录。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key):
        raise HTTPException(status_code=422, detail="无效的记录键")
    _m()._exec("DELETE FROM panel_manual WHERE kind = %s AND key = %s",
               (_KIND, key))
    return {"ok": True}
