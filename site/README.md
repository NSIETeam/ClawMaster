# ClawMaster 产品官网

官网地址：https://nsieteam.github.io/ClawMaster/ 。本目录是直接发布的静态 HTML、CSS 与 JavaScript，无需安装桌面应用依赖。

`updates.html` 提供 0.2.2 升级、服务器更新、组件生效与 macOS 微信逐次授权指南。`tutorials.html` 是教程中心，`office.html`、`development.html`、`personal.html` 分别提供办公、开发与个人管理的独立教程。`guide.html` 保留十节 WatchDog 企业工作跟进教程；`android.html` 提供安卓安装、模型配置、数据保留与测试范围说明。桌面旧教程和截图保留 0.2.0 来源标注，不作为新版截图证据。首页和各篇教程提供互相导航；每篇包含可复制示例、操作步骤和结果核验方法。

当前介绍 ClawMaster 桌面 0.2.2 与安卓独立 Agent 0.2.2。下载来自 `NSIETeam/ClawMaster-Desktop`；产品范围以该发布版本的发行说明及 `frontends/dsh/README.zh.md` 为依据。CRM/ERP 为本机单用户记录，企业组织权限、外部业务系统和通讯平台的接入需继续验证。

## 更新与发布

1. 从目标 GitHub Release 核实版本、附件名称、字节数与 SHA-256，更新 `release-manifest.json` 和 `index.html`。HTML 保留完整下载链接和校验值，禁用 JavaScript 也可使用。
2. 运行 `node --check site/app.js`、`node --test scripts/verify-product-site.test.mjs`、`node scripts/verify-product-site.mjs`、`node scripts/verify-product-site.mjs site --online` 和 `git diff --check`。再通过本地静态服务器检查桌面、手机、页面锚点、校验值复制和禁用 JavaScript 时的下载入口。
3. 推送至本仓库 `main` 后，由 `.github/workflows/pages.yml` 验证并发布 GitHub Pages。确认部署成功后核对线上 HTML、清单和下载地址。

`pages.yml` 是当前官网的发布入口。旧 Tauri 预览工作流仅发布旧应用附件，不再部署产品官网；`scripts/render-release-site.mjs` 的 schema 1 清单属于旧版安装包流程，不能用于此站点。当前清单 schema 4 通过 `releases.desktop` 与 `releases.android` 分别记录桌面和安卓发布信息；各资产的 `release` 指向其版本来源。四个桌面安装包使用 `desktop-v0.2.2`，安卓 APK 使用 `android-v0.2.2`，Intel Mac 不再列为新版本下载。官网下载区 `#intel-mac-policy` 说明集中维护 Apple Silicon 的发布取舍、历史版本入口及旧版不包含新修复的范围；升级指南链接到该说明。下载卡片以 `data-release-version` 的平台标识绑定各自版本，小于 1 MiB 的文件使用 KiB 展示。官网只引用已公开 Release，发布草稿不应提前上线链接。`--online` 会独立查询公开 GitHub Release，核对发布时间、附件名称、地址、字节数与摘要；默认 CI 执行离线站点检查。

## 品牌与截图

`assets/clawmaster.svg`、`assets/clawmaster-dark.svg` 原样复用 0.2.0 桌面的透明矢量图标。`assets/watchdog-workspace.png` 来自同版本生产界面的隔离验收环境，不含业务资料；首页流程卡片明确标注为示意，旧截图不改标为 0.2.2。官网白色背景与桌面产品保持一致。

## 本次验证范围

官网只涉及静态内容与轻量浏览器交互。采用站点发布检查及真实浏览器验证，不执行旧应用的全量测试；稀疏工作副本中的 `npm run doctor` 会报告未取出的旧工作区和未安装的应用开发依赖，不能作为桌面软件验证结果。
