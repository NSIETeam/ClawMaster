/** Upstream SDK entry pages requiring the local browser capability adapter. */
export const editorPages = ['documenteditor', 'spreadsheeteditor', 'presentationeditor'].map(name => `web-apps/apps/${name}/main/index.html`);
/** Parser-blocking loading installs compatibility before the SDK executes in its own frame. */
export const compatibilityScript = '<script src="../../../../editor-compatibility.js"></script>';

/**
 * Preserve upstream markup while loading the compatibility adapter first.
 * @param html Pinned upstream editor entry page.
 * @returns Entry page with the local adapter at the start of its head.
 */
export function addEditorCompatibility(html) {
  if (html.split('<head>').length !== 2 || html.includes(compatibilityScript)) throw new Error('Unexpected Office editor entry page.');
  return html.replace('<head>', `<head>\n    ${compatibilityScript}`);
}

/**
 * Skip the upstream Chromium-only heap sample when the browser exposes no memory statistics.
 * @param script Pinned upstream editor application script.
 * @returns Application script retaining its other behavior and legal notices.
 */
export function guardEditorMemorySample(script) {
  const sample = 'setTimeout(()=>{var t=10*Math.round(performance.memory.usedJSHeapSize';
  if (script.split(sample).length !== 2) throw new Error('Unexpected Office memory sampler.');
  return script.replace(sample, 'setTimeout(()=>{if(!performance.memory)return;var t=10*Math.round(performance.memory.usedJSHeapSize');
}

/**
 * Join the upstream trailing-slash theme directory without an empty URL segment.
 * @param script Pinned upstream presentation SDK.
 * @returns SDK using the canonical theme manifest URL.
 */
export function fixPresentationThemeUrl(script) {
  const load = 'AscCommon.N_e(t+"/themes.js"';
  if (script.split(load).length !== 2) throw new Error('Unexpected Office presentation theme loader.');
  return script.replace(load, 'AscCommon.N_e(t.replace(/\\/$/,"")+"/themes.js"');
}
