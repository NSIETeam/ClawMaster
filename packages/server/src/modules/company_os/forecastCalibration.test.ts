import { describe, expect, it } from 'vitest';
import { calibrateForecast, type ForecastObservation } from './forecastCalibration.js';

const observation = (
  forecast: bigint,
  actual: bigint,
  index: number,
  overrides: Partial<ForecastObservation> = {},
): ForecastObservation => ({
  organizationId: 'org-1', modelId: 'inventory-cover-v1', target: 'inventory_units',
  horizonDays: 28, unit: 'unit', forecast, actual,
  predictedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  resolvedAt: `2026-08-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
  evidenceRefs: [`forecast:${index}`], ...overrides,
});

describe('CompanyOS forecast calibration', () => {
  it('computes integer WAPE and signed bias from resolved evidence', () => {
    const result = calibrateForecast([
      observation(110n, 100n, 0), observation(180n, 200n, 1),
    ]);
    expect(result).toMatchObject({
      status: 'calibrated', sampleCount: 2, wapeBps: 1_000,
      biasBps: -333, confidence: 'low',
    });
    expect(result.evidenceRefs).toEqual(['forecast:0', 'forecast:1']);
  });

  it('raises confidence only with enough accurate resolved samples', () => {
    const medium = Array.from({ length: 8 }, (_, index) => observation(105n, 100n, index));
    const high = Array.from({ length: 20 }, (_, index) => observation(102n, 100n, index));
    expect(calibrateForecast(medium)).toMatchObject({ confidence: 'medium', wapeBps: 500 });
    expect(calibrateForecast(high)).toMatchObject({ confidence: 'high', wapeBps: 200 });
  });

  it('does not claim calibration without samples or a non-zero actual denominator', () => {
    expect(calibrateForecast([])).toMatchObject({
      status: 'insufficient', sampleCount: 0, confidence: 'none',
    });
    expect(calibrateForecast([observation(10n, 0n, 0)])).toMatchObject({
      status: 'insufficient', sampleCount: 1, confidence: 'none',
      missing: ['non_zero_actuals'],
    });
  });

  it('rejects mixed scope, invalid time order, and missing evidence', () => {
    expect(() => calibrateForecast([
      observation(1n, 1n, 0), observation(1n, 1n, 1, { organizationId: 'org-2' }),
    ])).toThrow('forecast_scope_mismatch');
    expect(() => calibrateForecast([
      observation(1n, 1n, 0, { resolvedAt: '2026-07-01T00:00:00.000Z' }),
    ])).toThrow('invalid_forecast_time');
    expect(() => calibrateForecast([
      observation(1n, 1n, 0, { evidenceRefs: [] }),
    ])).toThrow('forecast_evidence_required');
  });
});
