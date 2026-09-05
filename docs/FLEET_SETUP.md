# Fleet 车辆控制接入

管理员从个人中心点击「配置控制」，在接入页保存客户端 ID、客户端密钥和地区，完成应用注册、Tesla 授权和虚拟钥匙配对。中国大陆车辆使用 developer.tesla.cn 的应用。已有配置会显示保存状态，密钥不会回显。午休任务结束前不能替换控制凭据。

## 服务器准备

在 `.env` 设置 `FLEET_PUBLIC_ORIGIN=https://你的域名`（无末尾斜杠）。服务器需要向相应区域 Tesla 官方服务发起 HTTPS 请求。

```sh
docker compose build visualizer
docker compose run --rm --no-deps visualizer python -c 'from app.fleet import provision; provision()'
docker compose --profile control up -d --no-deps tesla-proxy visualizer
```

生成公钥的端点 `/.well-known/appspecific/com.tesla.3p.public-key.pem` 公开可读；签名代理没有宿主机端口。面板验证代理 TLS 证书与主机名。现有公钥存在而签名私钥缺失或不匹配时，准备命令拒绝覆盖，应先恢复原始私钥。

服务采用单 worker，与账号存储一致。OAuth state 十分钟过期，绑定管理员及浏览器登录会话，一次使用。配置变更会使待处理授权失效。令牌按需续期，刷新令牌轮换后立即落盘。访问日志关闭，避免记录回调的授权码；额外反向代理也不要记录此路径的查询参数。

## 备份和恢复

需要保留整个 `data/fleet/`（加密凭据及 master.key）、`data/tesla-proxy/`（签名私钥和 TLS 密钥证书）以及 `data/tesla-public-key.pem`，权限为目录 0700、文件 0600、所有者 1000:1000。凭据加密保护存储文件，但持有服务器文件读取权限的人仍可能同时获得解密密钥。

网页数据库导出不包含这些 Fleet 文件；迁移时使用服务器安全备份单独迁移，不可提交 Git 或公开下载。密钥丢失无法解密令牌；签名私钥丢失则需要生成新钥匙并重新注册和配对。

断开接入只清除本地凭据和令牌。彻底撤销需在 Tesla 账号撤销授权、车辆中移除虚拟钥匙。旧环境变量 CONTROL_API_URL / CONTROL_API_TOKEN 如仍配置，断开自建接入后仍会作为原有后端使用。

参考：
- https://developer.tesla.cn/docs/fleet-api/authentication/third-party-tokens
- https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries
- https://github.com/teslamotors/vehicle-command
