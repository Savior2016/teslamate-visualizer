"""File-backed accounts and revocable, password-bound sessions (single worker)."""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SESSION_TTL = 7 * 86400
USERNAME = re.compile(r"[A-Za-z0-9_.@-]{1,32}")


class AuthConfigurationError(Exception):
    pass


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000)
    return f"pbkdf2_sha256$600000${salt}${digest.hex()}"


def valid_hash(value):
    return isinstance(value, str) and bool(re.fullmatch(
        r"pbkdf2_sha256\$[0-9]{6,7}\$[a-f0-9]{32}\$[a-f0-9]{64}", value)) and 100_000 <= int(value.split("$")[1]) <= 2_000_000


def verify_password(password, stored):
    if not valid_hash(stored) or len(password) > 1024:
        return False
    _, iterations, salt, expected = stored.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
    return secrets.compare_digest(actual.hex(), expected)


class AccountStore:
    def __init__(self, path):
        self.path = Path(path)
        self.session_path = self.path.with_name("sessions.sqlite3")
        self.lock = threading.RLock()

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            users, roles = data["users"], data["roles"]
            if not users or not isinstance(users, dict) or not isinstance(roles, dict):
                raise ValueError()
            if any(not USERNAME.fullmatch(u) or not valid_hash(h) for u, h in users.items()):
                raise ValueError()
            if any(roles.get(u) not in ("admin", "viewer") for u in users):
                raise ValueError()
            if not any(roles[u] == "admin" for u in users):
                raise ValueError()
            return data
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise AuthConfigurationError("账号配置不可用，请联系管理员") from exc

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            tmp.unlink(missing_ok=True)

    def seed(self, seeds="", admins=""):
        """One-time legacy migration; explicit admins win, otherwise first seed/owner."""
        with self.lock:
            pairs = [p.partition(":") for p in seeds.split(",")]
            if self.path.exists():
                try:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    return  # Requests fail closed; never overwrite a damaged account file.
                if not isinstance(data, dict) or "roles" in data:
                    return
                users = data.get("users")
                if not isinstance(users, dict) or not users or any(
                        not USERNAME.fullmatch(u) or not valid_hash(h) for u, h in users.items()):
                    return
            else:
                users = {u.strip(): hash_password(p) for u, sep, p in pairs
                         if sep and USERNAME.fullmatch(u.strip()) and p and len(p) <= 1024}
                if not users:
                    return
            selected = {u.strip() for u in admins.split(",") if u.strip()}
            if not selected:
                selected = {next((u.strip() for u, _, _ in pairs if u.strip() in users), next(iter(users)))}
            if not selected.issubset(users):
                raise AuthConfigurationError("指定的管理员账号不存在")
            self._write({"users": users, "roles": {u: "admin" if u in selected else "viewer" for u in users}})

    def users(self):
        return self._read()["users"]

    def roles(self):
        return self._read()["roles"]

    def create_user(self, username, password, role="viewer"):
        if not USERNAME.fullmatch(username) or not 12 <= len(password) <= 1024 or role not in ("admin", "viewer"):
            raise ValueError("用户名格式错误，或密码不足 12 位，或角色无效")
        with self.lock:
            data = self._read()
            if username in data["users"]:
                raise ValueError("账号已存在")
            data["users"][username] = hash_password(password)
            data["roles"][username] = role
            self._write(data)

    def remove_user(self, username, actor):
        with self.lock:
            data = self._read()
            if username == actor or username not in data["users"]:
                raise ValueError("不能删除当前账号，或账号不存在")
            if data["roles"][username] == "admin" and sum(data["roles"][u] == "admin" for u in data["users"]) <= 1:
                raise ValueError("至少保留一个管理员")
            del data["users"][username]
            data["roles"].pop(username, None)
            self._write(data)
            self.revoke_user(username)

    def change_password(self, username, current, password):
        with self.lock:
            data = self._read()
            if not verify_password(current, data["users"].get(username)):
                raise ValueError("当前密码不正确")
            if not 12 <= len(password) <= 1024:
                raise ValueError("新密码需为 12–1024 位")
            data["users"][username] = hash_password(password)
            self._write(data)
            self.revoke_user(username)

    def _db(self):
        self.session_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.session_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.session_path, 0o600)
        conn = sqlite3.connect(self.session_path, timeout=10)
        conn.execute("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, expires REAL NOT NULL)")
        return conn

    def create_session(self, username):
        with self.lock:
            stored = self.users()[username]
            token = secrets.token_urlsafe(32)
            conn = self._db()
            try:
                with conn:
                    conn.execute("DELETE FROM sessions WHERE expires <= ?", (time.time(),))
                    # Bound sessions per account while preserving recently logged-in devices.
                    conn.execute("DELETE FROM sessions WHERE username=? AND token NOT IN (SELECT token FROM sessions WHERE username=? ORDER BY expires DESC LIMIT 19)", (username, username))
                    conn.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), username, stored, time.time() + SESSION_TTL))
            finally:
                conn.close()
            return token

    def session_user(self, token):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token or ""):
            return ""
        with self.lock:
            users = self.users()
            conn = self._db()
            try:
                row = conn.execute("SELECT username, password_hash, expires FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            finally:
                conn.close()
            if row and row[2] > time.time() and secrets.compare_digest(users.get(row[0], ""), row[1]):
                return row[0]
            return ""

    def revoke(self, token):
        with self.lock:
            conn = self._db()
            try:
                with conn:
                    conn.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))
            finally:
                conn.close()

    def revoke_user(self, username):
        with self.lock:
            conn = self._db()
            try:
                with conn:
                    conn.execute("DELETE FROM sessions WHERE username=?", (username,))
            finally:
                conn.close()
