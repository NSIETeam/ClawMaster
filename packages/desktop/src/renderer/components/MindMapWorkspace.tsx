/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useState } from 'react';

const INITIAL_OUTLINE = `ClawMaster
  目标
    明确中心主题
  路径
    拆分关键分支
  交付
    保存可编辑源文件`;

interface MindNode {
  label: string;
  children: MindNode[];
}

function parseOutline(source: string): MindNode[] {
  const roots: MindNode[] = [];
  const stack: Array<{ depth: number; node: MindNode }> = [];
  for (const raw of source.split(/\r?\n/u)) {
    const label = raw.trim().replace(/^[-*+]\s+/u, '');
    if (!label) continue;
    const indentation = raw.match(/^\s*/u)?.[0].replace(/\t/gu, '  ').length ?? 0;
    const depth = Math.floor(indentation / 2);
    const node: MindNode = { label, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    (parent ? parent.children : roots).push(node);
    stack.push({ depth, node });
  }
  return roots;
}

function MindBranch({ node }: { node: MindNode }): React.JSX.Element {
  return (
    <li>
      <span>{node.label}</span>
      {node.children.length ? <ul>{node.children.map((child, index) => <MindBranch key={`${child.label}-${index}`} node={child} />)}</ul> : null}
    </li>
  );
}

export function MindMapWorkspace(): React.JSX.Element {
  const [source, setSource] = useState(INITIAL_OUTLINE);
  const [status, setStatus] = useState('使用两个空格缩进一级，右侧会实时生成结构。');
  const roots = parseOutline(source);

  const save = async (): Promise<void> => {
    try {
      const path = await window.clawmaster.saveTextFile('clawmaster-mind-map.mmd', source);
      setStatus(path ? `已保存可编辑导图：${path}` : '已取消保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败。');
    }
  };

  return (
    <section className="claw-mind-map" aria-label="思维导图编辑器">
      <header>
        <div><strong>思维导图</strong><small>大纲编辑与结构预览</small></div>
        <button type="button" onClick={() => void save()}>保存源文件</button>
      </header>
      <textarea aria-label="思维导图大纲" value={source} spellCheck={false} onChange={(event) => setSource(event.target.value)} />
      <div className="claw-mind-map__canvas" aria-label="思维导图预览">
        {roots.length ? <ul>{roots.map((node, index) => <MindBranch key={`${node.label}-${index}`} node={node} />)}</ul> : <span>输入中心主题开始绘制</span>}
      </div>
      <div className="claw-mind-map__status" role="status">{status}</div>
    </section>
  );
}
