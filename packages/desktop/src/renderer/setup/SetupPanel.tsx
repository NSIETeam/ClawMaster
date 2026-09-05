/**
 * @license
 * Copyright 2025 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * setup / BYO-key 图形引导（Issue #7）。
 *
 * 真实向导：品牌供应商下拉 → API key（掩码 + 粘贴）→ 模型 id → 显示名，
 * 本地实时校验后提交给 Rust runtime。模型元数据原子落盘，API key 只进入
 * macOS Keychain 或 Windows Credential Manager。
 *
 * 落盘闭环（固定契约，protocol.ts SaveCustomModelMsg）：
 *   submit() → 上层 onSave(payload) 发 `save_custom_model` 帧 →
 *   Rust 校验 + 凭据库写入 → 广播最新 `models_list`（=成功，App 关面板）
 *   或广播 `error(save_failed)`（=失败，App 把文案经 saveError 传回，面板内提示）。
 *   面板本身只负责采集 + 校验 + 提交 + 反映 saving/saveError 态，不直接碰 transport。
 *
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from 'clawmaster-server';
import { VoiceSettings } from '../components/VoiceSettings.js';
import {
  ClawMasterCrown,
  IconCheck,
  IconClose,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconWarning,
} from '../components/icons.js';
import {
  PROVIDER_PRESETS,
  PROVIDER_OPTIONS,
  findPreset,
  buildConfig,
  buildSavePayload,
  validateForm,
  effectiveModelIds,
  type CustomModelProvider,
  type SetupFormState,
  type SaveCustomModelPayload,
  vendorFromBaseUrl,
} from './presets.js';

export interface SetupPanelProps {
  presentation?: 'page' | 'panel';
  /** server 已知的现有模型（get_models 回包），用于展示「已配置」态。 */
  models: ModelInfo[];
  /** 落盘进行中（已发帧、等 models_list / error 裁决）。 */
  saving?: boolean;
  /** 落盘失败文案（save_failed）。null = 无错误。 */
  saveError?: string | null;
  /** 关闭面板。 */
  onClose: () => void;
  /** 提交一个自定义模型（发 `save_custom_model` 帧，由上层裁决成功/失败）。 */
  onSave: (payload: SaveCustomModelPayload) => void;
  /** 删除一个已配置模型（发 `delete_custom_model` 帧；成功后 models_list 广播刷新列表）。 */
  onDeleteModel?: (id: string) => void;
  /** 打开 Rust 原生企业消息凭据页。 */
  onOpenChannelSettings?: (provider: 'feishu' | 'wecom' | 'dingtalk') => void;
}

const DEFAULT_PRESET = PROVIDER_PRESETS[0];

function initialForm(): SetupFormState {
  return {
    presetId: DEFAULT_PRESET.id,
    provider: DEFAULT_PRESET.provider,
    baseUrl: DEFAULT_PRESET.baseUrl,
    apiKey: '',
    modelId: '',
    selectedModels: [],
    displayName: '',
    maxTokens: '',
    enabled: true,
  };
}

