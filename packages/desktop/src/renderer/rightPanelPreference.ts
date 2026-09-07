import type { UiModePreferenceScope } from './uiModePreference.js';

// v2 intentionally resets the old always-open workspace wall. Context panels
// now stay out of the conversation until the user explicitly asks for them.
const STORAGE_PREFIX = 'clawmaster.right-panel.v2';

function normalizeServerUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').toLowerCase();
  return normalized || 'local';
}

export function rightPanelStorageKey(scope: UiModePreferenceScope): string {
  return [
    STORAGE_PREFIX,
    normalizeServerUrl(scope.serverUrl),
    scope.organizationId.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

export function readRightPanelCollapsed(
  scope: UiModePreferenceScope,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    return storage.getItem(rightPanelStorageKey(scope)) !== 'expanded';
  } catch {
    return true;
  }
}

export function writeRightPanelCollapsed(
  scope: UiModePreferenceScope,
  collapsed: boolean,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    storage.setItem(
      rightPanelStorageKey(scope),
      collapsed ? 'collapsed' : 'expanded',
    );
    return true;
  } catch {
    return false;
  }
}
