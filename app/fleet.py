"""Administrator Fleet onboarding. Secrets stay encrypted in the private data volume."""
import hashlib
import json
import logging
import os
import secrets
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

router = APIRouter()
ROOT = Path(os.environ.get("FLEET_DATA_DIR", "/data/fleet"))
PROXY_DIR = Path(os.environ.get("FLEET_PROXY_DIR", "/data/tesla-proxy"))
ORIGIN = os.environ.get("FLEET_PUBLIC_ORIGIN", "").rstrip("/")
PROXY_URL = os.environ.get("FLEET_PROXY_URL", "https://tesla-proxy:4443")
SCOPES = "openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds"
REGIONS = {
    "cn": ("https://fleet-api.prd.cn.vn.cloud.tesla.cn", "https://auth.tesla.cn", "https://auth.tesla.cn/oauth2/v3/token"),
    "na": ("https://fleet-api.prd.na.vn.cloud.tesla.com", "https://auth.tesla.com", "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"),
    "eu": ("https://fleet-api.prd.eu.vn.cloud.tesla.com", "https://auth.tesla.com", "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"),
}
_lock = threading.RLock()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read():
    if not (ROOT / "credentials.enc").exists():
        return {}
    try:
        return json.loads(Fernet((ROOT / "master.key").read_bytes()).decrypt((ROOT / "credentials.enc").read_bytes()))
    except (OSError, ValueError, InvalidToken):
        raise HTTPException(503, "Fleet 配置无法解密，请恢复原有密钥和配置文件") from None


def write(value):
    if not (ROOT / "master.key").exists():
        if (ROOT / "credentials.enc").exists():
            raise HTTPException(503, "Fleet 配置不可用，请检查服务器配置")
        atomic(ROOT / "master.key", Fernet.generate_key())
    atomic(ROOT / "credentials.enc", Fernet((ROOT / "master.key").read_bytes()).encrypt(json.dumps(value).encode()))


