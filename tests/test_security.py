import importlib
import io
import json
import os
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.auth import AccountStore, AuthConfigurationError
from app.tile_cache import TileCache

PASSWORD = "test-only-password-123"


@pytest.fixture
def store(tmp_path):
    result = AccountStore(tmp_path / "users.json")
    result.seed("owner:" + PASSWORD)
    result.create_user("guest", PASSWORD, "viewer")
    return result


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.setenv("USERS_FILE", str(store.path))
    from app import main
    monkeypatch.setattr(main, "accounts", store)
    monkeypatch.setattr(main, "auth_users", store.users)
    monkeypatch.setattr(main, "_make_session", store.create_session)
    monkeypatch.setattr(main, "_session_user", store.session_user)
    monkeypatch.setattr(main, "_manual_all", lambda kind: {})
    monkeypatch.setattr(main, "q", lambda *args: [])
    main._failures.clear()
    result = TestClient(main.app, raise_server_exceptions=False)
    yield result
    result.close()


def login(client, username="owner"):
    response = client.post("/api/login", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.cookies["ttv_session"]


@pytest.mark.parametrize("value", [None, "broken", '{"users":{}}', '{"users":[],"roles":{}}'])
def test_configuration_failure_is_closed(client, store, value):
    if value is None:
        store.path.unlink()
    else:
        store.path.write_text(value)
    assert client.get("/api/vehicle/delivery").status_code == 503
    assert client.post("/api/account/users", json={"username":"intruder", "password":PASSWORD}).status_code == 503


def test_logout_revokes_copied_token_and_persists(store):
    token = store.create_session("owner")
    restarted = AccountStore(store.path)
    assert restarted.session_user(token) == "owner"
    restarted.revoke(token)
    assert store.session_user(token) == ""


def test_password_change_revokes_all_devices(store):
    tokens = [store.create_session("owner") for _ in range(2)]
    store.change_password("owner", PASSWORD, "replacement-password-123")
    assert all(store.session_user(token) == "" for token in tokens)


def test_delete_recreate_does_not_revive_sessions(store):
    token = store.create_session("guest")
    store.remove_user("guest", "owner")
    store.create_user("guest", PASSWORD)
    assert store.session_user(token) == ""


def test_migration_preserves_hashes_and_explicit_owner(tmp_path):
    original = AccountStore(tmp_path / "users.json")
    original.seed("shared:"+PASSWORD+",personal:"+PASSWORD)
    hashes = original.users()
    original.path.write_text(json.dumps({"users": hashes}))
    original.seed("shared:"+PASSWORD, "personal")
    assert original.users() == hashes
    assert original.roles() == {"shared":"viewer", "personal":"admin"}


def test_admin_and_viewer_boundaries(client):
    login(client, "guest")
    assert client.get("/api/vehicle/delivery").status_code == 200
    for method, path, body in [("post", "/api/account/users", {}), ("delete", "/api/account/users/owner", None),
                                ("post", "/api/control/command", {}), ("post", "/api/parking/fees", {}),
                                ("post", "/api/backup/export", {"password":PASSWORD}), ("post", "/api/backup/import", {})]:
        assert getattr(client, method)(path, **({"json":body} if body is not None else {})).status_code == 403
    response = client.get("/api/account/status")
    assert response.json()["users"] == ["guest"]
    login(client)
    assert client.post("/api/account/users", json={"username":"newguest", "password":PASSWORD}).status_code == 200
    assert client.post("/api/backup/import", json={}).status_code == 410


def test_logout_endpoint_and_password_endpoint(client, store):
    token = login(client)
    assert client.post("/api/logout").status_code == 200
    assert store.session_user(token) == ""
    token = login(client)
    assert client.post("/api/account/password", json={"current_password":PASSWORD,"new_password":"new-test-password-123"}).status_code == 200
    assert store.session_user(token) == ""


def test_cookie_headers_and_cross_site_mutation(client):
    login(client)
    response = client.get("/api/vehicle/delivery")
    assert response.headers["cache-control"] == "no-store"
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert client.post("/api/logout", headers={"Origin":"https://external.invalid"}).status_code == 403
    assert client.post("/api/login", content=b"x" * 65537).status_code == 413
    # Streaming bodies without Content-Length are bounded too.
    assert client.post("/api/login", content=iter([b"x"*32768]*3)).status_code == 413


def test_untrusted_proxy_cannot_supply_ip_or_https(client):
    from app import main
    req = SimpleNamespace(client=SimpleNamespace(host="203.0.113.10"), headers={"x-forwarded-for":"1.2.3.4","x-forwarded-proto":"https"},url=SimpleNamespace(scheme="http"))
    assert main._client_ip(req) == "203.0.113.10"
    assert not main._https(req)
    login(client)
    assert client.get("/api/tiles/light/0/1/0.png").status_code == 404
    client.cookies.clear()
    assert client.get("/api/tiles/light/0/0/0.png").status_code == 401


def test_valid_session_not_locked_by_other_attempts(client):
    from app import main
    login(client)
    for _ in range(10):
        main._record_fail(("testclient", "owner"))
    assert client.get("/api/vehicle/delivery").status_code == 200


def test_cache_eviction_and_restart(tmp_path):
    cache = TileCache(tmp_path, max_bytes=10)
    cache.put(tmp_path / "1/0/0.png", b"a" * 6)
    cache.put(tmp_path / "1/0/1.png", b"b" * 6)
    assert not (tmp_path / "1/0/0.png").exists()
    assert sum(p.stat().st_size for p in tmp_path.rglob("*.png")) <= 10
    cache = TileCache(tmp_path, max_bytes=10)
    cache.put(tmp_path / "1/0/0.png", b"a" * 6)
    assert not (tmp_path / "1/0/1.png").exists()


@pytest.mark.parametrize("kind", ["symlink", "traversal", "duplicate", "oversize"])
def test_restore_rejects_unsafe_members(tmp_path, kind):
    from scripts.restore import unpack
    archive = tmp_path / "archive.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        member = tarfile.TarInfo("../escape" if kind == "traversal" else "users.json")
        if kind == "symlink":
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
        if kind == "oversize":
            member.size = 1024*1024+1
            tar.addfile(member, io.BytesIO(b"x" * member.size))
        else:
            tar.addfile(member)
        if kind == "duplicate":
            tar.addfile(member)
    directory = tmp_path / "out"
    directory.mkdir()
    with pytest.raises(ValueError):
        unpack(archive, directory)
