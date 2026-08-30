# TESLA Home

特斯拉车辆数据一体化自托管方案:**TeslaMate**(数据采集)+ **TESLA Home 面板**(可视化),一个 `docker compose` 全部搞定。

面板基于 TeslaMate 数据库构建:FastAPI + psycopg3 后端,ECharts + Leaflet 前端,只读访问 PostgreSQL。

## 功能

**面板**
- 车辆总览:Model Y 俯视图、能量占比环形图(按充电周期划分:剩余/行驶/哨兵/驻车空调/驻车耗电)、电池健康、胎压
- 行程轨迹地图:按天分组、可折叠行程列表,点击查看详情并缩放
- 活动时间线:行驶 / 充电 / 哨兵 / 驻车耗电 分段展示
- 充电详情与充电桩统计:充电量、损耗、费用、每公里成本
- 充电费用录入与计价(行程/哨兵/驻车事件按最近充电单价估算)
- 电量趋势、哨兵耗电曲线、能耗、车内/车外温度
- 电量 % ⇄ 度数 kWh ⇄ 里程 km 三态切换
- 移动端适配、深色/浅色主题

**一体化部署**
- 单 compose 编排:TeslaMate + PostgreSQL + MQTT + 面板(可选 Grafana、Caddy HTTPS)
- `setup.sh` 一键初始化(自动生成密钥与面板账号)
- 面板**个人中心**:自助完成 Tesla 账号授权(分步可视化指引)、修改密码、管理账号
- 镜像版本发布:ghcr.io 预构建镜像(amd64/arm64),tag 即发布

## 快速开始(全新机器)

