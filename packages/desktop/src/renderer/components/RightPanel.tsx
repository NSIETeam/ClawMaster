/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useState } from 'react';
import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import type { FileCheckpointSummary } from 'clawmaster-server';
import { ModuleWorkspace } from './ModuleWorkspace.js';
import { ArtifactWorkspace } from './ArtifactWorkspace.js';
import { MindMapWorkspace } from './MindMapWorkspace.js';
import { PlatformWorkspace, type PlatformWorkspaceTarget } from './PlatformWorkspace.js';
import { FileRecoveryWorkspace } from './FileRecoveryWorkspace.js';

/** Thin boundary: App owns capabilities, persistence, and business dialogs. */
export interface RightPanelProps {
  busy: boolean;
  presentation?: 'panel' | 'page';
  collapsed?: boolean;
  ready: boolean;
  readiness?: 'loading' | 'ready' | 'failed';
  onRetryCapabilities?: () => void;
  onRequestExpand?: () => void;
  scopeKey: string;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  fileCheckpoints?: readonly FileCheckpointSummary[];
  onRefreshFileCheckpoints?: () => void;
  onRestoreFileCheckpoint?: (checkpointId: string) => void;
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}

export function RightPanel({
  busy,
  presentation = 'panel',
  collapsed = false,
  ready,
  readiness = ready ? 'ready' : 'loading',
  onRetryCapabilities,
  onRequestExpand,
  scopeKey,
  layout,
  modules,
  fileCheckpoints,
  onRefreshFileCheckpoints,
  onRestoreFileCheckpoint,
  onActivate,
  onOpenMarketplace,
  onLayoutChange,
}: RightPanelProps): React.JSX.Element {
  const [activeView, setActiveView] = useState<'modules' | 'files' | 'mindmap' | 'recovery' | 'platform'>('modules');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [platformTarget, setPlatformTarget] = useState<PlatformWorkspaceTarget | null>(null);
  useEffect(() => {
    const showFiles = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path !== 'string' || !path) return;
      onRequestExpand?.();
      setFilePath(path);
      setActiveView('files');
    };
    window.addEventListener('clawmaster:edit-local-file', showFiles);
    return () => window.removeEventListener('clawmaster:edit-local-file', showFiles);
  }, [onRequestExpand]);
  useEffect(() => {
    const showMindMap = (): void => {
      onRequestExpand?.();
      setActiveView('mindmap');
    };
    window.addEventListener('clawmaster:open-mind-map', showMindMap);
    return () => window.removeEventListener('clawmaster:open-mind-map', showMindMap);
  }, [onRequestExpand]);
  useEffect(() => {
    if (!platformTarget) return;
    const installed = layout.groups.some((group) => group.moduleIds.includes(platformTarget.id));
    if (!installed) {
      setPlatformTarget(null);
      setActiveView((view) => view === 'platform' ? 'modules' : view);
    }
  }, [layout, platformTarget]);
  const closePlatform = (): void => {
    setPlatformTarget(null);
    setActiveView('modules');
  };
  useEffect(() => {
    const showPlatform = (event: Event): void => {
      const detail = (event as CustomEvent<PlatformWorkspaceTarget>).detail;
      if (
        !detail ||
        typeof detail.id !== 'string' ||
        typeof detail.label !== 'string' ||
        (detail.url !== null && typeof detail.url !== 'string')
      ) return;
      onRequestExpand?.();
      setPlatformTarget(detail);
      setActiveView('platform');
    };
    window.addEventListener('clawmaster:open-platform', showPlatform);
    return () => window.removeEventListener('clawmaster:open-platform', showPlatform);
  }, [onRequestExpand]);
  const hidden = presentation === 'panel' && collapsed;
  return (
    <aside
      className={`claw-right-panel claw-right-panel--${presentation}${activeView === 'platform' ? ' claw-right-panel--browser' : ''}${hidden ? ' claw-right-panel--collapsed' : ''}`}
      aria-label="功能组"
      aria-busy={busy || readiness === 'loading'}
      aria-hidden={hidden || undefined}
    >
      <div className="claw-right-panel__switcher" role="tablist" aria-label="右侧工作区">
        <button type="button" role="tab" aria-selected={activeView === 'modules'} onClick={() => setActiveView('modules')}>功能</button>
        <button type="button" role="tab" aria-selected={activeView === 'files'} onClick={() => setActiveView('files')}>文件</button>
        <button type="button" role="tab" aria-selected={activeView === 'mindmap'} onClick={() => setActiveView('mindmap')}>导图</button>
        {onRefreshFileCheckpoints && onRestoreFileCheckpoint ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'recovery'}
            onClick={() => {
              setActiveView('recovery');
              onRefreshFileCheckpoints();
            }}
          >版本</button>
        ) : null}
        {platformTarget ? <button type="button" role="tab" aria-selected={activeView === 'platform'} onClick={() => setActiveView('platform')}>{platformTarget.label}</button> : null}
      </div>
      {activeView === 'platform' && platformTarget ? (
        <PlatformWorkspace key={platformTarget.id} target={platformTarget} onClose={closePlatform} />
      ) : activeView === 'files' ? (
        <ArtifactWorkspace initialPath={filePath ?? undefined} />
      ) : activeView === 'mindmap' ? (
        <MindMapWorkspace />
      ) : activeView === 'recovery' && onRefreshFileCheckpoints && onRestoreFileCheckpoint ? (
        <FileRecoveryWorkspace
          checkpoints={fileCheckpoints}
          onRefresh={onRefreshFileCheckpoints}
          onRestore={onRestoreFileCheckpoint}
        />
      ) : readiness === 'ready' ? (
        <ModuleWorkspace
          presentation={presentation}
          scopeKey={scopeKey}
          layout={layout}
          modules={modules}
          onActivate={onActivate}
          onOpenMarketplace={onOpenMarketplace}
          onLayoutChange={onLayoutChange}
        />
      ) : readiness === 'failed' ? (
        <div className="claw-module-workspace__loading" role="status">
          <span>暂时无法加载可用模块。</span>
          {onRetryCapabilities ? <button type="button" onClick={onRetryCapabilities}>重试</button> : null}
        </div>
      ) : (
        <div className="claw-module-workspace__loading" role="status">正在加载可用模块…</div>
      )}
    </aside>
  );
}
