# 黄杨工作台 · StocksLive

一个单仓库项目：**iOS 原生壳 + 行情/工作/待机 Web 前端 + 本机 CarPlay 接收端**。

- iOS App：Swift + WKWebView，承载行情页面、健康/专注/日程、待机页和本机 CarPlay。
- Web 前端：FastAPI + 原生 JS（无构建步骤），入口 `web/app.py`。
- CarPlay：私有 `CoreAccessories` 虚拟配件端点，走 iAP2 认证与 RTSP/H.264，画面由 `AVSampleBufferDisplayLayer` 显示。
- CI：GitHub Actions 在每次 `main` 分支更新后自动构建**未签名 IPA**，产物在 Actions Artifact 中下载。
- 当前构建号从 **1** 重新开始；完整上线步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

> 仓库是私有仓库：<https://github.com/wisdom877/StocksLive>。MFi 配件证书/私钥**不入库**，只通过 GitHub Actions Secrets 注入。

## 目录

```
.
├── App/                     # iOS 原生壳、WebViewController、CarPlay 接收端
│   └── CarPlay/             # 协议栈、身份加载、接收器、协调器（Identity 不入库）
├── Shared/  Widget/         # 共享代码与手表/小组件
├── web/                     # FastAPI 行情站点
│   ├── app.py               # 主入口
│   ├── static/              # 无构建 JS / CSS / 图片
│   ├── scripts/  tests/     # 数据任务与测试
│   └── android/             # WebView APK 模板（签名库与构建产物不入库）
├── tools/                   # 部署、页面走查、CSS 清理等脚本
├── project.yml              # XcodeGen 工程定义
├── build-ipa.sh             # 本地/CI 一条命令产出未签名 IPA
└── .github/workflows/       # GitHub Actions
```

## 部署手册

完整版：[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)，包含服务器 systemd/nginx/HTTPS、数据库备份、`deploy2.py`、GitHub Actions、签名和 CarPlay 排障。

## IPA 自动构建

工作流：`.github/workflows/build-ipa.yml`

- 触发：推送到 `main`，或手动 `workflow_dispatch`
- Runner：`macos-15-intel`
- 步骤：安装 `xcodegen` → 注入 CarPlay 身份 → `./build-ipa.sh` → 上传 Artifact
- 产物：`StocksLive-unsigned-ipa` 中的 `StocksLive-unsigned.ipa`

需要在仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 内容 |
| --- | --- |
| `CARPLAY_CERT_B64` | `certificate.p7b` 的 Base64 |
| `CARPLAY_LEAF_B64` | `leaf.cer` 的 Base64 |
| `CARPLAY_KEY_B64` | `private.x963` 的 Base64 |

生成 Base64：

```bash
base64 < App/CarPlay/Identity/certificate.p7b | tr -d '\n'
base64 < App/CarPlay/Identity/leaf.cer        | tr -d '\n'
base64 < App/CarPlay/Identity/private.x963    | tr -d '\n'
```

本地构建：

```bash
brew install xcodegen
./build-ipa.sh
# 产物：build/StocksLive-unsigned.ipa
```

IPA 未签名，需用 Sideloadly / AltStore / 自己的证书重签后安装。

## 本地运行 Web

```bash
cd web
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
STOCK_SITE_PASSWORD=你的密码 uvicorn app:app --host 127.0.0.1 --port 8099
```

打开 `http://127.0.0.1:8099/`。首次启动会生成 `web/data/secret`、`auth.json`、`appkey`，这些文件已在 `.gitignore` 中排除。生产环境由 nginx 反代 `/stocks/`，服务监听 `127.0.0.1:8099`。

## 部署 Web

部署脚本只上传代码和静态资源，不覆盖线上数据库：

```bash
cp tools/deploy.env.example tools/deploy.env
# 编辑 tools/deploy.env，填入主机、账号、密码
source tools/deploy.env
python3 tools/deploy2.py check
python3 tools/deploy2.py static   # 仅前端，不重启
python3 tools/deploy2.py backend  # Python + 重启 + 健康检查
```

`tools/deploy.env` 已被忽略，不要把密码提交进仓库。

## CarPlay 说明

本机 CarPlay 接收端需要 iPhone 实际加入一个 Wi-Fi 网络，网络可以没有互联网，也可以是车机 Wi-Fi、路由器或另一台手机的热点；**自己开热点不能替代**加入 Wi-Fi 这一步。具体原因和替代方案见 `App/CarPlay/README.md`。

## 安全

- 不提交：`App/CarPlay/Identity/`、`web/data/` 运行库与密钥、`web/android/*.keystore`、`tools/deploy.env`。
- 所有生产密码、App Key、MFi 私钥都通过环境变量或 GitHub Secrets 注入。
- 仓库保持私有；如需公开，先确认代码中的第三方许可证与 MFi 合规边界。
