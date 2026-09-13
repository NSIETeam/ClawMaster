/** Local tabular processing; PapaParse owns CSV syntax and serialization. */
import Papa from 'papaparse';

/** Supported delimited-text formats. */
export type TableDelimiter = ',' | '\t';

/** Parser diagnostics use record numbers, including the optional header. */
export type DelimitedIssue =
  | { code: 'delimiter'; severity: 'warning' }
  | { code: 'quotes'; severity: 'error'; record: number }
  | { code: 'columns'; severity: 'error'; record: number; expected: number; actual: number };

/** Unconverted cell values and diagnostics from a local text source. */
export interface ParsedTable {
  delimiter: TableDelimiter;
  rows: string[][];
  issues: DelimitedIssue[];
  blankRowsRemoved: number;
}

/** Explicit transformations applied in trim, deduplicate, filter, sort order. */
export interface TableProcessingOptions {
  header: boolean;
  trim: boolean;
  deduplicate: boolean;
  filterColumn: number | null;
  filterText: string;
  sortColumn: number | null;
  sortDirection: 'ascending' | 'descending';
  locale: 'zh-CN' | 'en-US';
}

/** Complete processed dataset; the UI may display only part of rows. */
export interface ProcessedTable {
  headers: string[] | null;
  rows: string[][];
  sourceRows: number;
  trimmedCells: number;
  duplicatesRemoved: number;
  filteredOut: number;
  formulaCells: number;
}

/**
 * Parses CSV/TSV without coercion or implicit trimming. A terminal line break is
 * a record terminator; interior empty records are retained unless requested.
 * @param input Decoded text, optionally prefixed by a BOM.
 * @param requestedDelimiter Explicit format or PapaParse's CSV/TSV detection.
 * @param skipBlankRows Whether to remove completely empty parsed records.
 * @returns Cells, counts, and diagnostics; malformed data remains unprocessable.
 */
export function parseDelimited(
  input: string,
  requestedDelimiter: TableDelimiter | 'auto' = 'auto',
  skipBlankRows = false,
): ParsedTable {
  if (input === '' || input === '\ufeff') {
    return { delimiter: requestedDelimiter === '\t' ? '\t' : ',', rows: [], issues: [], blankRowsRemoved: 0 };
  }
  const issues: DelimitedIssue[] = [];
  let delimiter: TableDelimiter;
  if (requestedDelimiter === 'auto') {
    // Detection ignores empty lines; the real parse retains those records so the
    // user can decide whether to drop them.
    const probe = Papa.parse<string[]>(input, { delimitersToGuess: [',', '\t'], skipEmptyLines: true, preview: 1 });
    delimiter = probe.meta.delimiter === '\t' ? '\t' : ',';
    if (probe.errors.some(error => error.code === 'UndetectableDelimiter')) {
      issues.push({ code: 'delimiter', severity: 'warning' });
    }
  } else {
    delimiter = requestedDelimiter;
  }
  const parsed = Papa.parse<string[]>(input, { delimiter, dynamicTyping: false, skipEmptyLines: false });
  const rows = parsed.data;
  const last = rows.at(-1);
  if (/[\r\n]$/.test(input) && last?.length === 1 && last[0] === '') rows.pop();
  for (const error of parsed.errors) {
    if (error.type === 'Quotes') {
      const record = (error.row ?? 0) + 1;
      if (!issues.some(issue => issue.code === 'quotes' && issue.record === record)) {
        issues.push({ code: 'quotes', severity: 'error', record });
      }
    }
  }
  let blankRowsRemoved = 0;
  const retained: string[][] = [];
  for (const [index, row] of rows.entries()) {
    if (skipBlankRows && row.length === 1 && row[0] === '') {
      blankRowsRemoved++;
      continue;
    }
    const width = retained[0]?.length;
    if (width !== undefined && row.length !== width) {
      issues.push({ code: 'columns', severity: 'error', record: index + 1, expected: width, actual: row.length });
    }
    retained.push(row);
  }
  return { delimiter, rows: retained, issues, blankRowsRemoved };
}

/**
 * Creates a new processed table without modifying source values.
 * @param table Parsed table with no fatal diagnostic.
 * @param options Explicit operations; sorting uses numeric-aware text collation.
 * @returns All matching rows, header, and operation counts.
 * @throws Error when source syntax or record widths are invalid.
 */
export function processTable(table: ParsedTable, options: TableProcessingOptions): ProcessedTable {
  if (table.issues.some(issue => issue.severity === 'error')) throw new Error('Cannot process an invalid table');
  let trimmedCells = 0;
  const copied = table.rows.map(row => row.map(cell => {
    const next = options.trim ? cell.trim() : cell;
    if (cell !== next) trimmedCells++;
    return next;
  }));
  const headers = options.header && copied.length > 0 ? copied.shift()! : null;
  const sourceRows = copied.length;
  let rows = copied;
  let duplicatesRemoved = 0;
  if (options.deduplicate) {
    const seen = new Set<string>();
    rows = rows.filter(row => {
      const key = JSON.stringify(row);
      if (seen.has(key)) { duplicatesRemoved++; return false; }
      seen.add(key);
      return true;
    });
  }
  const beforeFilter = rows.length;
  if (options.filterText !== '') {
    const query = options.filterText.toLocaleLowerCase(options.locale);
    rows = rows.filter(row => {
      const values = options.filterColumn === null ? row : [row[options.filterColumn] ?? ''];
      return values.some(value => value.toLocaleLowerCase(options.locale).includes(query));
    });
  }
  if (options.sortColumn !== null) {
    const column = options.sortColumn;
    const direction = options.sortDirection === 'ascending' ? 1 : -1;
    const collator = new Intl.Collator(options.locale, { numeric: true, sensitivity: 'base' });
    rows.sort((left, right) => direction * collator.compare(left[column] ?? '', right[column] ?? ''));
  }
  const allRows = headers ? [headers, ...rows] : rows;
  const formulaCells = allRows.reduce((count, row) => count + row.filter(cell => /^[=+\-@\t\r]/.test(cell)).length, 0);
  return { headers, rows, sourceRows, trimmedCells, duplicatesRemoved, filteredOut: beforeFilter - rows.length, formulaCells };
}

/**
 * Serializes every processed row, including the optional header.
 * @param table Complete processed dataset.
 * @param delimiter Output separator.
 * @param protectFormulas Prefix spreadsheet-active cells with a single quote.
 * @returns Delimited text with CRLF record terminators and quoted multiline cells.
 */
export function serializeDelimited(table: ProcessedTable, delimiter: TableDelimiter, protectFormulas: boolean): string {
  return Papa.unparse(table.headers ? [table.headers, ...table.rows] : table.rows, {
    delimiter, newline: '\r\n', escapeFormulae: protectFormulas,
  });
}

/**
 * Decodes a local file without replacement characters for malformed byte sequences.
 * @param bytes Local file bytes.
 * @param encoding Browser-supported encoding selected by the user.
 * @returns Decoded text with any encoding BOM consumed.
 * @throws TypeError or RangeError for malformed bytes or an unsupported encoding.
 */
export function decodeDelimitedBytes(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
