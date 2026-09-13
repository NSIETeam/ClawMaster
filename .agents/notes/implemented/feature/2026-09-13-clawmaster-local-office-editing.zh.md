# Agent Note: ClawMaster 本地 Office 编辑

Status: implemented

[English](2026-09-13-clawmaster-local-office-editing.md) | 中文

## 问题

Office 文件需要在任务内编辑并可靠保存。独立文档服务会增加部署要求。

## 决策

[Office 组合包](../../../../frontends/office/README.zh.md)在 Better Sidebar 注册 DOCX、XLSX 和 PPTX 查看器。每个 iframe 持有一份文档，使用固定的 onlyoffice-web-local release-8 编辑器与本地 WebAssembly 转换。DSH 现有 WebServer 和 connection 认证提供已校验资源，不引入第二个服务器。HTML 资源策略将连接限制在同源范围内。

显式准备下载由 SHA-256 固定的归档。构建保持离线，并拒绝过期资源或本地依赖链接。分发保留 AGPL-3.0-only 条款、ONLYOFFICE 声明及对应源码入口；ClawMaster 品牌调整不取消这些义务。

原生空闲回调缺失会中断 WebKit 初始化，此时编辑器 iframe 使用定时器。资源准备检查 Chromium 内存采样能力并修正演示文稿主题 URL，保留认证、路径检查和法律标记。

保存保留磁盘根目录或 UNC 的绝对路径，复用侧栏上传，并携带打开时文件字节的强 SHA-256 `If-Match`。串行提交在收完请求体后重新检查文件。HTTP 412 保留已变化的磁盘内容；未确认或失败的保存保留当前查看器中的草稿，绝不确认成功。只有确认写入后才推进版本。

[桌面壳决策](2026-09-12-clawmaster-shell-over-dsh.zh.md)继续负责运行时、Session 和侧栏存续时间。Office 保存机制补充这些决策。

工具栏的未保存与保存状态交给现有侧栏宿主。标签实例持有关闭守卫，在关闭、替换、刷新或原位切换文件前复用页面内对话框；取消和重复请求都会保留 iframe。编辑器自带的保存按钮保留相同版本校验。应用退出和跨分栏重新挂载前仍须先保存。

## 考虑过的替代方案

**外部文档服务器。** 本地转换避免额外维护部署。

**仅预览渲染。** 它不提供 Office 编辑。

## 后果

资源在压缩前增加约 178 MiB。草稿只在所属查看器存续期间保留，不提供崩溃恢复。版本检查不承诺对其他文件系统进程进行原子比较。

[浏览器验收](../../../../frontends/office/tests/browser.test.mjs)验证三种格式的真实编辑、磁盘字节、重新打开与冲突，并保留 Word 表格、PowerPoint 文本及 Excel 公式和计算值。复杂排版、宏、加密文件与旧版二进制格式尚未验证。
