"""车辆档案(提车日期等随车设置)。

存 panel_manual 表 kind='settings'(key 固定),随数据库备份/迁移走。
独立成模块减少与 main.py 的并发修改冲突(同 backup/parking/control 模式)。
"""
import re
from datetime import date as _date, datetime

from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

router = APIRouter(prefix="/api/vehicle", tags=["vehicle"])

_KIND = "settings"
_KEY = "delivery_date"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class DeliveryIn(BaseModel):
    date: str  # 提车日期 YYYY-MM-DD;空串 = 清除


def _m():
    """延迟引用 main(避免循环导入);请求到来时 main 必然已加载完毕。"""
    from . import main
    return main


@router.get("/delivery")
def get_delivery():
    """提车日期;未设置返回 null(前端据此提示设置)。"""
    row = _m()._manual_all(_KIND).get(_KEY) or {}
    d = row.get("date")
    return {"date": d if isinstance(d, str) and _DATE_RE.fullmatch(d) else None}


@router.post("/delivery")
def set_delivery(payload: DeliveryIn):
    """设置/清除提车日期(date 为空串时删除)。"""
    main = _m()
    if payload.date == "":
        main._exec("DELETE FROM panel_manual WHERE kind = %s AND key = %s",
                   (_KIND, _KEY))
        return {"ok": True, "date": None}
    if not _DATE_RE.fullmatch(payload.date):
        raise HTTPException(status_code=422, detail="日期格式应为 YYYY-MM-DD")
    try:
        d = datetime.strptime(payload.date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="日期无效")
    if d > _date.today():
        raise HTTPException(status_code=422, detail="提车日期不能晚于今天")
    main._exec(
        """
        INSERT INTO panel_manual (kind, key, payload) VALUES (%s, %s, %s)
        ON CONFLICT (kind, key) DO UPDATE SET payload = EXCLUDED.payload
        """,
        (_KIND, _KEY, Jsonb({"date": payload.date})),
    )
    return {"ok": True, "date": payload.date}
