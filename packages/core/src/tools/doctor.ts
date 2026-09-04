/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * doctor 工具：一次性体检 ClawMaster 各能力所依赖的外部二进制/模块，返回可读报告
 * （哪些就绪、哪些缺、缺的怎么装、各自影响哪个能力）。只读、安全、自动批准。
 */

import {
  BaseTool,
  ToolResult,
  ToolCallConfirmationDetails,
  Icon,
  ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config } from '../config/config.js';
import { DoctorService, formatDoctorReport } from '../services/doctor.js';

export interface DoctorToolParams {
  action: 'check';
}

export class DoctorTool extends BaseTool<DoctorToolParams, ToolResult> {
  static readonly Name: string = 'doctor';

  constructor(_config: Config) {
    const desc = `Health-check ClawMaster capability providers, including Rust-native, packaged, and optional external components.

EXAMPLES:
  Run full check: {action:"check"}

Reports which capabilities are ready through Rust/Core providers, which required
runtime is genuinely missing, and which external tools are optional enhancements.
Never recommend installing every optional component as a prerequisite.

Read-only and auto-approved. No prerequisites -- uses which/where + --version.`;
    super(DoctorTool.Name, 'Doctor', desc, Icon.Wrench, {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: 'Health check to run',
          enum: ['check'],
        },
      },
      required: ['action'],
    });
  }

  validateToolParams(p: DoctorToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, DoctorTool.Name);
    return e || null;
  }

  toolLocations(): ToolLocation[] {
    return [];
  }

  getDescription(p: DoctorToolParams): string {
    return 'doctor: ' + p.action;
  }

  async shouldConfirmExecute(
    _p: DoctorToolParams,
    _s: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    return false; // 只读体检，自动批准
  }

  async execute(p: DoctorToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) {
      return { llmContent: 'doctor FAIL: ' + err, returnDisplay: 'doctor FAIL: ' + err };
    }
    try {
      const service = new DoctorService();
      const report = await service.check();
      const text = formatDoctorReport(report);
      const summary = report.missingCount === 0
        ? `doctor OK: 基础能力正常；${report.optionalMissingCount} 项按需增强未安装`
        : `doctor WARN: ${report.missingCount} 项必需能力缺失`;
      return { llmContent: text, returnDisplay: summary };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'doctor FAIL: ' + m, returnDisplay: 'doctor FAIL: ' + m };
    }
  }
}
