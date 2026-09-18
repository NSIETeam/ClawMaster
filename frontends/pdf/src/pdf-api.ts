/**
 * Browser-side PDF transport over the plugin's own authenticated Fetch routes.
 *
 * The carrier owns authentication and the origin check, so this is a typed wrapper with one extra job:
 * every failure becomes a {@link PdfApiError} carrying the server's code, so the panel can say "the
 * optional component does this" instead of "request failed".
 */
import { z } from 'zod';
import {
  PDF_EDIT_PATH, PDF_INFO_PATH, PDF_STIRLING_PATH,
  pdfCommandEnvelope, pdfEditReceiptSchema, pdfFailureSchema, pdfInfoSchema, pdfStirlingResponseSchema,
  type PdfEditReceipt, type PdfInfo, type StirlingStatus,
} from './protocol.ts';

/**
 * What the panel sends.
 *
 * Deliberately looser than the Host's schema: the Host validates the request in full, and duplicating
 * every bound here would only give the panel a second place to be wrong. This checks the two things the
 * panel alone knows — that it named a file and at least one operation — and lets the operation fields
 * through for the Host to judge.
 */
const panelEditRequestSchema = z.object({
  source: z.string().min(1).max(1024),
  inputs: z.array(z.string().min(1).max(1024)).max(20).optional(),
  operations: z.array(z.object({ op: z.string().min(1).max(40) }).loose()).min(1).max(50),
  inPlace: z.boolean().optional(),
}).loose();

/** One rejected PDF call, carrying the server's failure code. */
export class PdfApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PdfApiError';
  }
}

/** Typed calls against the PDF routes. */
export class PdfApi {
  constructor(private readonly request: typeof fetch) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, { credentials: 'same-origin', ...init });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PdfApiError('storage_unavailable', 'PDF response was not JSON.');
    }
    if (!response.ok) {
      const failure = pdfFailureSchema.safeParse(payload);
      if (failure.success) throw new PdfApiError(failure.data.error.code, failure.data.error.message);
      throw new PdfApiError('storage_unavailable', `PDF request failed with ${response.status}.`);
    }
    return payload;
  }

  /** Read one document's structure. */
  async info(path: string): Promise<PdfInfo> {
    const query = new URLSearchParams({ path });
    return pdfInfoSchema.parse(await this.call(`${PDF_INFO_PATH}?${query.toString()}`));
  }

  /** Run operations and write the results. */
  async edit(request: PanelEditRequest): Promise<PdfEditReceipt> {
    return pdfEditReceiptSchema.parse(await this.call(PDF_EDIT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pdfCommandEnvelope(panelEditRequestSchema).parse({ request })),
    }));
  }

  /** What the optional Stirling-PDF component can do, and whether it is installed. */
  async stirling(): Promise<StirlingStatus> {
    return pdfStirlingResponseSchema.parse(await this.call(PDF_STIRLING_PATH));
  }
}

/** One request the panel sends: a file and the operations to run over it. */
export interface PanelEditRequest {
  source: string;
  inputs?: string[];
  operations: Array<Record<string, unknown>>;
  inPlace?: boolean;
}