def provision():
    """Run once during deployment, before starting the proxy; never rotate existing keys."""
    from datetime import datetime, timedelta, timezone
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    keyfile = PROXY_DIR / "fleet-key.pem"
    if not keyfile.exists():
        if Path("/data/tesla-public-key.pem").exists():
            raise RuntimeError("Existing public key: import its matching private key before provisioning")
        key = ec.generate_private_key(ec.SECP256R1())
        atomic(keyfile, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key = serialization.load_pem_private_key(keyfile.read_bytes(), password=None)
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    target = Path("/data/tesla-public-key.pem")
    if target.exists() and target.read_bytes() != public:
        raise RuntimeError("Existing public key differs; refusing to replace it")
    atomic(target, public)
    certfile, tlsfile = PROXY_DIR / "tls-cert.pem", PROXY_DIR / "tls-key.pem"
    if not certfile.exists() and not tlsfile.exists():
        tls = ec.generate_private_key(ec.SECP384R1())
        name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "tesla-proxy")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(tls.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                .not_valid_after(now + timedelta(days=3650))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName("tesla-proxy")]), critical=False)
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).sign(tls, hashes.SHA256()))
        atomic(tlsfile, tls.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        atomic(certfile, cert.public_bytes(serialization.Encoding.PEM))
    if not certfile.exists() or not tlsfile.exists():
        raise RuntimeError("Incomplete TLS key pair; restore original files")


def origin():
    u = urllib.parse.urlsplit(ORIGIN)
    if u.scheme != "https" or not u.hostname or u.path or u.query or u.fragment or u.username or u.password or u.port:
        raise HTTPException(503, "服务器需配置 FLEET_PUBLIC_ORIGIN 为面板 HTTPS 域名")
    return ORIGIN


def admin(request):
    from . import main
    main.require_admin(request)


def reauth(request, password):
    from . import main
    admin(request)
    if not main._https(request):
        raise HTTPException(400, "请通过 HTTPS 配置应用密钥")
    key = (main._client_ip(request), "fleet:" + request.state.user)
    if main._is_locked(key):
        raise HTTPException(429, "尝试次数过多，请稍后再试")
    if not main._verify_password(password, main.auth_users().get(request.state.user)):
        main._record_fail(key)
        raise HTTPException(403, "面板登录密码不正确")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _remote_error_detail(exc, url):
    """Classify bounded error fields without exposing upstream text or credentials."""
    path = urllib.parse.urlsplit(url).path
    command = path.startswith("/api/1/vehicles/") and ("/command/" in path or path.endswith("/wake_up"))
    stage = "车辆指令服务" if command else "Tesla 授权服务" if path.endswith("/token") else "Tesla 服务"
    hints = {400: "检查请求参数、区域和应用权限", 401: "凭据无效或授权已过期，请重新授权",
             403: "检查应用权限及车辆区域", 408: "车辆未在线，请在 Tesla App 唤醒后再操作",
             409: "请求状态冲突；注册时请检查域名与公钥是否一致", 429: "请求过多，请稍后重试"}
    hint = hints.get(exc.code, "请稍后重试")
    if command and exc.code >= 500:
        hint = "代理或上游服务处理失败，请检查指令服务日志中的连接、签名会话及命令错误"
    try:
        raw = exc.read(16385)
        payload = json.loads(raw) if len(raw) <= 16384 else None
        if command and isinstance(payload, dict):
            response = payload.get("response")
            values = [payload.get("error"), payload.get("error_description"),
                      response.get("reason") if isinstance(response, dict) else None]
            known = (
                ("your public key has not been paired with the vehicle", "车辆未配对当前应用公钥，请在 Tesla App 添加此应用虚拟钥匙，并确认代理使用对应私钥"),
                ("vehicle not connected", "车辆未连接，请在 Tesla App 确认车辆在线后再操作"),
                ("vehicle busy or finishing wake-up", "车辆忙碌或正在唤醒，请待车辆在线后再操作"),
                ("no private key available", "签名代理未加载车辆控制私钥，请检查代理密钥配置"),
                ("context deadline exceeded", "车辆通信超时，指令执行结果未确认，请先在 Tesla App 核实车辆状态"),
                ("client provided malformed oauth token", "代理无法解析授权令牌，请检查令牌及代理版本兼容性"),
                ("unauthorized missing scopes", "授权缺少所需权限，请重新授权车辆控制权限"),
            )
            for marker, explanation in known:
                if any(isinstance(value, str) and marker in value.lower() for value in values):
                    hint = explanation
                    break
    except (OSError, ValueError):
        pass
    finally:
        exc.close()
    return f"{stage}返回 HTTP {exc.code}：{hint}"


def remote(url, data=None, token=None, form=False, context=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        data = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=25) as response:
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise ValueError("oversized")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError("invalid response")
            return result
    except urllib.error.HTTPError as exc:
        detail = _remote_error_detail(exc, url)
        # Log only our fixed diagnostic vocabulary, never URLs or upstream bodies.
        logging.getLogger(__name__).warning("%s", detail)
        raise HTTPException(502, detail) from None
    except (OSError, ValueError):
        raise HTTPException(502, "Tesla 服务连接失败或返回无效数据，请检查配置后重试") from None


def configured():
    with _lock:
        d = read()
        return bool(d.get("refresh_token") and d.get("registered") and d.get("paired"))


def token(d):
    if not d.get("refresh_token"):
        raise HTTPException(409, "请先完成 Tesla 账号授权")
    if d.get("expires_at", 0) < time.time() + 120:
        result = remote(REGIONS[d["region"]][2], {"grant_type": "refresh_token", "client_id": d["client_id"], "refresh_token": d["refresh_token"]}, form=True)
        save_tokens(d, result)
    return d["access_token"]


def save_tokens(d, result):
    if not isinstance(result.get("access_token"), str) or not isinstance(result.get("refresh_token"), str) or not result["access_token"] or not result["refresh_token"]:
        raise HTTPException(502, "Tesla 服务连接失败或返回无效数据，请检查配置后重试")
    try:
        lifetime = float(result["expires_in"])
        if not 0 < lifetime < 365 * 86400:
            raise ValueError("invalid expiry")
    except (KeyError, TypeError, ValueError):
        raise HTTPException(502, "Tesla 令牌有效期无效，请重新授权") from None
    d.update(access_token=result["access_token"], refresh_token=result["refresh_token"], expires_at=time.time() + lifetime)
    write(d)


def forward(vin, cmd, args):
    with _lock:
        d = read()
        if not configured():
            raise HTTPException(409, "请先完成应用信息、服务器公钥和注册步骤")
        access = token(d)
    suffix = "wake_up" if cmd == "wake_up" else "command/" + cmd
    context = ssl.create_default_context(cafile=str(PROXY_DIR / "tls-cert.pem"))
    payload = remote(PROXY_URL + "/api/1/vehicles/" + urllib.parse.quote(vin, safe="") + "/" + suffix, args, access, context=context)
    result = payload.get("response") or {}
    if cmd == "wake_up":
        return {"ok": result.get("state") == "online", "reason": "" if result.get("state") == "online" else "唤醒请求已发送，请稍后查看"}
    return {"ok": bool(result.get("result")), "reason": str(result.get("reason") or "")[:200]}


def vehicle_data(vin):
    with _lock:
        d = read()
        access = token(d)
        audience = REGIONS[d["region"]][0]
    path = "/api/1/vehicles/" + urllib.parse.quote(vin, safe="") + "/vehicle_data?endpoints=vehicle_state%3Bclimate_state%3Bcharge_state"
    return remote(audience + path, token=access).get("response") or {}


class Credentials(BaseModel):
    client_id: str = Field(min_length=1, max_length=256)
    client_secret: str = Field(default="", max_length=2048)
    region: Literal["cn", "na", "eu"] = "cn"
    password: str = Field(max_length=1024)


class Password(BaseModel):
    password: str = Field(max_length=1024)


@router.get("/api/fleet/status")
def status(request: Request):
    admin(request)
    with _lock:
        d = read()
    base = origin()
    return {"origin": base, "redirect_uri": base + "/auth/tesla/callback", "client_id": d.get("client_id", ""),
            "region": d.get("region", "cn"), "secret_saved": bool(d.get("client_secret")),
            "registered": bool(d.get("registered")), "authorized": bool(d.get("refresh_token")),
            "paired": bool(d.get("paired")), "public_key": Path("/data/tesla-public-key.pem").exists(),
            "proxy_installed": (PROXY_DIR / "tls-cert.pem").exists(),
            "pair_url": ("https://www.tesla.cn/_ak/" if d.get("region", "cn") == "cn" else "https://www.tesla.com/_ak/") + urllib.parse.urlsplit(base).hostname}


@router.post("/api/fleet/config")
def configure(body: Credentials, request: Request):
    reauth(request, body.password)
    origin()
    from . import nap
    with nap.lock, _lock:
        nap.ensure_idle()
        old = read()
        client_id = body.client_id.strip()
        secret = body.client_secret.strip() or (old.get("client_secret", "") if old.get("client_id") == client_id and old.get("region") == body.region else "")
        if not client_id or not secret:
            raise HTTPException(422, "请填写客户端 ID 和客户端密钥")
        if (client_id, secret, body.region) != (old.get("client_id"), old.get("client_secret"), old.get("region")):
            write({"client_id": client_id, "client_secret": secret, "region": body.region})
    return {"ok": True}


@router.post("/api/fleet/register")
def register(request: Request):
    admin(request)
    with _lock:
        d = read()
        if not d.get("client_secret"):
            raise HTTPException(409, "请先完成应用信息、服务器公钥和注册步骤")
        if not Path("/data/tesla-public-key.pem").exists():
            raise HTTPException(409, "请先完成应用信息、服务器公钥和注册步骤")
        audience, _, endpoint = REGIONS[d["region"]]
        result = remote(endpoint, {"grant_type": "client_credentials", "client_id": d["client_id"], "client_secret": d["client_secret"], "audience": audience, "scope": SCOPES.replace("offline_access ", "")}, form=True)
        partner = result.get("access_token")
        if not partner:
            raise HTTPException(502, "Tesla 服务连接失败或返回无效数据，请检查配置后重试")
        remote(audience + "/api/1/partner_accounts", {"domain": urllib.parse.urlsplit(origin()).hostname}, partner)
        d["registered"] = True
        write(d)
    return {"ok": True}


@router.post("/api/fleet/authorize")
def authorize(request: Request):
    from . import main
    admin(request)
    session = request.cookies.get(main.SESSION_COOKIE, "")
    if not session:
        raise HTTPException(409, "请在浏览器中登录面板后开始授权")
    from . import nap
    with nap.lock, _lock:
        nap.ensure_idle()
        d = read()
        if not d.get("registered"):
            raise HTTPException(409, "请先完成应用信息、服务器公钥和注册步骤")
        state = secrets.token_urlsafe(32)
        d["pending"] = {"state_hash": hashlib.sha256(state.encode()).hexdigest(), "session_hash": hashlib.sha256(session.encode()).hexdigest(), "user": request.state.user, "expires": time.time() + 600}
        write(d)
        query = urllib.parse.urlencode({"response_type": "code", "client_id": d["client_id"], "redirect_uri": origin() + "/auth/tesla/callback", "scope": SCOPES, "state": state, "prompt": "login", "locale": "zh-CN"})
        return {"url": REGIONS[d["region"]][1] + "/oauth2/v3/authorize?" + query}


@router.get("/auth/tesla/callback")
def callback(request: Request):
    from . import main
    admin(request)
    from . import nap
    with nap.lock, _lock:
        nap.ensure_idle()
        d = read()
        pending = d.get("pending", {})
        state = request.query_params.get("state", "")
        session = request.cookies.get(main.SESSION_COOKIE, "")
        valid = (pending.get("expires", 0) > time.time() and pending.get("user") == request.state.user
                 and secrets.compare_digest(pending.get("state_hash", ""), hashlib.sha256(state.encode()).hexdigest())
                 and secrets.compare_digest(pending.get("session_hash", ""), hashlib.sha256(session.encode()).hexdigest()))
        outcome = "invalid"
        if valid:
            d.pop("pending", None)
            write(d)  # consume before exchange; a failed code cannot be replayed
            if request.query_params.get("error"):
                outcome = "denied"
            elif request.query_params.get("code"):
                try:
                    result = remote(REGIONS[d["region"]][2], {"grant_type": "authorization_code", "client_id": d["client_id"], "client_secret": d["client_secret"], "code": request.query_params["code"], "audience": REGIONS[d["region"]][0], "redirect_uri": origin() + "/auth/tesla/callback"}, form=True)
                    save_tokens(d, result)
                    outcome = "success"
                except HTTPException:
                    outcome = "failed"
    response = RedirectResponse("/fleet.html?fleet=" + outcome, status_code=303)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/api/fleet/paired")
def paired(request: Request):
    admin(request)
    with _lock:
        d = read()
        if not d.get("registered") or not d.get("refresh_token"):
            raise HTTPException(409, "请先完成 Tesla 账号授权")
        d["paired"] = True  # user confirmation, never advertised as verified vehicle state
        write(d)
    return {"ok": True}


@router.post("/api/fleet/disconnect")
def disconnect(body: Password, request: Request):
    reauth(request, body.password)
    from . import nap
    with nap.lock, _lock:
        nap.ensure_idle()
        write({})
    return {"ok": True}
