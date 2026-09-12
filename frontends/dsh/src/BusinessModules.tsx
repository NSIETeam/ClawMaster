import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { parseDelimited, readStoredList } from './business';

type ModuleName = 'data' | 'crm' | 'erp';

interface CrmRecord {
  id: string;
  name: string;
  company: string;
  stage: string;
  nextAction: string;
}

interface ErpRecord {
  id: string;
  sku: string;
  name: string;
  stock: number;
  reorderAt: number;
}

const CRM_KEY = 'clawmaster.crm.records.v1';
const ERP_KEY = 'clawmaster.erp.records.v1';

function isCrmRecord(value: unknown): value is CrmRecord {
  const row = value as Partial<CrmRecord> | null;
  return row !== null && typeof row === 'object' && typeof row.id === 'string'
    && typeof row.name === 'string' && typeof row.company === 'string'
    && typeof row.stage === 'string' && typeof row.nextAction === 'string';
}

function isErpRecord(value: unknown): value is ErpRecord {
  const row = value as Partial<ErpRecord> | null;
  return row !== null && typeof row === 'object' && typeof row.id === 'string'
    && typeof row.sku === 'string' && typeof row.name === 'string'
    && typeof row.stock === 'number' && typeof row.reorderAt === 'number';
}

function initialList<T>(key: string, validate: (value: unknown) => value is T): T[] {
  if (typeof window === 'undefined') return [];
  return readStoredList(window.localStorage.getItem(key), validate);
}

function persist<T>(key: string, rows: T[]): void {
  window.localStorage.setItem(key, JSON.stringify(rows));
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="cm-module-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <button className="cm-module-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <section className="cm-module-panel">
        <header><div><p>ClawMaster 企业组件</p><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        {children}
      </section>
    </div>
  );
}

function DataProcessor({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState('客户,阶段,金额\n远航科技,方案确认,120000\n山海零售,初步接洽,48000');
  const table = useMemo(() => parseDelimited(source), [source]);
  const columnCount = Math.max(0, ...table.rows.map(row => row.length));
  return <Dialog title="数据处理器" onClose={onClose}>
    <div className="cm-module-body">
      <p className="cm-module-help">粘贴 CSV 或 TSV 数据，立即检查结构并预览内容。数据只保存在当前页面。</p>
      <textarea className="cm-data-input" value={source} onChange={event => setSource(event.target.value)} aria-label="CSV 或 TSV 数据" />
      <div className="cm-data-meta"><span>{Math.max(0, table.rows.length - 1)} 行数据</span><span>{columnCount} 列</span><span>{table.delimiter === '\t' ? 'TSV' : 'CSV'}</span></div>
      <div className="cm-data-table"><table><tbody>{table.rows.slice(0, 50).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => rowIndex === 0 ? <th key={columnIndex}>{cell}</th> : <td key={columnIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
    </div>
  </Dialog>;
}

function Crm({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState(() => initialList(CRM_KEY, isCrmRecord));
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    if (!name) return;
    const next = [...rows, { id: crypto.randomUUID(), name, company: String(data.get('company') ?? '').trim(), stage: String(data.get('stage') ?? '新线索'), nextAction: String(data.get('nextAction') ?? '').trim() }];
    setRows(next); persist(CRM_KEY, next); form.reset();
  };
  const remove = (id: string) => { const next = rows.filter(row => row.id !== id); setRows(next); persist(CRM_KEY, next); };
  return <Dialog title="CRM 客户跟进" onClose={onClose}><div className="cm-module-body">
    <p className="cm-module-help">管理客户阶段和下一步行动。本机数据会在应用重启后保留。</p>
    <form className="cm-module-form" onSubmit={add}><input name="name" placeholder="联系人 *" required /><input name="company" placeholder="公司" /><select name="stage" defaultValue="新线索"><option>新线索</option><option>沟通中</option><option>方案确认</option><option>已成交</option></select><input name="nextAction" placeholder="下一步行动" /><button type="submit">添加客户</button></form>
    <div className="cm-record-list">{rows.length === 0 ? <p className="cm-module-empty">还没有客户记录</p> : rows.map(row => <article key={row.id}><div><strong>{row.name}</strong><span>{row.company || '未填写公司'} · {row.stage}</span><small>{row.nextAction || '暂无下一步行动'}</small></div><button type="button" onClick={() => remove(row.id)}>删除</button></article>)}</div>
  </div></Dialog>;
}

function Erp({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState(() => initialList(ERP_KEY, isErpRecord));
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const sku = String(data.get('sku') ?? '').trim();
    if (!sku) return;
    const next = [...rows, { id: crypto.randomUUID(), sku, name: String(data.get('name') ?? '').trim(), stock: Number(data.get('stock') ?? 0), reorderAt: Number(data.get('reorderAt') ?? 0) }];
    setRows(next); persist(ERP_KEY, next); form.reset();
  };
  const remove = (id: string) => { const next = rows.filter(row => row.id !== id); setRows(next); persist(ERP_KEY, next); };
  return <Dialog title="ERP 库存台账" onClose={onClose}><div className="cm-module-body">
    <p className="cm-module-help">维护 SKU、当前库存和补货线，低库存会自动标记。本机数据会在应用重启后保留。</p>
    <form className="cm-module-form" onSubmit={add}><input name="sku" placeholder="SKU *" required /><input name="name" placeholder="品名" /><input name="stock" type="number" min="0" placeholder="库存" /><input name="reorderAt" type="number" min="0" placeholder="补货线" /><button type="submit">添加物料</button></form>
    <div className="cm-record-list">{rows.length === 0 ? <p className="cm-module-empty">还没有库存记录</p> : rows.map(row => <article key={row.id} className={row.stock <= row.reorderAt ? 'is-warning' : undefined}><div><strong>{row.name || row.sku}</strong><span>{row.sku} · 库存 {row.stock}</span><small>{row.stock <= row.reorderAt ? `需要补货（补货线 ${row.reorderAt}）` : `库存正常（补货线 ${row.reorderAt}）`}</small></div><button type="button" onClick={() => remove(row.id)}>删除</button></article>)}</div>
  </div></Dialog>;
}

export function BusinessModules() {
  const [active, setActive] = useState<ModuleName | null>(null);
  const modules: { id: ModuleName; mark: string; title: string; description: string }[] = [
    { id: 'data', mark: 'DT', title: '数据处理器', description: 'CSV / TSV 结构检查与表格预览' },
    { id: 'crm', mark: 'CRM', title: 'CRM', description: '客户阶段、公司与下一步行动' },
    { id: 'erp', mark: 'ERP', title: 'ERP', description: '库存台账与自动补货提醒' },
  ];
  return <>
    <section className="cm-business" aria-labelledby="cm-business-title"><div className="cm-dsh-section-heading"><div><h2 id="cm-business-title">企业组件</h2><p>编辑器、网页浏览器、文件与终端位于会话右侧工作台</p></div></div><div className="cm-business-grid">{modules.map(module => <button key={module.id} type="button" onClick={() => setActive(module.id)}><span>{module.mark}</span><strong>{module.title}</strong><small>{module.description}</small></button>)}</div></section>
    {active === 'data' && <DataProcessor onClose={() => setActive(null)} />}
    {active === 'crm' && <Crm onClose={() => setActive(null)} />}
    {active === 'erp' && <Erp onClose={() => setActive(null)} />}
  </>;
}
