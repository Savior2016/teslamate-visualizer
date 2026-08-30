#!/usr/bin/env bash
# TESLA Home 一体化部署初始化脚本
# 生成 .env(随机密钥 + 面板账号)、可选生成 Caddyfile,并拉起全部服务。
set -euo pipefail
cd "$(dirname "$0")"

info() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "未找到 docker,请先安装 Docker: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件,请安装 Docker Compose v2"

rand_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ---------- .env ----------
if [ -f .env ]; then
  ok ".env 已存在,跳过生成(如需重置请删除后重跑)"
else
  info "生成 .env ..."
  cp .env.example .env

  ENC_KEY="$(rand_hex 32)"
  DB_PASS="$(rand_hex 16)"
  # macOS sed -i 需要空参数,Linux 不需要;用临时文件兼容两者
  sedi() { sed "$@" .env > .env.tmp && mv .env.tmp .env; }
  sedi "s|^TESLAMATE_ENCRYPTION_KEY=.*|TESLAMATE_ENCRYPTION_KEY=${ENC_KEY}|"
  sedi "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASS}|"

  echo
  echo "请设置 TESLA Home 面板的登录账号(用于浏览器访问面板):"
  read -rp "  用户名 [admin]: " PANEL_USER
  PANEL_USER="${PANEL_USER:-admin}"
  while :; do
    read -rsp "  密码(留空则随机生成): " PANEL_PASS; echo
    if [ -z "${PANEL_PASS}" ]; then
      PANEL_PASS="$(rand_hex 8)"
      echo "  已生成随机密码: ${PANEL_PASS}  (请记录下来,稍后可登录面板「个人中心」修改)"
    fi
    [ ${#PANEL_PASS} -ge 6 ] && break
    warn "密码至少 6 位,请重试"
  done
  sedi "s|^PANEL_USERS=.*|PANEL_USERS=${PANEL_USER}:${PANEL_PASS}|"
  ok ".env 已生成(密钥已随机化)"
fi

# ---------- Caddyfile(可选 HTTPS)----------
PROFILE_ARGS=()
if [ -f Caddyfile ]; then
  ok "Caddyfile 已存在,启用 https"
  PROFILE_ARGS=(--profile https)
else
  echo
  read -rp "是否配置域名并启用自动 HTTPS?(需域名已解析到本机,80/443 已放行) [y/N]: " USE_HTTPS
  if [[ "${USE_HTTPS:-N}" =~ ^[yY]$ ]]; then
    read -rp "  域名(如 tesla.example.com): " DOMAIN
    [ -n "${DOMAIN}" ] || die "域名不能为空"
    sed "s|tesla\.example\.com|${DOMAIN}|g" Caddyfile.example > Caddyfile
    PROFILE_ARGS=(--profile https)
    ok "Caddyfile 已生成(${DOMAIN}),已启用 https profile"
    warn "首次签证书需要 80 端口可达;签好后建议在 .env 把 VISUALIZER_BIND 改为 127.0.0.1"
  fi
fi

mkdir -p data import

# ---------- 启动 ----------
echo
info "拉取镜像并启动服务 ..."
docker compose "${PROFILE_ARGS[@]}" pull --quiet || warn "部分镜像拉取失败,将尝试直接启动"
docker compose "${PROFILE_ARGS[@]}" up -d

echo
ok "部署完成!"
echo
echo "  TESLA Home 面板:  http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>'):8080"
echo "  下一步:打开面板 → 右上角「个人中心」,按指引完成 Tesla 账号授权"
[ ${#PROFILE_ARGS[@]} -gt 0 ] && echo "  HTTPS 入口:       https://${DOMAIN:-<你的域名>}"
echo
