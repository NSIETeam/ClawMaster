import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  buildCustomerModuleSubmission,
  locallyValidateCustomerModuleWasm,
  type CustomerModuleAuthoringDraft,
} from '../customerModuleAuthoring.js';
import { useModalDialog } from './useModalDialog.js';

const STEPS = ['基本信息', '上传 WASM', '输入表单', '权限与费用', '本地测试', '提交审核'];
const STEP_DESCRIPTIONS = [
  '定义用户能识别、平台能稳定追踪的模块身份。',
  '上传经过编译的 WASM 文件，并在本机完成静态检查。',
  '用 JSON Schema 描述运行模块时需要用户填写的内容。',
  '只申请运行所必需的能力，安装时仍由用户逐项确认。',
  '在隔离沙箱中验证模块行为，不触碰正式账号和数据。',
  '复核版本、发布者与权限声明，然后提交平台审核。',
] as const;

export function CustomerModuleAuthoringDialog({
  open,
  publisher,
  onSubmit,
  onClose,
}: {
  open: boolean;
  publisher: { id: string; name: string };
  onSubmit(input: { manifest: Record<string, unknown>; files: Record<string, string> }): Promise<void>;
  onClose(): void;
}): React.JSX.Element | null {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<CustomerModuleAuthoringDraft>({
    id: '', name: '', version: '1.0.0', description: '', releaseNotes: '', minimumClawMasterVersion: '1.15.3',
    permissions: [], inputSchema: { type: 'object', properties: {} },
  });
  const [wasm, setWasm] = useState<Uint8Array | null>(null);
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTrace, setTestTrace] = useState<Array<Record<string, unknown>>>([]);
  const [testPassed, setTestPassed] = useState(false);
  const [httpHosts, setHttpHosts] = useState('');
  const [httpWrites, setHttpWrites] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0); setStatus(null); setBusy(false); setWasm(null); setHttpHosts(''); setHttpWrites(false); setTestTrace([]); setTestPassed(false);
  }, [open]);
  const modal = useModalDialog(open, onClose, !busy);
  if (!open) return null;

  const advance = async (): Promise<void> => {
    try {
      setStatus(null);
      if (step === 0 && (!draft.id.trim() || !draft.name.trim() || !draft.description.trim())) {
        throw new Error('请完整填写模块 ID、名称和说明');
      }
      if (step === 1) {
        if (!wasm) throw new Error('请选择 WASM 文件');
        const imports = await locallyValidateCustomerModuleWasm(wasm);
        setStatus(`本地静态检查通过；Host 调用 ${imports.length} 项`);
      }
      if (step === 2) {
        const schema = JSON.parse(schemaText) as CustomerModuleAuthoringDraft['inputSchema'];
        if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
          throw new Error('输入表单必须是 object JSON Schema');
        }
        setDraft((current) => ({ ...current, inputSchema: schema }));
        setTestPassed(false);
      }
      if (step === 3) {
        const http = draft.permissions.find((permission) => permission.kind === 'http');
        if (http && (!Array.isArray(http.hosts) || http.hosts.length === 0)) throw new Error('申请 HTTP 权限时必须填写至少一个明确域名');
      }
      if (step === 4 && !testPassed) throw new Error('提交前必须完成一次本地沙箱测试');
      setStep((current) => Math.min(STEPS.length - 1, current + 1));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const togglePermission = (kind: 'model' | 'http' | 'storage' | 'file' | 'background'): void => {
    setTestPassed(false);
    setDraft((current) => {
      const exists = current.permissions.some((permission) => permission.kind === kind);
      const permission = kind === 'model' ? { kind, paid: true }
        : kind === 'http' ? { kind, hosts: [], writes: false }
          : kind === 'storage' ? { kind, access: 'read-write' }
            : kind === 'file' ? { kind, access: 'user-selected-read' }
              : { kind, defaultEnabled: false };
      return {
        ...current,
        permissions: exists
          ? current.permissions.filter((item) => item.kind !== kind)
          : [...current.permissions, permission],
      };
    });
  };

  const updateHttpPermission = (hostsText: string, writes: boolean): void => {
    setTestPassed(false);
    setHttpHosts(hostsText); setHttpWrites(writes);
    const hosts = [...new Set(hostsText.split(/[\s,]+/u).map((host) => host.trim().toLowerCase()).filter(Boolean))];
    setDraft((current) => ({
      ...current,
      permissions: current.permissions.map((item) => item.kind === 'http' ? { kind: 'http', hosts, writes } : item),
    }));
  };

  return createPortal(
    <div className="claw-module-marketplace-overlay claw-module-studio-overlay" onMouseDown={modal.onBackdropMouseDown}>
      <div ref={modal.dialogRef} className="claw-module-studio" role="dialog" aria-modal="true" aria-label="创建客户模块" onKeyDown={modal.onKeyDown}>
        <header className="claw-module-studio__header">
          <div>
            <span className="claw-module-studio__eyebrow">CLAWMASTER MODULE STUDIO</span>
            <h2>创建客户模块</h2>
            <p>把一个可审计的 WASM 能力发布给团队使用</p>
          </div>
          <button ref={modal.closeRef} type="button" aria-label="关闭创建模块" disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="claw-module-studio__workspace">
          <aside className="claw-module-studio__rail">
            <ol aria-label="创建进度">
              {STEPS.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={index < step ? 'is-complete' : index === step ? 'is-current' : ''}>
                <span>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>
                <div><strong>{label}</strong><small>{index < step ? '已完成' : index === step ? '正在编辑' : '待处理'}</small></div>
              </li>)}
            </ol>
          </aside>
          <main className="claw-module-studio__main">
            <div className="claw-module-studio__step-head">
              <span>步骤 {step + 1}/6</span>
              <h3>{STEPS[step]}</h3>
              <p>{STEP_DESCRIPTIONS[step]}</p>
            </div>
            <div className="claw-module-studio__content">
          {step === 0 ? <section className="claw-module-studio__form-grid" role="group" aria-label="模块身份">
            <label><span>稳定模块 ID <b>必填</b></span><input required aria-label="稳定模块 ID" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="com.company.module" /><small>发布后不可更改，建议使用反向域名。</small></label>
            <label><span>模块名称 <b>必填</b></span><input required aria-label="模块名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：合同风险检查" /></label>
            <label><span>版本</span><input aria-label="版本" value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} placeholder="1.0.0" /><small>遵循语义化版本。</small></label>
            <label className="is-wide"><span>模块说明 <b>必填</b></span><textarea required rows={4} aria-label="模块说明" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="说明它解决什么问题、适合谁使用。" /></label>
            <label className="is-wide"><span>本版本变更说明</span><textarea rows={3} aria-label="本版本变更说明" value={draft.releaseNotes} onChange={(event) => setDraft({ ...draft, releaseNotes: event.target.value })} placeholder="首次发布可填写主要能力；后续版本说明行为变化。" /></label>
          </section> : null}
          {step === 1 ? <label className="claw-module-studio__upload"><span>WASM 文件</span><strong>{wasm ? '文件已就绪，可以继续检查' : '选择一个 .wasm 构建产物'}</strong><small>文件仅在本机读取，进入下一步前会检查导入能力。</small><input aria-label="WASM 文件" type="file" accept=".wasm,application/wasm" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.arrayBuffer().then((body) => { setWasm(new Uint8Array(body)); setTestPassed(false); });
          }} /></label> : null}
          {step === 2 ? <label className="claw-module-studio__code-field"><span>输入表单 JSON Schema</span><textarea aria-label="输入表单 JSON Schema" rows={12} value={schemaText} onChange={(event) => setSchemaText(event.target.value)} /></label> : null}
          {step === 3 ? <fieldset className="claw-module-studio__permissions"><legend>能力清单</legend>{(['model', 'http', 'storage', 'file', 'background'] as const).map((kind) => <label key={kind}><input type="checkbox" checked={draft.permissions.some((permission) => permission.kind === kind)} onChange={() => togglePermission(kind)} /><span><strong>{kind}</strong><small>{kind === 'model' ? '调用模型，可能产生费用' : kind === 'background' ? '后台运行，安装后默认关闭' : '仅在模块运行期间授权'}</small></span></label>)}
            {draft.permissions.some((permission) => permission.kind === 'http') ? <div className="claw-module-studio__permission-detail">
              <label><span>允许的 HTTPS 域名</span><input aria-label="允许的 HTTPS 域名" value={httpHosts} placeholder="api.company.com, files.company.com" onChange={(event) => updateHttpPermission(event.target.value, httpWrites)} /></label>
              <label className="claw-module-studio__checkline"><input type="checkbox" checked={httpWrites} onChange={(event) => updateHttpPermission(httpHosts, event.target.checked)} /><span>允许 POST/PUT/PATCH/DELETE 外部写操作（必须携带幂等键）</span></label>
            </div> : null}
            <p className="claw-module-studio__note">后台授权默认关闭；即使声明，安装后也必须由用户另行开启，任务仍需通过 ClawMaster 后台任务登记。</p>
          </fieldset> : null}
          {step === 4 ? <section className="claw-module-studio__test"><div><strong>隔离沙箱</strong><p>网络、模型、文件和正式存储调用都会被拦截并记录。</p></div>
            <button type="button" className="claw-module-studio__primary" disabled={busy || !wasm} onClick={() => {
              if (!wasm) return;
              setBusy(true); setStatus('沙箱测试中…'); setTestTrace([]); setTestPassed(false);
              void buildCustomerModuleSubmission({ draft, publisher, wasm }).then((submission) => window.clawmaster.customerModuleTest(submission)).then((execution) => {
                setStatus(`退出状态：${execution.result.status} · 退出码 ${execution.result.exitCode ?? '无'}${execution.result.error ? ` · ${execution.result.error}` : ''}`);
                setTestTrace([...execution.audit, ...execution.hostAudit]);
                setTestPassed(execution.result.status === 'completed');
              }).catch((error) => setStatus(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
            }}>{busy ? '测试中…' : '运行本地沙箱测试'}</button>
            <p role="status">{status ?? '尚未运行。测试数据不会进入正式账号。'}</p>
            {testTrace.length > 0 ? <pre aria-label="本地测试调用轨迹">{JSON.stringify(testTrace, null, 2)}</pre> : null}
          </section> : null}
          {step === 5 ? <dl className="claw-module-studio__review"><div><dt>发布者</dt><dd>{publisher.name}</dd></div><div><dt>模块版本</dt><dd>{draft.id}@{draft.version}</dd></div><div><dt>权限</dt><dd>{draft.permissions.length === 0 ? '无' : draft.permissions.map((item) => String(item.kind)).join('、')}</dd></div></dl> : null}
          {status && step !== 4 ? <p className="claw-module-studio__alert" role="alert">{status}</p> : null}
            </div>
          </main>
        </div>
        <footer className="claw-module-studio__footer">
          <span>{step < 5 ? '草稿仅保存在当前窗口' : '提交后进入人工审核队列'}</span>
          <div><button type="button" className="claw-module-studio__secondary" disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}>上一步</button>
          {step < 5 ? <button type="button" className="claw-module-studio__primary" onClick={() => void advance()}>下一步</button> : <button type="button" className="claw-module-studio__primary" disabled={busy || !wasm} onClick={() => {
            if (!wasm) return;
            setBusy(true); setStatus(null);
            void buildCustomerModuleSubmission({ draft, publisher, wasm })
              .then(onSubmit)
              .then(() => { setStatus('已提交，等待平台人工审核'); })
              .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
              .finally(() => setBusy(false));
          }}>{busy ? '提交中…' : '提交审核'}</button>}</div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
