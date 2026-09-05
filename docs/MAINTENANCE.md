# 安全部署与备份恢复

面板使用独立的 `teslahome_panel` 数据库角色：读取遥测，仅写入 `panel_manual`。特权数据库凭据只由 TeslaMate、Grafana 和短期 `panel-db-init` 维护服务使用；网页容器不持有它。

## 升级现有部署

1. 保存当前镜像标签、Git 修改、`.env` 和 `data/users.json` 的私有备份，不提交这些文件。
2. 在 `.env` 添加独立的随机 `PANEL_DATABASE_PASSWORD`（例如 `openssl rand -hex 32`），不要替换原 `POSTGRES_PASSWORD` 或 `TESLAMATE_ENCRYPTION_KEY`。
3. 设置 `PANEL_ADMIN_USERS` 为主账号用户名；迁移旧 users.json 时只有指定账号成为管理员，其余保留密码并成为只读。已有 roles 的文件不会被环境变量重置。新部署默认第一个初始账号是管理员，新建账号默认只读。
4. 将 `.env` 与账号文件权限设为 0600。容器使用 UID/GID 1000，确保 `data/` 及其内容由 1000:1000 拥有，目录为 0700。
5. 将 `VISUALIZER_BIND`、`TESLAMATE_BIND`、`GRAFANA_BIND` 设为 `127.0.0.1`。HTTPS 使用 Caddy 入口；Grafana 如需访问使用 SSH 3000 隧道。
6. 执行 `docker compose run --rm --no-deps panel-db-init` 初始化最小权限角色，然后 `docker compose build visualizer` 和 `docker compose up -d --no-deps visualizer`。Grafana 绑定修改后执行 `docker compose --profile grafana up -d --no-deps grafana`。
7. 用 HTTPS 登录、核对数据与角色。旧版 Cookie 会失效一次，密码不变。验证成功后才清理旧镜像。

Caddy 的容器 DNS 名默认受信，代理 IP 每 30 秒重新解析。其他代理必须通过 `TRUSTED_PROXY_CIDRS` 显式配置，不能把所有公网地址加入信任列表。直连 HTTP 只适合通过本机或 SSH 隧道访问。

如果账号文件缺失或损坏，受保护接口返回 503，不开放匿名初始化。先从私有备份恢复有效账号文件；不要通过清空账号来关闭认证。临时会话仅保存在 `data/sessions.sqlite3`，修改密码或退出登录立即撤销对应会话。

## 导出

管理员在个人中心再次输入当前密码后导出。备份包含完整位置、行程、加密 Tesla Token 与面板密码哈希，属于敏感文件，不能上传公开仓库。下载必须完成后再核对文件可读性。

备份不包含原 TeslaMate 加密密钥。迁移时须通过独立安全渠道保留原 `TESLAMATE_ENCRYPTION_KEY`，否则需要重新授权 Tesla。数据库密码与 Tesla Token 加密密钥不是同一项。

## 恢复

网页不接受恢复上传。在 Docker 主机仓库目录使用 Python 3.12 或更新版本运行：

```sh
python3 scripts/restore.py /private/path/backup.tar.gz --confirm-overwrite --confirm-encryption-key
```

两个确认参数表示：你要覆盖当前数据库，且已保留原 Tesla 加密密钥或计划重新授权。只允许恢复自己信任的备份；SQL dump 本身可以包含可执行 SQL，格式检查不能证明来源可信。

流程会检查归档成员与大小、验证账号配置、停止面板和采集，在 `data/restore-backups/时间戳/` 保存恢复前数据，然后用 `pg_restore --single-transaction --exit-on-error` 恢复。SQL 失败会回滚数据库，服务随后恢复运行。数据库与账号文件不是一个事务；若最后的角色初始化或账号文件写入失败，保留恢复前文件并按错误信息人工核对，不能重复盲目导入。

默认限额：压缩包 512 MiB，数据库成员 2 GiB，账号和 manifest 各 1 MiB。更大数据应采用单独评估的数据库维护方案。不要在公共下载目录保存恢复前备份。

## 验证

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --check app/static/app.js
node --check app/static/account.js
# 安装 Playwright Chromium 或设置 BROWSER_EXECUTABLE 为本机浏览器路径
python tests/browser_smoke.py
```

数据库角色初始化使用 `scripts/configure-panel-db.sh`，仅用于标准 TeslaMate 数据库名 `teslamate`。自定义数据库部署应先适配该脚本再升级。
