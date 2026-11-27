# 部署手册

本文覆盖三件事：

1. 把 `web/` 行情站点部署到一台 Linux 服务器；
2. 配置 GitHub Actions，让每次 `main` 更新自动构建未签名 IPA；
3. 在本机或 CI 里构建、签名、安装 iOS App，并配置 CarPlay。

所有密码、App Key、MFi 私钥都不进 Git。生产凭据只放在服务器环境变量、本地 `tools/deploy.env` 或 GitHub Secrets 中。

---

## 一、部署 Web 站点

### 1.1 服务器要求

- Linux（推荐 Ubuntu 22.04 / Debian 12），x86_64 或 arm64
- Python 3.11+
- nginx
- systemd
- 一个指向服务器的域名；没有域名也可以先用 IP + HTTP 验证
- 服务器可访问外网，用于拉取行情/新闻数据

生产参考路径：

```text
站点目录：/www/wwwroot/stock-site
服务名：stock-site
监听：127.0.0.1:8100
公网入口：https://api.wisdomhqq.top/stocks/
```

### 1.2 拉取代码

```bash
sudo mkdir -p /www/wwwroot
cd /www/wwwroot
git clone https://github.com/wisdom877/StocksLive.git
cd StocksLive

# 只把 web/ 作为站点根目录，原生 App 源码不需要部署
sudo ln -sfn /www/wwwroot/StocksLive/web /www/wwwroot/stock-site
```

> 仓库是私有的，服务器上需要配置 GitHub Deploy Key 或 Personal Access Token。更简单的做法是在本地打包 `web/` 后用 `rsync` 上传。

### 1.3 创建虚拟环境

```bash
cd /www/wwwroot/stock-site
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
```

`requirements.txt` 只包含 Web 运行依赖：

```text
fastapi
uvicorn[standard]
requests
```

部署/巡检工具额外需要：

```bash
./venv/bin/pip install -r ../tools/requirements.txt
```

### 1.4 初始化运行数据

站点第一次启动会自动创建：

```text
data/secret       # 会话签名密钥
data/auth.json    # 登录密码哈希
data/appkey       # APK / 快捷指令长期密钥
data/*.db         # 行情、ETF、自选等 SQLite 数据库
```

这些文件全部被 `.gitignore` 排除，不会从 Git 覆盖。

如果要固定初始登录密码，在 systemd 里设置 `STOCK_SITE_PASSWORD`；不设置则随机生成并打印到日志：

```bash
sudo journalctl -u stock-site -n 50 --no-pager | grep '初始化登录密码'
```

登录后建议在页面里改密码。`data/` 权限收紧：

```bash
chmod 700 data
chmod 600 data/secret data/auth.json data/appkey
```

### 1.5 systemd 服务

创建 `/etc/systemd/system/stock-site.service`：

