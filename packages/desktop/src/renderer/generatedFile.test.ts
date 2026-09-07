import { describe, expect, it } from 'vitest';
import { generatedFilePath } from './generatedFile.js';

describe('generated file routing', () => {
  it('opens only confirmed native file results', () => {
    const result = { generatedFile: { path: '/workspace/demo.pptx' } };
    expect(generatedFilePath('succeeded', result)).toBe('/workspace/demo.pptx');
    expect(generatedFilePath('failed', result)).toBeNull();
    expect(generatedFilePath('unknownOutcome', result)).toBeNull();
    expect(generatedFilePath('succeeded', { outputPath: '/invented.pptx' })).toBeNull();
    expect(generatedFilePath('succeeded', { generatedFile: { path: '../demo.pptx' } })).toBeNull();
    expect(generatedFilePath('succeeded', { generatedFile: { path: 'C:\\work\\demo.docx' } })).toBe('C:\\work\\demo.docx');
    expect(generatedFilePath('succeeded', { generatedFile: { path: '\\\\?\\C:\\work\\demo.docx' } })).toBe('\\\\?\\C:\\work\\demo.docx');
  });
});
