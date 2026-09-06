/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

export interface ForecastObservation {
  organizationId: string;
  modelId: string;
  target: string;
  horizonDays: number;
  unit: string;
  forecast: bigint;
  actual: bigint;
  predictedAt: string;
  resolvedAt: string;
  evidenceRefs: readonly string[];
}

export interface ForecastCalibration {
  status: 'calibrated' | 'insufficient';
  organizationId?: string;
  modelId?: string;
  target?: string;
  horizonDays?: number;
  unit?: string;
  sampleCount: number;
  wapeBps?: number;
  biasBps?: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  missing: string[];
  evidenceRefs: string[];
  firstPredictedAt?: string;
  lastResolvedAt?: string;
}

function text(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 512) throw new Error(`invalid_${field}`);
  return result;
}

function bps(numerator: bigint, denominator: bigint): number {
  const value = numerator * 10_000n / denominator;
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error('forecast_ratio_overflow');
  return converted;
}

export function calibrateForecast(
  observations: readonly ForecastObservation[],
): ForecastCalibration {
  if (!observations.length) {
    return {
      status: 'insufficient', sampleCount: 0, confidence: 'none',
      missing: ['resolved_forecasts'], evidenceRefs: [],
    };
  }
  const first = observations[0]!;
  const scope = [
    text(first.organizationId, 'organization_id'), text(first.modelId, 'model_id'),
    text(first.target, 'forecast_target'), first.horizonDays, text(first.unit, 'forecast_unit'),
  ] as const;
  if (!Number.isSafeInteger(first.horizonDays) || first.horizonDays < 1 || first.horizonDays > 3_650) {
    throw new Error('invalid_forecast_horizon');
  }
  let absoluteError = 0n;
  let signedError = 0n;
  let actualMagnitude = 0n;
  const evidenceRefs = new Set<string>();
  let firstPredictedAt = first.predictedAt;
  let lastResolvedAt = first.resolvedAt;
  for (const item of observations) {
    const itemScope = [
      text(item.organizationId, 'organization_id'), text(item.modelId, 'model_id'),
      text(item.target, 'forecast_target'), item.horizonDays, text(item.unit, 'forecast_unit'),
    ];
    if (itemScope.some((value, index) => value !== scope[index])) {
      throw new Error('forecast_scope_mismatch');
    }
    const predictedAt = Date.parse(item.predictedAt);
    const resolvedAt = Date.parse(item.resolvedAt);
    if (!Number.isFinite(predictedAt) || !Number.isFinite(resolvedAt) || resolvedAt <= predictedAt) {
      throw new Error('invalid_forecast_time');
    }
    if (!item.evidenceRefs.length) throw new Error('forecast_evidence_required');
    for (const reference of item.evidenceRefs) evidenceRefs.add(text(reference, 'evidence_ref'));
    const error = item.forecast - item.actual;
    absoluteError += error < 0n ? -error : error;
    signedError += error;
    actualMagnitude += item.actual < 0n ? -item.actual : item.actual;
    if (item.predictedAt < firstPredictedAt) firstPredictedAt = item.predictedAt;
    if (item.resolvedAt > lastResolvedAt) lastResolvedAt = item.resolvedAt;
  }
  const base = {
    organizationId: scope[0], modelId: scope[1], target: scope[2],
    horizonDays: scope[3], unit: scope[4], sampleCount: observations.length,
    evidenceRefs: [...evidenceRefs].sort(), firstPredictedAt, lastResolvedAt,
  };
  if (actualMagnitude === 0n) {
    return { ...base, status: 'insufficient', confidence: 'none', missing: ['non_zero_actuals'] };
  }
  const wapeBps = bps(absoluteError, actualMagnitude);
  const biasBps = bps(signedError, actualMagnitude);
  const confidence = observations.length >= 20 && wapeBps <= 1_000
    ? 'high' : observations.length >= 8 && wapeBps <= 2_500 ? 'medium' : 'low';
  return { ...base, status: 'calibrated', wapeBps, biasBps, confidence, missing: [] };
}
