import React from 'react';
import type { UiMode } from '../uiModePreference.js';

export interface UiModeGuideProps {
  onSelect: (mode: UiMode) => void;
}

export function UiModePreview({ mode }: { mode: UiMode }): React.JSX.Element {
  return (
    <span className={`claw-ui-preview claw-ui-preview--${mode}`} aria-hidden="true">
      <span className="claw-ui-preview__chrome">
        <i />
        <i />
        <i />
        <b />
      </span>
      <span className="claw-ui-preview__sidebar">
        <b />
        <span>
          <i />
          <i />
          <i />
        </span>
        <span>
          <i />
          <i />
        </span>
      </span>
      <span className="claw-ui-preview__chat">
        <span className="claw-ui-preview__chat-head">
          <i />
          <b />
        </span>
        <span className="claw-ui-preview__messages">
          <i />
          <i />
          <i />
        </span>
        <span className="claw-ui-preview__composer">
          <i />
          <b />
        </span>
      </span>
      {mode === 'work' ? (
        <span className="claw-ui-preview__workspace">
          <span className="claw-ui-preview__tabs">
            <i />
            <i />
          </span>
          <span className="claw-ui-preview__agent-list">
            <b><i /><i /></b>
            <b><i /><i /></b>
            <b><i /><i /></b>
          </span>
          <span className="claw-ui-preview__work-grid">
            <i />
            <i />
          </span>
        </span>
      ) : (
        <span className="claw-ui-preview__focus-mark">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

export function UiModeGuide({ onSelect }: UiModeGuideProps): React.JSX.Element {
  return (
    <div className="claw-ui-guide__backdrop">
      <section className="claw-ui-guide" role="dialog" aria-modal="true" aria-labelledby="claw-ui-guide-title">
        <header className="claw-ui-guide__head">
          <span>WELCOME TO CLAWMASTER</span>
          <h1 id="claw-ui-guide-title">选择你习惯的工作界面</h1>
          <p>功能和数据完全相同，以后也可以在“设置与诊断”中随时切换。</p>
        </header>
        <div className="claw-ui-guide__options">
          <button type="button" className="claw-ui-guide__option" onClick={() => onSelect('conversational')}>
            <UiModePreview mode="conversational" />
            <span className="claw-ui-guide__option-copy">
              <strong>对话式 UI</strong>
              <small>专注当前对话，专家和记忆按需进入独立页面。</small>
              <b>选择对话式 UI</b>
            </span>
          </button>
          <button type="button" className="claw-ui-guide__option" onClick={() => onSelect('work')}>
            <UiModePreview mode="work" />
            <span className="claw-ui-guide__option-copy">
              <strong>工作式 UI</strong>
              <small>聊天和工作区同时展示，右侧常驻专家与企业记忆。</small>
              <b>选择工作式 UI</b>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
