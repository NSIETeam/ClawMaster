/**
 * PDF operations: bytes in, bytes out.
 *
 * This is the whole of the built-in PDF track. It is deliberately pure — no filesystem, no routes, no
 * DSH services — because that is what makes every operation testable, and because the same code runs in
 * the Host when the agent asks for it and in the panel when the user clicks a button.
 *
 * The capability boundary was measured against `pdf-lib` 1.17.1 rather than assumed:
 * - Pages cannot move between documents directly; a page from another file must be copied first.
 * - There is no encryption and no text extraction. Those two are exactly what the optional Stirling-PDF
 *   component is for, so this module refuses them by name instead of pretending.
 */
import { PDFDocument, degrees, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/** Every operation the built-in track can perform. */
export type PdfOperation =
  | { op: 'extract'; ranges: string; mode?: 'keep' | 'remove' }
  | { op: 'reorder'; order: string }
  | { op: 'rotate'; pages?: string | undefined; by: 90 | 180 | 270 }
  | { op: 'delete'; pages: string }
  | { op: 'merge'; paths?: string[]; extra?: Uint8Array[] }
  | { op: 'insert'; at: number; from: string }
  | { op: 'pageNumbers'; position?: 'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'; startAt?: number; template?: string }
  | { op: 'watermark'; text: string; opacity?: number; size?: number; angle?: number; color?: 'red' | 'grey' | 'blue' }
  | { op: 'metadata'; title?: string | undefined; author?: string | undefined; subject?: string | undefined; keywords?: string[] | undefined };

/** One input document: the one being edited, plus any named file another operation refers to. */
export interface PdfInput {
  /** The document under the cursor. */
  base?: Uint8Array;
  /** Other documents by name, for `merge` and `insert`. */
  files?: ReadonlyMap<string, Uint8Array>;
}

/** One file the operation sequence produced. */
export interface PdfOutput {
  /** A short name for the result, so a caller can name the file it writes. */
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  /**
   * True when this is the document carried through the sequence rather than a file the caller asked
   * for. It is marked rather than omitted because a caller may still want it — the note that a split
   * happened is information the caller needs, and a split must never overwrite the source.
   */
  carriedThrough?: boolean;
}

/** What the operation sequence reports. */
export interface PdfEditResult {
  outputs: PdfOutput[];
  /** Page count of the document that was carried through the sequence, when there is one. */
  pageCount?: number;
}

/** A refusal the caller can show a user, rather than a stack trace from inside the library. */
export class PdfError extends Error {
  constructor(readonly code: 'invalid_request' | 'unsupported' | 'damaged', message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

/** The built-in track's limits, so one call cannot exhaust the Host. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** More than this many outputs at once is a mistake, not a request. */
export const MAX_OUTPUTS = 200;

/**
 * Run an operation sequence over the input documents.
 * @param input - The base document and any named files the operations refer to.
 * @param operations - The operations to apply, in the order given.
 * @returns Every file the sequence produced.
 */
export async function editPdf(input: PdfInput, operations: readonly PdfOperation[]): Promise<PdfEditResult> {
  if (input.base === undefined && !operations.some(operation => operation.op === 'merge')) {
    throw new PdfError('invalid_request', 'A base document is required unless the sequence merges files.');
  }
  let doc = input.base === undefined ? await PDFDocument.create() : await loadDocument(input.base, 'base');
  const outputs: PdfOutput[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case 'extract': {
        const pages = selectPages(operation.ranges, doc.getPageCount());
        if (operation.mode === 'remove') {
          for (const pageIndex of [...pages].sort((left, right) => right - left)) doc.removePage(pageIndex);
          break;
        }
        outputs.push(...await splitPages(doc, pages, 'extract'));
        break;
      }
      case 'reorder': {
        const order = selectPages(operation.order, doc.getPageCount());
        if (order.length !== doc.getPageCount()) {
          throw new PdfError('invalid_request', `A new order must name every page exactly once; ${order.length} of ${doc.getPageCount()} were named.`);
        }
        // A page object cannot be added to the document it came from, so each page is replaced by a
        // copy in the new position and the originals are removed last.
        const copies = await doc.copyPages(doc, order);
        for (const pageIndex of [...Array(doc.getPageCount()).keys()].reverse()) doc.removePage(pageIndex);
        for (const copy of copies) doc.addPage(copy);
        break;
      }
      case 'rotate': {
        for (const pageIndex of operation.pages === undefined ? [...Array(doc.getPageCount()).keys()] : selectPages(operation.pages, doc.getPageCount())) {
          const page = doc.getPage(pageIndex);
          page.setRotation(degrees((page.getRotation().angle + operation.by) % 360));
        }
        break;
      }
      case 'delete': {
        for (const pageIndex of selectPages(operation.pages, doc.getPageCount()).sort((left, right) => right - left)) doc.removePage(pageIndex);
        if (doc.getPageCount() === 0) throw new PdfError('invalid_request', 'Deleting every page would leave nothing; at least one page must remain.');
        break;
      }
      case 'merge': {
        const sources = [...(operation.extra ?? [])];
        for (const path of operation.paths ?? []) {
          const bytes = input.files?.get(path);
          if (bytes === undefined) throw new PdfError('invalid_request', `No input file named ${path}.`);
          sources.push(bytes);
        }
        if (sources.length === 0) throw new PdfError('invalid_request', 'Merging needs at least one other document.');
        for (const [position, source] of sources.entries()) {
          const other = await loadDocument(source, `merge source ${position + 1}`);
          // Copying is mandatory: pdf-lib refuses a page that belongs to another document.
          const copied = await doc.copyPages(other, other.getPageIndices());
          for (const page of copied) doc.addPage(page);
        }
        break;
      }
      case 'insert': {
        const source = input.files?.get(operation.from);
        if (source === undefined) throw new PdfError('invalid_request', `No input file named ${operation.from}.`);
        const count = doc.getPageCount();
        if (!Number.isInteger(operation.at) || operation.at < 0 || operation.at > count) {
          throw new PdfError('invalid_request', `Insert at a position between 0 and ${count}, not ${operation.at}.`);
        }
        const other = await loadDocument(source, operation.from);
        const copied = await doc.copyPages(other, other.getPageIndices());
        for (const [offset, page] of copied.entries()) doc.insertPage(operation.at + offset, page);
        break;
      }
      case 'pageNumbers': {
        assertDrawable(operation.template ?? '{n}', 'page number template');
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.getPages().forEach((page, position) => {
          const label = (operation.template ?? '{n}').replace('{n}', String((operation.startAt ?? 1) + position)).replace('{total}', String(doc.getPageCount()));
          drawFooter(page, font, label, operation.position ?? 'bottom-center');
        });
        break;
      }
      case 'watermark': {
        assertDrawable(operation.text, 'watermark text');
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        const color = operation.color === 'red' ? rgb(0.85, 0.15, 0.15) : operation.color === 'blue' ? rgb(0.15, 0.3, 0.85) : rgb(0.45, 0.45, 0.45);
        for (const page of doc.getPages()) {
          drawWatermark(page, font, operation.text, {
            opacity: operation.opacity ?? 0.25,
            size: operation.size ?? 48,
            angle: operation.angle ?? 45,
            color,
          });
        }
        break;
      }
      case 'metadata': {
        if (operation.title !== undefined) doc.setTitle(operation.title);
        if (operation.author !== undefined) doc.setAuthor(operation.author);
        if (operation.subject !== undefined) doc.setSubject(operation.subject);
        if (operation.keywords !== undefined) doc.setKeywords([...operation.keywords]);
        // pdf-lib overwrites Producer with its own name on every save, so the vendor that actually
        // produced the file belongs in Creator, which pdf-lib leaves alone when it is already set.
        doc.setCreator('ClawMaster');
        doc.setModificationDate(new Date());
        break;
      }
      default: {
        // An operation the type system knows but this switch does not is a programming error, and it
        // must be loud rather than silently dropped from the sequence.
        throw new PdfError('invalid_request', `Unknown operation ${JSON.stringify((operation as { op?: unknown }).op)}.`);
      }
    }
  }

  // The document is carried through and reported, but when the sequence also produced files of its
  // own this one is a by-product: the caller decides whether to keep it, and its bytes are the same
  // as the source only when no operation changed the pages.
  outputs.push({ name: 'result', bytes: await doc.save(), pageCount: doc.getPageCount(), carriedThrough: outputs.length > 0 });
  if (outputs.length > MAX_OUTPUTS) throw new PdfError('invalid_request', `That would produce ${outputs.length} files; at most ${MAX_OUTPUTS} are produced at once.`);
  return { outputs, pageCount: doc.getPageCount() };
}

/** What a document is, without changing it. */
export interface PdfInfo {
  pageCount: number;
  /** Page sizes in points, in document order. */
  sizes: Array<{ width: number; height: number }>;
  /** Rotation already applied to each page, in degrees. */
  rotations: number[];
  title?: string;
  author?: string;
  subject?: string;
  keywords: string[];
  /** The tool that wrote the file; pdf-lib always claims Producer for itself. */
  creator?: string;
  producer?: string;
}

/**
 * Read a document's structure.
 * @param bytes - The whole file.
 * @returns Page geometry and the metadata fields ClawMaster cares about.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await loadDocument(bytes, 'document');
  const pages = doc.getPages();
  return {
    pageCount: doc.getPageCount(),
    sizes: pages.map(page => ({ width: round(page.getWidth()), height: round(page.getHeight()) })),
    rotations: pages.map(page => page.getRotation().angle),
    ...(doc.getTitle() === undefined ? {} : { title: doc.getTitle() as string }),
    ...(doc.getAuthor() === undefined ? {} : { author: doc.getAuthor() as string }),
    ...(doc.getSubject() === undefined ? {} : { subject: doc.getSubject() as string }),
    keywords: readKeywords(doc.getKeywords()),
    ...(doc.getCreator() === undefined ? {} : { creator: doc.getCreator() as string }),
    ...(doc.getProducer() === undefined ? {} : { producer: doc.getProducer() as string }),
  };
}

/**
 * Expand a page selection into zero-based page indexes.
 *
 * The syntax is what a person types: `1-3`, `5`, `2,4-6`, `last`, `-3` for the last three. Ranges may
 * be written either way round (`3-1`), because that is a slip, not a different request.
 * @param text - The selection.
 * @param total - How many pages the document has.
 * @returns Page indexes, in the order written, without duplicates.
 */
export function selectPages(text: string, total: number): number[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return [...Array(total).keys()];
  const seen = new Set<number>();
  const picked: number[] = [];
  const take = (pageIndex: number): void => {
    if (pageIndex < 0 || pageIndex >= total || seen.has(pageIndex)) return;
    seen.add(pageIndex);
    picked.push(pageIndex);
  };
  for (const part of trimmed.split(',').map(piece => piece.trim()).filter(piece => piece !== '')) {
    if (/^last$/i.test(part)) {
      take(total - 1);
      continue;
    }
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(part);
    if (range !== null) {
      const from = pageNumber(range[1]!, total);
      const to = pageNumber(range[2]!, total);
      if (from === undefined || to === undefined) throw new PdfError('invalid_request', `Page number out of range in "${part}" (the document has ${total} pages).`);
      const step = from <= to ? 1 : -1;
      for (let page = from; step > 0 ? page <= to : page >= to; page += step) take(page);
      continue;
    }
    if (/^-?\d+$/.test(part)) {
      const page = pageNumber(part, total);
      if (page === undefined) throw new PdfError('invalid_request', `Page number out of range in "${part}" (the document has ${total} pages).`);
      take(page);
      continue;
    }
    throw new PdfError('invalid_request', `Cannot read the page selection "${part}". Use page numbers, ranges like 2-5, "last", or "all".`);
  }
  return picked;
}

/**
 * One page number as written by a person, or undefined when it names no page.
 * Pages are counted from 1 in what a person types; a negative number counts back from the end, so -1
 * is the last page. Zero names nothing.
 */
function pageNumber(text: string, total: number): number | undefined {
  const value = Number(text);
  if (!Number.isInteger(value) || value === 0) return undefined;
  const index = value < 0 ? total + value : value - 1;
  return index >= 0 && index < total ? index : undefined;
}

/** Split a document into one file per selected page. */
async function splitPages(doc: PDFDocument, pages: readonly number[], name: string): Promise<PdfOutput[]> {
  const created: PdfOutput[] = [];
  for (const [position, pageIndex] of pages.entries()) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(doc, [pageIndex]);
    if (page !== undefined) single.addPage(page);
    created.push({ name: `${name}-${position + 1}`, bytes: await single.save(), pageCount: 1 });
  }
  return created;
}

/** Load a document, turning a damaged file into a refusal rather than a library stack trace. */
async function loadDocument(bytes: Uint8Array, label: string): Promise<PDFDocument> {
  if (bytes.byteLength === 0) throw new PdfError('damaged', `The ${label} is empty.`);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new PdfError('invalid_request', `The ${label} is ${Math.round(bytes.byteLength / 1048576)} MiB; at most ${MAX_INPUT_BYTES / 1048576} MiB is handled.`);
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  if (header !== '%PDF-') throw new PdfError('damaged', `The ${label} does not start with %PDF-.`);
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) throw new PdfError('unsupported', `The ${label} is encrypted; the built-in tools cannot open it.`);
    throw new PdfError('damaged', `The ${label} could not be read: ${message}`);
  }
}

