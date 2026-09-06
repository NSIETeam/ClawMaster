# 目标

把历史上分散且互相重叠的 #1、#2、#3、#4、#6、#8、#10、#11、#12、#13、#14、#15、#16、#17 收敛为一次可完成、可复现的 Beta 发布验收。

本 Issue 是下一版 Beta 的唯一 GitHub Issue 发布门禁。原 Issue 的长期愿景与外部验收不会丢失，已归档到 `docs/acceptance/open-issue-scope-audit.md` 及对应架构文档；它们不再以不可获得的账号、客户、证书或无限产品范围阻塞 Beta。

## 本次必须完成

- [ ] Tauri 是 Windows x64 与 macOS ARM64 唯一生产壳；安装后能启动、退出且没有孤儿进程。
- [ ] 至少一个 OpenAI-compatible 真实模型在最终安装包中完成流式回复；密钥只进入系统凭据库，日志、配置、产物和 Issue 证据不含 secret。
- [ ] Rust 主链完成模型、只读工具、需审批写工具、拒绝、取消和失败的用户可见闭环；production 不可达固定回显或假模型。
- [ ] 用户目录、项目/会话归类、记忆 recall/forget、StateCapsule 和 UsageLedger 的聚焦回归通过；路径逃逸与明文凭据被拒绝。
- [ ] CapabilityHost 对签名、哈希、平台、权限和安装确认 fail closed；未提供生产能力包时明确显示 unavailable，不伪造完成。
- [ ] Native RPA 在 Windows 与 macOS 的已安装应用中各完成一次可视系统浏览器点击；副作用前审批，取消无孤儿进程，回执和 audit 可追溯。
- [ ] 五个平台入口使用独立加密浏览器会话并按需显示；文件、导图、版本、浏览器等右侧模块未使用时不占据界面。缺少 HTTPS、租户授权或真实 Connector 时显示 blocked，不宣称已接通。
- [ ] CompanyOS 当前 P0 vertical slice 的确定性测试通过；真实 Design Partner、全量 OPC/DSH 和所有外部 Provider 属于后续路线图。
- [ ] Windows NSIS 与 macOS ARM64 DMG 来自同一干净 commit 和 lockfile。单个平台安装包以 20 MiB 为优化目标；超过目标必须给出组成报告，但 Beta 是否阻断由可运行性与明确批准决定，不以未经验证的 10 MiB 假目标卡死。
- [ ] 最终 commit 通过 doctor、diff check、相关单测、Rust 全套测试、typecheck、lint、boundary、code-map 和 Beta artifact gate。
- [ ] 从 GitHub 下载后的两个资产与 SHA256SUMS 一致；GitHub Release 与 Pages 下载页指向同一版本。
- [ ] 只做一次汇总 push；该 push 的 CI 全绿且上述安装态证据齐全后，才创建并发布 Beta tag。

## 不作为本次 Beta 门禁

- 运行时自动改写、候选接管、原子自升级与崩溃自动回滚的完整闭环；未实现命令必须 fail closed。
- 覆盖 DeepSeek Harness 的全部公开、可选和实验功能。
- CompanyOS 的所有部门、ERP/CRM/财务替代、全部外部 Provider 或真实 Design Partner 经营结果。
- 同时持有 OpenAI-compatible、Anthropic、Gemini 三套真实账号；本次只要求一个真实 Provider，其他 adapter 用 fixture/contract 验证。
- 50K/10K 基准、精确 40% Token 降幅、500-turn soak、24/72 小时观察窗。
- Windows Authenticode、macOS Developer ID/notarization/staple；这些是 stable 发布门禁，Beta 必须明确标记 prerelease 和签名状态。
- 在缺少第三方账号、HTTPS endpoint 或 staging tenant 时伪造企微、飞书或五平台生产验收。

## 关闭条件

只有上方“本次必须完成”全部有 commit、测试命令、CI run、安装包 hash 和安装态结果时才关闭。本 Issue 关闭后方可发布；发布失败则重新打开。
