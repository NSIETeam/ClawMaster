# ClawMaster 产品官网

官网地址：https://nsieteam.github.io/ClawMaster/ 。本目录是直接发布的静态 HTML、CSS 与 JavaScript，无需安装桌面应用依赖。

`guide.html` 提供十节 WatchDog 详细教程，包含虚构客户记录的完整练习、审批、验收、重复检查与故障恢复。

当前介绍 ClawMaster WatchDog 0.2.0-release，程序版本为 0.2.0。下载来自 `NSIETeam/ClawMaster-Desktop`；产品范围以该发布版本的发行说明及 `frontends/dsh/README.zh.md` 为依据。CRM/ERP 为本机单用户记录，企业组织权限、外部业务系统和通讯平台的接入需继续验证。

## 更新与发布

1. 从目标 GitHub Release 核实版本、附件名称、字节数与 SHA-256，更新 `release-manifest.json` 和 `index.html`。HTML 保留完整下载链接和校验值，禁用 JavaScript 也可使用。
2. 运行 `node --check site/app.js`、`node scripts/verify-product-site.mjs` 和 `git diff --check`。再通过本地静态服务器检查桌面、手机、页面锚点、校验值复制和禁用 JavaScript 时的下载入口。
3. 推送至本仓库 `main` 后，由 `.github/workflows/pages.yml` 验证并发布 GitHub Pages。确认部署成功后核对线上 HTML、清单和下载地址。

`pages.yml` 是当前官网的发布入口。旧 Tauri 预览工作流仅发布旧应用附件，不再部署产品官网；`scripts/render-release-site.mjs` 的 schema 1 清单属于旧版安装包流程，不能用于此站点。

## 品牌与截图

`assets/clawmaster.svg`、`assets/clawmaster-dark.svg` 原样复用 0.2.0 桌面的透明矢量图标。`assets/watchdog-workspace.png` 来自同版本生产界面的隔离验收环境，不含业务资料；首页流程卡片明确标注为示意。官网白色背景与桌面产品保持一致。

## 本次验证范围

官网只涉及静态内容与轻量浏览器交互。采用站点发布检查及真实浏览器验证，不执行旧应用的全量测试；稀疏工作副本中的 `npm run doctor` 会报告未取出的旧工作区和未安装的应用开发依赖，不能作为桌面软件验证结果。
