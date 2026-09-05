"""Administrator-only exports; restores are an offline maintenance operation."""
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

router = APIRouter(prefix="/api/backup", tags=["backup"])
_backup_lock = threading.Lock()


class ExportRequest(BaseModel):
    password: str


def _cleanup(path):
    shutil.rmtree(path, ignore_errors=True)
    _backup_lock.release()


@router.post("/export")
def export_backup(body: ExportRequest, request: Request):
    from . import main
    main.require_admin(request)
    key = (main._client_ip(request), "backup:" + request.state.user)
    if main._is_locked(key):
        raise HTTPException(status_code=429, detail="尝试次数过多，请稍后再试")
    if not main._verify_password(body.password, main.auth_users().get(request.state.user)):
        main._record_fail(key)
        raise HTTPException(status_code=403, detail="当前密码不正确")
    if not _backup_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="已有备份正在生成或下载")
    tmpdir = tempfile.mkdtemp(prefix="ttv-backup-")
    try:
        env = dict(os.environ, PGHOST=main.DATABASE_HOST, PGPORT=main.DATABASE_PORT,
                   PGUSER=main.DATABASE_USER, PGPASSWORD=main.DATABASE_PASS, PGDATABASE=main.DATABASE_NAME)
        dump_path = os.path.join(tmpdir, "backup.dump")
        proc = subprocess.run(["pg_dump", "-Fc", "--no-owner", "--no-acl", "-f", dump_path],
                              env=env, capture_output=True, text=True, timeout=900)
        if proc.returncode:
            raise HTTPException(status_code=500, detail="数据库备份失败，请管理员检查数据库与磁盘")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"tesla-home-backup-{stamp}.tar.gz"
        output = os.path.join(tmpdir, name)
        manifest = {"app": "tesla-home", "format_version": 2,
                    "created_at": stamp, "requires_original_encryption_key": True,
                    "restore": "Use scripts/restore.py during maintenance; never upload untrusted archives."}
        mpath = os.path.join(tmpdir, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        with tarfile.open(output, "w:gz") as tar:
            tar.add(dump_path, arcname="backup.dump")
            tar.add(main.USERS_FILE, arcname="users.json")
            tar.add(mpath, arcname="manifest.json")
        return FileResponse(output, filename=name, media_type="application/gzip",
                            headers={"Content-Encoding": "identity", "Cache-Control": "no-store"},
                            background=BackgroundTask(_cleanup, tmpdir))
    except BaseException as exc:
        _cleanup(tmpdir)
        if isinstance(exc, subprocess.TimeoutExpired):
            raise HTTPException(status_code=504, detail="备份超时，请稍后重试") from exc
        raise


@router.post("/import")
def import_disabled(request: Request):
    from . import main
    main.require_admin(request)
    raise HTTPException(status_code=410, detail="为保护数据库，恢复已移至服务器维护流程，请参阅维护文档")
