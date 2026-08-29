# TESLA Home

基于 TeslaMate 数据的自建可视化面板:FastAPI + psycopg3 后端,ECharts + Leaflet 前端,只读访问 TeslaMate 的 PostgreSQL 数据库。

## 功能

- 行程轨迹地图(Leaflet,按天分组、可折叠行程列表,点击查看详情并缩放)
- 活动时间线:行驶 / 充电 / 哨兵 / 驻车耗电 分段展示
- 电量趋势、哨兵耗电曲线,支持「电量 % ⇄ 里程 km」切换
- 充电费用录入与计价(行程/哨兵/驻车事件按最近充电单价估算费用)
- 胎压、能耗等指标,移动端适配

## 部署

```bash
cp docker-compose.example.yml docker-compose.yml
# 编辑 docker-compose.yml,填入数据库密码与面板账号
docker compose up -d --build
```

需要与 TeslaMate 部署在同一台机器(复用其 `teslamate_default` 网络,通过 `database` 别名访问 PostgreSQL)。

### 配置项

| 环境变量 | 说明 |
|---|---|
| `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_USER` / `DATABASE_PASS` / `DATABASE_NAME` | TeslaMate PostgreSQL 连接信息 |
| `DISPLAY_TZ` | 展示时区,默认 `Asia/Shanghai` |
| `VISUALIZER_USERS` | HTTP Basic Auth 账号,格式 `user:pass,user2:pass2`(密码可含冒号,取首个冒号分割);每 IP 10 分钟内 10 次失败锁定 5 分钟,`/api/health` 豁免 |

## 说明

- 哨兵模式推断:特斯拉不直接上报哨兵状态,面板用「驻车清醒 ≥30 分钟 + 非空调 + 不在行驶/充电区间」推断。
- 用户录入的充电费用保存在 `data/charge_costs.json`(未纳入版本管理)。