/**
 * Refuse text the built-in fonts cannot draw, with an explanation instead of a library error.
 *
 * `pdf-lib`'s standard fonts are WinAnsi: Latin letters, digits and Western punctuation. A CJK
 * watermark needs an embedded font subset, which would add megabytes to every install for a feature
 * most documents never use — so the built-in track says what it cannot do and names the track that can,
 * rather than encoding the text as question marks or failing deep inside the library.
 * @param text - The text about to be drawn.
 * @param what - What the text is, for the message.
 */
function assertDrawable(text: string, what: string): void {
  // eslint-disable-next-line no-control-regex
  const undrawable = [...text].filter(character => /[^\u0000-\u00ff]/.test(character));
  if (undrawable.length === 0) return;
  throw new PdfError(
    'unsupported',
    `The built-in tools draw Latin text only, so the ${what} cannot contain ${[...new Set(undrawable)].slice(0, 8).join(' ')}. `
    + 'Use Latin text here, or use the optional Stirling-PDF component, which embeds a full font.',
  );
}

/** Draw a page number where the caller asked for it. */
function drawFooter(page: PDFPage, font: PDFFont, label: string, position: 'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'): void {
  const size = 10;
  const width = page.getWidth();
  const height = page.getHeight();
  const textWidth = font.widthOfTextAtSize(label, size);
  const top = position.startsWith('top');
  const centered = position.endsWith('center');
  const x = centered ? (width - textWidth) / 2 : width - textWidth - 36;
  const y = top ? height - 28 : 24;
  page.drawText(label, { x, y, size, font, color: rgb(0.25, 0.25, 0.25) });
}

