export interface ParsedTable {
  delimiter: ',' | '\t';
  rows: string[][];
}

function parseRow(line: string, delimiter: ',' | '\t'): string[] {
  const cells: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  cells.push(value.trim());
  return cells;
}

export function parseDelimited(input: string): ParsedTable {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim().length > 0);
  const firstLine = lines[0] ?? '';
  const delimiter = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
  return { delimiter, rows: lines.map(line => parseRow(line, delimiter)) };
}

export function readStoredList<T>(raw: string | null, validate: (value: unknown) => value is T): T[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(validate) : [];
  } catch {
    return [];
  }
}
