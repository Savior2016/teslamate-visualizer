"""数据库一键导出/导入(个人中心「数据备份 / 迁移」)。

导出 = pg_dump -Fc 整库(含 panel_manual 手填数据与 TeslaMate 全部遥测)
       + 面板账号 users.json,打成 tar.gz 下载;
导入 = 上传该 tar.gz,pg_restore --clean --if-exists 整库覆盖恢复,
       并恢复面板账号文件。

独立成模块是为了减少与 main.py 的并发修改冲突;main.py 只需 include_router。
"""
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
from datetime import datetime

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

router = APIRouter(prefix="/api/backup", tags=["backup"])

_DB = dict(
    host=os.environ.get("DATABASE_HOST", "database"),
    port=os.environ.get("DATABASE_PORT", "5432"),
    dbname=os.environ.get("DATABASE_NAME", "teslamate"),
    user=os.environ.get("DATABASE_USER", "teslamate"),
    password=os.environ.get("DATABASE_PASS", ""),
)
USERS_FILE = os.environ.get("USERS_FILE", "/data/users.json")

DUMP_MEMBER = "backup.dump"
MANIFEST_MEMBER = "manifest.json"
USERS_MEMBER = "users.json"

_backup_lock = threading.Lock()


def _pg_env() -> dict:
    env = dict(os.environ)
    env["PGPASSWORD"] = _DB["password"]
    return env


def _pg_uri() -> str:
    return (f"postgresql://{_DB['user']}@{_DB['host']}:{_DB['port']}"
            f"/{_DB['dbname']}")


@router.get("/export")
def export_backup():
    """一键导出:整库 dump + 面板账号,打包 tar.gz 供下载迁移。"""
    if not _backup_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="已有备份/恢复任务进行中,请稍后再试")
    tmpdir = tempfile.mkdtemp(prefix="ttv-backup-")
    try:
        dump_path = os.path.join(tmpdir, DUMP_MEMBER)
        proc = subprocess.run(
            ["pg_dump", "-Fc", "-f", dump_path, _pg_uri()],
            env=_pg_env(), capture_output=True, text=True, timeout=900,
        )
        if proc.returncode != 0:
            raise HTTPException(status_code=500,
                                detail=f"pg_dump 失败:{proc.stderr[-500:]}")

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = os.path.join(tmpdir, f"tesla-home-backup-{stamp}.tar.gz")
        with tarfile.open(out_path, "w:gz") as tar:
            tar.add(dump_path, arcname=DUMP_MEMBER)
            if os.path.exists(USERS_FILE):
                tar.add(USERS_FILE, arcname=USERS_MEMBER)
            manifest = {
                "app": "tesla-home",
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "database": _DB["dbname"],
                "format": "pg_dump custom (-Fc)",
            }
            mpath = os.path.join(tmpdir, MANIFEST_MEMBER)
            with open(mpath, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
            tar.add(mpath, arcname=MANIFEST_MEMBER)

        fname = os.path.basename(out_path)
        return FileResponse(
            out_path, filename=fname, media_type="application/gzip",
            # tar.gz 已压缩,提示 GZipMiddleware 不要二次压缩
            headers={"Content-Encoding": "identity"},
            background=BackgroundTask(shutil.rmtree, tmpdir, True),
        )
    except HTTPException:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    finally:
        _backup_lock.release()


@router.post("/import")
async def import_backup(file: UploadFile):
    """一键导入:上传 export 生成的 tar.gz,整库覆盖恢复 + 恢复面板账号。

    恢复期间 TeslaMate 可能正在写入,会有短暂冲突报错;恢复完成后页面刷新的
    即为备份中的数据。panel_manual 等手填数据随库一起恢复。
    """
    if not _backup_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="已有备份/恢复任务进行中,请稍后再试")
    tmpdir = tempfile.mkdtemp(prefix="ttv-restore-")
    try:
        up_path = os.path.join(tmpdir, "upload.tar.gz")
        with open(up_path, "wb") as f:
            shutil.copyfileobj(file.file, f, length=1024 * 1024)

        try:
            tar = tarfile.open(up_path, "r:gz")
        except (tarfile.TarError, ValueError):
            raise HTTPException(status_code=422, detail="文件不是有效的备份包(tar.gz)")
        with tar:
            names = set(tar.getnames())
            if DUMP_MEMBER not in names or MANIFEST_MEMBER not in names:
                raise HTTPException(status_code=422,
                                    detail="备份包不完整(缺 backup.dump 或 manifest.json)")
            dump_path = os.path.join(tmpdir, DUMP_MEMBER)
            with tar.extractfile(DUMP_MEMBER) as src, open(dump_path, "wb") as dst:
                shutil.copyfileobj(src, dst)
            users_bytes = None
            if USERS_MEMBER in names:
                with tar.extractfile(USERS_MEMBER) as src:
                    users_bytes = src.read()

        # 整库覆盖恢复:--clean --if-exists 先 DROP 再重建
        proc = subprocess.run(
            ["pg_restore", "--clean", "--if-exists", "-d", _pg_uri(), dump_path],
            env=_pg_env(), capture_output=True, text=True, timeout=1800,
        )
        # pg_restore 遇到「对象不存在」之类的提示会返回非 0,但数据往往已恢复;
        # 仅当输出里有真正 error 才视为失败
        errs = [ln for ln in (proc.stderr or "").splitlines()
                if "ERROR" in ln.upper()]
        if errs:
            raise HTTPException(status_code=500,
                                detail="恢复出错:" + "; ".join(errs[:3])[:500])

        users_restored = False
        if users_bytes:
            try:
                data = json.loads(users_bytes.decode("utf-8"))
                if isinstance(data, dict) and isinstance(data.get("users"), dict):
                    tmp = USERS_FILE + ".tmp"
                    os.makedirs(os.path.dirname(USERS_FILE) or ".", exist_ok=True)
                    with open(tmp, "wb") as f:
                        f.write(users_bytes)
                    os.replace(tmp, USERS_FILE)
                    users_restored = True
            except (ValueError, UnicodeDecodeError, OSError):
                pass

        warns = [ln for ln in (proc.stderr or "").splitlines()
                 if ln.strip()][:3]
        return {
            "ok": True,
            "users_restored": users_restored,
            "warnings": warns,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _backup_lock.release()