/** Draw a diagonal watermark across the middle of a page. */
function drawWatermark(page: PDFPage, font: PDFFont, text: string, style: { opacity: number; size: number; angle: number; color: ReturnType<typeof rgb> }): void {
  const width = font.widthOfTextAtSize(text, style.size);
  // Rotation happens about the text origin, so the origin is placed to put the text's centre on the
  // page's centre; otherwise a rotated watermark drifts off the page.
  const radians = (style.angle * Math.PI) / 180;
  const x = page.getWidth() / 2 - (width / 2) * Math.cos(radians) + (style.size / 2) * Math.sin(radians);
  const y = page.getHeight() / 2 - (width / 2) * Math.sin(radians) - (style.size / 2) * Math.cos(radians);
  page.drawText(text, { x, y, size: style.size, font, color: style.color, opacity: style.opacity, rotate: degrees(style.angle) });
}

/**
 * Read the keywords back.
 *
 * `pdf-lib` joins the list with spaces rather than the commas a person would type, so the split is on
 * both: a comma when the writer used one, and whitespace otherwise. Round-tripping what ClawMaster
 * itself wrote is the case that has to work.
 * @param value - The keyword entry, which may be a single string or an array.
 * @returns The keywords, in order.
 */
function readKeywords(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const text = Array.isArray(value) ? value.join(' ') : value;
  return text.split(/[,;]\s*|\s+/).map(word => word.trim()).filter(word => word !== '');
}

/** Round a point measurement to two decimals, so metadata output is stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