export function SetupPanel({
  presentation = 'page',
  models,
  saving = false,
  saveError = null,
  onClose,
  onSave,
  onDeleteModel,
  onOpenChannelSettings,
}: SetupPanelProps): React.JSX.Element {
  const [form, setForm] = useState<SetupFormState>(initialForm);
  // 删除二次确认：记录「已点过一次删除」的模型 id，再点同一个才真删。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [revealKey, setRevealKey] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const preset = findPreset(form.presetId) ?? DEFAULT_PRESET;

  const errors = useMemo(() => validateForm(form), [form]);
  const valid = Object.keys(errors).length === 0;
  const cfg = useMemo(() => buildConfig(form), [form]);

  // Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 打开设置页即把焦点落到 API key 输入框（向导核心动作）。
  // 页面化后不再需要遮罩焦点陷阱 / inert 隐藏兄弟节点。
  useEffect(() => {
    keyRef.current?.focus();
  }, []);

  const patch = (next: Partial<SetupFormState>): void => {
    setForm((f) => ({ ...f, ...next }));
  };

  const selectPreset = (id: string): void => {
    const p = findPreset(id);
    if (!p) return;
    patch({
      presetId: id,
      provider: p.provider,
      // 锁定 baseUrl 的预设直接填官方端点；custom 清空让用户填。
      baseUrl: p.baseUrlLocked ? p.baseUrl : '',
      // 换供应商 → 清空已选模型（不同家的模型 id 不通用）。
      selectedModels: [],
      modelId: '',
    });
  };

  const startEdit = (model: ModelInfo): void => {
    const matched = PROVIDER_PRESETS.find(
      (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === (model.baseUrl ?? '').replace(/\/+$/, ''),
    );
    setForm({
      presetId: matched?.id ?? 'custom',
      provider: model.provider as CustomModelProvider,
      baseUrl: model.baseUrl ?? '',
      apiKey: '',
      modelId: model.modelId ?? '',
      selectedModels: [],
      displayName: model.displayName,
      replaceId: model.id,
      maxTokens: model.maxTokens ? String(model.maxTokens) : '',
      enabled: model.enabled !== false,
    });
    setTouched({});
    setRevealKey(false);
  };

  const cancelEdit = (): void => {
    setForm(initialForm());
    setTouched({});
  };

  /** 勾选 / 取消一个示例模型（进出 selectedModels）。 */
  const toggleModel = (id: string): void => {
    setForm((f) => ({
      ...f,
      selectedModels: f.selectedModels.includes(id)
        ? f.selectedModels.filter((m) => m !== id)
        : [...f.selectedModels, id],
    }));
    markTouched('modelId');
  };

  /** 把输入框里的自定义模型 id 加入已选集合，并清空输入框。 */
  const addTypedModel = (): void => {
    const id = form.modelId.trim();
    if (!id) return;
    setForm((f) => ({
      ...f,
      modelId: '',
      selectedModels: f.selectedModels.includes(id)
        ? f.selectedModels
        : [...f.selectedModels, id],
    }));
    markTouched('modelId');
  };

  const markTouched = (field: string): void => {
    setTouched((t) => ({ ...t, [field]: true }));
  };

  // 粘贴：input 原生即支持 Cmd/Ctrl+V；额外提供「从剪贴板粘贴」按钮兜底
  // （某些环境右键菜单缺失时）。
  const pasteKey = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        patch({ apiKey: text.trim() });
        markTouched('apiKey');
      }
    } catch {
      // 剪贴板权限被拒：聚焦输入框让用户手动 Cmd+V。
      keyRef.current?.focus();
    }
  };

  const openConsole = (): void => {
    if (preset.keyConsoleUrl) {
      void window.clawmaster?.openExternal?.(preset.keyConsoleUrl);
    }
  };

  const submit = (): void => {
    setTouched({
      modelId: true,
      baseUrl: true,
      apiKey: true,
      displayName: true,
    });
    if (!valid || saving) return;
    // 按固定契约发 `save_custom_model` 帧；成功/失败由上层监听 models_list / error 裁决。
    onSave(buildSavePayload(form));
  };

  const showErr = (field: string): string | undefined =>
    touched[field] ? errors[field] : undefined;

  return (
    <section className={`claw-setup-page claw-setup-page--${presentation}`} aria-label="配置你的模型">
      <div className="claw-setup">
        <header className="claw-setup__head">
          <div className="claw-setup__brand">
            <ClawMasterCrown size={28} />
          </div>
          <div className="claw-setup__titles">
            <h2 className="claw-setup__title">配置你的模型</h2>
            <p className="claw-setup__subtitle">
              选择供应商，粘贴密钥，再选择模型。
            </p>
          </div>
          <button
            type="button"
            className="claw-setup__close"
            onClick={onClose}
            aria-label="返回对话"
            title="返回对话"
          >
            <IconClose size={15} />
          </button>
        </header>

        {models.length > 0 ? (
          <div className="claw-setup__models">
            <div className="claw-setup__models-head">
              <span className="claw-setup__existing-dot" aria-hidden />
              已配置 {models.length} 个模型
            </div>
            {models.map((m) => (
              <div key={m.id} className="claw-setup__modelrow">
                <span className="claw-setup__modelname">{m.displayName}</span>
                {/* 厂商按接入域名识别；provider 只是协议名（全是 openai 的观感问题）。 */}
                <span className="claw-setup__modelvendor">
                  {vendorFromBaseUrl(m.baseUrl, m.provider)}
                </span>
                <button
                  type="button"
                  className="claw-setup__modeledit"
                  aria-label={`编辑 ${m.displayName}`}
                  onClick={() => startEdit(m)}
                >
                  编辑
                </button>
                {onDeleteModel ? (
                  <button
                    type="button"
                    className={
                      'claw-setup__modeldel' +
                      (confirmDeleteId === m.id ? ' is-confirm' : '')
                    }
                    onClick={() => {
                      if (confirmDeleteId === m.id) {
                        setConfirmDeleteId(null);
                        onDeleteModel(m.id);
                      } else {
                        setConfirmDeleteId(m.id);
                      }
                    }}
                    onBlur={() => setConfirmDeleteId(null)}
                  >
                    {confirmDeleteId === m.id ? '确认删除？' : '删除'}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="claw-setup__body">
          {/* —— 供应商预设 —— */}
          <label className="claw-setup__label">供应商</label>
          <div className="claw-setup__presets">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  'claw-setup__preset' +
                  (p.id === form.presetId ? ' is-active' : '')
                }
                onClick={() => selectPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset.note ? (
            <p className="claw-setup__hint">{preset.note}</p>
          ) : null}

          {/* —— 协议（仅 custom 暴露）—— */}
          {!preset.baseUrlLocked || Boolean(form.replaceId) ? (
            <>
              <label className="claw-setup__label">协议</label>
              <select
                className="claw-setup__select"
                value={form.provider}
                onChange={(e) =>
                  patch({ provider: e.target.value as CustomModelProvider })
                }
              >
                {PROVIDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          {/* —— base URL —— */}
          {!preset.baseUrlLocked || Boolean(form.replaceId) ? (
            <>
              <label className="claw-setup__label">接口地址 (base URL)</label>
              <input
                className={'claw-setup__input' + (showErr('baseUrl') ? ' is-error' : '')}
                type="text"
                value={form.baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => patch({ baseUrl: e.target.value })}
                onBlur={() => markTouched('baseUrl')}
              />
              {showErr('baseUrl') ? <p className="claw-setup__err">{showErr('baseUrl')}</p> : null}
            </>
          ) : null}

          {/* —— API key（掩码 + 粘贴 + 显隐）—— */}
          <label className="claw-setup__label">
            API key
            {preset.keyConsoleUrl ? (
              <button
                type="button"
                className="claw-setup__linkbtn"
                onClick={openConsole}
              >
                <span>去获取</span>
                <IconExternalLink size={11} />
              </button>
            ) : null}
          </label>
          <div className="claw-setup__keyrow">
            <input
              ref={keyRef}
              className={
                'claw-setup__input claw-setup__keyinput' +
                (showErr('apiKey') ? ' is-error' : '')
              }
              type={revealKey ? 'text' : 'password'}
              value={form.apiKey}
              placeholder={form.replaceId ? '留空则保留当前 API Key' : preset.keyHint}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => patch({ apiKey: e.target.value })}
              onBlur={() => markTouched('apiKey')}
            />
            <button
              type="button"
              className="claw-setup__iconbtn claw-setup__iconbtn--icon"
              onClick={() => setRevealKey((v) => !v)}
              aria-label={revealKey ? '隐藏' : '显示'}
              title={revealKey ? '隐藏' : '显示'}
            >
              {revealKey ? <IconEyeOff size={15} /> : <IconEye size={15} />}
            </button>
            <button
              type="button"
              className="claw-setup__iconbtn"
              onClick={() => void pasteKey()}
              title="从剪贴板粘贴"
            >
              粘贴
            </button>
          </div>
          {showErr('apiKey') ? (
            <p className="claw-setup__err">{showErr('apiKey')}</p>
          ) : (
            <p className="claw-setup__hint">
              {form.replaceId ? '留空会保留系统凭据库中的当前 API Key；输入新值才替换。' : 'API key 仅保存到本机系统凭据库，不写入配置文件，也不上传 ClawMaster 服务器。'}
            </p>
          )}

          {/* —— 模型（可多选：填一次 key 批量加入）—— */}
          <label className="claw-setup__label">
            模型
            <span className="claw-setup__locked">
              可多选 · 填一次 key 全部加入
            </span>
          </label>

          {/* 示例模型：点击勾选 / 取消 */}
          {preset.exampleModels.length > 0 ? (
            <div className="claw-setup__examples">
              {preset.exampleModels.map((m) => {
                const on = form.selectedModels.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    className={
                      'claw-setup__example' + (on ? ' is-selected' : '')
                    }
                    onClick={() => toggleModel(m)}
                  >
                    {on ? <IconCheck size={11} /> : <span aria-hidden>+</span>}
                    <span>{m}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* 自定义模型 id：输入 + 添加（回车也可） */}
          <div className="claw-setup__keyrow">
            <input
              className={
                'claw-setup__input' + (showErr('modelId') ? ' is-error' : '')
              }
              type="text"
              value={form.modelId}
              placeholder={`${preset.modelHint}（回车或点添加）`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => patch({ modelId: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTypedModel();
                }
              }}
              onBlur={() => markTouched('modelId')}
            />
            <button
              type="button"
              className="claw-setup__iconbtn"
              onClick={addTypedModel}
              disabled={!form.modelId.trim()}
            >
              添加
            </button>
          </div>

          {/* 已选模型 chips（可删） */}
          {form.selectedModels.length > 0 ? (
            <div className="claw-setup__chosen">
              {form.selectedModels.map((m) => (
                <span key={m} className="claw-setup__chosen-chip">
                  {m}
                  <button
                    type="button"
                    className="claw-setup__chosen-x"
                    onClick={() => toggleModel(m)}
                    aria-label={`移除 ${m}`}
                  >
                    <IconClose size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {showErr('modelId') ? (
            <p className="claw-setup__err">{showErr('modelId')}</p>
          ) : null}

          {/* —— 显示名（仅当最终恰好 1 个模型时）—— */}
          {effectiveModelIds(form).length <= 1 ? (
            <>
              <label className="claw-setup__label">显示名（可选）</label>
              <input
                className="claw-setup__input"
                type="text"
                value={form.displayName}
                placeholder={cfg.displayName || '在模型菜单里怎么称呼它'}
                spellCheck={false}
                onChange={(e) => patch({ displayName: e.target.value })}
              />
            </>
          ) : (
            <p className="claw-setup__hint">
              已选 {effectiveModelIds(form).length} 个模型，将各自以模型 id
              命名、共用这一个 key 一次性加入。
            </p>
          )}

          <label className="claw-setup__label">上下文窗口（tokens，可选）</label>
          <input
            className="claw-setup__input"
            type="number"
            min="1"
            value={form.maxTokens}
            placeholder="例如 128000"
            onChange={(e) => patch({ maxTokens: e.target.value })}
          />
          <label className="claw-setup__toggleline">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            启用这个模型
          </label>
        </div>

        {/* —— 落盘失败提示（save_failed）—— */}
        {saveError ? (
          <div className="claw-setup__savefail" role="alert">
            <span className="claw-setup__warn" aria-hidden>
              <IconWarning size={15} />
            </span>
            <span>{saveError}</span>
          </div>
        ) : null}

        <details className="claw-setup__advanced">
          <summary className="claw-setup__advanced-toggle">语音与企业消息</summary>
          <VoiceSettings />
          <div className="claw-setup__body">
            <div className="claw-setup__label">企业消息连接</div>
            <p className="claw-setup__hint">凭据由 Rust 验证，Secret 仅保存在系统凭据库。</p>
            <div className="claw-setup__presets">
              {([
                ['feishu', '飞书'],
                ['wecom', '企业微信'],
                ['dingtalk', '钉钉'],
              ] as const).map(([provider, label]) => (
                <button
                  key={provider}
                  type="button"
                  className="claw-setup__btn claw-setup__btn--ghost"
                  onClick={() => onOpenChannelSettings?.(provider)}
                >
                  配置{label}
                </button>
              ))}
            </div>
          </div>
        </details>

        <footer className="claw-setup__foot">
          <button
            type="button"
            className="claw-setup__btn claw-setup__btn--ghost"
            onClick={form.replaceId ? cancelEdit : onClose}
          >
            {form.replaceId ? '取消编辑' : '稍后'}
          </button>
          <button
            type="button"
            className="claw-setup__btn claw-setup__btn--primary"
            disabled={!valid || saving}
            onClick={submit}
            title={
              valid ? (form.replaceId ? '保存全部修改' : '保存并启用该模型') : '请先补全必填项'
            }
          >
            {saving ? (
              <>
                <span className="claw-setup__spinner" aria-hidden />
                保存中…
              </>
            ) : (
              form.replaceId ? '保存修改' : '完成配置'
            )}
          </button>
        </footer>
      </div>
    </section>
  );
}
