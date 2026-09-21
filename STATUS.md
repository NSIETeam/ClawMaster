# ClawMaster 当前状态与协作指南

> 更新：2026-09-21。本文面向所有协作者，描述当前发布状态、已修复的稳定性缺陷、
> 验收工具与协作规则。**动手前请读完。**

## 一、发布状态

| 版本 | 状态 | 说明 |
|---|---|---|
| `desktop-v0.0.1-beta.3` | ✅ CI 全绿 | 当前最佳候选：含 CSP 白窗修复、src 裁剪、Cargo.lock 同步 |
| `desktop-v0.0.1-beta.1` | ⚠️ 勿分发 | 实测安装后白窗（CSP 缺 unsafe-eval + nonce 使样式失效） |
| `desktop-v0.2.x` 旧线 | 归档 | 内部历史线，勿基于它发新版 |
| 公开发布 | ⏸ 未发布 | beta.3 通过隔离安装验证后可挂 Release |

**发布门槛（强规则）**：任何版本发布前必须通过
`beta3-install-test.yml`（真实安装 → 真实浏览器渲染断言）。Node 侧测试
全绿不代表浏览器渲染正常——白窗事故两次由此漏过。

## 二、已修复的稳定性缺陷（勿回退）

1. **页面 CSP 白窗**：`packages/host/frontend-static`。旧实现从页面内容
   推导策略（哈希/nonce），前端一变就失配 → 白窗 + 插件样式被拦导致布局
   塌陷。已改为**静态常量策略**（allow eval/inline-styles/same-origin），
   结构上不可能再与前端失配。回归测试锁定于 frontend-static.spec.ts。
2. **会话历史一坏全坏**：旧版读取器把缺 id 的历史事件判为 corrupt，整个
   会话视图死亡。已改为：缺 id 就地修复、`gateway/internal` 内部事件豁免
   消息不变量。回归测试锁定于 session.spec.ts（78 用例）。
3. **飞书长连接卡死**：`@xmanrui/dsh-im` 三处默认值缺陷（看门狗默认关闭、
   回复超时 600s、重连 10 次后永久下线）。已改为 120s 看门狗 / 180s 回复
   超时 / 1000 次重连，任何卡点 ≤3 分钟。桌面补丁与 provenance 哈希已再生。
4. **loader 启动隔离**：单个坏插件 entry 不再杀死 host（启动期降级禁用 +
   醒目日志，下次启动重试）。

## 三、工具（全部零依赖，可直接运行）

| 工具 | 用途 |
|---|---|
| `apps/desktop-tauri/scripts/clawmaster-doctor.mjs` | 12 项健康快照（--json 机器可读），含 CSP 模式、bundle 可解析性、patch 合法性、会话统计、im 卡点、启动错误 |
| `~/.dsh/scripts/code-chaos-test.sh` | 代码级破坏测试：6 场景破坏后断言必要模块降级存活（APFS 克隆隔离，不碰生产目录） |
| `~/.dsh/scripts/chaos-test.sh` | 环境级破坏测试：8 项注入断言 doctor 全部识别 |
| `~/.dsh/scripts/clawmaster-maintenance.sh` | 自动会话治理（空会话/残留锁/失配缓存/30 天归档）+ 记忆摘要 30 天保留；launchd 每周日自动跑 |

**发版前必跑**：doctor（对产物环境）+ `beta3-install-test.yml` dispatch。

## 四、协作规则（血泪教训）

1. **单线发版**：`main` 目前对齐 0.2.3 发布线，`desktop-v0.0.1-*` 是公开发布
   线。曾有两条机器各自独立修同一批 bug 并互相覆盖 main——合并前先看
   对方分支。
2. **发布只走** `desktop-release.yml`（tag push 或 dispatch publish=true），
   版本校验/干净源校验/provenance 校验都在里面，绕过 = 白屏事故重演。
3. **改 frontend/CSP/会话格式必须加浏览器级断言测试**，Node 侧测试不够。
4. 破坏性实验一律在 worktree/克隆里做，完成后 `git worktree remove`。

## 五、已知未决事项

- [ ] `fix/csp-eval-and-inline-styles` 分支（beta.1 的 CSP 修复）待合并进
      主发布线后删除
- [ ] office 编辑器资源 178M（fonts 80M）是 mac dmg 超过 100M 的主因；
      字体子集化是达标路径，需产品确认可接受的字体损失范围
- [ ] `@openviking/dsh-memory-plugin` 依赖 DeepSeek key 的旧逻辑已兼容
      config/llm.json 覆盖（小米等 OpenAI 兼容后端可用 keychain_account），
      但管理界面的配置入口还没有
- [ ] 孤儿门禁引用清理：`tauri-node-runtime.yml`、`verify-tauri-node-runtime.mjs`、
      `sqlcipher-tauri/` 等被测试引用但文件从未提交（所有分支均无），相关
      测试应删除或补齐文件
- [ ] `codex/runtime-watchdog` 分支与 beta.3 修了重叠问题（fresh-install
      smoke、symlink），下次 rebase 时注意冲突

## 六、代码图谱（2026-09-21 审查）

对发布路径核心四包 + frontend-static（52 个源文件）做过文件级与符号级
死代码审查（esbuild metafile + 全仓引用比对），结论：**无死代码**。

- `session/invariant.ts`、`agent-loop/invariant.ts` 由 `sdk-minimal` bundle
  的 cordis patch 装载（`@deepseek-ai/dsh-session/invariant` 等子路径导出），
  非死代码
- `inject`/`apply`/`name` 为 cordis 插件协议导出，由框架调用
- `frontend-static` 已收敛为单文件包（静态 CSP 后无残留哈希工具）

新组件接入时请保持：每个 src 文件要么被同包 import，要么被 bundle patch
装载，要么是包 exports 子路径——三者之外即为死代码，提交前删除。
