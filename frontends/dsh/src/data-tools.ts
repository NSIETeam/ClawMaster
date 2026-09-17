/** Workspace CSV tools over DSH filesystem policy, observation guards, and logged tool results. */
import type { Context } from '@deepseek-ai/cordis';
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import {
  approveEscalation, ESCALATION_TARGETS, escalationHintMarker, sandboxDenialMarker,
  validateEscalationArgs, type SandboxExecutionPolicy,
} from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-user-approval';
import {
  decodeDelimitedBytes, parseDelimited, processTable, serializeDelimited,
  type ProcessedTable, type TableDelimiter,
} from './business.ts';

/** Deployment limits for complete imports and model-visible previews. */
export interface DataToolsConfig {
  maxInputBytes?: number;
  previewRows?: number;
  previewColumns?: number;
  previewCellChars?: number;
  maxDiagnostics?: number;
}

type Limits = Required<DataToolsConfig>;

function resolveLimits(config: DataToolsConfig): Limits {
  const limits = {
    maxInputBytes: config.maxInputBytes ?? 16 * 1024 * 1024,
    previewRows: config.previewRows ?? 10,
    previewColumns: config.previewColumns ?? 8,
    previewCellChars: config.previewCellChars ?? 120,
    maxDiagnostics: config.maxDiagnostics ?? 10,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CSV ${key} must be a positive safe integer`);
  }
  return limits;
}

interface CsvArguments {
  input_path: string;
  output_path?: string;
  delimiter?: 'auto' | 'csv' | 'tsv';
  output_format?: 'csv' | 'tsv';
  encoding?: 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';
  header?: boolean;
  skip_blank_rows?: boolean;
  trim?: boolean;
  deduplicate?: boolean;
  filter?: { text: string; column?: number };
  sort?: { column: number; direction?: 'ascending' | 'descending' };
  sort_locale?: 'zh-CN' | 'en-US';
  protect_formulas?: boolean;
  sandbox_permissions?: string;
  justification?: string;
}

function resolveInput(args: CsvArguments) {
  if (args.input_path.trim() === '') throw new Error('input_path must be non-empty');
  if (args.output_path !== undefined && args.output_path.trim() === '') throw new Error('output_path must be non-empty');
  validateEscalationArgs(args.sandbox_permissions, args.justification);
  if (args.output_path === undefined && args.sandbox_permissions !== undefined) throw new Error('A preview does not need write escalation; supply output_path to save a file');
  for (const [name, column] of [['filter.column', args.filter?.column], ['sort.column', args.sort?.column]] as const) {
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 0)) throw new Error(`${name} must be a non-negative safe integer`);
  }
  const delimiter: TableDelimiter | 'auto' = args.delimiter === undefined || args.delimiter === 'auto' ? 'auto' : args.delimiter === 'tsv' ? '\t' : ',';
  return {
    inputPath: args.input_path,
    outputPath: args.output_path ?? null,
    delimiter,
    outputDelimiter: args.output_format === 'tsv' ? '\t' as const : ',' as const,
    encoding: args.encoding ?? 'utf-8',
    skipBlankRows: args.skip_blank_rows ?? false,
    protectFormulas: args.protect_formulas ?? true,
    options: {
      header: args.header ?? true,
      trim: args.trim ?? false,
      deduplicate: args.deduplicate ?? false,
      filterColumn: args.filter?.column ?? null,
      filterText: args.filter?.text ?? '',
      sortColumn: args.sort?.column ?? null,
      sortDirection: args.sort?.direction ?? 'ascending',
      locale: args.sort_locale ?? 'zh-CN',
    },
  };
}

function previewTable(table: ProcessedTable, columns: number, limits: Limits) {
  let clippedCells = 0;
  const project = (row: string[]) => row.slice(0, limits.previewColumns).map(cell => {
    if (cell.length <= limits.previewCellChars) return cell;
    clippedCells++;
    return cell.slice(0, limits.previewCellChars);
  });
  const headers = table.headers === null ? null : project(table.headers);
  const rows = table.rows.slice(0, limits.previewRows).map(project);
  return {
    headers,
    rows,
    omittedRows: table.rows.length - rows.length,
    omittedColumns: Math.max(0, columns - limits.previewColumns),
    clippedCells,
    cellCharacterLimit: limits.previewCellChars,
  };
}

async function workspaceTarget(ctx: Omit<Context, 'sessions'>, root: FsTarget, cwd: string, path: string, exec: ToolExecution): Promise<FsTarget> {
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
  if (!ctx.fs.contains(root, target)) {
    throw new FsError('CSV files must be inside the current Session workspace; choose a workspace path', 'FS_PERMISSION_DENIED');
  }
  return target;
}

async function executionPolicy(ctx: Omit<Context, 'sessions'>, args: CsvArguments, input: ReturnType<typeof resolveInput>, exec: ToolExecution): Promise<SandboxExecutionPolicy> {
  const standing = ctx.sandboxPolicy.resolve({ session: exec.agent?.session });
  if (args.sandbox_permissions === undefined || args.justification === undefined) return standing;
  const approvedOperation = `CSV input ${JSON.stringify(input.inputPath)}; output ${JSON.stringify(input.outputPath)}; output format ${args.output_format ?? 'csv'}`;
  const mode = await approveEscalation({
    requestedMode: args.sandbox_permissions,
    justification: `${args.justification} [${approvedOperation}]`,
    effectiveMode: standing.mode,
    subject: 'operation',
  }, {
    approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'csv_process', signal: exec.signal,
  });
  return { ...standing, mode };
}

const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    inputPath: { type: 'string', required: true },
    outputPath: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    operation: { type: 'string', required: true, enum: ['preview', 'create', 'update'] },
    inputFormat: { type: 'string', required: true, enum: ['csv', 'tsv'] },
    outputFormat: { type: 'string', required: true, enum: ['csv', 'tsv'] },
    inputBytes: { type: 'integer', required: true },
    outputBytes: { type: 'integer', required: true },
    columns: { type: 'integer', required: true },
    sourceRows: { type: 'integer', required: true },
    resultRows: { type: 'integer', required: true },
    blankRowsRemoved: { type: 'integer', required: true },
    trimmedCells: { type: 'integer', required: true },
    duplicatesRemoved: { type: 'integer', required: true },
    filteredOut: { type: 'integer', required: true },
    formulaCells: { type: 'integer', required: true },
    formulasProtected: { type: 'boolean', required: true },
    delimiterDetected: { type: 'boolean', required: true },
    preview: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        headers: { required: true, oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        rows: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
        omittedRows: { type: 'integer', required: true },
        omittedColumns: { type: 'integer', required: true },
        clippedCells: { type: 'integer', required: true },
        cellCharacterLimit: { type: 'integer', required: true },
      },
    },
  },
} as const;

/**
 * Register CSV preview and processing through DSH's normal Tool pipeline.
 * Files remain inside the calling Session workspace, including approved writes.
 * Reads preserve original bytes; writes are complete UTF-8 files with a BOM.
 * Existing outputs require DSH's prior observation and atomic version guard.
 * @param ctx DSH Tool, sandboxed filesystem, policy, and optional approval services.
 * @param config Deployment limits for file size, preview, and parser diagnostics.
 * @throws Error for invalid limits or a filesystem provider that does not enforce sandbox policy.
 */
export function applyDataTools(ctx: Omit<Context, 'sessions'>, config: DataToolsConfig = {}): void {
  const limits = resolveLimits(config);
  if (ctx.fs.sandboxMode === undefined) throw new Error('csv_process requires a sandbox-enforcing DSH filesystem provider');
  const tool = defineTool({
    name: 'csv_process',
    description: 'Read a complete workspace CSV/TSV, optionally trim cells, remove duplicate rows, filter, and sort. Omit output_path to preview only; supply it to save every result row as UTF-8 with a BOM. Quoted multiline fields and text values are preserved. Column indexes are zero-based. Preview cells are before spreadsheet formula escaping; preview truncation never truncates the saved file. Existing output files must be read first. Operations run in trim, deduplicate, filter, sort order.',
    parameters: {
      input_path: { type: 'string', required: true, description: 'CSV/TSV path inside the current Session workspace.' },
      output_path: { type: 'string', description: 'Workspace path to save. Omit for a read-only preview.' },
      delimiter: { type: 'string', enum: ['auto', 'csv', 'tsv'], description: 'Input separator; defaults to automatic CSV/TSV detection.' },
      output_format: { type: 'string', enum: ['csv', 'tsv'], description: 'Saved format; defaults to csv.' },
      encoding: { type: 'string', enum: ['utf-8', 'gb18030', 'utf-16le', 'utf-16be'], description: 'Input encoding; defaults to strict UTF-8.' },
      header: { type: 'boolean', description: 'First record is a header; defaults to true.' },
      skip_blank_rows: { type: 'boolean', description: 'Remove empty records; defaults to false.' },
      trim: { type: 'boolean', description: 'Trim leading/trailing whitespace in every cell; defaults to false.' },
      deduplicate: { type: 'boolean', description: 'Remove identical data rows after trimming; defaults to false.' },
      filter: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Case-insensitive substring to keep; empty text keeps all rows.' },
          column: { type: 'integer', description: 'Zero-based column; omit to search every column.' },
        },
      },
      sort: {
        type: 'object', additionalProperties: false,
        properties: {
          column: { type: 'integer', required: true, description: 'Zero-based column for numeric-aware text ordering.' },
          direction: { type: 'string', enum: ['ascending', 'descending'], description: 'Defaults to ascending.' },
        },
      },
      sort_locale: { type: 'string', enum: ['zh-CN', 'en-US'], description: 'Text collation and filtering locale; defaults to zh-CN.' },
      protect_formulas: { type: 'boolean', description: 'Prefix spreadsheet-active cells with a quote on export; defaults to true.' },
      sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Only retry a sandbox-denied save with the narrowest wider mode and justification. DSH asks for one-time approval; paths remain workspace-confined.' },
      justification: { type: 'string', description: 'Required with sandbox_permissions: explain why this exact save needs wider access.' },
    },
    output: {
      schema: resultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.output_path === undefined,
    async execute(args: CsvArguments, exec) {
      const input = resolveInput(args);
      const cwd = exec.agent?.session.header.cwd;
      if (cwd === undefined || cwd.trim() === '') throw new Error('csv_process requires a Session workspace');
      exec.signal.throwIfAborted();
      const approvalBinding = JSON.stringify({ input, mode: args.sandbox_permissions, justification: args.justification, outputFormat: args.output_format });
      const policy = await executionPolicy(ctx, args, input, exec);
      const resumedInput = resolveInput(args);
      const resumedBinding = JSON.stringify({ input: resumedInput, mode: args.sandbox_permissions, justification: args.justification, outputFormat: args.output_format });
      if (resumedBinding !== approvalBinding) throw new Error('CSV arguments changed while approval was pending; no file was saved. Review the operation and retry.');
      const root = await ctx.fs.resolve(cwd, { signal: exec.signal });
      const source = await workspaceTarget(ctx, root, cwd, input.inputPath, exec);
      const destination = input.outputPath === null ? null : await workspaceTarget(ctx, root, cwd, input.outputPath, exec);
      const info = await ctx.fs.stat(source, exec.signal);
      if (info === undefined) {
        ctx.emit('fs/observed', source, { kind: 'absent' }, exec);
        throw new FsError('CSV input file was not found', 'FS_NOT_FOUND');
      }
      if (info.type !== 'file') throw new FsError('CSV input must be a regular file', 'FS_NOT_REGULAR_FILE');
      const bytes = await ctx.fs.readBytes(source, exec.signal, limits.maxInputBytes);
      const afterRead = await ctx.fs.stat(source, exec.signal);
      if (afterRead?.version !== info.version) throw new FsError('CSV input changed while reading; retry the operation', 'FS_STALE_VERSION');
      const table = parseDelimited(decodeDelimitedBytes(bytes, input.encoding), input.delimiter, input.skipBlankRows);
      const errors = table.issues.filter(issue => issue.severity === 'error');
      if (errors.length > 0) throw new Error(`CSV input has ${errors.length} parsing errors; no file was saved. ${JSON.stringify(errors.slice(0, limits.maxDiagnostics))}`);
      const columns = table.rows[0]?.length ?? 0;
      for (const [name, column] of [['filter.column', input.options.filterColumn], ['sort.column', input.options.sortColumn]] as const) {
        if (column !== null && column >= columns) throw new Error(`${name} must be less than the input column count (${columns})`);
      }
      exec.signal.throwIfAborted();
      const processed = processTable(table, input.options);
      const preview = previewTable(processed, columns, limits);
      const output = '\ufeff' + serializeDelimited(processed, input.outputDelimiter, input.protectFormulas);
      exec.signal.throwIfAborted();
      ctx.emit('fs/observed', source, { kind: 'present', version: info.version }, exec);
      let operation: 'preview' | 'create' | 'update' = 'preview';
      if (destination !== null) {
        const intent = await ctx.waterfall('fs/write-intent', destination, exec, () => ({ kind: 'createIfAbsent' } as const));
        try {
          const outcome = await ctx.fs.writeText(destination, output, intent, exec.signal, policy);
          operation = outcome.operation;
          ctx.emit('fs/observed', destination, { kind: 'present', version: outcome.version }, exec);
        } catch (error) {
          if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') {
            throw new FsError(`${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker('operation')}`, error.code, { cause: error });
          }
          throw error;
        }
      }
      return {
        inputPath: source.displayPath,
        outputPath: destination?.displayPath ?? null,
        operation,
        inputFormat: table.delimiter === '\t' ? 'tsv' as const : 'csv' as const,
        outputFormat: input.outputDelimiter === '\t' ? 'tsv' as const : 'csv' as const,
        inputBytes: bytes.length,
        outputBytes: Buffer.byteLength(output, 'utf-8'),
        columns,
        sourceRows: processed.sourceRows,
        resultRows: processed.rows.length,
        blankRowsRemoved: table.blankRowsRemoved,
        trimmedCells: processed.trimmedCells,
        duplicatesRemoved: processed.duplicatesRemoved,
        filteredOut: processed.filteredOut,
        formulaCells: processed.formulaCells,
        formulasProtected: input.protectFormulas,
        delimiterDetected: !table.issues.some(issue => issue.code === 'delimiter'),
        preview,
      };
    },
    presentCall: args => ({
      card: 'generic', title: args.output_path === undefined ? `Preview ${args.input_path}` : `Process ${args.input_path}`,
      kind: args.output_path === undefined ? 'read' : 'edit',
      locations: [{ path: args.input_path }, ...args.output_path === undefined ? [] : [{ path: args.output_path }]],
    }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
  });
  ctx.effect(() => ctx.tools.register(tool), 'clawmaster: CSV tools');
}
