/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, type Config } from '../config/config.js';
import { WriteFileTool } from './write-file.js';
import {
  ToolConfirmationOutcome,
  type FileDiff,
  type ToolEditConfirmationDetails,
} from './tools.js';

describe('WriteFileTool', () => {
  let rootDir: string;
  let outsideDir: string;
  let approvalMode: ApprovalMode;
  let setApprovalMode: ReturnType<typeof vi.fn>;
  let tool: WriteFileTool;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-outside-'));
    approvalMode = ApprovalMode.DEFAULT;
    setApprovalMode = vi.fn((mode: ApprovalMode) => { approvalMode = mode; });
    const config = {
      getTargetDir: () => rootDir,
      getApprovalMode: () => approvalMode,
      setApprovalMode,
      getProjectSettingsManager: () => ({
        getSettings: () => ({ autoTrimTrailingSpaces: true }),
      }),
      getVsCodePluginMode: () => false,
      getUsageStatisticsEnabled: () => false,
    } as unknown as Config;
    tool = new WriteFileTool(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('accepts a file inside the configured root', () => {
      expect(tool.validateToolParams({
        file_path: path.join(rootDir, 'file.txt'),
        content: 'hello',
      })).toBeNull();
    });

    it('rejects relative and outside-root paths', () => {
      expect(tool.validateToolParams({ file_path: 'file.txt', content: 'hello' }))
        .toMatch(/absolute/iu);
      expect(tool.validateToolParams({
        file_path: path.join(outsideDir, 'file.txt'),
        content: 'hello',
      })).toMatch(/root directory/iu);
    });

    it('rejects a directory used as a file', () => {
      const directory = path.join(rootDir, 'directory');
      fs.mkdirSync(directory);
      expect(tool.validateToolParams({ file_path: directory, content: 'hello' }))
        .toMatch(/is a directory/iu);
    });
  });

  describe('file snapshot', () => {
    it('returns proposed content unchanged for a new file', async () => {
      const filePath = path.join(rootDir, 'new.txt');
      // @ts-expect-error Testing the internal snapshot boundary directly.
      await expect(tool._getCorrectedFileContent(filePath, 'proposed')).resolves.toEqual({
        originalContent: '',
        correctedContent: 'proposed',
        fileExists: false,
      });
    });

    it('returns original and proposed content unchanged for an existing file', async () => {
      const filePath = path.join(rootDir, 'existing.txt');
      fs.writeFileSync(filePath, 'original');
      // @ts-expect-error Testing the internal snapshot boundary directly.
      await expect(tool._getCorrectedFileContent(filePath, 'proposed')).resolves.toEqual({
        originalContent: 'original',
        correctedContent: 'proposed',
        fileExists: true,
      });
    });

    it('reports a read failure without changing proposed content', async () => {
      const filePath = path.join(rootDir, 'unreadable.txt');
      fs.writeFileSync(filePath, 'original');
      vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw new Error('permission denied');
      });

      // @ts-expect-error Testing the internal snapshot boundary directly.
      const result = await tool._getCorrectedFileContent(filePath, 'proposed');
      expect(result).toEqual({
        originalContent: '',
        correctedContent: 'proposed',
        fileExists: true,
        error: { message: 'permission denied', code: undefined },
      });
    });
  });

  describe('confirmation', () => {
    const signal = new AbortController().signal;

    it('returns false for invalid parameters', async () => {
      await expect(tool.shouldConfirmExecute(
        { file_path: 'relative.txt', content: 'content' },
        signal,
      )).resolves.toBe(false);
    });

    it.each([
      { name: 'new', original: undefined },
      { name: 'existing', original: 'original content' },
    ])('shows the exact proposed content for a $name file', async ({ name, original }) => {
      const filePath = path.join(rootDir, `${name}.txt`);
      if (original !== undefined) fs.writeFileSync(filePath, original);
      const proposed = 'proposed content';

      const confirmation = await tool.shouldConfirmExecute(
        { file_path: filePath, content: proposed },
        signal,
      ) as ToolEditConfirmationDetails;

      expect(confirmation).toEqual(expect.objectContaining({
        title: `Confirm Write: ${name}.txt`,
        fileName: `${name}.txt`,
        newContent: proposed,
      }));
      expect(confirmation.fileDiff).toContain(proposed);
      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedAlways);
      expect(setApprovalMode).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    });
  });

  describe('execute', () => {
    const signal = new AbortController().signal;

    it('creates a new file with the exact proposed content', async () => {
      const filePath = path.join(rootDir, 'new.txt');
      const result = await tool.execute({ file_path: filePath, content: 'content' }, signal);

      expect(fs.readFileSync(filePath, 'utf8')).toBe('content');
      expect(result.llmContent).toMatch(/Successfully created/iu);
      expect((result.returnDisplay as FileDiff).fileName).toBe('new.txt');
    });

    it('overwrites an existing file with the exact proposed content', async () => {
      const filePath = path.join(rootDir, 'existing.txt');
      fs.writeFileSync(filePath, 'old');
      const result = await tool.execute({ file_path: filePath, content: 'new' }, signal);

      expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
      expect(result.llmContent).toMatch(/Successfully overwrote/iu);
      expect((result.returnDisplay as FileDiff).fileDiff).toContain('old');
    });

    it('creates missing parent directories', async () => {
      const filePath = path.join(rootDir, 'nested', 'file.txt');
      await tool.execute({ file_path: filePath, content: 'content' }, signal);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('content');
    });

    it('reports whether the user modified proposed content', async () => {
      const modified = await tool.execute({
        file_path: path.join(rootDir, 'modified.txt'),
        content: 'content',
        modified_by_user: true,
      }, signal);
      const unmodified = await tool.execute({
        file_path: path.join(rootDir, 'unmodified.txt'),
        content: 'content',
      }, signal);

      expect(modified.llmContent).toMatch(/User modified the `content`/u);
      expect(unmodified.llmContent).not.toMatch(/User modified the `content`/u);
    });
  });
});
