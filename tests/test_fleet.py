import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from test_security import client, store, login, PASSWORD
from app import fleet, main


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch, client):
    client.base_url = "https://testserver"
    monkeypatch.setattr(fleet, "ROOT", tmp_path / "fleet")
    monkeypatch.setattr(fleet, "ORIGIN", "https://panel.example.com")
    monkeypatch.setattr(main, "_https", lambda request: True)


def config(client):
    login(client)
    return client.post("/api/fleet/config", json={"client_id":"test-client", "client_secret":"test-secret-value", "region":"cn", "password":PASSWORD})


def test_encryption_and_no_secret_response(client):
    assert config(client).status_code == 200
    assert b"test-secret-value" not in (fleet.ROOT / "credentials.enc").read_bytes()
    assert fleet.read()["client_secret"] == "test-secret-value"
    status = client.get("/api/fleet/status")
    assert status.json()["secret_saved"]
    assert "test-secret-value" not in status.text
    response = client.post("/api/fleet/config", json={"client_id":{},"client_secret":"sensitive-invalid","password":PASSWORD})
    assert response.status_code == 422
    assert "sensitive-invalid" not in response.text and PASSWORD not in response.text


def test_viewer_and_reauth(client):
    login(client,"guest")
    assert client.get("/api/fleet/status").status_code == 403
    assert client.post("/api/fleet/config",json={}).status_code == 403
    login(client)
    assert client.post("/api/fleet/config",json={"client_id":"x","client_secret":"y","password":"wrong"}).status_code == 403
    assert not fleet.read()


def test_oauth_state_session_and_single_use(client, monkeypatch):
    assert config(client).status_code == 200
    d=fleet.read(); d["registered"]=True; fleet.write(d)
    r=client.post("/api/fleet/authorize",json={})
    assert r.status_code == 200
    query=parse_qs(urlsplit(r.json()["url"]).query)
    assert urlsplit(r.json()["url"]).hostname == "auth.tesla.cn"
    assert query["redirect_uri"] == ["https://panel.example.com/auth/tesla/callback"]
    assert "client_secret" not in query
    calls=[]
    def remote(*args,**kwargs):
        calls.append(args)
        return {"access_token":"test-access","refresh_token":"test-refresh","expires_in":3600}
    monkeypatch.setattr(fleet,"remote",remote)
    bad=client.get("/auth/tesla/callback?code=code&state=wrong",follow_redirects=False)
    assert "invalid" in bad.headers["location"] and not calls
    state=query["state"][0]
    path="/auth/tesla/callback?code=code&state="+state
    # Different authenticated session must not consume the pending authorization.
    old=client.cookies.get("ttv_session")
    client.cookies.clear(); login(client)
    assert "invalid" in client.get(path,follow_redirects=False).headers["location"]
    client.cookies.clear();client.cookies.set("ttv_session",old)
    result=client.get(path,follow_redirects=False)
    assert "success" in result.headers["location"] and len(calls)==1
    assert calls[0][0] == "https://auth.tesla.cn/oauth2/v3/token"
    assert fleet.read()["refresh_token"] == "test-refresh"
    assert "invalid" in client.get(path,follow_redirects=False).headers["location"]
    assert len(calls)==1


def test_refresh_rotation_and_changed_client(client,monkeypatch):
    config(client)
    d=fleet.read();d.update(access_token="old",refresh_token="refresh-old",expires_at=0,registered=True,paired=True);fleet.write(d)
    monkeypatch.setattr(fleet,"remote",lambda *a,**k:{"access_token":"new","refresh_token":"refresh-new","expires_in":3600})
    assert fleet.token(d)=="new"
    assert fleet.read()["refresh_token"]=="refresh-new"
    r=client.post("/api/fleet/config",json={"client_id":"different","client_secret":"new-secret","region":"cn","password":PASSWORD})
    assert r.status_code==200
    assert not fleet.configured() and "refresh_token" not in fleet.read()


def test_corrupt_key_fails_closed(client):
    config(client)
    (fleet.ROOT/"master.key").unlink()
    assert client.get("/api/fleet/status").status_code==503


