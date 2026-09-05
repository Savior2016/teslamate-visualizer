#!/usr/bin/env python3
"""Offline restore with a pre-restore backup and transactional database rollback.
Run on the Docker host from this repository; only use your own trusted backups.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.auth import AccountStore, AuthConfigurationError

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_DUMP = 2 * 1024 * 1024 * 1024


def unpack(archive, directory):
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Compressed backup exceeds 512 MiB")
    seen = set()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            if member.name not in {"backup.dump", "users.json", "manifest.json"} or member.name in seen or not member.isfile():
                raise ValueError("Unexpected, duplicate or non-regular archive entry")
            limit = MAX_DUMP if member.name == "backup.dump" else 1024 * 1024
            if member.size > limit:
                raise ValueError("Archive member exceeds size limit")
            seen.add(member.name)
            with tar.extractfile(member) as src, (directory / member.name).open("wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
    if not {"backup.dump", "manifest.json"}.issubset(seen):
        raise ValueError("Incomplete backup")
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("app") != "tesla-home":
        raise ValueError("Not a TESLA Home backup")
    return directory / "backup.dump"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--confirm-overwrite", action="store_true")
    parser.add_argument("--confirm-encryption-key", action="store_true", help="Original TeslaMate key is retained, or Tesla reauthorization is planned")
    args = parser.parse_args()
    if not args.confirm_overwrite or not args.confirm_encryption_key:
        parser.error("Both confirmation flags are required; read docs/MAINTENANCE.md first")
    os.chdir(Path(__file__).resolve().parents[1])
    os.umask(0o077)
    dc = ["docker", "compose"]
    with tempfile.TemporaryDirectory(prefix="teslahome-restore-") as tmp:
        directory = Path(tmp)
        dump = unpack(args.archive.resolve(), directory)
        users_file = directory / "users.json"
        restored_accounts = None
        if users_file.exists():
            accounts = AccountStore(users_file)
            accounts.seed()  # migrate legacy account files, first account remains admin
            restored_accounts = accounts._read()  # validate before touching live data
        # A non-restoring validation pass; still only accept archives you trust.
        subprocess.run(dc + ["exec", "-T", "database", "pg_restore", "--list"], stdin=dump.open("rb"), stdout=subprocess.DEVNULL, check=True)
        rollback = Path("data") / "restore-backups" / datetime.now().strftime("%Y%m%d-%H%M%S")
        rollback.mkdir(parents=True, mode=0o700)
        for name in ("users.json", "sessions.sqlite3"):
            if (Path("data") / name).exists():
                shutil.copy2(Path("data") / name, rollback / name)
        subprocess.run(dc + ["stop", "teslamate", "visualizer"], check=True)
        try:
            with (rollback / "before.dump").open("wb") as dest:
                subprocess.run(dc + ["exec", "-T", "database", "sh", "-c", 'exec pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"'], stdout=dest, check=True)
            with dump.open("rb") as src:
                subprocess.run(dc + ["exec", "-T", "database", "sh", "-c", 'exec pg_restore -U "$POSTGRES_USER" --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl -d "$POSTGRES_DB"'], stdin=src, check=True)
            subprocess.run(dc + ["run", "--rm", "--no-deps", "panel-db-init"], check=True)
            if restored_accounts:
                AccountStore("data/users.json")._write(restored_accounts)
            # Never resurrect sessions from another machine or from the old accounts.
            (Path("data") / "sessions.sqlite3").unlink(missing_ok=True)
        finally:
            subprocess.run(dc + ["start", "teslamate", "visualizer"], check=True)
        print("Restore completed. Previous data is retained in", rollback)


if __name__ == "__main__":
    main()
