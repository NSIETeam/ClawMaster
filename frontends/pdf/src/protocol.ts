/**
 * The PDF wire contract: what the Sidebar panel and the Host agree on.
 * Pure formatting and validation only, so the browser half can bundle it too.
 */
import { z } from 'zod';
import { PDF_EXTENSION } from './constants.ts';

export const PDF_INFO_PATH = '/api/clawmaster/pdf/info';
export const PDF_EDIT_PATH = '/api/clawmaster/pdf/edit';
export const PDF_STIRLING_PATH = '/api/clawmaster/pdf/stirling';

/** How many files one request may name as inputs. */
export const MAX_INPUT_FILES = 20;

/** A page selection as a person writes it: `1,3-5`, `last`, `-2--1`, `all`. */
export const pageSelectionSchema = z.string().min(1).max(200);

/**
 * One operation on the wire.
 *
 * This accepts any operation *name* and validates its fields loosely, on purpose. A strict union would
 * reject `ocr` or `encrypt` here, and the answer would be a flat 400 — but those are exactly the
 * operations a user is most likely to ask for and most needs an explanation about, because the optional
 * Stirling-PDF component is what performs them. Naming an operation the built-in track does not have is
 * therefore a *supported* request that produces one precise refusal, not a malformed message, so the
 * capability check lives in the service where it can say which component to enable.
 */
export const pdfOperationSchema = z.object({
  op: z.string().min(1).max(40).describe('The operation name.'),
}).loose();

/** An operation name the built-in track implements. */
export const BUILT_IN_OPERATIONS = [
  'extract', 'reorder', 'rotate', 'delete', 'merge', 'insert', 'pageNumbers', 'watermark', 'metadata',
] as const;


/** One request to run operations over a file. */
export const pdfEditRequestSchema = z.object({
  /** The file to work on, relative to the task folder. */
  source: z.string().min(1).max(1024),
  /** Other files the operations refer to, also relative to the task folder. */
  inputs: z.array(z.string().min(1).max(1024)).max(MAX_INPUT_FILES).default([]),
  operations: z.array(pdfOperationSchema).min(1).max(50),
  /** Overwrite the source when the sequence produces a single file, instead of writing beside it. */
  inPlace: z.boolean().default(false),
}).strict();
export type PdfEditRequest = z.output<typeof pdfEditRequestSchema>;

/** One file the edit produced. */
export const pdfOutputSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().min(0),
  pageCount: z.number().int().min(0),
}).strict();
export type PdfOutput = z.output<typeof pdfOutputSchema>;

/** What an edit reports. */
export const pdfEditReceiptSchema = z.object({
  source: z.string().min(1),
  outputs: z.array(pdfOutputSchema),
  /** The revision of each written file, in the same `sha256-<hex>` shape the sidebar uses. */
  revisions: z.record(z.string(), z.string()),
  /** True when the source itself was replaced. */
  replacedSource: z.boolean(),
}).strict();
export type PdfEditReceipt = z.output<typeof pdfEditReceiptSchema>;

/** Page geometry and metadata, as the panel shows them. */
export const pdfInfoSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().min(0),
  pageCount: z.number().int().min(0),
  sizes: z.array(z.object({ width: z.number(), height: z.number() }).strict()),
  rotations: z.array(z.number()),
  title: z.string().optional(),
  author: z.string().optional(),
  subject: z.string().optional(),
  keywords: z.array(z.string()),
  creator: z.string().optional(),
  producer: z.string().optional(),
  /** The sidebar's revision for this file, so a later write can detect a concurrent edit. */
  revision: z.string(),
}).strict();
export type PdfInfo = z.output<typeof pdfInfoSchema>;

/** What the optional Stirling-PDF track reports about itself. */
export const stirlingStatusSchema = z.object({
  /** The built-in track is always present; this says whether the heavy track is. */
  available: z.boolean(),
  /** Where the optional runtime lives when it is installed. */
  directory: z.string(),
  /** The version reported by the runtime, when it is installed. */
  version: z.string().optional(),
  /** Why it is not available, when it is not. */
  reason: z.string().optional(),
  /** The operations the built-in track refuses and the optional track exists for. */
  delegatedOperations: z.array(z.string()),
}).strict();
export type StirlingStatus = z.output<typeof stirlingStatusSchema>;

/** The Stirling route answers with the status object itself rather than an envelope. */
export const pdfStirlingResponseSchema = stirlingStatusSchema;

/** The failure shape every route answers with. */
export const pdfFailureSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
}).strict();

/** The operations the built-in track cannot do, and the optional track is for. */
export const DELEGATED_OPERATIONS = ['encrypt', 'decrypt', 'ocr', 'fillForm', 'sign', 'extractText', 'convert', 'cjkWatermark'] as const;

/** The request envelope every route uses, mirroring the notes and voice commands. */
export function pdfCommandEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ request: schema }).strict();
}

/** True when a path names a PDF, for the panel's affordances. */
export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(PDF_EXTENSION);
}