def test_upstream_error_never_echoes_secrets(monkeypatch):
    import io
    import urllib.error
    class Opener:
        def open(self,*a,**k):
            raise urllib.error.HTTPError("https://auth.tesla.cn/",401,"bad",{},io.BytesIO(b"SECRET_TOKEN"))
    monkeypatch.setattr(fleet.urllib.request,"build_opener",lambda *a:Opener())
    with pytest.raises(HTTPException) as error:fleet.remote("https://auth.tesla.cn/")
    assert "SECRET_TOKEN" not in error.value.detail


def test_http_rejected(client,monkeypatch):
    monkeypatch.setattr(main,"_https",lambda request:False)
    assert config(client).status_code==400


@pytest.mark.parametrize("payload, expected", [
    ({"error": "vehicle unavailable: vehicle is offline or asleep"}, "车辆当前离线或休眠"),
    ({"error_description": "vehicle unavailable: vehicle is offline or asleep"}, "车辆当前离线或休眠"),
    ({"response": {"reason": "vehicle unavailable: vehicle is offline or asleep SECRET_TOKEN"}}, "车辆当前离线或休眠"),
    ({"error": "vehicle rejected request: your public key has not been paired with the vehicle"}, "未配对当前应用公钥"),
    ({"error": "vehicle not connected"}, "车辆未连接"),
    ({"error": "vehicle busy or finishing wake-up"}, "车辆忙碌"),
    ({"error_description": "no private key available"}, "未加载车辆控制私钥"),
    ({"error": "context deadline exceeded"}, "执行结果未确认"),
    ({"response": {"reason": "context deadline exceeded"}}, "执行结果未确认"),
    ({"error": "client provided malformed OAuth token: SECRET_TOKEN"}, "无法解析授权令牌"),
    ({"error": "Unauthorized missing scopes"}, "缺少所需权限"),
    ({"error": "unknown SECRET_TOKEN", "response": []}, "代理或上游服务处理失败"),
    (["SECRET_TOKEN"], "代理或上游服务处理失败"),
])
def test_command_http_500_diagnostics(monkeypatch, caplog, payload, expected):
    import io
    import urllib.error
    calls = []
    body = io.BytesIO(json.dumps(payload).encode())
    class Opener:
        def open(self, request, **kwargs):
            calls.append(request)
            raise urllib.error.HTTPError(request.full_url, 500, "error", {}, body)
    monkeypatch.setattr(fleet.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(HTTPException) as error:
        fleet.remote("https://tesla-proxy:4443/api/1/vehicles/test-vin/command/set_sentry_mode",
                     {"on": True}, "SECRET_TOKEN")
    assert error.value.status_code == 502
    assert "车辆指令服务返回 HTTP 500" in error.value.detail
    assert expected in error.value.detail
    assert "SECRET_TOKEN" not in error.value.detail and "test-vin" not in error.value.detail
    assert len(calls) == 1  # No automatic replay of a possibly executed command.
    assert calls[0].get_method() == "POST" and json.loads(calls[0].data) == {"on": True}
    assert body.closed
    assert expected in caplog.text
    assert "SECRET_TOKEN" not in caplog.text and "test-vin" not in caplog.text


@pytest.mark.parametrize("raw", [b"<html>SECRET_TOKEN</html>", b"x" * 16385, b"null"])
def test_command_invalid_error_body(raw):
    import io
    import urllib.error
    error = urllib.error.HTTPError("https://proxy/", 500, "error", {}, io.BytesIO(raw))
    detail = fleet._remote_error_detail(error, "https://proxy/api/1/vehicles/test/command/door_lock")
    assert "HTTP 500" in detail and "代理或上游服务处理失败" in detail
    assert "SECRET_TOKEN" not in detail


def test_token_http_500_identifies_auth_stage():
    import io
    import urllib.error
    error = urllib.error.HTTPError("https://auth.tesla.cn/", 500, "error", {}, io.BytesIO(b'{"error":"SECRET_TOKEN"}'))
    detail = fleet._remote_error_detail(error, "https://auth.tesla.cn/oauth2/v3/token")
    assert "Tesla 授权服务返回 HTTP 500" in detail and "SECRET_TOKEN" not in detail