前置:已安装 [Docker](https://docs.docker.com/engine/install/) 与 Compose v2 插件。

```bash
git clone https://github.com/Savior2016/teslamate-visualizer.git
cd teslamate-visualizer
./setup.sh
```

脚本会:生成随机加密密钥与数据库密码 → 让你设置面板账号密码 → (可选)配置域名启用自动 HTTPS → 拉取镜像并启动全部服务。

启动后:

1. 打开面板 `http://<服务器IP>:8080`,用刚才设置的账号登录
2. 点右上角「**个人中心**」,按页面里的分步指引完成 **Tesla 账号授权**(见下)
3. 授权完成后数据自动开始累积,面板逐步出报表

### Tesla 账号授权(自助填写 Tesla 秘钥)

TeslaMate 通过 Tesla 官方 API 令牌连接车辆。整个过程在面板「个人中心」有实时状态指引:

1. **获取令牌**:iPhone/Mac 用 App Store 的「Auth app for Tesla」;Windows/macOS/Linux 用 [Tesla Auth](https://github.com/adriankumpf/tesla_auth)。用 Tesla 账号登录后复制 Access Token 与 Refresh Token
2. **粘贴令牌**:打开 TeslaMate 管理页 `http://<服务器IP>:4000`,在登录页粘贴两个令牌并保存
   - 公网服务器上 4000 默认只监听本机回环,先建隧道:`ssh -L 4000:127.0.0.1:4000 用户@<服务器>`,再访问 `http://localhost:4000`
   - 家庭服务器/局域网:把 `.env` 里 `TESLAMATE_BIND` 改为 `0.0.0.0` 后 `docker compose up -d`
3. 个人中心的指引步骤会自动亮灯:授权 ✓ → 识别车辆 ✓ → 数据同步 ✓

令牌加密存储在你自己服务器的数据库里(`ENCRYPTION_KEY` 加密),不经过任何第三方。

### 修改面板密码 / 管理账号

面板右上角「**个人中心**」→ 修改密码 / 添加账号 / 删除账号,即刻生效,无需改配置、无需重启。

> 账号存于 `data/users.json`(pbkdf2_sha256 哈希)。`.env` 里的 `PANEL_USERS` 只在首次启动时播种,之后改它不再生效。

## 手动部署(不用 setup.sh)

```bash
cp .env.example .env
# 编辑 .env:TESLAMATE_ENCRYPTION_KEY(可用 openssl rand -hex 32 生成)、
#           POSTGRES_PASSWORD、PANEL_USERS
docker compose pull
docker compose up -d
```

可选服务(profile):

```bash
docker compose --profile grafana up -d   # TeslaMate 官方 Grafana 仪表盘(127.0.0.1:3000)
docker compose --profile https up -d     # Caddy 自动 HTTPS,先复制 Caddyfile.example 为 Caddyfile 并改域名
```

### HTTPS

1. 域名解析到服务器,安全组/防火墙放行 80 与 443
2. `cp Caddyfile.example Caddyfile`,把 `tesla.example.com` 换成你的域名
3. `docker compose --profile https up -d`,Caddy 自动签发并续期 Let's Encrypt 证书
4. 签证书成功后,可在 `.env` 把 `VISUALIZER_BIND` 改为 `127.0.0.1`(8080 不再直接对外),然后 `docker compose --profile https up -d`

登录认证由面板应用层完成(与 Caddy 无关),改密码在个人中心自助完成。

## 升级版本

```bash
# 面板升级到指定版本(版本号见 Releases):
sed -i 's|^VISUALIZER_IMAGE=.*|VISUALIZER_IMAGE=ghcr.io/savior2016/teslamate-visualizer:v1.0.0|' .env
# TeslaMate 升级:改 .env 的 TESLAMATE_VERSION(建议先备份数据库)
docker compose pull && docker compose up -d
```

## 配置项(.env)

| 变量 | 说明 |
|---|---|
| `TESLAMATE_ENCRYPTION_KEY` | Tesla API 令牌加密密钥,**首次生成后不要再改**,否则已保存的令牌无法解密 |
| `POSTGRES_PASSWORD` | 数据库密码 |
| `PANEL_USERS` | 面板初始账号 `user:pass`(仅首次启动播种,之后用个人中心管理) |
| `TZ` | 展示时区,默认 `Asia/Shanghai` |
| `VISUALIZER_BIND` | 面板监听地址,默认 `0.0.0.0`(应用层有登录认证) |
| `TESLAMATE_BIND` | TeslaMate 管理页监听地址,默认 `127.0.0.1` |
| `GRAFANA_BIND` | Grafana 监听地址,默认 `127.0.0.1` |
| `TESLAMATE_VERSION` 等 | 各镜像版本/标签 |

## 数据与备份

| 数据 | 位置 |
|---|---|
| 车辆遥测数据库 | docker 卷 `teslamate_teslamate-db` |
| 面板账号 / 充电费用 / 充电桩信息 / 瓦片缓存 | `./data/` |
| TeslaMate 数据导入目录 | `./import/` |
| HTTPS 证书 | docker 卷 `teslamate-visualizer_caddy_data` |

备份:`docker exec tesla-home-database-1 pg_dump -U teslamate teslamate | gzip > backup.sql.gz`,外加 `data/` 目录。

## 从旧版分立部署迁移(teslamate + teslamate-visualizer 两个项目)

一体化包的 docker 卷名与旧部署完全一致,数据原样保留:

1. 记下旧 `teslamate/docker-compose.yml` 里的 `ENCRYPTION_KEY`、`DATABASE_PASS`,和旧面板的 `VISUALIZER_USERS`
2. 在新目录按上面手动部署准备 `.env`,**填入相同的 ENCRYPTION_KEY 和数据库密码**(否则会话令牌无法解密、数据库认证失败)
3. 停旧项目:`docker compose -f 旧teslamate目录/docker-compose.yml down` 与旧面板项目 down
4. 新项目 `docker compose up -d`(旧面板 `data/` 目录整个复制过来可保留充电费用记录)
5. 若用 Caddy:新方案认证收归应用层,Caddyfile 用 `Caddyfile.example` 重新生成(不再含 basic_auth)

## 开发

```bash
# 面板从本地源码构建运行:
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# 发布版本(推 tag 触发 GitHub Actions,构建多架构镜像并推送 ghcr.io):
git tag v1.0.0 && git push origin v1.0.0
```

## 实现说明

- 哨兵模式推断:特斯拉不直接上报哨兵状态,面板用「驻车清醒 ≥30 分钟 + 非空调 + 不在行驶/充电区间」推断
- 能耗自校准:每理想续航公里电量由充电历史校准;停放耗电按「充电量 ÷ 表显电量增幅」校准(含充电损耗)
- 地图瓦片由本站同源代理(上游 OSM 官方瓦片,磁盘缓存),国内移动网络下也能出图