```ini
[Unit]
Description=StocksLive Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/www/wwwroot/stock-site
EnvironmentFile=/etc/stockslive.env
ExecStart=/www/wwwroot/stock-site/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8100 --workers 1
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

创建 `/etc/stockslive.env`（权限 `600`，不要提交进 Git）：

```bash
sudo tee /etc/stockslive.env >/dev/null <<'EOF'
STOCK_SITE_PASSWORD=替换成你的初始密码
EOF
sudo chmod 600 /etc/stockslive.env
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stock-site
sudo systemctl status stock-site --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8100/
```

`--workers 1` 是刻意的：站点里有内存缓存、SSE 推送和 SQLite 写入，单进程最稳。

### 1.6 nginx 反向代理

站点挂在 `/stocks/` 下。创建 `/etc/nginx/conf.d/stockslive.conf`：

```nginx
server {
    listen 80;
    server_name api.wisdomhqq.top;

    client_max_body_size 32m;

    location /stocks/ {
        proxy_pass http://127.0.0.1:8100/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /stocks/static/ {
        alias /www/wwwroot/stock-site/static/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        access_log off;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I http://127.0.0.1/stocks/
```

如果站点直接挂在根路径 `/`，把 `location /stocks/` 改成 `location /`，`proxy_pass` 末尾的 `/` 去掉。

### 1.7 HTTPS

用 certbot：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.wisdomhqq.top
sudo certbot renew --dry-run
```

证书续期后 nginx 会自动 reload。iOS App 的 `WebViewController` 默认加载 HTTPS 地址；如果继续用 HTTP，需要在 `App/Info.plist` 的 ATS 例外里加域名，否则 WKWebView 白屏。

### 1.8 首次验收

```bash
curl -s https://api.wisdomhqq.top/stocks/ | grep 'app-base'
curl -s -o /dev/null -w '%{http_code}\n' https://api.wisdomhqq.top/stocks/static/style.css
```

浏览器打开：

```text
https://api.wisdomhqq.top/stocks/
```

检查登录、持仓、行情、待机页六页、CarPlay 第 7 页。

### 1.9 数据库备份

SQLite 文件在 `data/`。建议每天低峰期备份：

```bash
sudo crontab -e
```

加入：

```cron
10 4 * * * cd /www/wwwroot/stock-site && ./venv/bin/python scripts/backup_db.py >> data/backup.log 2>&1
```

或直接打包：

```bash
tar czf /root/stock-site-data-$(date +%F).tgz \
  -C /www/wwwroot/stock-site data/*.db data/auth.json data/appkey data/secret
```

不要把备份放进 Git。

### 1.10 日志与排障

```bash
sudo journalctl -u stock-site -f
sudo tail -f /www/wwwroot/stock-site/data/service.log
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
```

常见问题：

| 现象 | 排查 |
| --- | --- |
| 502 Bad Gateway | `systemctl status stock-site`；确认监听 `127.0.0.1:8100` |
| 页面白屏但 HTML 200 | 看浏览器 Console；确认 `/stocks/static/*.js` 200 |
| 登录后立刻退出 | `data/secret` / `auth.json` 权限或 cookie 域名 |
| 行情不刷新 | 服务器出网、数据源限流、`data/*.db` 可写 |
| 待机页没有数据 | 看 `/api/v1/...` 请求与 `service.log` |
| SSE 断流 | nginx `proxy_buffering off`、`proxy_read_timeout` |

---

## 二、用仓库脚本部署 Web

仓库里的 `tools/deploy2.py` 做三件事：上传前语法闸门、上传后 MD5 回读、可选重启服务。

### 2.1 配置

```bash
cd /path/to/StocksLive
cp tools/deploy.env.example tools/deploy.env
```

编辑：

```bash
STOCK_HOST=106.53.132.252
STOCK_PORT=22
STOCK_USER=root
STOCK_PASSWORD=你的服务器密码
STOCK_REMOTE=/www/wwwroot/stock-site
```

`tools/deploy.env` 已被 `.gitignore` 排除。脚本不会把密码写进仓库。

### 2.2 命令

```bash
source tools/deploy.env

python3 tools/deploy2.py check      # 只检查：JS 重名、JS/Python 语法
python3 tools/deploy2.py static     # 只传前端，不重启
python3 tools/deploy2.py backend    # 传 Python + 重启 + 健康检查
python3 tools/deploy2.py all        # backend + static
python3 tools/deploy2.py logrotate  # 安装日志轮转
```

本地依赖：

```bash
pip install -r tools/requirements.txt
```

`deploy2.py` 默认从仓库的 `web/` 取文件；如果站点目录结构不同，改 `tools/deploy.env` 的 `STOCK_REMOTE`，不要改脚本里的绝对路径。

### 2.3 回滚

前端每次上传会在远端保留上一版备份（脚本内 `backup` 逻辑）。后端回滚最稳的方式是：

```bash
cd /www/wwwroot/stock-site
git log --oneline -5
git checkout <上一个提交> -- .
sudo systemctl restart stock-site
```

或直接用数据库/代码备份恢复。数据库回滚前先停服务，避免 SQLite 写坏。

---

## 三、iOS App 构建

### 3.1 版本号

版本在 `project.yml`：

```yaml
MARKETING_VERSION: "1.0"          # 显示版本
CURRENT_PROJECT_VERSION: "1"      # 构建号，从 1 重新开始
```

改完执行 `xcodegen generate`，或直接跑 `build-ipa.sh`（脚本内部会生成工程）。

> 如果手机上还装着构建号 50 的旧包，iOS 不允许安装构建号更小的同 Bundle ID 包。先删除旧 App，再安装新包；或者临时把构建号调大。

Bundle ID：

```yaml
PRODUCT_BUNDLE_IDENTIFIER: com.example.stocks
PRODUCT_BUNDLE_IDENTIFIER: com.example.stocks.DndLiveWidget
```

扩展 ID 必须是 App ID + 后缀。自签前改成自己描述文件对应的 App ID。

### 3.2 本地构建

需要 macOS + Xcode 15+：

```bash
brew install xcodegen
cd /path/to/StocksLive
./build-ipa.sh
# 产物：build/StocksLive-unsigned.ipa
```

脚本会：

1. 检查 `xcodegen`、`xcodebuild`
2. 如果存在 `CARPLAY_CERT_B64 / CARPLAY_LEAF_B64 / CARPLAY_KEY_B64`，解码到 `App/CarPlay/Identity/`
3. 生成 `StocksLive.xcodeproj`
4. `xcodebuild archive`，关闭签名
5. 组装 `Payload/`，补齐手表图标，打 IPA

产物是**未签名**的，不能直接安装。

### 3.3 GitHub Actions 自动构建

工作流：`.github/workflows/build-ipa.yml`。

触发：

- push 到 `main`
- 手动 `workflow_dispatch`

流程：

```text
web-check（Ubuntu，5 秒）
  ├─ python3 -m compileall -q web
  └─ node --check web/static/app-*.js
        ↓
build（macOS 15 Intel，约 2–4 分钟）
  ├─ brew install xcodegen
  ├─ 注入三个 CarPlay Secret
  ├─ ./build-ipa.sh
  └─ upload-artifact: StocksLive-unsigned-ipa（保留 14 天）
```

下载：

```text
GitHub → Actions → 对应 run → Artifacts → StocksLive-unsigned-ipa
```

### 3.4 Secrets 配置

仓库 Settings → Secrets and variables → Actions → New repository secret：

```bash
base64 < App/CarPlay/Identity/certificate.p7b | tr -d '\n'   # CARPLAY_CERT_B64
base64 < App/CarPlay/Identity/leaf.cer        | tr -d '\n'   # CARPLAY_LEAF_B64
base64 < App/CarPlay/Identity/private.x963    | tr -d '\n'   # CARPLAY_KEY_B64
```

三个 Secret 缺一不可；缺了仍能构建，但运行时 CarPlay 会报“配件身份缺失”。

私钥只放在本机密码管理器 + GitHub Secrets。不要写进 README、Issue、聊天记录或 CI 日志。

### 3.5 签名与安装

未签名 IPA 用以下任一方式重签：

- Sideloadly：拖入 IPA，填 Apple ID 或 p12 + mobileprovision，勾选注入扩展。
- AltStore：同一套签名流程，7 天续签（免费 Apple ID）。
- Xcode：解压 `Payload/StocksLive.app`，用自己的 Team 重签；Widget 扩展会一起签。

安装后首次运行：

```text
设置 → 通用 → VPN 与设备管理 → 信任开发者证书
```

免费 Apple ID 7 天有效；付费开发者证书 1 年。Widget/锁屏扩展必须一起签，否则锁屏卡片不出现。

### 3.6 签名前置：Access WiFi Information

CarPlay 接收端要读当前 Wi-Fi SSID：

1. Apple Developer → Certificates, Identifiers & Profiles → Identifiers
2. 选择 `com.example.stocks`
3. 勾选 **Access WiFi Information**
4. 重新生成 mobileprovision
5. 用新描述文件重签

`App/StocksLive.entitlements` 已包含：

```xml
<key>com.apple.developer.networking.wifi-info</key>
<true/>
```

没有这个权限时，App 读不到 SSID，CarPlay 页会退化为手动输入 Wi-Fi。

---

## 四、CarPlay 接收端

### 4.1 它怎么工作

```text
iPhone（发送端） ── Wi-Fi ──> 本机 App（接收端）
                               ├─ CoreAccessories 虚拟配件端点
                               ├─ iAP2 0xAA00 证书链 / 0xAA05 认证
                               ├─ RTSP + H.264
                               └─ AVSampleBufferDisplayLayer + 触控回传
```

接收端必须有一个可被发送端路由到的局域网 IPv4，并监听 RTSP/媒体端口。因此：

- 可以用路由器、车机 Wi-Fi、另一台手机热点；
- 网络可以完全没有互联网；
- **不能**用本机自己开热点替代加入 Wi-Fi；
- **不能**用蜂窝数据替代；
- 同一台 iPhone 既当发送端又当接收端，USB 也不行（host/device 角色冲突）。

### 4.2 启动顺序

1. iPhone 加入一个 Wi-Fi；
2. 打开 App → 待机第 7 页；
3. 长按 `Hello CarPlay!` 1 秒；
4. 首次会弹 Wi-Fi 凭据层；已保存则直接启动；
5. 画面出现后，原生关闭叉号在 CarPlay 圆角界面外侧右上。

### 4.3 验证日志

Xcode Devices → Console，过滤 `[CarPlay]`。正常链路应出现：

```text
0xAA00 → 0xAA05 → 0x1D02 → 0x4300 → RECORD
```

只看到 `0xAA00` 就停：检查证书链、私钥、设备时间、Wi-Fi 是否同一网段。
看到 `RECORD` 但没有画面：检查 H.264 解码、`AVSampleBufferDisplayLayer`、内存压力。

### 4.4 合规边界

- 上游 CarWithin 为 AGPL-3.0-only，核心文件 GPL-3.0-or-later；再分发前确认许可证义务。
- MFi 证书/私钥只用于本机自签测试，不要公开分发 IPA。
- App 使用私有 `CoreAccessories` 接口，系统升级可能失效。

---

## 五、日常发布流程

### Web 更新

```bash
git pull
source tools/deploy.env
python3 tools/deploy2.py check
python3 tools/deploy2.py static    # 只改前端
# 改了 Python 再执行 backend
```

### iOS 更新

```bash
# 改代码
# 改 project.yml 的 CURRENT_PROJECT_VERSION（递增）
git add -A
git commit -m "feat: ..."
git push origin main
```

推送后：

1. GitHub Actions 自动跑 `web-check`；
2. 通过后 macOS runner 构建 IPA；
3. 下载 Artifact；
4. 自签安装。

### 发布检查清单

- [ ] `web-check` 绿
- [ ] IPA 构建绿
- [ ] 新构建号大于已安装版本，或先卸载旧 App
- [ ] CarPlay 第 7 页长按可启动
- [ ] 待机六页数据正常
- [ ] 登录、行情、持仓页面正常
- [ ] 服务器 `data/` 已备份
- [ ] 没有把 `Identity/`、`auth.json`、`appkey`、keystore、`deploy.env` 提交进 Git

---

## 六、故障速查

| 问题 | 处理 |
| --- | --- |
| Actions 找不到 Secret | Settings → Secrets 检查三个名字完全一致 |
| `xcodegen: command not found` | 本地 `brew install xcodegen`；CI 已自动安装 |
| IPA 安装提示版本更低 | 删除旧 App，或提高 `CURRENT_PROJECT_VERSION` |
| App 白屏 | 检查 `WebViewController.homeURL`、ATS 例外、HTTPS 证书 |
| 待机长按没反应 | 强制退出 App 重开；确认最新 JS 已加载；看 Console 报错 |
| CarPlay 启动失败 | 看第 7 页小字提示；常见是未连 Wi-Fi、缺 Identity、App ID 没开 WiFi 权限 |
| 服务器 502 | `systemctl status stock-site`；`curl 127.0.0.1:8100` |
| 数据库锁 | 确认只有一个 uvicorn worker；停服务后备份/恢复 |
| nginx 静态 404 | `alias` 路径必须指到 `web/static/`，末尾带 `/` |
